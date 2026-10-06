import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  NbtByte,
  NbtDouble,
  NbtList,
  TAG,
  blockColor,
  decodeChunk,
  encodePng,
  nbt,
  packLongs,
  readNbt,
  readRegionChunk,
  renderTopDown,
  writeNbt,
  type NbtCompound,
} from "../src/index.ts";

test("NBT round-trips every tag type (gzip and raw)", () => {
  const root: NbtCompound = {
    b: new NbtByte(-3),
    i: 123456,
    l: -9007199254740993n,
    d: new NbtDouble(1.5),
    s: "minecraft:stone ✓",
    list: new NbtList(TAG.String, ["a", "b"]),
    empty: new NbtList(TAG.End, []),
    nested: { ints: new Int32Array([1, -2]), longs: new BigInt64Array([5n, -6n]), bytes: new Int8Array([1, -1]) },
  };
  for (const gzip of [true, false]) {
    const back = readNbt(writeNbt(root, { name: "Data", gzip }));
    assert.equal(back.name, "Data");
    assert.equal(nbt.num(back.root.b), -3);
    assert.equal(back.root.i, 123456);
    assert.equal(back.root.l, -9007199254740993n);
    assert.equal(nbt.num(back.root.d), 1.5);
    assert.equal(back.root.s, "minecraft:stone ✓");
    assert.deepEqual(nbt.list(back.root.list), ["a", "b"]);
    const nested = nbt.compound(back.root.nested)!;
    assert.deepEqual([...(nested.ints as Int32Array)], [1, -2]);
    assert.deepEqual([...(nested.longs as BigInt64Array)], [5n, -6n]);
    assert.deepEqual([...(nested.bytes as Int8Array)], [1, -1]);
  }
});

test("NBT rejects truncated data", () => {
  const raw = writeNbt({ s: "hello" }, { gzip: false });
  assert.throws(() => readNbt(raw.subarray(0, raw.length - 3)), /ends early/);
});

test("packed longs round-trip, including the sign bit", () => {
  const values = Array.from({ length: 4096 }, (_, i) => (i * 7) % 16);
  const longs = packLongs(values, 4);
  const view = decodeChunk(
    chunkNbt(0, 0, [{ y: 0, palette: Array.from({ length: 16 }, (_, i) => `minecraft:b${i}`), data: longs }], new Array(256).fill(0)),
  );
  for (const i of [0, 1, 15, 16, 255, 4095]) {
    const x = i & 15, z = (i >> 4) & 15, y = i >> 8;
    assert.equal(view.blockAt(x, y, z), `minecraft:b${values[i]}`);
  }
});

/** A chunk with a grass floor at y=-61, a 3x3 stone_bricks platform at y=-60 under a glass roof at y=-57, plus water. */
function sampleChunk(cx: number, cz: number): NbtCompound {
  const palette = ["minecraft:air", "minecraft:grass_block", "minecraft:stone_bricks", "minecraft:water", "minecraft:glass"];
  const values = new Array(4096).fill(0);
  const heights = new Array(256).fill(0);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      values[(3 << 8) | (z << 4) | x] = x >= 12 ? 3 : 1; // y = -64 + 3 = -61
      heights[z * 16 + x] = 4; // top block y=-61 → value 4 above minY
      if (x >= 2 && x <= 4 && z >= 2 && z <= 4) {
        values[(4 << 8) | (z << 4) | x] = 2;
        values[(7 << 8) | (z << 4) | x] = 4;
        heights[z * 16 + x] = 8;
      }
    }
  }
  return chunkNbt(cx, cz, [{ y: -4, palette, data: packLongs(values, 4) }], heights);
}

function chunkNbt(cx: number, cz: number, sections: { y: number; palette: string[]; data: BigInt64Array }[], heights: number[]): NbtCompound {
  return {
    DataVersion: 4903,
    xPos: cx,
    zPos: cz,
    yPos: -4,
    Status: "minecraft:full",
    sections: new NbtList(
      TAG.Compound,
      sections.map((s) => ({
        Y: new NbtByte(s.y),
        block_states: { palette: new NbtList(TAG.Compound, s.palette.map((Name) => ({ Name }))), data: s.data },
      })),
    ),
    Heightmaps: { WORLD_SURFACE: packLongs(heights, 9) },
  };
}

function regionWith(chunks: Map<string, NbtCompound>): Buffer {
  const header = Buffer.alloc(8192);
  const bodies: Buffer[] = [];
  let sector = 2;
  for (const [key, root] of chunks) {
    const [cx, cz] = key.split(",").map(Number) as [number, number];
    const comp = deflateSync(writeNbt(root, { gzip: false }));
    const body = Buffer.alloc(Math.ceil((comp.length + 5) / 4096) * 4096);
    body.writeUInt32BE(comp.length + 1, 0);
    body[4] = 2;
    comp.copy(body, 5);
    header.writeUInt32BE((sector << 8) | (body.length / 4096), ((cx & 31) + (cz & 31) * 32) * 4);
    sector += body.length / 4096;
    bodies.push(body);
  }
  return Buffer.concat([header, ...bodies]);
}

test("region reader finds chunks and decodes blocks and the surface", () => {
  const region = regionWith(new Map([["1,2", sampleChunk(1, 2)]]));
  assert.equal(readRegionChunk(region, 0, 0), undefined);
  const view = decodeChunk(readRegionChunk(region, 1, 2)!);
  assert.equal(view.x, 1);
  assert.equal(view.minY, -64);
  assert.equal(view.surface![0], -61);
  assert.equal(view.surface![3 * 16 + 3], -57);
  assert.equal(view.blockAt(3, -60, 3), "minecraft:stone_bricks");
  assert.equal(view.blockAt(13, -61, 0), "minecraft:water");
  assert.equal(view.blockAt(0, 100, 0), "minecraft:air");
});

test("renderTopDown draws colors, relief and missing chunks", async () => {
  const region = regionWith(new Map([["0,0", sampleChunk(0, 0)]]));
  const result = await renderTopDown({
    x1: 0,
    z1: 0,
    x2: 19,
    z2: 15,
    scale: 2,
    loadRegion: async (rx, rz) => (rx === 0 && rz === 0 ? region : undefined),
    markers: [{ x: 3, z: 3 }],
  });
  assert.equal(result.width, 40);
  assert.equal(result.height, 32);
  assert.equal(result.png.subarray(1, 4).toString(), "PNG");
  assert.equal(result.stats.minY, -61);
  assert.equal(result.stats.maxY, -60);
  assert.equal(result.stats.missingChunks, 1); // chunk 1,0 isn't in the region
  const top = Object.fromEntries(result.stats.topBlocks);
  assert.equal(top.stone_bricks, 9);
  assert.equal(top.water, 64);
  assert.deepEqual(result.stats.seeThrough, [["glass", 9]]);
});

test("maxY cuts the world horizontally", async () => {
  const region = regionWith(new Map([["0,0", sampleChunk(0, 0)]]));
  const result = await renderTopDown({ x1: 0, z1: 0, x2: 15, z2: 15, maxY: -61, loadRegion: async () => region });
  const top = Object.fromEntries(result.stats.topBlocks);
  assert.equal(top.stone_bricks, undefined);
  assert.equal(top.grass_block, 192);
  assert.equal(result.stats.maxY, -61);
});

test("block colors: exact, dye and fallback rules", () => {
  assert.deepEqual(blockColor("minecraft:grass_block"), [109, 153, 48]);
  assert.deepEqual(blockColor("minecraft:light_blue_concrete"), [58, 175, 217]);
  assert.deepEqual(blockColor("minecraft:blue_wool"), [53, 57, 157]);
  assert.deepEqual(blockColor("minecraft:spruce_log[axis=y]"), [102, 81, 51]);
  assert.equal(blockColor("somemod:weird_thing").length, 3);
});

test("PNG encoder writes a valid header", () => {
  const png = encodePng(Buffer.alloc(4 * 4 * 4, 255), 4, 4);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 4);
});

test("chunks without a heightmap (fresh from --forceUpgrade) still get a surface", () => {
  const root = sampleChunk(0, 0);
  delete root.Heightmaps;
  const view = decodeChunk(root);
  assert.equal(view.surface![0], -61);
  assert.equal(view.surface![3 * 16 + 3], -57, "glass roof is the top block");
});
