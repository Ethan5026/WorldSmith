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
  assert.deepEqual(nether.generator.settings.structure_overrides, ["worldsmith:void_fortresses", "worldsmith:void_bastions"]);
  const fortresses = json(worldDatapack(s).find((f) => f.path.endsWith("worldgen/structure_set/void_fortresses.json")) as ReturnType<typeof dimFile>);
  assert.deepEqual(fortresses.structures, [{ structure: "minecraft:fortress", weight: 1 }]);
  // Worst case from any point to the nearest fortress start: the largest gap between starts on one axis
  // is (spacing + spacing - separation) chunks; half of that on both axes, in blocks.
  const { spacing, separation } = fortresses.placement;
  const half = ((2 * spacing - separation) * 16) / 2;
  assert.ok(Math.hypot(half, half) <= 200, `a fortress within 200 blocks of any portal (worst case ${Math.round(Math.hypot(half, half))})`);
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

test("dragon End: void with the End's own spires and platform, plus a one-time exit-portal anchor per End", () => {
  const s = spec({ end: "dragon", endGen: "abc123" });
  const end = json(dimFile(s, "the_end"));
  assert.equal(end.generator.type, "minecraft:flat");
  assert.equal(end.generator.settings.biome, "minecraft:the_end");
  assert.deepEqual(end.generator.settings.layers, [{ block: "minecraft:air", height: 1 }], "no land");
  const files = worldDatapack(s);
  const load = files.find((f) => f.path.endsWith("function/load.mcfunction"));
  assert.match(load?.kind === "inline" ? load.content : "", /scoreboard objectives add worldsmith dummy\nexecute unless score #end_anchor_abc123 worldsmith matches 1 run function worldsmith:end_anchor\/start/);
  const place = files.find((f) => f.path.endsWith("function/end_anchor/place.mcfunction"));
  const text = place?.kind === "inline" ? place.content : "";
  assert.match(text, /unless loaded 0 63 0 run return run schedule/, "waits for the center chunk");
  assert.match(text, /if block 0 63 0 minecraft:air run setblock 0 63 0 minecraft:bedrock/, "never overwrites anything");
  // The 10 spires, each placed once at its own center (positions from 26.2's EndSpikeFeature).
  const spikes = [...text.matchAll(/place feature minecraft:end_spike (-?\d+) 0 (-?\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(spikes, [[42, 0], [33, 24], [12, 39], [-13, 39], [-34, 24], [-42, -1], [-34, -25], [-13, -40], [12, -40], [33, -25]]);
  assert.match(text, /scoreboard players set #end_anchor_abc123 worldsmith 1/);
  // A plain void End has no features and no anchor.
  const plain = spec({ end: "void" });
  assert.ok(!worldDatapack(plain).some((f) => f.path.includes("end_anchor")));
});

test("dimension resets only ever name Nether/End folders", () => {
  for (const dirs of Object.values(DIMENSION_DIRS)) for (const d of dirs) assert.doesNotMatch(d, /overworld|^world\/?$|\.\./);
});
