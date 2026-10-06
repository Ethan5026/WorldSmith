// Top-down map of a world area as a PNG: block colors from above, with map-style relief shading
// (lighter where the ground rises to the north, darker where it falls), plus optional markers.
// Glass and similar blocks are tinted see-through so roofs don't hide what's inside; water is
// shaded by depth; maxY slices the world horizontally to show a building's floor plan.

import { deflateSync, crc32 } from "node:zlib";
import { blockColor, type RGB } from "./colors.ts";
import { decodeChunk, readRegionChunk, type ChunkView } from "./region.ts";
import { describeBlockEntity, type Feature } from "./features.ts";

export interface Marker {
  x: number;
  z: number;
  color?: RGB;
}

export interface RenderRequest {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /** Pixels per block (1–8). Default: as large as fits in ~768 px. */
  scale?: number;
  /** Load r.<rx>.<rz>.mca for the dimension being rendered, or undefined if it doesn't exist. */
  loadRegion: (rx: number, rz: number) => Promise<Buffer | undefined>;
  markers?: Marker[];
  /** Ignore everything above this y (a horizontal cut, e.g. just under a roof). */
  maxY?: number;
  /** Coordinate grid with labels (default on). */
  grid?: boolean;
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  scale: number;
  stats: { minY: number; maxY: number; missingChunks: number; topBlocks: [string, number][]; seeThrough: [string, number][] };
  /** Block entities in the area (chests with contents, sign text, command blocks…), at most 100. */
  features: Feature[];
  /** Block coordinate every grid line marks (0 if no grid). */
  gridStep: number;
}

const MAX_SPAN = 512;
const AIR = /^minecraft:(air|cave_air|void_air|light|structure_void|barrier)$/;
const SEE_THROUGH = /(^minecraft:(glass|glass_pane|tinted_glass|iron_bars|tripwire|string)$)|_stained_glass(_pane)?$/;
const WATER = /^minecraft:(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;

interface Column {
  y: number;
  block: string;
  /** Translucent blocks passed through on the way down (top first). */
  over: string[];
  waterDepth: number;
}

/** Walk down a column from its surface (or maxY) to the first block worth drawing. */
function walkColumn(c: ChunkView, lx: number, lz: number, maxY: number | undefined): Column | undefined {
  let y = c.surface![lz * 16 + lx]!;
  if (maxY !== undefined && y > maxY) y = maxY;
  const over: string[] = [];
  let waterDepth = 0;
  for (; y >= c.minY; y--) {
    const id = c.blockAt(lx, y, lz);
    if (waterDepth && !WATER.test(id)) {
      // The bottom of the water: draw the floor through it (or plain water over a void).
      return { y: y + waterDepth, block: AIR.test(id) ? "minecraft:water" : id, over, waterDepth };
    }
    if (AIR.test(id)) continue;
    if (SEE_THROUGH.test(id)) {
      if (over.length < 4) over.push(id);
      continue;
    }
    if (WATER.test(id)) {
      if (++waterDepth < 24) continue;
      return { y: y + waterDepth - 1, block: "minecraft:water", over, waterDepth };
    }
    return { y, block: id, over, waterDepth };
  }
  return waterDepth ? { y: y + waterDepth, block: "minecraft:water", over, waterDepth } : undefined;
}

export async function renderTopDown(req: RenderRequest): Promise<RenderResult> {
  const x1 = Math.min(req.x1, req.x2);
  const x2 = Math.max(req.x1, req.x2);
  const z1 = Math.min(req.z1, req.z2);
  const z2 = Math.max(req.z1, req.z2);
  const w = x2 - x1 + 1;
  const h = z2 - z1 + 1;
  if (w > MAX_SPAN || h > MAX_SPAN) throw new Error(`Area is ${w}×${h}; render at most ${MAX_SPAN}×${MAX_SPAN} blocks at a time.`);
  const scale = Math.max(1, Math.min(8, req.scale ?? (Math.floor(768 / Math.max(w, h)) || 1)));

  const regions = new Map<string, Promise<Buffer | undefined>>();
  const chunks = new Map<string, ChunkView | null>();
  let missing = 0;
  const chunkAt = async (cx: number, cz: number): Promise<ChunkView | null> => {
    const key = `${cx},${cz}`;
    if (chunks.has(key)) return chunks.get(key)!;
    const rk = `${cx >> 5},${cz >> 5}`;
    if (!regions.has(rk)) regions.set(rk, req.loadRegion(cx >> 5, cz >> 5));
    const region = await regions.get(rk)!;
    let view: ChunkView | null = null;
    try {
      const raw = region ? readRegionChunk(region, cx, cz) : undefined;
      view = raw ? decodeChunk(raw) : null;
    } catch {
      view = null; // a chunk being rewritten while we read, or a format we can't decode
    }
    if (!view?.surface) missing++;
    chunks.set(key, view?.surface ? view : null);
    return chunks.get(key)!;
  };

  const features: Feature[] = [];
  // Heights and columns, one row of padding to the north for shading.
  const heights = new Int16Array(w * (h + 1)).fill(-32768);
  const columns: (Column | undefined)[] = new Array(w * h);
  for (let cz = z1 >> 4; cz <= z2 >> 4; cz++) {
    for (let cx = x1 >> 4; cx <= x2 >> 4; cx++) {
      const c = await chunkAt(cx, cz);
      if (!c?.surface) continue;
      for (const be of c.blockEntities) {
        const f = describeBlockEntity(be, (x, y, z) => c.blockAt(x - cx * 16, y, z - cz * 16));
        if (f && f.x >= x1 && f.x <= x2 && f.z >= z1 && f.z <= z2 && (req.maxY === undefined || f.y <= req.maxY)) features.push(f);
      }
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const x = cx * 16 + lx;
          const z = cz * 16 + lz;
          if (x < x1 || x > x2 || z < z1 - 1 || z > z2) continue;
          const col = walkColumn(c, lx, lz, req.maxY);
          if (!col) continue;
          heights[(z - z1 + 1) * w + (x - x1)] = col.y;
          if (z >= z1) columns[(z - z1) * w + (x - x1)] = col;
        }
      }
    }
  }

  const W = w * scale;
  const H = h * scale;
  const px = Buffer.alloc(W * H * 4);
  const counts = new Map<string, number>();
  const seen = new Map<string, number>();
  let minY = Infinity;
  let maxY = -Infinity;
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const y = heights[(z + 1) * w + x]!;
      const north = heights[z * w + x]!;
      let rgb: RGB;
      const col = columns[z * w + x];
      if (y === -32768 || !col) {
        rgb = (x + z) % 2 ? [40, 40, 44] : [52, 52, 56]; // not generated / not loaded
      } else {
        const id = col.waterDepth ? "minecraft:water" : col.block;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        for (const o of new Set(col.over)) seen.set(o, (seen.get(o) ?? 0) + 1);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        let base = blockColor(col.block);
        if (col.waterDepth) base = mix(base, blockColor("minecraft:water"), Math.min(0.92, 0.5 + col.waterDepth * 0.06));
        for (const o of [...col.over].reverse()) base = mix(base, blockColor(o), 0.3);
        const shade = north === -32768 || col.waterDepth ? 1 : y > north ? 1.12 : y < north ? 0.8 : 1;
        rgb = [base[0] * shade, base[1] * shade, base[2] * shade].map((v) => Math.max(0, Math.min(255, Math.round(v)))) as RGB;
      }
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((z * scale + dy) * W + (x * scale + dx)) * 4;
          px[i] = rgb[0];
          px[i + 1] = rgb[1];
          px[i + 2] = rgb[2];
          px[i + 3] = 255;
        }
      }
    }
  }
  const gridStep = req.grid === false ? 0 : niceStep(Math.max(w, h) / 6);
  if (gridStep) drawGrid(px, W, H, x1, z1, scale, gridStep);
  for (const m of req.markers ?? []) drawMarker(px, W, H, (m.x - x1) * scale + scale / 2, (m.z - z1) * scale + scale / 2, Math.max(3, scale * 2), m.color ?? [230, 40, 40]);

  return {
    png: encodePng(px, W, H),
    width: W,
    height: H,
    scale,
    stats: {
      minY: minY === Infinity ? 0 : minY,
      maxY: maxY === -Infinity ? 0 : maxY,
      missingChunks: missing,
      topBlocks: tally(counts),
      seeThrough: tally(seen),
    },
    features: features.sort((a, b) => a.z - b.z || a.x - b.x || b.y - a.y).slice(0, 100),
    gridStep,
  };
}

function tally(m: Map<string, number>): [string, number][] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, n]) => [id.replace(/^minecraft:/, ""), n]);
}

function niceStep(target: number): number {
  return [5, 10, 20, 25, 50, 100].find((s) => s >= target) ?? 100;
}

function shadePixel(px: Buffer, W: number, H: number, x: number, y: number, f: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = px[i]! * f;
  px[i + 1] = px[i + 1]! * f;
  px[i + 2] = px[i + 2]! * f;
}

/** Faint lines at multiples of step, labeled with their x (top edge) and z (left edge). */
function drawGrid(px: Buffer, W: number, H: number, x1: number, z1: number, scale: number, step: number): void {
  const first = (v: number) => Math.ceil(v / step) * step;
  let lastLabelEnd = -1;
  for (let x = first(x1); (x - x1) * scale < W; x += step) {
    const col = (x - x1) * scale;
    for (let y = 0; y < H; y++) if (y % 4 < 2) shadePixel(px, W, H, col, y, 0.6);
    if (col + 2 > lastLabelEnd && col + 2 + labelWidth(String(x)) <= W) lastLabelEnd = drawLabel(px, W, H, col + 2, 2, String(x));
  }
  let lastLabelBottom = 16; // keep clear of the x labels along the top
  for (let z = first(z1); (z - z1) * scale < H; z += step) {
    const row = (z - z1) * scale;
    for (let x = 0; x < W; x++) if (x % 4 < 2) shadePixel(px, W, H, x, row, 0.6);
    if (row + 2 > lastLabelBottom && row + 2 + 14 <= H) {
      drawLabel(px, W, H, 2, row + 2, String(z));
      lastLabelBottom = row + 2 + 14;
    }
  }
}

// 3x5 pixel digits (and minus), drawn at 2x so they stay legible.
const GLYPHS: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
  "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001001001001",
  "8": "111101111101111", "9": "111101111001111", "-": "000000111000000",
};

const labelWidth = (text: string) => text.length * 8 + 2;

/** Draw text on a dark backing box; returns the right edge in pixels. */
function drawLabel(px: Buffer, W: number, H: number, x: number, y: number, text: string): number {
  const P = 2;
  const width = labelWidth(text);
  for (let dy = 0; dy < 5 * P + 2 * P; dy++) for (let dx = 0; dx < width; dx++) shadePixel(px, W, H, x + dx, y + dy, 0.35);
  [...text].forEach((ch, n) => {
    const g = GLYPHS[ch];
    if (!g) return;
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (g[gy * 3 + gx] !== "1") continue;
        for (let sy = 0; sy < P; sy++) {
          for (let sx = 0; sx < P; sx++) {
            const ix = x + P + n * 4 * P + gx * P + sx;
            const iy = y + P + gy * P + sy;
            if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
            const i = (iy * W + ix) * 4;
            px[i] = 255;
            px[i + 1] = 255;
            px[i + 2] = 255;
          }
        }
      }
    }
  });
  return x + width;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function drawMarker(px: Buffer, W: number, H: number, cx: number, cy: number, r: number, rgb: RGB): void {
  for (let d = -r; d <= r; d++) {
    for (const [x, y] of [
      [cx + d, cy + d],
      [cx + d, cy - d],
    ]) {
      const ix = Math.round(x!);
      const iy = Math.round(y!);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
      const i = (iy * W + ix) * 4;
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
    }
  }
}

export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
