import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBlockState, checkGamerule, datapackMeta, LEGACY_GAMERULES, loadVersion } from "../src/index.ts";

const v = loadVersion("26.2")!;

test("26.2 reference has the facts we measured on the live server", () => {
  assert.equal(v.protocol, 776);
  assert.equal(v.dataVersion, 4903);
  assert.deepEqual(v.dataPack, [107, 1]);
  assert.equal(Object.keys(v.gamerules).length, 59);
  assert.equal(v.gamerules.command_blocks_work, "bool");
  assert.equal(v.gamerules.max_block_modifications, "int");
  assert.deepEqual(v.blocks.command_block?.props?.facing, ["north", "east", "south", "west", "up", "down"]);
  assert.equal(loadVersion("1.0.0"), undefined);
});

test("legacy game rule names translate; live-verified failures are covered", () => {
  // These four were rejected by the live 26.2 server:
  for (const [old, now] of [
    ["commandBlockOutput", "command_block_output"],
    ["keepInventory", "keep_inventory"],
    ["doDaylightCycle", "advance_time"],
    ["doMobSpawning", "spawn_mobs"],
  ]) {
    const r = checkGamerule(v, old!);
    assert.ok(r.ok && r.name === now && r.translatedFrom === old, old);
  }
  const inverted = checkGamerule(v, "disableRaids");
  assert.ok(inverted.ok && inverted.note === "inverted");
  const bad = checkGamerule(v, "keep_inventry");
  assert.ok(!bad.ok && bad.suggestions[0] === "keep_inventory");
});

test("every legacy mapping points at a real 26.2 rule", () => {
  for (const [old, { name }] of Object.entries(LEGACY_GAMERULES)) assert.ok(v.gamerules[name], `${old} → ${name}`);
});

test("block states are checked against the registry", () => {
  assert.deepEqual(checkBlockState(v, "minecraft:repeater[facing=east,delay=2]"), []);
  assert.deepEqual(checkBlockState(v, 'chain_command_block[facing=east,conditional=true]{auto:1b,Command:"say hi"}'), []);
  const badValue = checkBlockState(v, "repeater[delay=9]");
  assert.match(badValue[0]!.error, /delay=9/);
  assert.ok(badValue[0]!.suggestions.includes("delay=4"));
  const badProp = checkBlockState(v, "lever[on=true]");
  assert.match(badProp[0]!.error, /no property "on"/);
  const badBlock = checkBlockState(v, "comand_block");
  assert.equal(badBlock[0]!.suggestions[0], "command_block");
});

test("datapack meta targets the version's data pack format", () => {
  assert.deepEqual(JSON.parse(datapackMeta(v, "x")).pack.min_format, [107, 1]);
});
