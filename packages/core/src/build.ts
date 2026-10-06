// BuildScript: what Claude writes to set up areas in a world (lobbies, arenas, chests, signs,
// command blocks, teleport pads…). It compiles to plain vanilla commands, so it works on any
// server type and is Bedrock-safe. Everything is validated against the world's exact version first.

import { z } from "zod";
import { checkBlockState, checkGamerule, type McVersionData } from "@worldsmith/mcdata";
import { buildStructure, STRUCTURE_DIR, STRUCTURE_NAMESPACE, structureHash, StructureError, voxelBlocks } from "@worldsmith/mcworld";

const Vec = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
type Vec = z.infer<typeof Vec>;

const Block = z.string().min(1).max(300).describe("Block state, e.g. smooth_stone or oak_stairs[facing=north]");
const Facing = z.enum(["north", "south", "east", "west"]);

const TextLine = z.union([
  z.string().max(90),
  z.object({ text: z.string().max(90), color: z.string().max(20).optional(), bold: z.boolean().optional(), italic: z.boolean().optional() }),
]);

const Item = z.object({
  id: z.string().regex(/^(minecraft:)?[a-z0-9_]+$/),
  count: z.number().int().min(1).max(99).default(1),
  slot: z.number().int().min(0).max(26).optional(),
});

/** Template names in the library (save_template), e.g. "spawn-lobby". */
export const TemplateName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "lowercase letters, digits, - and _");

export const BuildOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("fill"),
    from: Vec,
    to: Vec,
    block: Block,
    mode: z.enum(["replace", "hollow", "outline", "keep", "destroy"]).default("replace").describe("hollow = walls/floor/roof with air inside"),
  }),
  z.object({ op: z.literal("set"), at: Vec, block: Block, nbt: z.string().max(2000).optional().describe("Raw SNBT block entity data (advanced)") }),
  z.object({
    op: z.literal("chest"),
    at: Vec,
    kind: z.enum(["chest", "trapped_chest", "barrel"]).default("chest"),
    facing: Facing.default("north"),
    items: z.array(Item).max(27).default([]),
    loot: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).optional().describe("Loot table id, e.g. minecraft:chests/simple_dungeon"),
    name: z.string().max(40).optional(),
  }),
  z.object({
    op: z.literal("sign"),
    at: Vec,
    wood: z.enum(["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "bamboo", "crimson", "warped", "pale_oak"]).default("oak"),
    wall: z.boolean().default(false).describe("Wall sign (needs a block behind it) instead of a standing sign"),
    facing: Facing.default("south").describe("Direction the text faces"),
    lines: z.array(TextLine).min(1).max(4),
    color: z.string().max(20).default("black"),
    glowing: z.boolean().default(false),
  }),
  z.object({
    op: z.literal("command_block"),
    at: Vec,
    kind: z.enum(["impulse", "repeating", "chain"]).default("impulse"),
    facing: z.enum(["north", "south", "east", "west", "up", "down"]).default("up"),
    command: z.string().min(1).max(1000),
    alwaysActive: z.boolean().default(false).describe("true = runs without redstone (needed for chain blocks)"),
    conditional: z.boolean().default(false),
  }),
  z.object({
    op: z.literal("teleport_pad"),
    at: Vec.describe("Where the pressure plate goes; a hidden command block is placed under it"),
    to: Vec.describe("Destination, relative to the origin like everything else"),
    plate: z.string().default("stone_pressure_plate"),
    message: z.string().max(60).optional(),
  }),
  z.object({ op: z.literal("structure"), id: z.string().regex(/^[a-z0-9_]+:[a-z0-9_/]+$/), at: Vec.describe("Vanilla structure, e.g. minecraft:village_plains") }),
  z.object({ op: z.literal("feature"), id: z.string().regex(/^[a-z0-9_]+:[a-z0-9_/]+$/), at: Vec.describe("Placed feature, e.g. minecraft:oak") }),
  z.object({
    op: z.literal("summon"),
    entity: z.string().regex(/^(minecraft:)?[a-z0-9_]+$/),
    at: Vec,
    nbt: z.string().max(2000).optional(),
  }),
  z.object({ op: z.literal("spawnpoint"), at: Vec }),
  z.object({ op: z.literal("gamerule"), rule: z.string().max(64), value: z.union([z.boolean(), z.number().int()]) }),
  z.object({ op: z.literal("command"), run: z.string().min(1).max(1400).describe("Any other console command, run as-is (no leading slash)") }),
  z.object({
    op: z.literal("template"),
    name: TemplateName.describe("A saved template (see list_templates)"),
    at: Vec.describe("Where the template's corner (its lowest north-west block before rotating) goes"),
    rotation: z.enum(["none", "clockwise_90", "180", "counterclockwise_90"]).default("none"),
    mirror: z.enum(["none", "left_right", "front_back"]).default("none"),
  }),
  z.object({
    op: z.literal("voxels"),
    at: Vec.describe("Lowest north-west corner of the drawing"),
    legend: z.record(z.string().length(1), Block).describe('Character → block state, e.g. {"#": "stone_bricks", "D": "oak_door[facing=south,half=lower]"}'),
    layers: z
      .array(z.array(z.string().max(96)).max(96))
      .min(1)
      .max(96)
      .describe("Bottom layer first; each layer lists rows from north to south; each character is one block from west to east. Space or . leaves the world's block as it is."),
  }),
]);
export type BuildOp = z.infer<typeof BuildOp>;

export const BuildScript = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).describe("Short id, e.g. spawn-lobby"),
  origin: Vec.describe("Absolute world position all op coordinates are relative to"),
  ops: z.array(BuildOp).min(1).max(2000),
});
export type BuildScript = z.infer<typeof BuildScript>;

export interface CompiledBuild {
  commands: string[];
  /** Structure files to put into the world before the commands run (voxel drawings). */
  files: { path: string; base64: string }[];
  /** Library templates the commands place (they must be installed in the world first). */
  templates: string[];
  /** Absolute bounding box of everything placed (for forceloading). */
  bounds: { min: Vec; max: Vec } | undefined;
  /** Problems that stop the build (nothing runs). */
  errors: string[];
}

/** Vanilla's default max_block_modifications (26.x name of commandModificationBlockLimit). */
const FILL_LIMIT = 32768;
const RCON_MAX = 1446;

/** SNBT double-quoted string. */
export function snbtString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function textComponent(line: z.infer<typeof TextLine>): string {
  if (typeof line === "string") return snbtString(line);
  const parts = [`text:${snbtString(line.text)}`];
  if (line.color) parts.push(`color:${snbtString(line.color)}`);
  if (line.bold) parts.push("bold:1b");
  if (line.italic) parts.push("italic:1b");
  return `{${parts.join(",")}}`;
}

const ROTATION: Record<string, number> = { south: 0, west: 4, north: 8, east: 12 };
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const pos = (v: Vec): string => v.join(" ");
const ns = (id: string): string => (id.includes(":") ? id : `minecraft:${id}`);

/** Split a fill into pieces under the per-command block limit, slicing along the longest axis. */
function splitFill(a: Vec, b: Vec): [Vec, Vec][] {
  const min: Vec = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const max: Vec = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  const size = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
  if (size[0]! * size[1]! * size[2]! <= FILL_LIMIT) return [[min, max]];
  const axis = size.indexOf(Math.max(...size));
  const slab = size.reduce((p, s, i) => (i === axis ? p : p * s), 1);
  const step = Math.max(1, Math.floor(FILL_LIMIT / slab));
  const out: [Vec, Vec][] = [];
  for (let start = min[axis]!; start <= max[axis]!; start += step) {
    const lo = [...min] as Vec;
    const hi = [...max] as Vec;
    lo[axis] = start;
    hi[axis] = Math.min(max[axis]!, start + step - 1);
    out.push([lo, hi]);
  }
  return out;
}

export interface CompileOptions {
  /** Library templates: name → in-world id (worldsmith:<name>_<hash>) and size. */
  templates?: Map<string, { id: string; size: Vec }>;
}

/** Compile a BuildScript to console commands. Pure: no I/O. */
export function compileBuild(script: BuildScript, data?: McVersionData, opts: CompileOptions = {}): CompiledBuild {
  const commands: string[] = [];
  const files: CompiledBuild["files"] = [];
  const templates: string[] = [];
  const errors: string[] = [];
  const points: Vec[] = [];
  const at = (v: Vec): Vec => {
    const p = add(script.origin, v);
    points.push(p);
    return p;
  };
  const block = (state: string, where: string): string => {
    const s = state.trim().replace(/^minecraft:/, "");
    if (data) for (const issue of checkBlockState(data, s)) errors.push(`${where}: ${issue.error}${issue.suggestions.length ? ` Valid: ${issue.suggestions.slice(0, 6).join(", ")}` : ""}`);
    return ns(s);
  };

  script.ops.forEach((op, i) => {
    const where = `op ${i + 1} (${op.op})`;
    switch (op.op) {
      case "fill": {
        const b = block(op.block, where);
        // hollow/outline need the whole box in one command; replace/keep/destroy can be split.
        const pieces = op.mode === "hollow" || op.mode === "outline" ? [[op.from, op.to] as [Vec, Vec]] : splitFill(op.from, op.to);
        for (const [f, t] of pieces) commands.push(`fill ${pos(at(f))} ${pos(at(t))} ${b} ${op.mode}`);
        break;
      }
      case "set":
        commands.push(`setblock ${pos(at(op.at))} ${block(op.block, where)}${op.nbt ?? ""}`);
        break;
      case "chest": {
        const b = block(`${op.kind}${op.kind === "barrel" ? "[facing=up]" : `[facing=${op.facing}]`}`, where);
        const parts: string[] = [];
        if (op.items.length) {
          parts.push(`Items:[${op.items.map((it, n) => `{Slot:${it.slot ?? n}b,id:${snbtString(ns(it.id))},count:${it.count}}`).join(",")}]`);
        }
        if (op.loot) parts.push(`LootTable:${snbtString(op.loot)}`);
        if (op.name) parts.push(`CustomName:${textComponent(op.name)}`);
        commands.push(`setblock ${pos(at(op.at))} ${b}${parts.length ? `{${parts.join(",")}}` : ""}`);
        break;
      }
      case "sign": {
        const state = op.wall ? `${op.wood}_wall_sign[facing=${op.facing}]` : `${op.wood}_sign[rotation=${ROTATION[op.facing]}]`;
        const lines = [...op.lines, "", "", "", ""].slice(0, 4).map(textComponent);
        const nbt = `{front_text:{messages:[${lines.join(",")}],color:${snbtString(op.color)},has_glowing_text:${op.glowing ? 1 : 0}b},is_waxed:1b}`;
        commands.push(`setblock ${pos(at(op.at))} ${block(state, where)}${nbt}`);
        break;
      }
      case "command_block": {
        const id = op.kind === "impulse" ? "command_block" : `${op.kind}_command_block`;
        const b = block(`${id}[facing=${op.facing},conditional=${op.conditional}]`, where);
        const auto = op.alwaysActive || op.kind === "chain" ? 1 : 0;
        commands.push(`setblock ${pos(at(op.at))} ${b}{Command:${snbtString(op.command)},auto:${auto}b,TrackOutput:1b}`);
        break;
      }
      case "teleport_pad": {
        const plate = block(op.plate, where);
        const dest = add(script.origin, op.to);
        // Message first (it must target the player before they're teleported away), then the teleport.
        // The plate powers the impulse block under it; a chain block below runs right after it, in the
        // same tick, because the impulse block faces down into it.
        const tp = `tp @p[distance=..2] ${pos(dest)}`;
        const first = op.message ? `title @p[distance=..2] actionbar ${textComponent(op.message)}` : tp;
        commands.push(
          `setblock ${pos(at(op.at))} ${block(`command_block[facing=${op.message ? "down" : "up"}]`, where)}{Command:${snbtString(first)},auto:0b,TrackOutput:1b}`,
        );
        if (op.message) {
          commands.push(`setblock ${pos(at(add(op.at, [0, -1, 0])))} ${block("chain_command_block[facing=down]", where)}{Command:${snbtString(tp)},auto:1b,TrackOutput:0b}`);
        }
        commands.push(`setblock ${pos(at(add(op.at, [0, 1, 0])))} ${plate}`);
        break;
      }
      case "structure":
        commands.push(`place structure ${op.id} ${pos(at(op.at))}`);
        break;
      case "feature":
        commands.push(`place feature ${op.id} ${pos(at(op.at))}`);
        break;
      case "summon":
        commands.push(`summon ${ns(op.entity)} ${pos(at(op.at))}${op.nbt ? ` ${op.nbt}` : ""}`);
        break;
      case "spawnpoint":
        commands.push(`setworldspawn ${pos(at(op.at))}`);
        break;
      case "gamerule": {
        if (data) {
          const r = checkGamerule(data, op.rule);
          if (!r.ok) errors.push(`${where}: ${r.error}${r.suggestions.length ? ` Did you mean ${r.suggestions.join(", ")}?` : ""}`);
          else commands.push(`gamerule ${r.name} ${r.note === "inverted" && typeof op.value === "boolean" ? !op.value : op.value}`);
        } else commands.push(`gamerule ${op.rule} ${op.value}`);
        break;
      }
      case "template": {
        const t = opts.templates?.get(op.name);
        if (!t) {
          errors.push(`${where}: no template called "${op.name}"${opts.templates?.size ? `. Saved templates: ${[...opts.templates.keys()].slice(0, 12).join(", ")}` : " (save one with save_template)"}`);
          break;
        }
        const p = at(op.at);
        // Rotation turns the template around its corner; cover every way it can swing for loading.
        const reach = Math.max(t.size[0], t.size[2]);
        at([op.at[0] - reach, op.at[1], op.at[2] - reach]);
        at([op.at[0] + reach, op.at[1] + t.size[1] - 1, op.at[2] + reach]);
        if (!templates.includes(op.name)) templates.push(op.name);
        commands.push(`place template ${t.id} ${pos(p)} ${op.rotation} ${op.mirror}`);
        break;
      }
      case "voxels": {
        const legend: Record<string, string> = {};
        for (const [ch, state] of Object.entries(op.legend)) legend[ch] = block(state, `${where} legend "${ch}"`);
        try {
          const { size, blocks } = voxelBlocks(op.layers, legend);
          const data2 = buildStructure(size, blocks, data?.dataVersion ?? 4903);
          const name = `build_${structureHash(data2)}`;
          if (!files.some((f) => f.path.endsWith(`/${name}.nbt`))) files.push({ path: `${STRUCTURE_DIR}/${name}.nbt`, base64: data2.toString("base64") });
          const p = at(op.at);
          at([op.at[0] + size[0] - 1, op.at[1] + size[1] - 1, op.at[2] + size[2] - 1]);
          commands.push(`place template ${STRUCTURE_NAMESPACE}:${name} ${pos(p)}`);
        } catch (err) {
          if (err instanceof StructureError) errors.push(`${where}: ${err.message}`);
          else throw err;
        }
        break;
      }
      case "command":
        if (/^\/?(whitelist|op|deop|pardon|stop|restart|ban)\b/i.test(op.run.trim())) {
          errors.push(`${where}: "${op.run.split(" ")[0]}" isn't allowed in builds (access and server control stay with the owner).`);
        } else commands.push(op.run.trim().replace(/^\//, ""));
        break;
    }
  });

  for (const c of commands) {
    if (Buffer.byteLength(c) > RCON_MAX) errors.push(`A command is ${Buffer.byteLength(c)} bytes (max ${RCON_MAX}); shorten it or split it: ${c.slice(0, 80)}…`);
  }
  const bounds = points.length
    ? {
        min: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.min(...points.map((p) => p[2]))] as Vec,
        max: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1])), Math.max(...points.map((p) => p[2]))] as Vec,
      }
    : undefined;
  return { commands, files, templates, bounds, errors };
}
