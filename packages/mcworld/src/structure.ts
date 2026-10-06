// Structure templates (.nbt): the format of structure blocks and `/place template`. WorldSmith makes
// them three ways: from a list of blocks, from a layer-by-layer drawing (voxels), or by copying a box
// out of a world's region files (exact block states plus chest/sign/command block contents).
//
// Minecraft 26.x loads them from world/generated/<namespace>/structure/<name>.nbt and caches a
// template once loaded, so the file name in a world always carries a content hash: re-saving a
// template gives a new id instead of a stale cached copy.

import { createHash } from "node:crypto";
import { NbtList, TAG, nbt, readNbt, writeNbt, type NbtCompound } from "./nbt.ts";
import { decodeChunk, readRegionChunk, type ChunkView } from "./region.ts";

export const STRUCTURE_NAMESPACE = "worldsmith";
/** Where /place template finds worldsmith:<name> in 26.x (note: singular "structure"). */
export const STRUCTURE_DIR = `world/generated/${STRUCTURE_NAMESPACE}/structure`;
/** Keep templates to a size that places in one go without straining the server. */
export const MAX_TEMPLATE_BLOCKS = 128 * 128 * 64;

export type Vec3 = [number, number, number];

export interface StructureBlock {
  pos: Vec3;
  /** Full block state, e.g. "minecraft:oak_stairs[facing=north]". */
  state: string;
  /** Block entity data (chest items, sign text…), without x/y/z. */
  nbt?: NbtCompound;
}

export class StructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructureError";
  }
}

const ints = (...v: number[]) => new NbtList(TAG.Int, v);

/** "oak_stairs[facing=north,half=bottom]" → { Name: "minecraft:oak_stairs", Properties: {...} } */
export function parseState(state: string): NbtCompound {
  const m = /^([a-z0-9_.-]+:)?([a-z0-9_./-]+)(?:\[(.*)\])?$/.exec(state.trim());
  if (!m) throw new StructureError(`Not a block state: ${state}`);
  const out: NbtCompound = { Name: `${m[1] ?? "minecraft:"}${m[2]}` };
  if (m[3]) {
    const props: NbtCompound = {};
    for (const kv of m[3].split(",").filter(Boolean)) {
      const [k, v] = kv.split("=").map((s) => s.trim());
      if (!k || v === undefined) throw new StructureError(`Bad property "${kv}" in ${state}`);
      props[k] = v;
    }
    out.Properties = props;
  }
  return out;
}

/** Encode a structure template. Positions are relative to the template's corner (0,0,0). */
export function buildStructure(size: Vec3, blocks: StructureBlock[], dataVersion: number): Buffer {
  const index = new Map<string, number>();
  const palette: NbtCompound[] = [];
  const out: NbtCompound[] = [];
  for (const b of blocks) {
    if (b.pos.some((v, i) => v < 0 || v >= size[i]!)) throw new StructureError(`Block at ${b.pos.join(",")} is outside the template size ${size.join("×")}`);
    let id = index.get(b.state);
    if (id === undefined) {
      id = palette.length;
      index.set(b.state, id);
      palette.push(parseState(b.state));
    }
    const entry: NbtCompound = { pos: ints(...b.pos), state: id };
    if (b.nbt) entry.nbt = b.nbt;
    out.push(entry);
  }
  return writeNbt({
    DataVersion: dataVersion,
    size: ints(...size),
    palette: new NbtList(TAG.Compound, palette),
    blocks: new NbtList(TAG.Compound, out),
    entities: new NbtList(TAG.End, []),
  });
}

export interface StructureInfo {
  size: Vec3;
  blocks: number;
  blockEntities: number;
  /** Most common blocks (name → count), air excluded. */
  top: [string, number][];
}

export function structureInfo(data: Buffer): StructureInfo {
  const { root } = readNbt(data);
  const size = nbt.list(root.size).map((v) => nbt.num(v) ?? 0);
  if (size.length !== 3) throw new StructureError("Not a structure template (no size)");
  const palette = nbt.list(root.palette).map((p) => nbt.str(nbt.compound(p)?.Name) ?? "?");
  const counts = new Map<string, number>();
  let blockEntities = 0;
  const blocks = nbt.list(root.blocks);
  for (const b of blocks) {
    const c = nbt.compound(b);
    const name = palette[nbt.num(c?.state) ?? -1] ?? "?";
    if (c?.nbt) blockEntities++;
    if (name !== "minecraft:air") counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return {
    size: size as Vec3,
    blocks: blocks.length,
    blockEntities,
    top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => [n.replace(/^minecraft:/, ""), c]),
  };
}

/** Short content hash used in in-world template ids. */
export function structureHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 10);
}

/**
 * Voxels: a build drawn as text. layers[0] is the bottom layer; each layer is a list of rows from
 * north (low z) to south; each character in a row is one block from west (low x) to east.
 * Space and "." leave whatever is in the world; every other character must be in the legend.
 */
export function voxelBlocks(layers: string[][], legend: Record<string, string>): { size: Vec3; blocks: StructureBlock[] } {
  const sizeY = layers.length;
  const sizeZ = Math.max(0, ...layers.map((l) => l.length));
  const sizeX = Math.max(0, ...layers.flatMap((l) => l.map((r) => r.length)));
  if (!sizeX || !sizeY || !sizeZ) throw new StructureError("The drawing is empty.");
  const blocks: StructureBlock[] = [];
  const unknown = new Set<string>();
  layers.forEach((layer, y) =>
    layer.forEach((row, z) =>
      [...row].forEach((ch, x) => {
        if (ch === " " || ch === ".") return;
        const state = legend[ch];
        if (!state) return void unknown.add(ch);
        blocks.push({ pos: [x, y, z], state: state.includes(":") ? state : `minecraft:${state}` });
      }),
    ),
  );
  if (unknown.size) throw new StructureError(`Characters missing from the legend: ${[...unknown].map((c) => JSON.stringify(c)).join(", ")}`);
  return { size: [sizeX, sizeY, sizeZ], blocks };
}

/** Copy a box (inclusive corners, absolute coordinates) out of a world's region files. */
export async function captureStructure(
  loadRegion: (rx: number, rz: number) => Promise<Buffer | undefined>,
  a: Vec3,
  b: Vec3,
): Promise<{ size: Vec3; blocks: StructureBlock[]; missingChunks: number }> {
  const min: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const max: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  const size: Vec3 = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
  if (size[0] * size[1] * size[2] > MAX_TEMPLATE_BLOCKS) {
    throw new StructureError(`That box is ${size.join("×")} blocks; templates hold at most ${MAX_TEMPLATE_BLOCKS} blocks. Save it in parts.`);
  }
  const regions = new Map<string, Promise<Buffer | undefined>>();
  const blocks: StructureBlock[] = [];
  let missingChunks = 0;
  for (let cz = min[2] >> 4; cz <= max[2] >> 4; cz++) {
    for (let cx = min[0] >> 4; cx <= max[0] >> 4; cx++) {
      const rk = `${cx >> 5},${cz >> 5}`;
      if (!regions.has(rk)) regions.set(rk, loadRegion(cx >> 5, cz >> 5));
      const region = await regions.get(rk)!;
      const raw = region ? readRegionChunk(region, cx, cz) : undefined;
      if (!raw) {
        missingChunks++;
        continue;
      }
      const chunk: ChunkView = decodeChunk(raw);
      const entities = new Map<string, NbtCompound>();
      for (const be of chunk.blockEntities) {
        const { x, y, z, ...rest } = be;
        entities.set(`${nbt.num(x)},${nbt.num(y)},${nbt.num(z)}`, rest as NbtCompound);
      }
      for (let y = min[1]; y <= max[1]; y++) {
        for (let z = Math.max(min[2], cz * 16); z <= Math.min(max[2], cz * 16 + 15); z++) {
          for (let x = Math.max(min[0], cx * 16); x <= Math.min(max[0], cx * 16 + 15); x++) {
            const state = chunk.stateAt(x - cx * 16, y, z - cz * 16);
            if (state === "minecraft:structure_void") continue;
            const be = entities.get(`${x},${y},${z}`);
            if (be) delete be.keepPacked;
            blocks.push({ pos: [x - min[0], y - min[1], z - min[2]], state, ...(be ? { nbt: be } : {}) });
          }
        }
      }
    }
  }
  return { size, blocks, missingChunks };
}
