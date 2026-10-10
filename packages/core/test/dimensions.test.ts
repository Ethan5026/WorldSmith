import { test } from "node:test";
import assert from "node:assert/strict";
import { DIMENSION_DIRS, worldDatapack, WorldSpec } from "../src/index.ts";

const spec = (dimensions?: unknown) =>
  WorldSpec.parse({ slug: "sky", name: "Sky", minecraft: { version: "26.2", protocol: 776, type: "PAPER" }, memoryMb: 2048, properties: dimensions ? { dimensions } : {} });
const dimFile = (s: WorldSpec, d: string) => worldDatapack(s).find((f) => f.path === `world/datapacks/worldsmith/data/minecraft/dimension/${d}.json`);
const json = (f: ReturnType<typeof dimFile>) => JSON.parse(f && f.kind === "inline" ? f.content : "null");

test("dimensions: unset writes nothing (existing worlds keep vanilla generation)", () => {
  assert.equal(dimFile(spec(), "the_nether"), undefined);
  assert.equal(dimFile(spec(), "the_end"), undefined);
});

test("dimensions: a void Nether keeps fortresses and bastions; a void End is empty; the overworld is never defined", () => {
  const s = spec({ nether: "void", end: "void" });
  const nether = json(dimFile(s, "the_nether"));
  assert.equal(nether.type, "minecraft:the_nether");
  assert.equal(nether.generator.type, "minecraft:flat");
  assert.deepEqual(nether.generator.settings.layers, [{ block: "minecraft:air", height: 1 }]);
  assert.deepEqual(nether.generator.settings.structure_overrides, ["minecraft:nether_complexes"]);
  const end = json(dimFile(s, "the_end"));
  assert.equal(end.type, "minecraft:the_end");
  assert.deepEqual(end.generator.settings.structure_overrides, []);
  assert.ok(!worldDatapack(s).some((f) => f.path.includes("dimension/overworld")));
});

test("dimensions: switching back to normal writes the vanilla 26.2 definitions (a pack file can only be replaced)", () => {
  const s = spec({ nether: "normal", end: "normal" });
  assert.deepEqual(json(dimFile(s, "the_nether")).generator, {
    type: "minecraft:noise",
    settings: "minecraft:nether",
    biome_source: { type: "minecraft:multi_noise", preset: "minecraft:nether" },
  });
  assert.deepEqual(json(dimFile(s, "the_end")).generator, { type: "minecraft:noise", settings: "minecraft:end", biome_source: { type: "minecraft:the_end" } });
});

test("dimension resets only ever name Nether/End folders", () => {
  for (const dirs of Object.values(DIMENSION_DIRS)) for (const d of dirs) assert.doesNotMatch(d, /overworld|^world\/?$|\.\./);
});
