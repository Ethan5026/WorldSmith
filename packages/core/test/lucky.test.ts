import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBlockState, loadVersion } from "@worldsmith/mcdata";
import { buildArena, buildMarket, BuildScript, compileBuild, compileLuckyBosses, compileWorld, LuckyBossesOp, VOID_WORLD, WorldSpec } from "../src/index.ts";

const v = loadVersion("26.2")!;
const kit = (extra: Record<string, unknown> = {}) => LuckyBossesOp.parse({ op: "lucky_bosses", market: [0, 0, 0], arena: [0, 0, 90], ...extra });

const stateIssues = (state: string) => checkBlockState(v, state.replace(/^minecraft:/, "")).map((i) => `${state}: ${i.error}`);

test("lucky_bosses: venue structures use only valid 26.2 block states", () => {
  for (const g of [buildArena(), buildMarket()]) {
    const states = new Set(g.cells.values());
    const issues = [...states].flatMap(stateIssues);
    assert.deepEqual(issues, []);
  }
});

test("lucky_bosses: the arena clears its inside when re-placed (air above the floor), the market has a lucky statue", () => {
  const arena = buildArena();
  assert.equal(arena.cells.get("0,1,0"), "air", "arena center is cleared every round");
  assert.equal(arena.cells.get("0,0,0"), "gold_block");
  assert.equal(buildMarket().cells.get("0,5,0"), "petrified_oak_slab[type=double,waterlogged=false]");
});

test("lucky_bosses: compiles to a datapack, two hashed templates and build commands with valid blocks", () => {
  const c = compileBuild(BuildScript.parse({ name: "lucky", origin: [0, 100, 0], ops: [kit()] }), v);
  assert.deepEqual(c.errors, []);
  const paths = c.files.map((f) => f.path);
  assert.ok(paths.includes("world/datapacks/worldsmith_game/data/minecraft/tags/function/tick.json"));
  assert.ok(paths.some((p) => /world\/generated\/worldsmith\/structure\/lb_arena_[0-9a-f]{10}\.nbt$/.test(p)));
  assert.ok(paths.some((p) => /lb_market_[0-9a-f]{10}\.nbt$/.test(p)));
  // Overrides for Lucky Block Reborn outcomes live in the luckyblock namespace.
  assert.ok(paths.includes("world/datapacks/worldsmith_game/data/luckyblock/function/wishing_well/deathwish.mcfunction"));
  // The game pack must load after the lucky block pack so the overrides win.
  assert.ok(c.commands.includes('datapack enable "file/worldsmith_game" last'));
  for (const cmd of c.commands.filter((x) => x.startsWith("setblock "))) {
    const state = cmd.split(" ")[4]!.replace(/\{.*$/, "");
    assert.deepEqual(stateIssues(state), [], cmd);
  }
  assert.equal(c.commands.at(-1), "function worldsmith_game:lb/setup");
  // Bounds cover both islands (for loading chunks during the build).
  assert.ok(c.bounds!.min[2] <= -18 && c.bounds!.max[2] >= 90 + 31);
});

test("lucky_bosses: every function the kit calls exists; the Giant Boss pack is only reached through a macro", () => {
  const g = compileLuckyBosses(kit({ rounds: 4 }), [0, 100, 0], v);
  const names = new Set(
    g.files.filter((f) => f.path.includes("/data/worldsmith_game/function/")).map((f) => `worldsmith_game:${f.path.split("/function/")[1]!.replace(/\.mcfunction$/, "")}`),
  );
  const all = [...g.files.map((f) => f.content), ...g.commands].join("\n");
  const called = [...all.matchAll(/function (worldsmith_game:[a-z0-9_/]+)/g)].map((m) => m[1]!);
  const missing = [...new Set(called)].filter((n) => !names.has(n));
  assert.deepEqual(missing, []);
  assert.doesNotMatch(all, /function giant:/, "giant:spawn is called by name through lb/call");
  assert.match(all, /\{fn:"giant:spawn"\}/);
  // One reward function per round; four regular bosses plus the final Giant King.
  for (let r = 1; r <= 4; r++) assert.ok(names.has(`worldsmith_game:lb/reward/${r}`));
  assert.ok(!names.has("worldsmith_game:lb/reward/5"));
  for (const b of ["bone_baron", "broodmother", "blaze_lord", "hexlord", "giant_king"]) assert.ok(names.has(`worldsmith_game:lb/boss/${b}/spawn`), b);
});

test("lucky_bosses: settings reach the game (rounds, timer, lucky blocks per player, difficulty)", () => {
  const g = compileLuckyBosses(kit({ rounds: 5, luckySeconds: 90, luckyBlocksPerPlayer: 6, difficulty: "hard" }), [0, 100, 0], v);
  const fileText = (name: string) => g.files.find((f) => f.path.endsWith(`/lb/${name}.mcfunction`))!.content;
  const setup = fileText("setup");
  assert.match(setup, /scoreboard players set #rounds lb 5/);
  assert.match(setup, /scoreboard players set #luckyT lb 1800/);
  assert.match(setup, /scoreboard players set #diff lb 140/);
  assert.match(fileText("place_lucky"), /limit=6\]/);
  // Five traders, one of them a wandering trader that never leaves.
  const traders = fileText("traders");
  assert.equal(traders.match(/^summon /gm)!.length, 5);
  assert.match(traders, /summon minecraft:wandering_trader [^\n]*DespawnDelay:0/);
  assert.match(traders, /"minecraft:smite":5/);
  assert.match(traders, /potion:"minecraft:long_fire_resistance"/);
});

test("lucky_bosses: arena and market must be far apart", () => {
  const c = compileBuild(BuildScript.parse({ name: "lucky", origin: [0, 100, 0], ops: [kit({ arena: [0, 0, 40] })] }), v);
  assert.match(c.errors.join(" "), /at least 70 blocks/);
});

test("trader op: summons the trader, then adds each offer in its own short command", () => {
  const c = compileBuild(
    BuildScript.parse({
      name: "shop",
      origin: [10, 64, 10],
      ops: [
        {
          op: "trader",
          at: [0, 1, 0],
          profession: "cleric",
          name: "Potions",
          facing: "east",
          trades: [
            { buy: { id: "emerald", count: 4 }, sell: { id: "potion", potion: "long_fire_resistance" } },
            { buy: { id: "emerald", count: 12 }, sell: { id: "diamond_sword", name: "Undead Bane", enchantments: { smite: 5 } } },
          ],
        },
      ],
    }),
    v,
  );
  assert.deepEqual(c.errors, []);
  assert.match(c.commands[0]!, /^summon minecraft:villager 10 65 10 \{Tags:\["ws_new_trader_0","ws_trader"\],NoAI:1b,.*Rotation:\[-90f,0f\].*Offers:\{Recipes:\[\]\}.*profession:"minecraft:cleric",level:5/);
  assert.equal(c.commands.length, 4);
  assert.match(c.commands[2]!, /append value \{buy:\{id:"minecraft:emerald",count:12\},sell:\{id:"minecraft:diamond_sword",count:1,components:\{"minecraft:custom_name":\{text:"Undead Bane",italic:false\},"minecraft:enchantments":\{"minecraft:smite":5\}\}\},maxUses:9999/);
  assert.equal(c.commands[3], "tag @e[tag=ws_new_trader_0] remove ws_new_trader_0");
});

test("void sky worlds: generatorSettings reaches the server", () => {
  const spec = WorldSpec.parse({
    slug: "sky",
    name: "Sky",
    minecraft: { version: "26.2", protocol: 776, type: "PAPER" },
    memoryMb: 2048,
    properties: { levelType: "flat", generatorSettings: VOID_WORLD },
  });
  const env = compileWorld(spec, { rconPassword: "x".repeat(24) }).env;
  assert.equal(env.LEVEL_TYPE, "flat");
  assert.equal(JSON.parse(env.GENERATOR_SETTINGS!).biome, "minecraft:the_void");
});
