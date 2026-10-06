// Game kits: whole minigames as one build step. Hunger Games compiles to a datapack (loot tables
// and functions) plus a command-block control panel in the world: a Start button, a Reset button
// and a repeating clock that runs the game. All vanilla, so it works for Bedrock players too.
//
// Verified mechanics (docs/builder-notes.md): scoreboard state machine, title countdown, worldborder
// shrink with explicit seconds (a bare number is ticks in 26.x), loot tables that fill on first open.

import { z } from "zod";
import type { McVersionData } from "@worldsmith/mcdata";
import { datapackMeta } from "@worldsmith/mcdata";

const Vec = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
type Vec = z.infer<typeof Vec>;

export const LootItem = z.object({
  item: z.string().regex(/^(minecraft:)?[a-z0-9_]+$/),
  weight: z.number().int().min(1).max(100).default(10),
  min: z.number().int().min(1).max(64).default(1),
  max: z.number().int().min(1).max(64).default(1),
});
export type LootItem = z.infer<typeof LootItem>;

export const HungerGamesOp = z.object({
  op: z.literal("hunger_games"),
  center: Vec.describe("The cornucopia: middle of the arena, at the height players stand on"),
  arenaRadius: z.number().int().min(20).max(120).default(80).describe("Starting world border radius"),
  finalRadius: z.number().int().min(5).max(60).default(15),
  pads: z.object({ count: z.number().int().min(2).max(24).default(12), radius: z.number().int().min(3).max(40).default(10) }).default({ count: 12, radius: 10 }),
  padBlock: z.string().default("gold_block").describe("Block under each starting spot"),
  centerChests: z.object({ count: z.number().int().min(0).max(24).default(8), radius: z.number().int().min(1).max(20).default(4) }).default({ count: 8, radius: 4 }),
  hiddenChests: z
    .object({ count: z.number().int().min(0).max(60).default(16), minRadius: z.number().int().min(0).max(110).default(25) })
    .default({ count: 16, minRadius: 25 })
    .describe("Barrels buried at the surface at random spots between minRadius and the arena edge"),
  graceSeconds: z.number().int().min(0).max(600).default(60).describe("No PvP for this long after GO"),
  shrinkSeconds: z.number().int().min(30).max(3600).default(600).describe("Border shrinks to finalRadius over this long, after the grace period"),
  countdownSeconds: z.number().int().min(3).max(30).default(10),
  lobby: Vec.optional().describe("Where everyone goes when a game ends"),
  controls: Vec.describe("Where the control panel goes (3 command blocks with buttons and signs, 5 blocks wide)"),
  loot: z.object({ center: z.array(LootItem).min(1).max(60).optional(), hidden: z.array(LootItem).min(1).max(60).optional() }).default({}),
});
export type HungerGamesOp = z.infer<typeof HungerGamesOp>;

export const GAME_PACK = "world/datapacks/worldsmith_game";
const NS = "worldsmith_game";

const DEFAULT_CENTER: LootItem[] = [
  { item: "stone_sword", weight: 12, min: 1, max: 1 },
  { item: "iron_sword", weight: 4, min: 1, max: 1 },
  { item: "bow", weight: 6, min: 1, max: 1 },
  { item: "arrow", weight: 10, min: 4, max: 12 },
  { item: "leather_chestplate", weight: 8, min: 1, max: 1 },
  { item: "iron_helmet", weight: 4, min: 1, max: 1 },
  { item: "iron_boots", weight: 4, min: 1, max: 1 },
  { item: "chainmail_leggings", weight: 4, min: 1, max: 1 },
  { item: "bread", weight: 12, min: 2, max: 5 },
  { item: "cooked_beef", weight: 8, min: 1, max: 4 },
  { item: "apple", weight: 8, min: 1, max: 3 },
  { item: "golden_apple", weight: 2, min: 1, max: 1 },
  { item: "shield", weight: 3, min: 1, max: 1 },
];
const DEFAULT_HIDDEN: LootItem[] = [
  { item: "iron_axe", weight: 8, min: 1, max: 1 },
  { item: "diamond_sword", weight: 2, min: 1, max: 1 },
  { item: "flint_and_steel", weight: 6, min: 1, max: 1 },
  { item: "ender_pearl", weight: 5, min: 1, max: 2 },
  { item: "fishing_rod", weight: 5, min: 1, max: 1 },
  { item: "crossbow", weight: 4, min: 1, max: 1 },
  { item: "tnt", weight: 3, min: 1, max: 2 },
  { item: "cobweb", weight: 6, min: 2, max: 4 },
  { item: "lava_bucket", weight: 2, min: 1, max: 1 },
  { item: "diamond_chestplate", weight: 1, min: 1, max: 1 },
  { item: "golden_apple", weight: 4, min: 1, max: 1 },
  { item: "cooked_porkchop", weight: 8, min: 2, max: 4 },
];

const ns = (id: string) => (id.includes(":") ? id : `minecraft:${id}`);
const p = (v: Vec) => v.join(" ");

function lootTable(items: LootItem[], rolls: [number, number]): string {
  return JSON.stringify(
    {
      type: "minecraft:chest",
      pools: [
        {
          rolls: { type: "minecraft:uniform", min: rolls[0], max: rolls[1] },
          entries: items.map((i) => ({
            type: "minecraft:item",
            name: ns(i.item),
            weight: i.weight,
            ...(i.max > 1 ? { functions: [{ function: "minecraft:set_count", count: { type: "minecraft:uniform", min: i.min, max: Math.max(i.min, i.max) } }] } : {}),
          })),
        },
      ],
    },
    null,
    2,
  );
}

/** Deterministic pseudo-random numbers (same build → same hidden chest spots). */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const ring = (c: Vec, r: number, n: number, i: number): Vec => {
  const a = (2 * Math.PI * i) / n;
  return [c[0] + Math.round(Math.sin(a) * r), c[1], c[2] - Math.round(Math.cos(a) * r)];
};

export interface CompiledGame {
  files: { path: string; content: string }[];
  /** Commands that set the game up in the world (run once, after /reload). */
  commands: string[];
  /** Absolute points the game touches (for loading chunks). */
  points: Vec[];
}

/** Compile a Hunger Games kit at an absolute center. Pure. */
export function compileHungerGames(op: HungerGamesOp, origin: Vec, seed: string, data?: McVersionData): CompiledGame {
  const add = (v: Vec): Vec => [origin[0] + v[0], origin[1] + v[1], origin[2] + v[2]];
  const c = add(op.center);
  const ctl = add(op.controls);
  const lobby = op.lobby ? add(op.lobby) : undefined;
  const R = op.arenaRadius;
  const fn = (name: string) => `${NS}:hg/${name}`;
  const files: { path: string; content: string }[] = [];
  const file = (name: string, lines: string[]) => files.push({ path: `${GAME_PACK}/data/${NS}/function/hg/${name}.mcfunction`, content: `${lines.join("\n")}\n` });

  const pads = Array.from({ length: op.pads.count }, (_, i) => ring(c, op.pads.radius, op.pads.count, i));
  const chests = Array.from({ length: op.centerChests.count }, (_, i) => ring(c, op.centerChests.radius, op.centerChests.count, i));
  const random = rng(seed);
  const hidden = Array.from({ length: op.hiddenChests.count }, () => {
    const a = random() * 2 * Math.PI;
    const r = op.hiddenChests.minRadius + random() * Math.max(0, R - 4 - op.hiddenChests.minRadius);
    return [c[0] + Math.round(Math.sin(a) * r), c[2] + Math.round(Math.cos(a) * r)] as [number, number];
  });
  const freeze = (who: string) => [
    `execute as ${who} run attribute @s minecraft:movement_speed base set 0`,
    `execute as ${who} run attribute @s minecraft:jump_strength base set 0`,
  ];
  const unfreeze = (who: string) => [
    `execute as ${who} run attribute @s minecraft:movement_speed base set 0.1`,
    `execute as ${who} run attribute @s minecraft:jump_strength base set 0.42`,
  ];

  files.push({
    path: `${GAME_PACK}/pack.mcmeta`,
    content: data ? datapackMeta(data, "WorldSmith game: Hunger Games") : JSON.stringify({ pack: { description: "WorldSmith game: Hunger Games" } }),
  });
  files.push({ path: `${GAME_PACK}/data/${NS}/loot_table/hg/center.json`, content: lootTable(op.loot.center ?? DEFAULT_CENTER, [3, 6]) });
  files.push({ path: `${GAME_PACK}/data/${NS}/loot_table/hg/hidden.json`, content: lootTable(op.loot.hidden ?? DEFAULT_HIDDEN, [2, 4]) });

  // Build-time setup: scoreboards, buried hidden barrels (marked so resets can refill them), reset.
  file("setup", [
    "# Generated by WorldSmith. Run once when the game is built.",
    "scoreboard objectives add hg dummy",
    "scoreboard objectives add hg_deaths deathCount",
    "kill @e[type=minecraft:marker,tag=hg_hidden]",
    ...hidden.flatMap(([x, z]) => [
      `summon minecraft:marker ${x} 300 ${z} {Tags:["hg_hidden","hg_new"]}`,
      // spreadplayers drops the marker onto the surface at (about) that spot.
      `spreadplayers ${x} ${z} 0 1 false @e[type=minecraft:marker,tag=hg_new,limit=1]`,
      `execute as @e[type=minecraft:marker,tag=hg_new] at @s run setblock ~ ~-1 ~ minecraft:barrel[facing=up]`,
      "tag @e[type=minecraft:marker,tag=hg_new] remove hg_new",
    ]),
    `function ${fn("refill")}`,
    `function ${fn("reset")}`,
  ]);
  file("refill", [
    ...chests.map((ch) => `data merge block ${p(ch)} {Items:[],LootTable:"${NS}:hg/center"}`),
    `execute as @e[type=minecraft:marker,tag=hg_hidden] at @s run data merge block ~ ~-1 ~ {Items:[],LootTable:"${NS}:hg/hidden"}`,
  ]);
  file("reset", [
    "scoreboard players set #state hg 0",
    "scoreboard players set #t hg 0",
    `worldborder center ${c[0]} ${c[2]}`,
    `worldborder set ${R * 2}`,
    "gamerule pvp false",
    `forceload add ${c[0] - R} ${c[2] - R} ${c[0] + R} ${c[2] + R}`,
    `schedule function ${fn("reset_loaded")} 3s`,
  ]);
  file("reset_loaded", [
    `function ${fn("refill")}`,
    `forceload remove ${c[0] - R} ${c[2] - R} ${c[0] + R} ${c[2] + R}`,
    'tellraw @a {text:"Hunger Games: chests refilled, ready to start.",color:"green"}',
  ]);
  file("ready", [
    "tag @s remove hg_q",
    "tag @s add hg_alive",
    "gamemode survival @s",
    "clear @s",
    "effect clear @s",
    "effect give @s minecraft:instant_health 1 10 true",
    "effect give @s minecraft:saturation 5 10 true",
    ...freeze("@s"),
  ]);
  pads.forEach((pad, i) => file(`pad/${i}`, [`tp @s ${pad[0]} ${pad[1]} ${pad[2]} facing ${c[0]} ${c[1]} ${c[2]}`, `function ${fn("ready")}`]));
  file("start", [
    'execute if score #state hg matches 1.. run tellraw @a {text:"A game is already running. Press Reset first.",color:"red"}',
    "execute if score #state hg matches 1.. run return 0",
    "tag @a remove hg_alive",
    "tag @a[gamemode=!spectator,gamemode=!creative] add hg_q",
    ...pads.map((_, i) => `execute as @r[tag=hg_q] run function ${fn(`pad/${i}`)}`),
    // More players than pads: the rest start scattered near the center.
    `execute if entity @a[tag=hg_q] run spreadplayers ${c[0]} ${c[2]} 3 ${op.pads.radius + 6} false @a[tag=hg_q]`,
    `execute as @a[tag=hg_q] run function ${fn("ready")}`,
    "scoreboard players reset * hg_deaths",
    "execute store result score #players hg if entity @a[tag=hg_alive]",
    "scoreboard players set #t hg 0",
    "scoreboard players set #state hg 1",
    `worldborder set ${R * 2}`,
    "gamerule pvp false",
  ]);
  const cd = op.countdownSeconds;
  file("countdown", [
    "scoreboard players add #t hg 1",
    ...Array.from({ length: cd }, (_, i) => {
      const n = cd - i;
      return `execute if score #t hg matches ${i * 20 + 1} run title @a title {text:"${n}",color:"${n <= 3 ? "red" : "gold"}",bold:true}`;
    }),
    `execute if score #t hg matches ${cd * 20 + 1} run function ${fn("go")}`,
  ]);
  file("go", [
    'title @a title {text:"GO!",color:"green",bold:true}',
    ...unfreeze("@a[tag=hg_alive]"),
    "scoreboard players set #t hg 0",
    "scoreboard players set #state hg 2",
    op.graceSeconds > 0
      ? `tellraw @a {text:"Grace period: no fighting for ${op.graceSeconds} seconds.",color:"yellow"}`
      : `function ${fn("grace_over")}`,
  ]);
  file("grace_over", [
    "gamerule pvp true",
    "scoreboard players set #state hg 3",
    `worldborder set ${op.finalRadius * 2} ${op.shrinkSeconds}s`,
    `tellraw @a {text:"Fight! The border is closing in.",color:"red",bold:true}`,
  ]);
  file("live", [
    "scoreboard players add #t hg 1",
    ...(op.graceSeconds > 0 ? [`execute if score #state hg matches 2 if score #t hg matches ${op.graceSeconds * 20} run function ${fn("grace_over")}`] : []),
    `execute as @a[tag=hg_alive,scores={hg_deaths=1..}] run function ${fn("eliminated")}`,
    "execute store result score #alive hg if entity @a[tag=hg_alive]",
    `execute if score #players hg matches 2.. if score #alive hg matches ..1 run function ${fn("end")}`,
    `execute if score #alive hg matches 0 run function ${fn("end")}`,
  ]);
  file("eliminated", [
    "tag @s remove hg_alive",
    "scoreboard players reset @s hg_deaths",
    "gamemode spectator @s",
    'tellraw @a [{selector:"@s",color:"red"},{text:" is out!",color:"gray"}]',
  ]);
  file("end", [
    'execute if entity @a[tag=hg_alive] run title @a title {selector:"@a[tag=hg_alive]",color:"gold",bold:true}',
    'execute if entity @a[tag=hg_alive] run title @a subtitle {text:"wins the Hunger Games!",color:"yellow"}',
    'execute unless entity @a[tag=hg_alive] run title @a title {text:"Nobody survived",color:"gray"}',
    "scoreboard players set #state hg 0",
    "gamerule pvp false",
    ...unfreeze("@a"),
    "tag @a remove hg_alive",
    "gamemode adventure @a[gamemode=!creative]",
    ...(lobby ? [`tp @a[gamemode=!creative] ${p(lobby)}`] : []),
    `worldborder set ${R * 2}`,
  ]);
  file("tick", [
    `execute if score #state hg matches 1 run function ${fn("countdown")}`,
    `execute if score #state hg matches 2..3 run function ${fn("live")}`,
  ]);

  // Control panel: [Start] [Reset] [clock], each command block with a button on top, signs in front.
  const at = (dx: number, dy: number, dz: number): string => p([ctl[0] + dx, ctl[1] + dy, ctl[2] + dz]);
  const sign = (dx: number, lines: string[]) =>
    `setblock ${at(dx, 0, 1)} minecraft:oak_sign[rotation=0]{front_text:{messages:[${[...lines, "", "", "", ""].slice(0, 4).map((l) => `"${l}"`).join(",")}],color:"black",has_glowing_text:0b},is_waxed:1b}`;
  const commands = [
    "reload",
    `datapack enable "file/worldsmith_game"`,
    ...pads.map((pad) => `setblock ${pad[0]} ${pad[1] - 1} ${pad[2]} ${ns(op.padBlock)}`),
    ...chests.map((ch, i) => `setblock ${p(ch)} minecraft:chest[facing=${["south", "west", "north", "east"][Math.round((4 * i) / Math.max(1, chests.length)) % 4]}]`),
    `setblock ${at(0, 0, 0)} minecraft:command_block[facing=up]{Command:"function ${fn("start")}",auto:0b,TrackOutput:0b}`,
    `setblock ${at(0, 1, 0)} minecraft:stone_button[face=floor]`,
    `setblock ${at(2, 0, 0)} minecraft:command_block[facing=up]{Command:"function ${fn("reset")}",auto:0b,TrackOutput:0b}`,
    `setblock ${at(2, 1, 0)} minecraft:stone_button[face=floor]`,
    `setblock ${at(4, 0, 0)} minecraft:repeating_command_block[facing=up]{Command:"function ${fn("tick")}",auto:1b,TrackOutput:0b}`,
    sign(0, ["Hunger Games", "▶ START", "Press the button"]),
    sign(2, ["Hunger Games", "⟲ RESET", "Refill chests,", "reset border"]),
    sign(4, ["Game clock", "(leave it on)"]),
    `function ${fn("setup")}`,
  ];
  const points: Vec[] = [
    [c[0] - R, c[1], c[2] - R],
    [c[0] + R, c[1], c[2] + R],
    ctl,
    [ctl[0] + 4, ctl[1] + 1, ctl[2] + 1],
    ...(lobby ? [lobby] : []),
  ];
  return { files, commands, points };
}
