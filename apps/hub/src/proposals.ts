// Proposals: new worlds Claude suggests and only the owner can approve. A proposal is a WorldPlan
// (base recipe or map, Modrinth content, settings, build steps), resolved and checked when it's
// proposed, so approving builds exactly what the card showed. When Bedrock players may join,
// approval waits for the owner's crossplay answers (textures and behavior priorities). The owner
// can also send a plan back with a note, which Claude reads with proposal_status.

import { z } from "zod";
import {
  BedrockPriority,
  compileBuild,
  evaluateCrossplay,
  WorldPlan,
  WorldProperties,
  type ContentCrossplay,
  type CrossplayReport,
} from "@worldsmith/core";
import { loadVersion } from "@worldsmith/mcdata";
import { audit, type Db } from "./db.ts";
import type { Push } from "./push.ts";
import type { Catalog, Resolution, ResolvedContent } from "./catalog.ts";
import type { BuildService } from "./builds.ts";
import type { MapReport, MapWorldInfo, SavedGame } from "./worker-client.ts";
import type { WorldService } from "./worlds.ts";

/** The simple path: a world straight from a downloaded map (becomes a plan with a map base). */
export const WorldFromMap = z.object({
  mapId: z.string().regex(/^\d{8}-\d{6}-[0-9a-f]{6}$/),
  /** Which world in the zip (MapReport.worlds[].root); "" for a zip with the world at the top. */
  root: z.string().max(300).default(""),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/, "lowercase letters, digits and dashes (2-31)"),
  name: z.string().min(1).max(60),
  bedrock: z.enum(["yes", "no", "unknown"]).default("unknown"),
  gamemode: WorldProperties.shape.gamemode.optional(),
  difficulty: WorldProperties.shape.difficulty.optional(),
  /** Claude's pitch: why this map, what it plans to add (lobby, rules, chests…). */
  notes: z.string().max(2000).optional(),
});
export type WorldFromMap = z.infer<typeof WorldFromMap>;

export function planFromMap(r: WorldFromMap): WorldPlan {
  return WorldPlan.parse({
    name: r.name,
    slug: r.slug,
    pitch: r.notes ?? `${r.name}, from a downloaded map.`,
    base: { kind: "map", mapId: r.mapId, root: r.root },
    bedrock: r.bedrock,
    properties: { ...(r.gamemode ? { gamemode: r.gamemode } : {}), ...(r.difficulty ? { difficulty: r.difficulty } : {}) },
  });
}

export const CrossplayAnswers = z.object({
  bedrockPlayers: z.enum(["yes", "no"]).optional(),
  textures: BedrockPriority.optional(),
  behavior: BedrockPriority.optional(),
});
export type CrossplayAnswers = z.infer<typeof CrossplayAnswers>;

type Status = "pending" | "building" | "approved" | "declined" | "failed";

interface ProposalRow {
  id: number;
  kind: "world_from_map" | "world_plan";
  title: string;
  payload: string;
  status: Status;
  created_by: string;
  created_at: number;
  decided_at: number | null;
  result: string | null;
}

interface Payload {
  plan: WorldPlan;
  resolution: Resolution;
}

export interface BuildOutcome {
  name: string;
  ok: boolean;
  failed: number;
  errors?: string[];
}

export interface ProposalView {
  id: number;
  kind: "world_plan";
  title: string;
  status: Status;
  createdBy: string;
  createdAt: string;
  decidedAt?: string;
  plan: WorldPlan;
  base:
    | { kind: "recipe"; name: string; description: string; tags: string[] }
    | { kind: "map"; levelName: string; version?: string; needsUpgrade: boolean; gameMode: string; sizeMb: number; source: string; warnings: string[] }
    | { kind: "saved"; title: string; description?: string; savedFrom: string; savedAt: string; sizeMb: number }
    | { kind: "missing"; note: string };
  minecraft: string;
  content: (Pick<ResolvedContent, "label" | "why" | "requiredBy"> & { title: string; type: string; version: string; url: string; license?: string })[];
  builds: { name: string; steps: number; kinds: string[] }[];
  crossplay: CrossplayReport;
  result?: { slug?: string; error?: string; note?: string; builds?: BuildOutcome[] };
}

/** What a vanilla map brings, for the crossplay check. Everything in it is server-side vanilla. */
function mapContent(map: MapWorldInfo): ContentCrossplay[] {
  const content: ContentCrossplay[] = [{ id: "map", name: map.levelName, textures: "native", behavior: "identical", differences: [] }];
  if (map.datapacks.length) {
    content.push({ id: "map-datapacks", name: `Map datapacks (${map.datapacks.join(", ")})`, textures: "native", behavior: "identical", differences: [] });
  }
  return content;
}

export class ProposalService {
  db: Db;
  worlds: WorldService;
  push: Push;
  catalog: Catalog;
  builds: BuildService;

  constructor(db: Db, worlds: WorldService, push: Push, catalog: Catalog, builds: BuildService) {
    this.db = db;
    this.worlds = worlds;
    this.push = push;
    this.catalog = catalog;
    this.builds = builds;
  }

  private row(id: number): ProposalRow {
    const r = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as unknown as ProposalRow | undefined;
    if (!r) throw new Error(`No proposal #${id}.`);
    return r;
  }

  private payload(r: ProposalRow): Payload {
    const raw = JSON.parse(r.payload) as unknown;
    if (r.kind === "world_from_map") {
      return { plan: planFromMap(WorldFromMap.parse(raw)), resolution: { minecraft: "26.2", serverType: "PAPER", items: [], issues: [] } };
    }
    const p = raw as Payload;
    return { plan: WorldPlan.parse(p.plan), resolution: p.resolution };
  }

  /** Minecraft version and server type a plan's base runs on. */
  private async platform(plan: WorldPlan) {
    if (plan.base.kind === "saved") {
      const game = await this.worlds.worker.getGame(plan.base.game);
      return { minecraft: game.spec.minecraft.version, type: game.spec.minecraft.type, game };
    }
    const id = plan.base.kind === "recipe" ? plan.base.recipe : "map";
    const recipe = this.worlds.recipes.get(id);
    if (!recipe) throw new Error(`No recipe called "${id}". Available: ${[...this.worlds.recipes.keys()].join(", ")}`);
    return { minecraft: recipe.spec.minecraft.version, type: recipe.spec.minecraft.type, game: undefined };
  }

  private async saved(plan: WorldPlan): Promise<SavedGame | undefined> {
    return plan.base.kind === "saved" ? this.worlds.worker.getGame(plan.base.game).catch(() => undefined) : undefined;
  }

  private async map(plan: WorldPlan): Promise<{ report: MapReport; world: MapWorldInfo } | undefined> {
    if (plan.base.kind !== "map") return undefined;
    const report = await this.worlds.worker.getMap(plan.base.mapId).catch(() => undefined);
    const root = plan.base.root;
    const world = report?.worlds.find((w) => w.root === root);
    return report && world ? { report, world } : undefined;
  }

  private crossplay(plan: WorldPlan, p: Payload, map: MapWorldInfo | undefined, answers: CrossplayAnswers = {}, game?: SavedGame): CrossplayReport {
    const base: ContentCrossplay[] = [];
    if (plan.base.kind === "recipe") {
      const recipe = this.worlds.recipes.get(plan.base.recipe);
      if (recipe) {
        base.push({ id: recipe.id, name: recipe.name, textures: "native", behavior: recipe.tags.includes("Java + Bedrock") ? "identical" : "approximate", differences: [] });
      }
    } else if (map) base.push(...mapContent(map));
    else if (game) {
      const plugins = game.spec.files.some((f) => /^(plugins|mods)\//.test(f.path));
      base.push({ id: game.name, name: game.title, textures: "native", behavior: plugins ? "approximate" : "identical", differences: [] });
    }
    return evaluateCrossplay(
      { bedrockPlayers: answers.bedrockPlayers ?? plan.bedrock, textures: answers.textures, behavior: answers.behavior },
      [...base, ...p.resolution.items.map((i) => i.crossplay)],
    );
  }

  private async view(r: ProposalRow): Promise<ProposalView> {
    const p = this.payload(r);
    const { plan } = p;
    const m = await this.map(plan);
    const game = await this.saved(plan);
    let base: ProposalView["base"];
    if (plan.base.kind === "recipe") {
      const recipe = this.worlds.recipes.get(plan.base.recipe);
      base = recipe ? { kind: "recipe", name: recipe.name, description: recipe.description, tags: recipe.tags } : { kind: "missing", note: `Recipe ${plan.base.recipe} is gone.` };
    } else if (m) {
      base = {
        kind: "map",
        levelName: m.world.levelName,
        version: m.world.version,
        needsUpgrade: m.world.needsUpgrade,
        gameMode: m.world.gameMode,
        sizeMb: Math.round(m.world.worldBytes / 1024 / 1024),
        source: m.report.source.kind === "url" ? m.report.source.url : `uploaded ${m.report.source.filename}`,
        warnings: m.report.warnings,
      };
    } else if (game) {
      base = { kind: "saved", title: game.title, description: game.description, savedFrom: game.source, savedAt: game.createdAt, sizeMb: Math.max(1, Math.round(game.bytes / 1024 / 1024)) };
    } else base = { kind: "missing", note: plan.base.kind === "saved" ? "The saved minigame is gone." : "The downloaded map is gone." };
    return {
      id: r.id,
      kind: "world_plan",
      title: r.title,
      status: r.status,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).toISOString(),
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : undefined,
      plan,
      base,
      minecraft: p.resolution.minecraft,
      content: p.resolution.items.map((i) => ({
        title: i.project.title,
        type: i.project.type,
        version: i.version.number,
        url: i.project.url,
        license: i.project.license,
        label: i.label,
        why: i.why,
        requiredBy: i.requiredBy,
      })),
      builds: plan.builds.map((b) => ({ name: b.name, steps: b.ops.length, kinds: [...new Set(b.ops.map((o) => o.op))] })),
      crossplay: this.crossplay(plan, p, m?.world, {}, game),
      result: r.result ? (JSON.parse(r.result) as ProposalView["result"]) : undefined,
    };
  }

  /** Check, resolve and file a world plan. Throws (nothing is filed) if anything needs fixing. */
  async proposeWorldPlan(raw: unknown, by: string): Promise<ProposalView> {
    const plan = WorldPlan.parse(raw);
    const { minecraft, type } = await this.platform(plan);
    if (this.worlds.row(plan.slug)) throw new Error(`A world called "${plan.slug}" already exists.`);
    const same = (this.db.prepare("SELECT id, kind, status, payload, created_by FROM proposals WHERE status IN ('pending','building')").all() as unknown as ProposalRow[]).filter(
      (r) => this.payload(r).plan.slug === plan.slug,
    );
    // Claude may revise its own plan while the owner hasn't acted on it: the new card replaces the old one.
    const replaces = same.filter((r) => r.status === "pending" && !by.startsWith("owner") && !r.created_by.startsWith("owner"));
    if (same.length > replaces.length) throw new Error(`Another proposal already uses the name "${plan.slug}".`);
    if (plan.base.kind === "map") {
      const report = await this.worlds.worker.getMap(plan.base.mapId);
      const root = plan.base.root;
      if (!report.worlds.some((w) => w.root === root)) {
        throw new Error(`Import ${plan.base.mapId} has no world at "${plan.base.root}". Worlds in it: ${report.worlds.map((w) => JSON.stringify(w.root)).join(", ")}`);
      }
    }

    const resolution = await this.catalog.resolve(plan.content, minecraft, type);
    const problems = [...resolution.issues];
    if (plan.builds.length) {
      const data = loadVersion(minecraft);
      const library = plan.builds.some((b) => b.ops.some((o) => o.op === "template")) ? await this.worlds.worker.listTemplates() : [];
      const templates = new Map(library.map((t) => [t.name, { id: t.id, size: t.size }]));
      for (const b of plan.builds) for (const e of compileBuild(b, data, { templates }).errors) problems.push(`Build "${b.name}": ${e}`);
    }
    if (problems.length) throw new Error(`Fix these before proposing:\n${problems.map((p) => `- ${p}`).join("\n")}`);

    const title = `New world: ${plan.name}`;
    const id = Number(
      this.db
        .prepare("INSERT INTO proposals (kind, title, payload, created_by, created_at) VALUES ('world_plan', ?, ?, ?, ?)")
        .run(title, JSON.stringify({ plan, resolution } satisfies Payload), by, Date.now()).lastInsertRowid,
    );
    for (const old of replaces) {
      this.db
        .prepare("UPDATE proposals SET status = 'declined', decided_at = ?, result = ? WHERE id = ? AND status = 'pending'")
        .run(Date.now(), JSON.stringify({ note: `Replaced by #${id}` }), old.id);
      audit(this.db, "proposal_replaced", { id: old.id, by: id });
    }
    audit(this.db, "proposal_created", { id, kind: "world_plan", slug: plan.slug, base: plan.base.kind, content: resolution.items.length, builds: plan.builds.length, by });
    // The owner's own "Make a world" is already on their screen; only Claude's ideas need a nudge.
    if (!by.startsWith("owner")) {
      await this.push
        .notify({ title: "Claude has a world for you to review", body: `${plan.name}: ${plan.pitch.slice(0, 100)}`, url: "/#proposals", tag: `proposal-${id}` })
        .catch(() => 0);
    }
    return this.view(this.row(id));
  }

  async proposeWorldFromMap(raw: unknown, by: string): Promise<ProposalView> {
    return this.proposeWorldPlan(planFromMap(WorldFromMap.parse(raw)), by);
  }

  async list(): Promise<ProposalView[]> {
    const rows = this.db
      .prepare("SELECT * FROM proposals WHERE status IN ('pending','building') OR created_at > ? ORDER BY id DESC LIMIT 30")
      .all(Date.now() - 14 * 24 * 3600 * 1000) as unknown as ProposalRow[];
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: number): Promise<ProposalView> {
    return this.view(this.row(id));
  }

  /** Decline, optionally with a note for Claude ("request changes"). */
  async decline(id: number, note?: string): Promise<ProposalView> {
    const r = this.row(id);
    if (r.status !== "pending") throw new Error(`Proposal #${id} is already ${r.status}.`);
    this.db
      .prepare("UPDATE proposals SET status = 'declined', decided_at = ?, result = ? WHERE id = ?")
      .run(Date.now(), note ? JSON.stringify({ note: note.slice(0, 1000) }) : null, id);
    audit(this.db, "proposal_declined", { id, note: note ? note.slice(0, 200) : null });
    return this.get(id);
  }

  /** Owner approval: checks the crossplay answers, creates the world, then runs the plan's builds. */
  async approve(id: number, rawAnswers: unknown, opts: { wait?: boolean } = {}): Promise<ProposalView> {
    const answers = CrossplayAnswers.parse(rawAnswers ?? {});
    const r = this.row(id);
    if (r.status !== "pending") throw new Error(`Proposal #${id} is already ${r.status}.`);
    const p = this.payload(r);
    const { plan } = p;
    const m = await this.map(plan);
    if (plan.base.kind === "map" && !m) throw new Error("The downloaded map for this plan is gone. Ask Claude to import it again.");
    const game = await this.saved(plan);
    if (plan.base.kind === "saved" && !game) throw new Error("The saved minigame for this plan is gone.");
    const check = this.crossplay(plan, p, m?.world, answers, game);
    if (check.status === "needs_input") throw new Error(`Answer first: ${check.questions.map((q) => q.prompt).join(" ")}`);
    if (check.status === "conflicts") throw new Error(`Doesn't fit your Bedrock priorities: ${check.conflicts.map((c) => `${c.name}: ${c.problem}`).join("; ")}`);
    const claimed = this.db.prepare("UPDATE proposals SET status = 'building', decided_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), id);
    if (claimed.changes !== 1) throw new Error(`Proposal #${id} was decided elsewhere.`);
    const bedrock = (answers.bedrockPlayers ?? plan.bedrock) === "yes";
    const extras = { properties: plan.properties, gamerules: plan.gamerules, files: p.resolution.items.map((i) => i.file), bedrock };

    const build = async (): Promise<void> => {
      let slug: string | undefined;
      const outcomes: BuildOutcome[] = [];
      try {
        const world =
          plan.base.kind === "recipe"
            ? await this.worlds.createFromRecipe(plan.base.recipe, plan.slug, plan.name, extras)
            : plan.base.kind === "saved"
              ? await this.worlds.createFromSaved(game!, plan.slug, plan.name, extras)
              : await this.worlds.createFromMap(m!.report, plan.base.root, { slug: plan.slug, name: plan.name, ...extras });
        slug = world.slug;
        // Old maps: convert every chunk now, so the world is ready (and Claude can see it) right away.
        await this.worlds.runUpgradeBoot(world.slug);
        for (const script of plan.builds) {
          const rep = await this.builds.run(world.slug, script, { allowRestart: true, by: `plan #${id}` });
          outcomes.push({ name: script.name, ok: rep.ok, failed: rep.failed?.length ?? 0, ...(rep.errors ? { errors: rep.errors } : {}) });
        }
        if (plan.builds.length) await this.worlds.stop(world.slug, "plan built");
        const failedBuilds = outcomes.filter((o) => !o.ok);
        this.db
          .prepare("UPDATE proposals SET status = 'approved', result = ? WHERE id = ?")
          .run(JSON.stringify({ slug: world.slug, builds: outcomes, ...(failedBuilds.length ? { error: `${failedBuilds.length} build step(s) had problems: ${failedBuilds.map((b) => b.name).join(", ")}` } : {}) }), id);
        audit(this.db, "proposal_approved", { id, slug: world.slug, bedrock, textures: answers.textures ?? null, behavior: answers.behavior ?? null, builds: outcomes.length });
      } catch (err) {
        const error = slug ? `${plan.name} was created, but: ${(err as Error).message}` : (err as Error).message;
        this.db.prepare("UPDATE proposals SET status = 'failed', result = ? WHERE id = ?").run(JSON.stringify({ slug, error, builds: outcomes }), id);
        audit(this.db, "proposal_failed", { id, error });
      }
    };
    // The portal doesn't wait (old maps and builds take minutes); it shows "Building…" until done.
    if (opts.wait === false) void build();
    else await build();
    return this.get(id);
  }
}
