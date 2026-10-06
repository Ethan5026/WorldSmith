// Worlds: create from recipes, start/stop, the featured world, wake-on-join and idle sleep.

import { randomBytes } from "node:crypto";
import { instantiateRecipe, loadRecipes, WorldProperties, WorldSpec, type Recipe } from "@worldsmith/core";
import { audit, type Db } from "./db.ts";
import type { BackupInfo, MapReport, WorkerClient, WorkerWorldStatus } from "./worker-client.ts";
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
}

const PERIODIC_BACKUP_MS = 6 * 60 * 60 * 1000;

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

  /** Create a world from a recipe and set it up on the worker (doesn't start it). */
  async createFromRecipe(recipeId: string, slug: string, name: string): Promise<WorldView> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe) throw new Error(`No recipe called "${recipeId}". Available: ${[...this.recipes.keys()].join(", ")}`);
    if (this.row(slug)) throw new Error(`A world called "${slug}" already exists.`);
    const spec = instantiateRecipe(recipe, { slug, name });
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
    opts: { slug: string; name: string; bedrock: boolean; gamemode?: WorldProperties["gamemode"]; difficulty?: WorldProperties["difficulty"] },
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
      },
    });
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
