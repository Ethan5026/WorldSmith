import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { NbtByte, NbtList, TAG, buildStructure, captureStructure, nbt, packLongs, parseState, readNbt, structureHash, structureInfo, voxelBlocks, writeNbt, type NbtCompound } from "../src/index.ts";

test("block states parse into Name + Properties", () => {
  assert.deepEqual(parseState("oak_stairs[facing=north,half=top]"), { Name: "minecraft:oak_stairs", Properties: { facing: "north", half: "top" } });
  assert.deepEqual(parseState("mymod:thing"), { Name: "mymod:thing" });
  assert.throws(() => parseState("Bad Block!"), /Not a block state/);
});

test("structures encode the vanilla template layout and hash deterministically", () => {
  const data = buildStructure([2, 1, 1], [
    { pos: [0, 0, 0], state: "minecraft:stone" },
    { pos: [1, 0, 0], state: "minecraft:chest[facing=east]", nbt: { id: "minecraft:chest", Items: new NbtList(TAG.End, []) } },
  ], 4903);
  const { root } = readNbt(data);
  assert.equal(root.DataVersion, 4903);
  assert.deepEqual(nbt.list(root.size), [2, 1, 1]);
  assert.equal(nbt.list(root.palette).length, 2);
  const info = structureInfo(data);
  assert.equal(info.blocks, 2);
  assert.equal(info.blockEntities, 1);
  assert.equal(structureHash(data), structureHash(buildStructure([2, 1, 1], [{ pos: [0, 0, 0], state: "minecraft:stone" }, { pos: [1, 0, 0], state: "minecraft:chest[facing=east]", nbt: { id: "minecraft:chest", Items: new NbtList(TAG.End, []) } }], 4903)));
  assert.throws(() => buildStructure([1, 1, 1], [{ pos: [1, 0, 0], state: "minecraft:stone" }], 4903), /outside/);
});

test("voxel drawings: bottom layer first, rows north→south, characters west→east", () => {
  const { size, blocks } = voxelBlocks(
    [
      ["###", "#.#", "###"],
      ["G G", "   ", "G G"],
    ],
    { "#": "stone_bricks", G: "glass" },
  );
  assert.deepEqual(size, [3, 2, 3]);
  assert.equal(blocks.length, 8 + 4);
  assert.deepEqual(blocks.find((b) => b.pos[1] === 1 && b.pos[0] === 2 && b.pos[2] === 2)?.state, "minecraft:glass");
  assert.throws(() => voxelBlocks([["#X"]], { "#": "stone" }), /missing from the legend: "X"/);
});

test("capture copies exact states and block entities out of region files", async () => {
  const palette = ["minecraft:air", "minecraft:oak_stairs[facing=north,half=bottom]", "minecraft:chest[facing=south]"];
  const values = new Array(4096).fill(0);
  values[(0 << 8) | (2 << 4) | 1] = 1; // y=-64 (local 0), z=2, x=1
  values[(0 << 8) | (2 << 4) | 2] = 2;
  const chunk: NbtCompound = {
    DataVersion: 4903,
    xPos: 0,
    zPos: 0,
    yPos: -4,
    sections: new NbtList(TAG.Compound, [
      {
        Y: new NbtByte(-4),
        block_states: {
          palette: new NbtList(TAG.Compound, palette.map((s) => parseState(s))),
          data: packLongs(values, 4),
        },
      },
    ]),
    block_entities: new NbtList(TAG.Compound, [{ id: "minecraft:chest", x: 2, y: -64, z: 2, keepPacked: new NbtByte(0), CustomName: "Loot" }]),
    Heightmaps: {},
  };
  const header = Buffer.alloc(8192);
  const comp = deflateSync(writeNbt(chunk, { gzip: false }));
  const body = Buffer.alloc(Math.ceil((comp.length + 5) / 4096) * 4096);
  body.writeUInt32BE(comp.length + 1, 0);
  body[4] = 2;
  comp.copy(body, 5);
  header.writeUInt32BE((2 << 8) | (body.length / 4096), 0);
  const region = Buffer.concat([header, body]);

  const cap = await captureStructure(async () => region, [1, -64, 2], [2, -63, 2]);
  assert.deepEqual(cap.size, [2, 2, 1]);
  assert.equal(cap.missingChunks, 0);
  const stairs = cap.blocks.find((b) => b.pos[0] === 0 && b.pos[1] === 0)!;
  assert.equal(stairs.state, "minecraft:oak_stairs[facing=north,half=bottom]");
  const chest = cap.blocks.find((b) => b.pos[0] === 1 && b.pos[1] === 0)!;
  assert.deepEqual(chest.nbt, { id: "minecraft:chest", CustomName: "Loot" });
  assert.equal(cap.blocks.filter((b) => b.pos[1] === 1).every((b) => b.state === "minecraft:air"), true, "air is copied so pasting clears");
  await assert.rejects(captureStructure(async () => region, [0, 0, 0], [500, 100, 500]), /at most/);
});
