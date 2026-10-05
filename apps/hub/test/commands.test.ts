import { test } from "node:test";
import assert from "node:assert/strict";
import { loadVersion } from "@worldsmith/mcdata";
import { prepareCommand } from "../src/mcp.ts";

const v = loadVersion("26.2")!;

test("old game rule names are translated (the exact command the live server rejected)", () => {
  assert.deepEqual(prepareCommand(v, "gamerule commandBlockOutput false"), {
    command: "gamerule command_block_output false",
    note: '"commandBlockOutput" is called "command_block_output" in 26.2.',
  });
  const r = prepareCommand(v, "/gamerule doDaylightCycle false");
  assert.ok("command" in r && r.command === "gamerule advance_time false");
});

test("inverted legacy rules flip their value", () => {
  const r = prepareCommand(v, "gamerule disableRaids true");
  assert.ok("command" in r && r.command === "gamerule raids false" && /inverted/.test(r.note ?? ""));
});

test("unknown game rules and bad block states are rejected before anything runs", () => {
  const g = prepareCommand(v, "gamerule keep_inventry true");
  assert.ok("error" in g && g.error.includes("keep_inventory"));
  const rep = prepareCommand(v, "setblock 2 -60 3 minecraft:repeater[facing=east,delay=9]");
  assert.ok("error" in rep && rep.error.includes("delay=4"));
  const fill = prepareCommand(v, "fill 0 0 0 4 4 4 comand_block");
  assert.ok("error" in fill && fill.error.includes("command_block"));
});

test("valid builder commands pass through untouched (incl. command block NBT with spaces)", () => {
  const cmd = 'setblock 1 -60 6 minecraft:chain_command_block[facing=east,conditional=true]{auto:1b,Command:"scoreboard players add #cond lab 1"}';
  assert.deepEqual(prepareCommand(v, cmd), { command: cmd });
  assert.deepEqual(prepareCommand(v, "/say hello"), { command: "say hello" });
  assert.deepEqual(prepareCommand(undefined, "anything goes"), { command: "anything goes" });
});
