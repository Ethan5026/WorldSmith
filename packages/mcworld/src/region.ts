// Region (.mca) files and the parts of a chunk the renderer needs: the surface heightmap and the
// block at any position (1.18+ chunk format: sections with palette + packed block_states).

import { gunzipSync, inflateSync } from "node:zlib";
import { nbt, readNbt, type NbtCompound } from "./nbt.ts";

export class RegionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegionError";
  }
}

/** Raw chunk NBT from a region file, or undefined if the chunk was never generated. */
export function readRegionChunk(region: Buffer, cx: number, cz: number): NbtCompound | undefined {
  if (region.length < 8192) return undefined;
  const index = ((cx & 31) + (cz & 31) * 32) * 4;
  const loc = region.readUInt32BE(index);
  const sector = loc >>> 8;
  if (sector === 0) return undefined;
  const at = sector * 4096;
  if (at + 5 > region.length) return undefined;
  const length = region.readUInt32BE(at);
  const type = region[at + 4]!;
  if (type & 0x80) return undefined; // oversized chunk stored in a separate .mcc file: skip
  const data = region.subarray(at + 5, at + 4 + length);
  let raw: Buffer;
  if (type === 1) raw = gunzipSync(data);
  else if (type === 2) raw = inflateSync(data);
  else if (type === 3) raw = Buffer.from(data);
  else throw new RegionError(`chunk compression type ${type} isn't supported (LZ4 or custom)`);
  return readNbt(raw).root;
}

interface Section {
  palette: string[];
  /** Full block states, e.g. "minecraft:oak_stairs[facing=north,half=bottom]" (same order as palette). */
  states: string[];
  data?: BigInt64Array;
  bits: number;
  /** Palette index per block (y*256 + z*16 + x), decoded on first use. */
  indexes?: Uint16Array;
}

export interface ChunkView {
  x: number;
  z: number;
  minY: number;
  /** Top non-air y per column (index z*16+x), from the WORLD_SURFACE heightmap; undefined if missing. */
  surface?: Int16Array;
  /** Chests, signs, command blocks… with absolute x/y/z. */
  blockEntities: NbtCompound[];
  /** Block name at chunk-local x/z and absolute y. */
  blockAt(x: number, y: number, z: number): string;
  /** Full block state ("name[prop=value,…]") at chunk-local x/z and absolute y. */
  stateAt(x: number, y: number, z: number): string;
}

function unpackAll(longs: BigInt64Array, bits: number, count: number): Uint16Array {
  const out = new Uint16Array(count);
  const perLong = Math.floor(64 / bits);
  const mask = (1 << bits) - 1;
  for (let w = 0, i = 0; w < longs.length && i < count; w++) {
    // Split each long into two 32-bit halves so the inner loop stays in fast integer math.
    const v = BigInt.asUintN(64, longs[w]!);
    const lo = Number(v & 0xffffffffn);
    const hi = Number(v >> 32n);
    for (let k = 0; k < perLong && i < count; k++, i++) {
      const shift = k * bits;
      let val: number;
      if (shift + bits <= 32) val = (lo >>> shift) & mask;
      else if (shift >= 32) val = (hi >>> (shift - 32)) & mask;
      else val = ((lo >>> shift) | (hi << (32 - shift))) & mask;
      out[i] = val;
    }
  }
  return out;
}

function unpack(longs: BigInt64Array, bits: number, index: number): number {
  const perLong = Math.floor(64 / bits);
  const word = longs[Math.floor(index / perLong)];
  if (word === undefined) return 0;
  const shift = BigInt((index % perLong) * bits);
  return Number((BigInt.asUintN(64, word) >> shift) & ((1n << BigInt(bits)) - 1n));
}

export function decodeChunk(root: NbtCompound): ChunkView {
  const cx = nbt.num(root.xPos) ?? 0;
  const cz = nbt.num(root.zPos) ?? 0;
  const minY = (nbt.num(root.yPos) ?? -4) * 16;
  const sections = new Map<number, Section>();
  for (const s of nbt.list(root.sections)) {
    const sec = nbt.compound(s);
    if (!sec) continue;
    const y = nbt.num(sec.Y);
    const states = nbt.compound(sec.block_states);
    if (y === undefined || !states) continue;
    const entries = nbt.list(states.palette).map((p) => nbt.compound(p));
    const palette = entries.map((p) => nbt.str(p?.Name) ?? "minecraft:air");
    const full = entries.map((p, i) => {
      const props = nbt.compound(p?.Properties);
      const kv = props ? Object.entries(props).map(([k, v]) => `${k}=${nbt.str(v) ?? ""}`) : [];
      return kv.length ? `${palette[i]}[${kv.join(",")}]` : palette[i]!;
    });
    sections.set(y, { palette, states: full, data: nbt.longs(states.data), bits: Math.max(4, Math.ceil(Math.log2(palette.length))) });
  }

  let surface: Int16Array | undefined;
  const hm = nbt.longs(nbt.compound(root.Heightmaps)?.WORLD_SURFACE);
  if (hm) {
    // Bits per value depend on world height (9 for 384); infer them from the array length,
    // since values never span two longs (1.16+).
    let bits = 9;
    for (let b = 1; b <= 16; b++) if (Math.ceil(256 / Math.floor(64 / b)) === hm.length) bits = b;
    surface = new Int16Array(256);
    for (let i = 0; i < 256; i++) surface[i] = minY + unpack(hm, bits, i) - 1;
  }

  const lookup = (x: number, y: number, z: number, which: "palette" | "states"): string => {
    const sec = sections.get(Math.floor(y / 16));
    if (!sec || sec.palette.length === 0) return "minecraft:air";
    const list = sec[which];
    if (!sec.data || list.length === 1) return list[0]!;
    sec.indexes ??= unpackAll(sec.data, sec.bits, 4096);
    return list[sec.indexes[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]!] ?? "minecraft:air";
  };

  if (!surface && sections.size) {
    // No heightmap (e.g. chunks converted by --forceUpgrade but not yet played): find each column's
    // top block from the blocks themselves, starting at the highest section that has any.
    const top = Math.max(...[...sections.entries()].filter(([, s]) => s.palette.some((p) => !/^minecraft:(air|cave_air|void_air)$/.test(p))).map(([y]) => y));
    if (Number.isFinite(top)) {
      surface = new Int16Array(256).fill(minY - 1);
      for (let i = 0; i < 256; i++) {
        const x = i & 15;
        const z = i >> 4;
        for (let y = top * 16 + 15; y >= minY; y--) {
          if (!/^minecraft:(air|cave_air|void_air)$/.test(lookup(x, y, z, "palette"))) {
            surface[i] = y;
            break;
          }
        }
      }
    }
  }

  return {
    x: cx,
    z: cz,
    minY,
    surface,
    blockEntities: nbt.list(root.block_entities).map((b) => nbt.compound(b)).filter((b): b is NbtCompound => b !== undefined),
    blockAt(x, y, z) {
      return lookup(x, y, z, "palette");
    },
    stateAt(x, y, z) {
      return lookup(x, y, z, "states");
    },
  };
}

/** Pack small integers into longs the way Minecraft does (for tests and generated data). */
export function packLongs(values: number[], bits: number): BigInt64Array {
  const perLong = Math.floor(64 / bits);
  const out = new BigInt64Array(Math.ceil(values.length / perLong));
  values.forEach((v, i) => {
    const w = Math.floor(i / perLong);
    const shifted = BigInt(v) << BigInt((i % perLong) * bits);
    out[w] = BigInt.asIntN(64, BigInt.asUintN(64, out[w]!) | shifted);
  });
  return out;
}

/** Where a dimension's region files live, newest layout first (26.x moved them under dimensions/). */
export function regionDirs(dimension: string): string[] {
  const id = dimension.includes(":") ? dimension : `minecraft:${dimension}`;
  const [ns, name] = id.split(":") as [string, string];
  const modern = `world/dimensions/${ns}/${name}/region`;
  if (id === "minecraft:overworld") return [modern, "world/region"];
  if (id === "minecraft:the_nether") return [modern, "world/DIM-1/region", "world_nether/DIM-1/region"];
  if (id === "minecraft:the_end") return [modern, "world/DIM1/region", "world_the_end/DIM1/region"];
  return [modern];
}
