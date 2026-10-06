import { test } from "node:test";
import assert from "node:assert/strict";
import { loadVersion } from "@worldsmith/mcdata";
import { BuildScript, compileBuild, snbtString } from "../src/index.ts";

const v = loadVersion("26.2")!;
const build = (ops: unknown[], origin = [100, 64, -20]) => BuildScript.parse({ name: "test", origin, ops });

test("coordinates are relative to the origin; bounds cover everything placed", () => {
  const c = compileBuild(build([{ op: "fill", from: [0, 0, 0], to: [10, 0, 10], block: "smooth_stone" }, { op: "set", at: [5, 1, 5], block: "lantern" }]), v);
  assert.deepEqual(c.errors, []);
  assert.equal(c.commands[0], "fill 100 64 -20 110 64 -10 minecraft:smooth_stone replace");
  assert.equal(c.commands[1], "setblock 105 65 -15 minecraft:lantern");
  assert.deepEqual(c.bounds, { min: [100, 64, -20], max: [110, 65, -10] });
});

test("big fills are split under the per-command block limit; hollow rooms stay one command", () => {
  const big = compileBuild(build([{ op: "fill", from: [0, 0, 0], to: [99, 9, 99], block: "stone" }]), v);
  assert.ok(big.commands.length > 1);
  const total = big.commands
    .map((c) => c.split(" ").slice(1, 7).map(Number))
    .reduce((s, [x1, y1, z1, x2, y2, z2]) => s + (x2! - x1! + 1) * (y2! - y1! + 1) * (z2! - z1! + 1), 0);
  assert.equal(total, 100 * 10 * 100, "pieces cover the whole box exactly");
  const room = compileBuild(build([{ op: "fill", from: [0, 0, 0], to: [20, 6, 20], block: "oak_planks", mode: "hollow" }]), v);
  assert.equal(room.commands.length, 1);
  assert.match(room.commands[0]!, / hollow$/);
});

test("signs: plain and styled lines, text is escaped, always 4 lines, waxed", () => {
  const c = compileBuild(
    build([{ op: "sign", at: [0, 1, 0], facing: "north", lines: ['Say "hi"', { text: "OneBlock", color: "gold", bold: true }], glowing: true }]),
    v,
  );
  assert.deepEqual(c.errors, []);
  assert.equal(
    c.commands[0],
    'setblock 100 65 -20 minecraft:oak_sign[rotation=8]{front_text:{messages:["Say \\"hi\\"",{text:"OneBlock",color:"gold",bold:1b},"",""],color:"black",has_glowing_text:1b},is_waxed:1b}',
  );
});

test("chests with items, loot tables and names", () => {
  const c = compileBuild(
    build([{ op: "chest", at: [1, 1, 1], facing: "east", items: [{ id: "diamond_sword" }, { id: "minecraft:bread", count: 16, slot: 26 }], name: "Starter Kit" }, { op: "chest", at: [2, 1, 1], kind: "barrel", loot: "minecraft:chests/simple_dungeon" }]),
    v,
  );
  assert.deepEqual(c.errors, []);
  assert.equal(c.commands[0], 'setblock 101 65 -19 minecraft:chest[facing=east]{Items:[{Slot:0b,id:"minecraft:diamond_sword",count:1},{Slot:26b,id:"minecraft:bread",count:16}],CustomName:"Starter Kit"}');
  assert.equal(c.commands[1], 'setblock 102 65 -19 minecraft:barrel[facing=up]{LootTable:"minecraft:chests/simple_dungeon"}');
});

test("command blocks and a teleport pad (verified pattern: plate on an impulse block)", () => {
  const c = compileBuild(
    build([
      { op: "command_block", at: [0, 0, 0], kind: "repeating", facing: "east", command: 'say "loop"', alwaysActive: true },
      { op: "teleport_pad", at: [5, 0, 5], to: [50, 10, 50], message: "Off to the arena!" },
    ]),
    v,
  );
  assert.deepEqual(c.errors, []);
  assert.equal(c.commands[0], 'setblock 100 64 -20 minecraft:repeating_command_block[facing=east,conditional=false]{Command:"say \\"loop\\"",auto:1b,TrackOutput:1b}');
  assert.match(c.commands[1]!, /^setblock 105 64 -15 minecraft:command_block\[facing=down\]\{Command:"title @p\[distance=\.\.2\] actionbar \\"Off to the arena!\\""/);
  assert.match(c.commands[2]!, /^setblock 105 63 -15 minecraft:chain_command_block\[facing=down\]\{Command:"tp @p\[distance=\.\.2\] 150 74 30"/);
  assert.equal(c.commands[3], "setblock 105 65 -15 minecraft:stone_pressure_plate");
});

test("invalid blocks, states and game rules stop the build with suggestions", () => {
  const c = compileBuild(
    build([
      { op: "set", at: [0, 0, 0], block: "comand_block" },
      { op: "set", at: [0, 0, 0], block: "repeater[delay=9]" },
      { op: "gamerule", rule: "keepInventory", value: true },
      { op: "gamerule", rule: "made_up_rule", value: true },
    ]),
    v,
  );
  assert.equal(c.errors.length, 3);
  assert.match(c.errors[0]!, /command_block/);
  assert.match(c.errors[1]!, /delay=4/);
  assert.match(c.errors[2]!, /made_up_rule/);
  assert.ok(c.commands.includes("gamerule keep_inventory true"), "legacy names are translated");
});

test("builds can't touch access or server control", () => {
  for (const run of ["whitelist add Stranger", "op Stranger", "/stop", "ban Ethan5026"]) {
    assert.equal(compileBuild(build([{ op: "command", run }]), v).errors.length, 1, run);
  }
  assert.equal(compileBuild(build([{ op: "command", run: "time set day" }]), v).errors.length, 0);
});

test("SNBT strings escape quotes and backslashes", () => {
  assert.equal(snbtString('a"b\\c'), '"a\\"b\\\\c"');
});

test("template op: places the hashed library id, rotated, and needs a saved template", () => {
  const templates = new Map([["lobby", { id: "worldsmith:lobby_1e40a526fd", size: [15, 6, 15] as [number, number, number] }]]);
  const ok = compileBuild({ name: "t", origin: [100, -61, 60], ops: [{ op: "template", name: "lobby", at: [0, 0, 0], rotation: "clockwise_90", mirror: "none" }] }, undefined, { templates });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.commands, ["place template worldsmith:lobby_1e40a526fd 100 -61 60 clockwise_90 none"]);
  assert.deepEqual(ok.templates, ["lobby"]);
  assert.deepEqual(ok.bounds, { min: [85, -61, 45], max: [115, -56, 75] }, "bounds cover every rotation");
  const missing = compileBuild({ name: "t", origin: [0, 0, 0], ops: [{ op: "template", name: "arena", at: [0, 0, 0], rotation: "none", mirror: "none" }] }, undefined, { templates });
  assert.match(missing.errors[0]!, /no template called "arena". Saved templates: lobby/);
});

test("voxels op: one structure file per drawing, placed at its corner", () => {
  const r = compileBuild({
    name: "t",
    origin: [10, 0, 10],
    ops: [{ op: "voxels", at: [1, 1, 1], legend: { "#": "stone", G: "glass" }, layers: [["##", "##"], ["G.", ".G"]] }],
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.files.length, 1);
  assert.match(r.files[0]!.path, /^world\/generated\/worldsmith\/structure\/build_[0-9a-f]{10}\.nbt$/);
  const name = r.files[0]!.path.split("/").pop()!.replace(".nbt", "");
  assert.deepEqual(r.commands, [`place template worldsmith:${name} 11 1 11`]);
  assert.deepEqual(r.bounds, { min: [11, 1, 11], max: [12, 2, 12] });
  const bad = compileBuild({ name: "t", origin: [0, 0, 0], ops: [{ op: "voxels", at: [0, 0, 0], legend: { "#": "stone" }, layers: [["#?"]] }] });
  assert.match(bad.errors[0]!, /missing from the legend: "\?"/);
});
