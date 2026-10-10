// Running BuildScripts against a live world: wake it, back it up, load the area, run the compiled
// commands, classify every result, and report. The backup is the undo button (portal restore).

import { BuildScript, compileBuild, WorldSpec } from "@worldsmith/core";
import { loadVersion } from "@worldsmith/mcdata";
import { audit } from "./db.ts";
import type { WorldService } from "./worlds.ts";

export interface BuildReport {
  ok: boolean;
  world: string;
  name: string;
  /** Problems found before anything ran (nothing was changed). */
  errors?: string[];
  commands?: number;
  changed?: number;
  unchanged?: number;
  failed?: { command: string; output: string }[];
  backup?: string;
  notes?: string[];
}

const BATCH = 40;
const MAX_CHUNKS = 256;
const UNCHANGED = /^(Could not set the block|No blocks were filled|Nothing changed)/i;
const FAILED = /(There is no template|Incorrect argument|Unknown or incomplete|Unknown (block|item|entity)|Invalid|Expected|not loaded|out of the world|Failed to|Can't|Cannot|Unable to|Unknown command)/i;

export class BuildService {
  worlds: WorldService;

  constructor(worlds: WorldService) {
    this.worlds = worlds;
  }

  async ensureOnline(slug: string, timeoutMs = 150_000): Promise<void> {
    let view = await this.worlds.view(slug, true);
    if (view.state === "online") return;
    if (view.state === "asleep") await this.worlds.start(slug, "build");
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      view = await this.worlds.view(slug, true);
      if (view.state === "online") return;
      if (view.state === "error" || view.state === "missing") break;
    }
    throw new Error(`${view.name} didn't come online (state: ${view.state}).`);
  }

  /** Turn command blocks on (server property → needs a restart). */
  async enableCommandBlocks(slug: string): Promise<void> {
    const spec = this.worlds.spec(slug);
    const next = WorldSpec.parse({ ...spec, properties: { ...spec.properties, enableCommandBlock: true } });
    this.worlds.db.prepare("UPDATE worlds SET spec = ? WHERE slug = ?").run(JSON.stringify(next), slug);
    const s = await this.worlds.worker.status(slug);
    if (s.container === "running") await this.worlds.stop(slug, "enable command blocks");
    await this.worlds.reapply(slug);
    audit(this.worlds.db, "world_command_blocks_enabled", { slug });
  }

  async run(slug: string, raw: unknown, opts: { allowRestart?: boolean; by?: string } = {}): Promise<BuildReport> {
    const script = BuildScript.parse(raw);
    const spec = this.worlds.spec(slug);
    const library = script.ops.some((o) => o.op === "template") ? await this.worlds.worker.listTemplates() : [];
    const compiled = compileBuild(script, loadVersion(spec.minecraft.version), {
      templates: new Map(library.map((t) => [t.name, { id: t.id, size: t.size }])),
    });
    const base = { world: slug, name: script.name };
    if (compiled.errors.length) return { ok: false, ...base, errors: compiled.errors };
    const notes: string[] = [];

    const needsCommandBlocks = script.ops.some((o) => o.op === "command_block" || o.op === "teleport_pad" || o.op === "hunger_games" || o.op === "lucky_bosses");
    if (needsCommandBlocks && !spec.properties.enableCommandBlock) {
      const view = await this.worlds.view(slug, true);
      if (view.state === "online" && view.players.online > 0 && !opts.allowRestart) {
        return {
          ok: false,
          ...base,
          errors: [
            `Command blocks are off in ${spec.name}. Turning them on restarts the world, and ${view.players.online} player(s) are online. Ask first, then retry with allowRestart: true.`,
          ],
        };
      }
      await this.enableCommandBlocks(slug);
      notes.push("Turned on command blocks (the world restarted).");
    }

    await this.ensureOnline(slug);
    const backup = await this.worlds.backup(slug, `before-${script.name}`.slice(0, 32));

    const b = compiled.bounds;
    let area: string | undefined;
    if (b) {
      const chunks = (Math.floor(b.max[0] / 16) - Math.floor(b.min[0] / 16) + 1) * (Math.floor(b.max[2] / 16) - Math.floor(b.min[2] / 16) + 1);
      if (chunks > MAX_CHUNKS) {
        return { ok: false, ...base, errors: [`The build spans ${chunks} chunks; split it into parts of at most ${MAX_CHUNKS} chunks.`] };
      }
      area = `${b.min[0]} ${b.min[2]} ${b.max[0]} ${b.max[2]}`;
    }

    // Structure files first: library templates this build places, and voxel drawings.
    if (compiled.templates.length) await this.worlds.worker.installTemplates(slug, compiled.templates);
    if (compiled.files.length) {
      await this.worlds.worker.putFiles(
        slug,
        compiled.files.map((f) => ({ kind: "inline" as const, encoding: "base64" as const, path: f.path, content: f.base64 })),
      );
    }

    const failed: { command: string; output: string }[] = [];
    let changed = 0;
    let unchanged = 0;
    try {
      if (area) {
        await this.worlds.worker.rcon(slug, [`forceload add ${area}`]);
        // Chunks load in the background; give a big area a moment before placing blocks in it.
        const chunks = (Math.floor(b!.max[0] / 16) - Math.floor(b!.min[0] / 16) + 1) * (Math.floor(b!.max[2] / 16) - Math.floor(b!.min[2] / 16) + 1);
        if (chunks > 9) await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 + chunks * 40)));
      }
      for (let i = 0; i < compiled.commands.length; i += BATCH) {
        const batch = compiled.commands.slice(i, i + BATCH);
        const outputs = await this.worlds.worker.rcon(slug, batch);
        batch.forEach((command, j) => {
          const output = (outputs[j] ?? "").replace(/§./g, "").trim();
          if (UNCHANGED.test(output)) unchanged++;
          else if (FAILED.test(output)) failed.push({ command, output: output.slice(0, 300) });
          else changed++;
        });
      }
    } finally {
      if (area) await this.worlds.worker.rcon(slug, [`forceload remove ${area}`]).catch(() => undefined);
    }

    audit(this.worlds.db, "world_built", { slug, name: script.name, by: opts.by, commands: compiled.commands.length, failed: failed.length, backup: backup.id });
    return {
      ok: failed.length === 0,
      ...base,
      commands: compiled.commands.length,
      changed,
      unchanged,
      failed,
      backup: backup.id,
      notes: [...notes, `Backup ${backup.id} was taken first; restore it in the portal to undo.`],
    };
  }
}
