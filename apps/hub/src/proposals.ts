// Proposals: things Claude may suggest but only the owner can approve (today: a new world from a
// downloaded map). Claude files one through MCP; the owner gets a push and decides in the portal.
// When Bedrock players may join, approval waits until the owner has answered the crossplay
// questions (textures and behavior priorities).

import { z } from "zod";
import { BedrockPriority, evaluateCrossplay, WorldProperties, type ContentCrossplay, type CrossplayReport } from "@worldsmith/core";
import { audit, type Db } from "./db.ts";
import type { Push } from "./push.ts";
import type { MapReport, MapWorldInfo } from "./worker-client.ts";
import type { WorldService } from "./worlds.ts";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/, "lowercase letters, digits and dashes (2-31)");

export const WorldFromMap = z.object({
  mapId: z.string().regex(/^\d{8}-\d{6}-[0-9a-f]{6}$/),
  /** Which world in the zip (MapReport.worlds[].root); "" for a zip with the world at the top. */
  root: z.string().max(300).default(""),
  slug: Slug,
  name: z.string().min(1).max(60),
  bedrock: z.enum(["yes", "no", "unknown"]).default("unknown"),
  gamemode: WorldProperties.shape.gamemode.optional(),
  difficulty: WorldProperties.shape.difficulty.optional(),
  /** Claude's pitch: why this map, what it plans to add (lobby, rules, chests…). */
  notes: z.string().max(2000).optional(),
});
export type WorldFromMap = z.infer<typeof WorldFromMap>;

export const CrossplayAnswers = z.object({
  bedrockPlayers: z.enum(["yes", "no"]).optional(),
  textures: BedrockPriority.optional(),
  behavior: BedrockPriority.optional(),
});
export type CrossplayAnswers = z.infer<typeof CrossplayAnswers>;

interface ProposalRow {
  id: number;
  kind: "world_from_map";
  title: string;
  payload: string;
  status: "pending" | "building" | "approved" | "declined" | "failed";
  created_by: string;
  created_at: number;
  decided_at: number | null;
  result: string | null;
}

export interface ProposalView {
  id: number;
  kind: "world_from_map";
  title: string;
  status: ProposalRow["status"];
  createdBy: string;
  createdAt: string;
  decidedAt?: string;
  request: WorldFromMap;
  map?: { levelName: string; version?: string; needsUpgrade: boolean; gameMode: string; sizeMb: number; source: string; warnings: string[] };
  crossplay: CrossplayReport;
  result?: { slug?: string; error?: string };
}

/** What a vanilla map brings, for the crossplay check. Everything in it is server-side vanilla. */
function mapContent(map: MapWorldInfo | undefined): ContentCrossplay[] {
  if (!map) return [];
  const content: ContentCrossplay[] = [
    { id: "map", name: map.levelName, textures: "native", behavior: "identical", differences: [] },
  ];
  if (map.datapacks.length) {
    content.push({
      id: "map-datapacks",
      name: `Map datapacks (${map.datapacks.join(", ")})`,
      textures: "native",
      behavior: "identical",
      differences: [],
    });
  }
  return content;
}

export class ProposalService {
  db: Db;
  worlds: WorldService;
  push: Push;

  constructor(db: Db, worlds: WorldService, push: Push) {
    this.db = db;
    this.worlds = worlds;
    this.push = push;
  }

  private row(id: number): ProposalRow {
    const r = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as unknown as ProposalRow | undefined;
    if (!r) throw new Error(`No proposal #${id}.`);
    return r;
  }

  private crossplay(request: WorldFromMap, map: MapWorldInfo | undefined, answers: CrossplayAnswers = {}): CrossplayReport {
    return evaluateCrossplay(
      { bedrockPlayers: answers.bedrockPlayers ?? request.bedrock, textures: answers.textures, behavior: answers.behavior },
      mapContent(map),
    );
  }

  private async view(r: ProposalRow): Promise<ProposalView> {
    const request = WorldFromMap.parse(JSON.parse(r.payload));
    let report: MapReport | undefined;
    try {
      report = await this.worlds.worker.getMap(request.mapId);
    } catch {
      report = undefined; // deleted import: still show the proposal
    }
    const map = report?.worlds.find((w) => w.root === request.root);
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      status: r.status,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).toISOString(),
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : undefined,
      request,
      map:
        map && report
          ? {
              levelName: map.levelName,
              version: map.version,
              needsUpgrade: map.needsUpgrade,
              gameMode: map.gameMode,
              sizeMb: Math.round(map.worldBytes / 1024 / 1024),
              source: report.source.kind === "url" ? report.source.url : `uploaded ${report.source.filename}`,
              warnings: report.warnings,
            }
          : undefined,
      crossplay: this.crossplay(request, map),
      result: r.result ? (JSON.parse(r.result) as ProposalView["result"]) : undefined,
    };
  }

  async proposeWorldFromMap(raw: unknown, by: string): Promise<ProposalView> {
    const request = WorldFromMap.parse(raw);
    const report = await this.worlds.worker.getMap(request.mapId);
    const map = report.worlds.find((w) => w.root === request.root);
    if (!map) throw new Error(`Import ${request.mapId} has no world at "${request.root}". Worlds in it: ${report.worlds.map((w) => JSON.stringify(w.root)).join(", ")}`);
    if (this.worlds.row(request.slug)) throw new Error(`A world called "${request.slug}" already exists.`);
    const clash = (this.db.prepare("SELECT payload FROM proposals WHERE status IN ('pending','building')").all() as { payload: string }[]).some(
      (p) => (JSON.parse(p.payload) as WorldFromMap).slug === request.slug,
    );
    if (clash) throw new Error(`Another proposal already uses the name "${request.slug}".`);
    const title = `New world: ${request.name}`;
    const id = Number(
      this.db
        .prepare("INSERT INTO proposals (kind, title, payload, created_by, created_at) VALUES ('world_from_map', ?, ?, ?, ?)")
        .run(title, JSON.stringify(request), by, Date.now()).lastInsertRowid,
    );
    audit(this.db, "proposal_created", { id, kind: "world_from_map", slug: request.slug, map: request.mapId, by });
    // The owner's own "Make a world" is already on their screen; only Claude's ideas need a nudge.
    if (!by.startsWith("owner")) {
      await this.push
        .notify({ title: "Claude has a world for you to review", body: `${request.name}, from the map "${map.levelName}". Tap to approve or decline.`, url: "/#proposals", tag: `proposal-${id}` })
        .catch(() => 0);
    }
    return this.view(this.row(id));
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

  async decline(id: number): Promise<ProposalView> {
    const r = this.row(id);
    if (r.status !== "pending") throw new Error(`Proposal #${id} is already ${r.status}.`);
    this.db.prepare("UPDATE proposals SET status = 'declined', decided_at = ? WHERE id = ?").run(Date.now(), id);
    audit(this.db, "proposal_declined", { id });
    return this.get(id);
  }

  /** Owner approval: checks the crossplay answers, then builds the world. */
  async approve(id: number, rawAnswers: unknown, opts: { wait?: boolean } = {}): Promise<ProposalView> {
    const answers = CrossplayAnswers.parse(rawAnswers ?? {});
    const r = this.row(id);
    if (r.status !== "pending") throw new Error(`Proposal #${id} is already ${r.status}.`);
    const request = WorldFromMap.parse(JSON.parse(r.payload));
    const report = await this.worlds.worker.getMap(request.mapId);
    const map = report.worlds.find((w) => w.root === request.root);
    const check = this.crossplay(request, map, answers);
    if (check.status === "needs_input") throw new Error(`Answer first: ${check.questions.map((q) => q.prompt).join(" ")}`);
    if (check.status === "conflicts") throw new Error(`Doesn't fit your Bedrock priorities: ${check.conflicts.map((c) => `${c.name}: ${c.problem}`).join("; ")}`);
    const claimed = this.db.prepare("UPDATE proposals SET status = 'building', decided_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), id);
    if (claimed.changes !== 1) throw new Error(`Proposal #${id} was decided elsewhere.`);
    const bedrock = (answers.bedrockPlayers ?? request.bedrock) === "yes";
    const build = async (): Promise<void> => {
      let slug: string | undefined;
      try {
        const world = await this.worlds.createFromMap(report, request.root, {
          slug: request.slug,
          name: request.name,
          bedrock,
          gamemode: request.gamemode,
          difficulty: request.difficulty,
        });
        slug = world.slug;
        // Old maps: convert every chunk now, so the world is ready (and Claude can see it) right away.
        await this.worlds.runUpgradeBoot(world.slug);
        this.db.prepare("UPDATE proposals SET status = 'approved', result = ? WHERE id = ?").run(JSON.stringify({ slug: world.slug }), id);
        audit(this.db, "proposal_approved", { id, slug: world.slug, bedrock, textures: answers.textures ?? null, behavior: answers.behavior ?? null });
      } catch (err) {
        const error = slug ? `${request.name} was created, but: ${(err as Error).message}` : (err as Error).message;
        this.db.prepare("UPDATE proposals SET status = 'failed', result = ? WHERE id = ?").run(JSON.stringify({ slug, error }), id);
        audit(this.db, "proposal_failed", { id, error });
      }
    };
    // The portal doesn't wait (old maps take minutes to upgrade); it shows "Building…" until done.
    if (opts.wait === false) void build();
    else await build();
    return this.get(id);
  }
}
