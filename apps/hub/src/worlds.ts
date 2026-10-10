// Worlds: create from recipes, start/stop, the featured world, wake-on-join and idle sleep.

import { randomBytes } from "node:crypto";
import { instantiateRecipe, loadRecipes, WorldProperties, WorldSpec, type Recipe, type WorldFile } from "@worldsmith/core";
import { audit, type Db } from "./db.ts";
import type { BackupInfo, MapReport, SavedGame, WorkerClient, WorkerWorldStatus } from "./worker-client.ts";
import type { AccessService } from "./access.ts";

export interface WorldRow {
  slug: string;
  name: string;
  recipe: string | null;
  spec: string;
  created_at: number;
  last_active_at: number | null;
  last_backup_at: number | null;
  only_with_me: number;
  lan_port: number | null;
}

/** Ports the gatekeeper opens on the home network, one per world with Wi-Fi play on. */
export const LAN_PORTS = Array.from({ length: 10 }, (_, i) => 25570 + i);

const PERIODIC_BACKUP_MS = 6 * 60 * 60 * 1000;

/** What a world plan adds on top of its base: settings, game rules, pinned content, Bedrock choice. */
export interface PlanExtras {
  properties?: WorldProperties;
  gamerules?: Record<string, boolean | number>;
  files?: WorldFile[];
  bedrock?: boolean;
}

function withExtras(spec: WorldSpec, extras: PlanExtras): WorldSpec {
  return WorldSpec.parse({
    ...spec,
    files: [...spec.files, ...(extras.files ?? [])],
    gamerules: { ...spec.gamerules, ...extras.gamerules },
    crossplay: extras.bedrock === undefined ? spec.crossplay : { bedrock: extras.bedrock },
  });
}

export type WorldState = "asleep" | "waking" | "online" | "missing" | "error";

export interface WorldView {
  slug: string;
  name: string;
  recipe: string | null;
  featured: boolean;
  onlyWithMe: boolean;
  state: WorldState;
  version: string;
  protocol: number;
  players: { online: number; max: number };
  backend: string;
  /** Port people on the home network use for this world (null = Wi-Fi play off). */
  lanPort: number | null;
}

const STATUS_TTL_MS = 3000;

export class WorldService {
  db: Db;
  worker: WorkerClient;
  access: AccessService;
  recipes: Map<string, Recipe>;
  private statusCache = new Map<string, { at: number; status: WorkerWorldStatus }>();
  private waking = new Map<string, number>();

  constructor(db: Db, worker: WorkerClient, access: AccessService, recipesDir: string) {
    this.db = db;
    this.worker = worker;
    this.access = access;
    this.recipes = loadRecipes(recipesDir);
  }

  rows(): WorldRow[] {
    return this.db.prepare("SELECT * FROM worlds ORDER BY created_at").all() as unknown as WorldRow[];
  }
  row(slug: string): WorldRow | undefined {
    return this.db.prepare("SELECT * FROM worlds WHERE slug = ?").get(slug) as unknown as WorldRow | undefined;
  }
  spec(slug: string): WorldSpec {
    const r = this.row(slug);
    if (!r) throw new Error(`No world called "${slug}".`);
    return WorldSpec.parse(JSON.parse(r.spec));
  }

  featuredSlug(): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = 'featured_world'").get() as { value: string } | undefined)?.value;
  }
  setFeatured(slug: string): void {
    if (!this.row(slug)) throw new Error(`No world called "${slug}".`);
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('featured_world', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(slug);
    audit(this.db, "world_featured", { slug });
  }

  /** Turn Wi-Fi (LAN) play on or off: a world with it on gets its own port on the home network. */
  setLan(slug: string, on: boolean): number | null {
    const r = this.row(slug);
    if (!r) throw new Error(`No world called "${slug}".`);
    if (!on) {
      this.db.prepare("UPDATE worlds SET lan_port = NULL WHERE slug = ?").run(slug);
      if (r.lan_port !== null) audit(this.db, "world_lan", { slug, port: null });
      return null;
    }
    if (r.lan_port !== null) return r.lan_port;
    const used = new Set((this.db.prepare("SELECT lan_port FROM worlds WHERE lan_port IS NOT NULL").all() as { lan_port: number }[]).map((x) => x.lan_port));
    const port = LAN_PORTS.find((p) => !used.has(p));
    if (port === undefined) throw new Error(`Wi-Fi play is on for ${LAN_PORTS.length} worlds already. Turn it off for one first.`);
    this.db.prepare("UPDATE worlds SET lan_port = ? WHERE slug = ?").run(port, slug);
    audit(this.db, "world_lan", { slug, port });
    return port;
  }

  slugForLanPort(port: number): string | undefined {
    return (this.db.prepare("SELECT slug FROM worlds WHERE lan_port = ?").get(port) as { slug: string } | undefined)?.slug;
  }

  /** Create a world from a recipe and set it up on the worker (doesn't start it). */
  async createFromRecipe(recipeId: string, slug: string, name: string, extras: PlanExtras = {}): Promise<WorldView> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe) throw new Error(`No recipe called "${recipeId}". Available: ${[...this.recipes.keys()].join(", ")}`);
    if (this.row(slug)) throw new Error(`A world called "${slug}" already exists.`);
    const spec = withExtras(instantiateRecipe(recipe, { slug, name, properties: extras.properties }), extras);
    this.db
      .prepare("INSERT INTO worlds (slug, name, recipe, spec, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(slug, name, recipeId, JSON.stringify(spec), Date.now());
    try {
      await this.worker.apply(spec, randomBytes(24).toString("base64url"), this.access.accessFiles(slug));
    } catch (err) {
      this.db.prepare("DELETE FROM worlds WHERE slug = ?").run(slug);
      throw err;
    }
    if (!this.featuredSlug()) this.setFeatured(slug);
    audit(this.db, "world_created", { slug, recipe: recipeId });
    return this.view(slug);
  }

  /** Create a world from an imported public map (see the worker's map store). Doesn't start it. */
  async createFromMap(
    report: MapReport,
    root: string,
    opts: { slug: string; name: string; bedrock: boolean; gamemode?: WorldProperties["gamemode"]; difficulty?: WorldProperties["difficulty"] } & PlanExtras,
  ): Promise<WorldView> {
    const map = report.worlds.find((w) => w.root === root);
    if (!map) throw new Error(`That import has no world at "${root}".`);
    const recipe = this.recipes.get("map");
    if (!recipe) throw new Error("The map recipe is missing.");
    if (this.row(opts.slug)) throw new Error(`A world called "${opts.slug}" already exists.`);
    const difficulty = WorldProperties.shape.difficulty.safeParse(map.difficulty);
    const spec = instantiateRecipe(recipe, {
      slug: opts.slug,
      name: opts.name,
      properties: {
        // Spectator-mode maps are showcases; let people walk around instead.
        gamemode: opts.gamemode ?? (map.gameMode === "spectator" ? "adventure" : map.gameMode),
        difficulty: opts.difficulty ?? (difficulty.success ? difficulty.data : undefined),
        hardcore: map.hardcore,
        ...opts.properties,
      },
    });
    Object.assign(spec, withExtras(spec, { ...opts, properties: undefined }));
    spec.crossplay = { bedrock: opts.bedrock };
    spec.upgradeWorld = map.needsUpgrade;
    this.db
      .prepare("INSERT INTO worlds (slug, name, recipe, spec, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(opts.slug, opts.name, "map", JSON.stringify(spec), Date.now());
    try {
      await this.worker.apply(spec, randomBytes(24).toString("base64url"), this.access.accessFiles(opts.slug));
      await this.worker.installMap(opts.slug, report.id, root);
    } catch (err) {
      this.db.prepare("DELETE FROM worlds WHERE slug = ?").run(opts.slug);
      await this.worker.remove(opts.slug, true).catch(() => undefined);
      throw err;
    }
    if (!this.featuredSlug()) this.setFeatured(opts.slug);
    audit(this.db, "world_created", { slug: opts.slug, recipe: "map", map: report.id, level: map.levelName, version: map.version ?? null });
    return this.view(opts.slug);
  }

  /**
   * An old imported map's one-time upgrade: boot it once on the upgrade server, wait until every chunk
   * is converted and the server is up, then put it to sleep (which switches it back to its normal
   * server type, see stop()).
   */
  async runUpgradeBoot(slug: string, timeoutMs = 20 * 60_000): Promise<void> {
    if (!this.spec(slug).upgradeWorld) return;
    await this.start(slug, "map upgrade");
    const until = Date.now() + timeoutMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await this.worker.status(slug);
      if (s.mc?.online) break;
      if (s.container === "exited" || s.container === "dead") {
        const tail = (await this.worker.logs(slug, 20).catch(() => "")).split("\n").slice(-8).join("\n");
        throw new Error(`The map upgrade stopped early:\n${tail}`);
      }
      if (Date.now() > until) throw new Error("The map upgrade took longer than 20 minutes.");
    }
    audit(this.db, "map_upgraded", { slug });
    await this.stop(slug, "map upgrade finished");
  }

  /**
   * Delete a world (owner only, from the portal). A final backup is kept on the worker, so it can be
   * brought back by an admin; the container, volume and the hub's records are removed.
   */
  async remove(slug: string): Promise<{ finalBackup?: string }> {
    const spec = this.spec(slug);
    const s = await this.worker.status(slug).catch(() => undefined);
    if (s?.container === "running") await this.worker.stop(slug);
    let finalBackup: string | undefined;
    if (s && s.container !== "missing") finalBackup = (await this.worker.backup(slug, "before-delete")).id;
    await this.worker.remove(slug, true);
    this.db.prepare("DELETE FROM world_members WHERE world_slug = ?").run(slug);
    this.db.prepare("DELETE FROM worlds WHERE slug = ?").run(slug);
    if (this.featuredSlug() === slug) {
      const next = this.rows()[0]?.slug;
      if (next) this.setFeatured(next);
      else this.db.prepare("DELETE FROM settings WHERE key = 'featured_world'").run();
    }
    this.statusCache.delete(slug);
    this.waking.delete(slug);
    audit(this.db, "world_deleted", { slug, name: spec.name, finalBackup: finalBackup ?? null });
    return { finalBackup };
  }

  /** Save a world as a reusable minigame (snapshot + its spec). */
  async saveAsGame(slug: string, game: { name: string; title: string; description?: string }): Promise<SavedGame> {
    const saved = await this.worker.saveGame(slug, { ...game, spec: this.spec(slug) });
    audit(this.db, "minigame_saved", { slug, name: game.name });
    return saved;
  }

  /** Create a fresh, independent world from a saved minigame. Doesn't start it. */
  async createFromSaved(game: SavedGame, slug: string, name: string, extras: PlanExtras = {}): Promise<WorldView> {
    if (this.row(slug)) throw new Error(`A world called "${slug}" already exists.`);
    const spec = withExtras(WorldSpec.parse({ ...game.spec, slug, name, upgradeWorld: false, properties: { ...game.spec.properties, motd: name, ...extras.properties } }), extras);
    this.db
      .prepare("INSERT INTO worlds (slug, name, recipe, spec, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(slug, name, spec.recipe ?? null, JSON.stringify(spec), Date.now());
    try {
      await this.worker.apply(spec, randomBytes(24).toString("base64url"), this.access.accessFiles(slug));
      await this.worker.installGame(slug, game.name);
      // A void Nether/End starts empty, even if the saved game had explored them.
      const dims = spec.properties.dimensions ?? {};
      const voids = (["nether", "end"] as const).filter((d) => dims[d] === "void");
      if (voids.length) await this.worker.resetDimensions(slug, voids);
    } catch (err) {
      this.db.prepare("DELETE FROM worlds WHERE slug = ?").run(slug);
      await this.worker.remove(slug, true).catch(() => undefined);
      throw err;
    }
    if (!this.featuredSlug()) this.setFeatured(slug);
    audit(this.db, "world_created", { slug, from: "saved_game", game: game.name });
    return this.view(slug);
  }

  /** Adopt a world that already exists on the worker (created before the hub tracked it). */
  async adopt(recipeId: string, slug: string, name: string, properties?: WorldProperties): Promise<WorldView> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe) throw new Error(`No recipe called "${recipeId}".`);
    const spec = instantiateRecipe(recipe, { slug, name, properties });
    this.db
      .prepare("INSERT OR IGNORE INTO worlds (slug, name, recipe, spec, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(slug, name, recipeId, JSON.stringify(spec), Date.now());
    if (!this.featuredSlug()) this.setFeatured(slug);
    await this.syncAccess(slug);
    return this.view(slug);
  }

  /**
   * Switch the Nether and/or End between normal and void (Skyblock-style). Only those dimensions are
   * touched: a dimension whose mode changes has its existing land cleared (safety backup first), so
   * it generates fresh; the overworld is never changed. Restarts the world if it's running.
   */
  async setDimensions(
    slug: string,
    dims: { nether?: "normal" | "void"; end?: "normal" | "void" },
    opts: { allowRestart?: boolean } = {},
  ): Promise<{ world: WorldView; reset: ("nether" | "end")[]; safetyBackup?: string; restarted: boolean }> {
    const spec = this.spec(slug);
    const before = spec.properties.dimensions ?? {};
    const reset = (["nether", "end"] as const).filter((d) => dims[d] && dims[d] !== (before[d] ?? "normal"));
    const view = await this.view(slug, true);
    if (view.state === "online" && view.players.online > 0 && !opts.allowRestart) {
      throw new Error(`${spec.name} has ${view.players.online} player(s) online; changing dimensions restarts it. Ask first, then retry with allowRestart.`);
    }
    const wasRunning = (await this.worker.status(slug)).container === "running";
    if (wasRunning) await this.stop(slug, "dimension change");
    const next = WorldSpec.parse({ ...spec, properties: { ...spec.properties, dimensions: { ...before, ...dims } } });
    this.db.prepare("UPDATE worlds SET spec = ? WHERE slug = ?").run(JSON.stringify(next), slug);
    const safetyBackup = reset.length ? (await this.worker.resetDimensions(slug, reset)).safetyBackup.id : undefined;
    await this.reapply(slug);
    if (wasRunning) await this.start(slug, "dimension change");
    audit(this.db, "world_dimensions_changed", { slug, dims: next.properties.dimensions, reset, safetyBackup: safetyBackup ?? null });
    return { world: await this.view(slug, true), reset, safetyBackup, restarted: wasRunning };
  }

  /** Rebuild a stopped world's container from its saved spec (new settings, files, limits). Keeps the world data. */
  async reapply(slug: string): Promise<WorldView> {
    const spec = this.spec(slug);
    const s = await this.worker.status(slug);
    if (s.container === "running") throw new Error(`${spec.name} is running. Stop it first.`);
    if (s.container !== "missing") await this.backup(slug, "before-apply");
    await this.worker.apply(spec, randomBytes(24).toString("base64url"), this.access.accessFiles(slug));
    this.statusCache.delete(slug);
    audit(this.db, "world_reapplied", { slug });
    return this.view(slug, true);
  }

  async status(slug: string, fresh = false): Promise<WorkerWorldStatus> {
    const hit = this.statusCache.get(slug);
    if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;
    const status = await this.worker.status(slug);
    this.statusCache.set(slug, { at: Date.now(), status });
    if (status.mc?.online && status.mc.players.online > 0) {
      this.db.prepare("UPDATE worlds SET last_active_at = ? WHERE slug = ?").run(Date.now(), slug);
    }
    return status;
  }

  stateOf(slug: string, s: WorkerWorldStatus): WorldState {
    if (s.container === "missing") return "missing";
    if (s.container === "running") {
      if (s.mc?.online) {
        this.waking.delete(slug);
        return "online";
      }
      return s.health === "unhealthy" ? "error" : "waking";
    }
    return this.waking.has(slug) ? "waking" : "asleep";
  }

  async view(slug: string, fresh = false): Promise<WorldView> {
    const r = this.row(slug)!;
    const spec = WorldSpec.parse(JSON.parse(r.spec));
    let s: WorkerWorldStatus;
    try {
      s = await this.status(slug, fresh);
    } catch {
      s = { slug, container: "missing", backend: "" };
    }
    return {
      slug,
      name: r.name,
      recipe: r.recipe,
      featured: this.featuredSlug() === slug,
      onlyWithMe: r.only_with_me === 1,
      state: this.stateOf(slug, s),
      version: spec.minecraft.version,
      protocol: spec.minecraft.protocol,
      players: s.mc?.online ? s.mc.players : { online: 0, max: 20 },
      backend: s.backend,
      lanPort: r.lan_port ?? null,
    };
  }

  async views(): Promise<WorldView[]> {
    return Promise.all(this.rows().map((r) => this.view(r.slug)));
  }

  async start(slug: string, reason: string): Promise<void> {
    this.spec(slug); // throws if unknown
    this.waking.set(slug, Date.now());
    this.statusCache.delete(slug);
    await this.syncAccess(slug);
    await this.worker.start(slug);
    this.db.prepare("UPDATE worlds SET last_active_at = ? WHERE slug = ?").run(Date.now(), slug);
    audit(this.db, "world_started", { slug, reason });
  }

  /**
   * Someone is joining right now. The server only counts them once they've finished logging in,
   * so without this an idle world could be put to sleep under a player who is mid-join.
   */
  markActive(slug: string): void {
    this.db.prepare("UPDATE worlds SET last_active_at = ? WHERE slug = ?").run(Date.now(), slug);
  }

  async stop(slug: string, reason: string): Promise<void> {
    this.waking.delete(slug);
    this.statusCache.delete(slug);
    await this.worker.stop(slug);
    audit(this.db, "world_stopped", { slug, reason });
    // Going to sleep is the natural snapshot point: back up if anyone played since the last one.
    const r = this.row(slug);
    if (r && (r.last_active_at ?? 0) > (r.last_backup_at ?? 0)) {
      await this.backup(slug, "sleep").catch((err) => console.error("backup on sleep failed", slug, err));
    }
    // An imported map upgrades on its first start; after that, start normally (upgrading is slow).
    const spec = this.spec(slug);
    if (spec.upgradeWorld) {
      spec.upgradeWorld = false;
      this.db.prepare("UPDATE worlds SET spec = ? WHERE slug = ?").run(JSON.stringify(spec), slug);
      await this.worker
        .apply(spec, randomBytes(24).toString("base64url"), this.access.accessFiles(slug))
        .catch((err) => console.error("clearing the upgrade flag failed", slug, err));
    }
  }

  async backup(slug: string, label: string): Promise<BackupInfo> {
    this.spec(slug);
    const info = await this.worker.backup(slug, label);
    this.db.prepare("UPDATE worlds SET last_backup_at = ? WHERE slug = ?").run(Date.now(), slug);
    audit(this.db, "world_backed_up", { slug, label, id: info.id, bytes: info.bytes });
    return info;
  }

  listBackups(slug: string): Promise<BackupInfo[]> {
    this.spec(slug);
    return this.worker.listBackups(slug);
  }

  /** Owner-only (portal): roll a world back. Takes a safety backup, restores, re-installs the recipe's files. */
  async restore(slug: string, id: string): Promise<WorldView> {
    const spec = this.spec(slug); // unknown world → clear error before touching the worker
    const s = await this.worker.status(slug);
    if (s.container === "running") await this.stop(slug, "restore");
    const { safetyBackup } = await this.worker.restore(slug, id);
    await this.worker.apply(spec, randomBytes(24).toString("base64url"), this.access.accessFiles(slug));
    this.statusCache.delete(slug);
    audit(this.db, "world_restored", { slug, id, safetyBackup: safetyBackup.id });
    return this.view(slug, true);
  }

  /** Push the current whitelist/ops to a world (files always; live reload if it's running). */
  async syncAccess(slug: string): Promise<void> {
    await this.worker.putFiles(slug, this.access.accessFiles(slug));
    const s = await this.worker.status(slug);
    if (s.container === "running" && s.mc?.online) await this.worker.rcon(slug, this.access.liveSyncCommands(slug));
  }

  async syncAccessEverywhere(): Promise<void> {
    await Promise.all(this.rows().map((r) => this.syncAccess(r.slug).catch((e) => console.error("sync failed", r.slug, e))));
  }

  /** Names of players currently in a running world (via the console's "list"). */
  async onlinePlayers(slug: string): Promise<string[]> {
    const [out] = await this.worker.rcon(slug, ["list"]);
    const names = (out ?? "").split(":").slice(1).join(":").trim();
    return names ? names.split(",").map((n) => n.trim()).filter(Boolean) : [];
  }

  /** Put worlds nobody has played for their idle limit to sleep. Called every minute. */
  async sleepIdleWorlds(): Promise<void> {
    for (const r of this.rows()) {
      let s: WorkerWorldStatus;
      try {
        s = await this.status(r.slug, true);
      } catch {
        continue;
      }
      if (s.container !== "running") continue;
      if (s.mc?.online && s.mc.players.online > 0) {
        if (Date.now() - (r.last_backup_at ?? 0) > PERIODIC_BACKUP_MS) {
          await this.backup(r.slug, "periodic").catch((err) => console.error("periodic backup failed", r.slug, err));
        }
        continue;
      }
      const idleMinutes = WorldSpec.parse(JSON.parse(r.spec)).idleSleepMinutes;
      const lastActive = Math.max(r.last_active_at ?? 0, s.startedAt ? Date.parse(s.startedAt) : 0);
      if (Date.now() - lastActive > idleMinutes * 60_000) await this.stop(r.slug, `idle ${idleMinutes} min`);
    }
  }
}
