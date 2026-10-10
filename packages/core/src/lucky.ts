// Lucky Block Boss Rush: a "Lucky Block Challenge Games" kit (Pat & Jen style) for 2-4 players, as one
// build step. Each round: break lucky blocks in the Sky Colosseum, then fight a boss together; win
// and you get emeralds to spend at the Lucky Bazaar, whose traders sell exactly what the next boss is
// weak to. Rounds draw a random boss from a pool; the last round is always the Giant King.
//
// It pairs with two Modrinth datapacks the world plan installs (no installs for players, Bedrock-safe):
//   lbr             Lucky Block Reborn: a datapack port of the classic Lucky Block mod. A lucky block is
//                   a double petrified oak slab; breaking it rolls one of ~45 outcomes.
//   usrx-giant-boss Giant Boss: `function giant:spawn` makes a 6× zombie with 200 HP and minion waves.
// Both are called through a macro (`$function $(fn)`), so the kit still loads and runs (with a vanilla
// fallback giant) if a pack is missing.
//
// Compiles to: functions in the worldsmith_game datapack (run from #minecraft:tick, not a command
// block, so the clock never depends on loaded chunks), two generated structure templates (the arena,
// which is re-placed every round as a repair, and the market), traders, markers and button panels.

import { z } from "zod";
import type { McVersionData } from "@worldsmith/mcdata";
import { datapackMeta } from "@worldsmith/mcdata";
import { buildStructure, structureHash, STRUCTURE_DIR, STRUCTURE_NAMESPACE, type StructureBlock } from "@worldsmith/mcworld";
import { GAME_PACK } from "./games.ts";
import { snbtString } from "./snbt.ts";
import { itemSnbt, traderEntity, type Trade, type TradeItem, type TraderSpec } from "./trade.ts";

const Vec = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
type Vec = z.infer<typeof Vec>;

export const LuckyBossesOp = z.object({
  op: z.literal("lucky_bosses"),
  market: Vec.describe("Center of the Lucky Bazaar (trading hub, lobby and respawn point), at the height players stand on"),
  arena: Vec.describe("Center of the Sky Colosseum floor, at the height players stand on. Keep it 70+ blocks from the market"),
  rounds: z.number().int().min(2).max(6).default(3).describe("Boss rounds; the last one is always the Giant King"),
  luckyBlocksPerPlayer: z.number().int().min(3).max(12).default(8),
  luckySeconds: z.number().int().min(30).max(600).default(120).describe("Time to break lucky blocks before the boss arrives"),
  difficulty: z.enum(["easy", "normal", "hard"]).default("normal").describe("Boss health: easy 75%, normal 100%, hard 140%"),
});
export type LuckyBossesOp = z.infer<typeof LuckyBossesOp>;

const NS = "worldsmith_game";
const fn = (name: string) => `${NS}:lb/${name}`;
const DIFF = { easy: 75, normal: 100, hard: 140 } as const;

/** Arena geometry (blocks from the center). */
const A = { floor: 20, wall: 22, stands: 27, outer: 28, rim: 31, depth: 16, air: 16 } as const;
/** Market geometry. */
const M = { plaza: 8, stall: 10, hedge: 16, rim: 18, depth: 12, air: 9 } as const;

// ---------- small helpers ----------

const p = (v: Vec) => v.join(" ");
const tc = (text: string, color?: string, extra = "") => `{text:${snbtString(text)}${color ? `,color:${snbtString(color)}` : ""}${extra}}`;

/** Deterministic noise in [0,1) from integer coordinates and a seed. */
function hash(x: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Sparse block grid in coordinates relative to a center; dy 0 is the floor block. */
class Grid {
  cells = new Map<string, string>();
  set(x: number, y: number, z: number, state: string) {
    this.cells.set(`${x},${y},${z}`, state);
  }
  has(x: number, y: number, z: number) {
    return this.cells.has(`${x},${y},${z}`);
  }
  /** Structure blocks with positions shifted so the minimum corner is (0,0,0). */
  toStructure(): { size: Vec; offset: Vec; blocks: StructureBlock[] } {
    const pts = [...this.cells.keys()].map((k) => k.split(",").map(Number) as Vec);
    const min: Vec = [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.min(...pts.map((q) => q[2]))];
    const max: Vec = [Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[2]))];
    const blocks = [...this.cells.entries()].map(([k, state]) => {
      const [x, y, z] = k.split(",").map(Number) as Vec;
      return { pos: [x - min[0], y - min[1], z - min[2]] as Vec, state: state.includes(":") ? state : `minecraft:${state}` };
    });
    return { size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1], offset: min, blocks };
  }
}

const STONE = ["stone", "andesite", "tuff", "stone", "cobblestone", "andesite"];

/** A floating island: grass top at dy 0 (where nothing else is), dirt, then stone tapering to a point. */
function island(g: Grid, radius: number, depth: number, seed: number) {
  for (let x = -radius - 1; x <= radius + 1; x++) {
    for (let z = -radius - 1; z <= radius + 1; z++) {
      const r = Math.hypot(x, z);
      for (let d = 0; d <= depth; d++) {
        if (d > 0 && g.has(x, -d, z)) continue;
        const rr = radius - d * (radius / (depth + 1)) * (0.75 + 0.5 * hash(x >> 2, z >> 2, seed + d)) + (hash(x, z, seed) - 0.5) * 2;
        if (r > rr) continue;
        if (d === 0) {
          if (!g.has(x, 0, z)) g.set(x, 0, z, "grass_block[snowy=false]");
          continue;
        }
        const n = hash(x, z, seed + 100 + d);
        g.set(x, -d, z, d <= 2 ? "dirt" : n < 0.03 ? "gold_ore" : n < 0.05 ? "raw_gold_block" : STONE[Math.floor(n * 997) % STONE.length]!);
      }
    }
  }
}

/** Stairs with the high back toward the outside of a circle (seats face the center). */
function outward(x: number, z: number): string {
  return Math.abs(x) > Math.abs(z) ? (x > 0 ? "east" : "west") : z > 0 ? "south" : "north";
}

// ---------- the Sky Colosseum ----------

export interface ArenaLayout {
  /** Lucky block spots (dy 1, i.e. standing level). */
  spots: Vec[];
  /** Where players start a round. */
  starts: Vec[];
}

export function arenaLayout(): ArenaLayout {
  const ring = (r: number, n: number, phase: number): Vec[] =>
    Array.from({ length: n }, (_, i) => {
      const a = phase + (2 * Math.PI * i) / n;
      return [Math.round(Math.sin(a) * r), 1, Math.round(-Math.cos(a) * r)] as Vec;
    });
  return { spots: [...ring(6, 8, Math.PI / 8), ...ring(11, 12, 0), ...ring(15.5, 16, Math.PI / 16)], starts: ring(18, 8, 0) };
}

export function buildArena(): Grid {
  const g = new Grid();
  const { spots, starts } = arenaLayout();
  const spotSet = new Set(spots.map(([x, , z]) => `${x},${z}`));
  const startSet = new Set(starts.map(([x, , z]) => `${x},${z}`));
  for (let x = -A.rim; x <= A.rim; x++) {
    for (let z = -A.rim; z <= A.rim; z++) {
      const r = Math.hypot(x, z);
      if (r > A.outer + 0.5) continue;
      const ang = Math.atan2(x, -z); // 0 = north, clockwise
      if (r <= A.floor + 0.5) {
        // Floor: gold medallion, sandstone sun pattern, red rings and spokes, froglight studs.
        const spoke = Math.abs(Math.sin(4 * ang)) * r < 0.7 && r > 3.5;
        const ringA = r > 8.5 && r <= 9.5;
        const ringB = r > 13.5 && r <= 14.5;
        let b: string;
        if (r <= 1.6) b = "gold_block";
        else if (r <= 3.6) b = "chiseled_sandstone";
        else if (r > 19.5) b = "red_sandstone";
        else if ((ringA || ringB) && spoke) b = "ochre_froglight[axis=y]";
        else if (ringA || ringB) b = "cut_red_sandstone";
        else if (spoke) b = "smooth_red_sandstone";
        else b = (Math.floor((ang + Math.PI) / (Math.PI / 8)) + Math.floor(r / 2.5)) % 2 ? "smooth_sandstone" : "sandstone";
        if (spotSet.has(`${x},${z}`)) b = "gold_block";
        if (startSet.has(`${x},${z}`)) b = "emerald_block";
        g.set(x, 0, z, b);
        g.set(x, -1, z, "sandstone");
      } else if (r <= A.wall + 0.5) {
        // Inner wall: 4 high, banded, gold and lanterns at the four compass points.
        const compass = Math.abs(x) <= 1 || Math.abs(z) <= 1;
        for (let y = 0; y <= 4; y++) {
          let b = y <= 1 ? "cut_red_sandstone" : y === 3 ? (Math.floor((ang + Math.PI) / (Math.PI / 12)) % 2 ? "chiseled_sandstone" : "cut_sandstone") : "smooth_sandstone";
          if (y === 4) b = compass ? "gold_block" : "cut_sandstone";
          g.set(x, y, z, b);
        }
        if (compass && r <= A.wall - 0.5) g.set(x, 5, z, "lantern[hanging=false,waterlogged=false]");
      } else if (r <= A.stands + 0.5) {
        // Stands: five rising tiers of seats.
        const tier = Math.min(5, Math.max(1, Math.ceil(r - A.wall - 0.5)));
        const top = 4 + tier;
        for (let y = 0; y < top; y++) g.set(x, y, z, y % 4 === 3 ? "cut_sandstone" : "sandstone");
        const seat = tier % 2 ? "smooth_sandstone_stairs" : "smooth_red_sandstone_stairs";
        g.set(x, top, z, `${seat}[facing=${outward(x, z)},half=bottom,shape=straight,waterlogged=false]`);
      } else {
        // Outer wall with quartz pillars every 15°, each crowned with gold and a lantern.
        const pillar = Math.abs(Math.sin(12 * ang)) * r < 0.8;
        if (pillar) {
          for (let y = 0; y <= 12; y++) g.set(x, y, z, "quartz_pillar[axis=y]");
          g.set(x, 13, z, "gold_block");
          g.set(x, 14, z, "lantern[hanging=false,waterlogged=false]");
        } else {
          for (let y = 0; y <= 10; y++) g.set(x, y, z, y === 6 ? "orange_terracotta" : y === 7 ? "white_terracotta" : y === 10 ? "cut_sandstone" : "smooth_sandstone");
          if ((Math.floor((ang + Math.PI) / (Math.PI / 48)) % 2) === 0) g.set(x, 11, z, "chiseled_sandstone");
        }
      }
    }
  }
  island(g, A.rim, A.depth, 7);
  // Flowers and grass tufts on the rim.
  for (let x = -A.rim; x <= A.rim; x++) {
    for (let z = -A.rim; z <= A.rim; z++) {
      if (g.cells.get(`${x},0,${z}`) !== "grass_block[snowy=false]") continue;
      const n = hash(x, z, 31);
      if (n < 0.08) g.set(x, 1, z, ["dandelion", "poppy", "cornflower", "oxeye_daisy"][Math.floor(n * 50) % 4]!);
      else if (n < 0.3) g.set(x, 1, z, "short_grass");
    }
  }
  // Air inside the walls, so re-placing the arena each round clears what lucky blocks left behind.
  for (let x = -A.outer; x <= A.outer; x++) {
    for (let z = -A.outer; z <= A.outer; z++) {
      if (Math.hypot(x, z) > A.outer + 0.5) continue;
      for (let y = 1; y <= A.air; y++) if (!g.has(x, y, z)) g.set(x, y, z, "air");
    }
  }
  return g;
}

// ---------- the Lucky Bazaar ----------

type Side = "north" | "east" | "south" | "west";
/** Stall frame: u runs along the stall front, v goes away from the plaza (0 = front, at radius 10). */
function frame(side: Side, u: number, v: number): [number, number] {
  const d = M.stall + v;
  if (side === "north") return [u, -d];
  if (side === "south") return [-u, d];
  if (side === "east") return [d, u];
  return [-d, -u];
}
const TOWARD: Record<Side, Side> = { north: "south", south: "north", east: "west", west: "east" };

interface StallStyle {
  side: Side;
  wool: [string, string];
  job: string;
}

const STALLS: StallStyle[] = [
  { side: "north", wool: ["red_wool", "white_wool"], job: "grindstone[face=floor,facing=north]" },
  { side: "east", wool: ["yellow_wool", "white_wool"], job: "blast_furnace[facing=west,lit=false]" },
  { side: "west", wool: ["purple_wool", "white_wool"], job: "brewing_stand[has_bottle_0=false,has_bottle_1=false,has_bottle_2=false]" },
];

export function buildMarket(): Grid {
  const g = new Grid();
  for (let x = -M.rim; x <= M.rim; x++) {
    for (let z = -M.rim; z <= M.rim; z++) {
      const r = Math.hypot(x, z);
      if (r <= 3.0 && r > 0.5) {
        g.set(x, 0, z, "water[level=0]");
        g.set(x, -1, z, "prismarine_bricks");
      } else if (r <= 0.5) {
        for (let y = 0; y <= 3; y++) g.set(x, y, z, "quartz_pillar[axis=y]");
        g.set(x, 4, z, "gold_block");
        g.set(x, 5, z, "petrified_oak_slab[type=double,waterlogged=false]");
      } else if (r <= 3.8) {
        g.set(x, 0, z, "quartz_bricks");
        g.set(x, 1, z, "quartz_slab[type=bottom,waterlogged=false]");
      } else if (r <= M.plaza + 0.5) {
        g.set(x, 0, z, r > M.plaza - 0.5 ? "gold_block" : (x + z) % 2 === 0 ? "polished_andesite" : "smooth_stone");
      } else if ((Math.abs(x) <= 1 || Math.abs(z) <= 1) && r <= M.stall + 0.5) {
        g.set(x, 0, z, "polished_andesite");
      } else if (r > M.hedge && r <= M.hedge + 1.2) {
        const post = Math.abs(Math.sin(6 * Math.atan2(x, -z))) * r < 0.8;
        if (post) {
          g.set(x, 1, z, "stripped_oak_log[axis=y]");
          g.set(x, 2, z, "gold_block");
          g.set(x, 3, z, "lantern[hanging=false,waterlogged=false]");
        } else {
          const leaf = hash(x, z, 5) < 0.3 ? "flowering_azalea_leaves" : "azalea_leaves";
          for (const y of [1, 2]) g.set(x, y, z, `${leaf}[distance=1,persistent=true,waterlogged=false]`);
        }
      }
    }
  }
  for (const s of STALLS) stall(g, s);
  gate(g);
  // The Lucky Merchant's rug by the fountain.
  for (let x = -1; x <= 1; x++) for (let z = -6; z <= -4; z++) g.set(x, 1, z, x === 0 && z === -5 ? "yellow_carpet" : "orange_carpet");
  g.set(0, 1, -5, "air"); // the merchant stands here
  island(g, M.rim, M.depth, 13);
  for (let x = -M.rim; x <= M.rim; x++) {
    for (let z = -M.rim; z <= M.rim; z++) {
      if (Math.hypot(x, z) > M.hedge + 1.2) continue;
      if (g.cells.get(`${x},0,${z}`) === "grass_block[snowy=false]" && hash(x, z, 77) < 0.06) g.set(x, 1, z, ["dandelion", "poppy", "allium"][Math.floor(hash(x, z, 78) * 3)]!);
      for (let y = 1; y <= M.air; y++) if (!g.has(x, y, z)) g.set(x, y, z, "air");
    }
  }
  return g;
}

function stall(g: Grid, s: StallStyle) {
  const at = (u: number, v: number, y: number, state: string) => {
    const [x, z] = frame(s.side, u, v);
    g.set(x, y, z, state);
  };
  for (let u = -3; u <= 3; u++) for (let v = 0; v <= 4; v++) at(u, v, 0, "spruce_planks");
  for (let u = -2; u <= 2; u++) at(u, 1, 1, u === 1 ? s.job : "stripped_spruce_wood[axis=y]");
  for (const u of [-3, 3]) for (const v of [0, 4]) for (let y = 1; y <= 4; y++) at(u, v, y, "spruce_log[axis=y]");
  for (let u = -2; u <= 2; u++) for (let y = 1; y <= 3; y++) at(u, 4, y, "spruce_planks");
  for (const u of [-3, 3]) for (let v = 1; v <= 3; v++) at(u, v, 1, "spruce_planks");
  for (let u = -3; u <= 3; u++) {
    const wool = s.wool[(u + 3) % 2]!;
    for (let v = 0; v <= 4; v++) at(u, v, 5, wool);
    at(u, -1, 4, wool);
  }
  at(0, 0, 4, "lantern[hanging=true,waterlogged=false]");
}

/** The Arena Gate (south): a quartz-and-gold arch with the FIGHT / NEW GAME buttons and the Quartermaster. */
function gate(g: Grid) {
  const at = (u: number, v: number, y: number, state: string) => {
    const [x, z] = frame("south", u, v);
    g.set(x, y, z, state);
  };
  for (let u = -4; u <= 4; u++) for (let v = 0; v <= 4; v++) at(u, v, 0, Math.abs(u) <= 1 ? "polished_andesite" : "smooth_quartz");
  for (const u of [-4, 4]) for (let y = 1; y <= 6; y++) at(u, 1, y, "quartz_pillar[axis=y]");
  for (let u = -4; u <= 4; u++) at(u, 1, 7, "gold_block");
  at(0, 1, 8, "petrified_oak_slab[type=double,waterlogged=false]");
  at(-2, 1, 0, "iron_block"); // NEW GAME button pedestal (command block below)
  at(2, 1, 0, "gold_block"); // FIGHT button pedestal
  for (let u = -1; u <= 1; u++) at(u, 2, 1, u === 0 ? "fletching_table" : "stripped_birch_wood[axis=y]");
  for (let u = -2; u <= 2; u++) for (let y = 1; y <= 3; y++) at(u, 4, y, "quartz_bricks");
}

// ---------- bosses ----------

interface Ability {
  every: number;
  say: string;
  lines: string[];
}
interface Boss {
  key: string;
  name: string;
  color: string;
  /** Health before scaling (round, players, difficulty). */
  base: number;
  /** Next-boss sign: two short lines on what beats it. */
  sign: [string, string];
  hint: string;
  /** Run positioned at the arena center (standing height). Must tag the boss lb_boss. */
  spawn: string[];
  abilities: Ability[];
}

const boss = (o: Boss) => o;
const BOSS_BASE = `PersistenceRequired:1b,CustomNameVisible:1b,DeathLootTable:"minecraft:empty"`;
const attrs = (a: Record<string, number>) => `attributes:[${Object.entries(a).map(([k, v]) => `{id:"minecraft:${k}",base:${v}}`).join(",")}]`;
const minionCap = 6;

export function bosses(arenaFloorY: number): Boss[] {
  return [
    boss({
      key: "bone_baron",
      name: "The Bone Baron",
      color: "white",
      base: 120,
      sign: ["Smite weapons,", "shields & arrow armor"],
      hint: "A giant undead archer. Smite weapons hit it hard; shields and Projectile Protection stop its arrows. When it calls an Arrow Storm, keep moving!",
      spawn: [
        `summon minecraft:skeleton ~ ~ ~ {Tags:["lb_boss"],${BOSS_BASE},CustomName:${tc("The Bone Baron", "white", ",bold:1b")},equipment:{mainhand:{id:"minecraft:bow",count:1,components:{"minecraft:enchantments":{"minecraft:power":3,"minecraft:punch":1}}},head:{id:"minecraft:golden_helmet",count:1,components:{"minecraft:unbreakable":{}}},chest:{id:"minecraft:chainmail_chestplate",count:1}},drop_chances:{mainhand:0f,head:0f,chest:0f},${attrs({ scale: 2.2, knockback_resistance: 0.7, follow_range: 64, movement_speed: 0.3 })}}`,
      ],
      abilities: [
        {
          every: 100,
          say: "Arrow Storm! Look up!",
          lines: [[1, 1], [-1, 1], [1, -1], [-1, -1], [0, 0]].map(
            ([dx, dz]) => `execute at @a[tag=lb_alive] run summon minecraft:arrow ~${dx} ~12 ~${dz} {Motion:[0.0,-2.0,0.0],damage:3.0d,pickup:0b}`,
          ),
        },
        {
          every: 300,
          say: "The Bone Baron calls his guard!",
          lines: [2, -2].map(
            (d) => `execute if score #mc lb matches ..${minionCap - 1} run summon minecraft:skeleton ~${d} ~ ~ {Tags:["lb_minion"],equipment:{mainhand:{id:"minecraft:bow",count:1},head:{id:"minecraft:leather_helmet",count:1}},drop_chances:{mainhand:0f,head:0f}}`,
          ),
        },
      ],
    }),
    boss({
      key: "broodmother",
      name: "The Broodmother",
      color: "dark_green",
      base: 140,
      sign: ["Bane of Arthropods,", "milk for the venom"],
      hint: "A huge spider. Bane of Arthropods shreds it, milk cures its venom, and a sword cuts through its webs. Don't stand close when it rears up.",
      spawn: [
        `summon minecraft:spider ~ ~ ~ {Tags:["lb_boss"],${BOSS_BASE},CustomName:${tc("The Broodmother", "dark_green", ",bold:1b")},${attrs({ scale: 3.2, knockback_resistance: 0.8, follow_range: 64, movement_speed: 0.36, attack_damage: 7 })}}`,
      ],
      abilities: [
        { every: 120, say: "Web Snare!", lines: ["execute at @a[tag=lb_alive] run setblock ~ ~ ~ minecraft:cobweb keep"] },
        {
          every: 160,
          say: "Venom Burst! Get back!",
          lines: [
            "particle minecraft:item_slime ~ ~1 ~ 3 0.5 3 0 80",
            "effect give @a[tag=lb_alive,distance=..7] minecraft:poison 6 1",
          ],
        },
        {
          every: 240,
          say: "The brood hatches!",
          lines: [2, -2, 0].map((d) => `execute if score #mc lb matches ..${minionCap - 1} run summon minecraft:cave_spider ~${d} ~ ~${d === 0 ? 2 : 0} {Tags:["lb_minion"]}`),
        },
      ],
    }),
    boss({
      key: "blaze_lord",
      name: "The Blaze Lord",
      color: "gold",
      base: 110,
      sign: ["Snowballs & arrows,", "Fire Resistance"],
      hint: "A fireproof flying blaze. Snowballs hurt it (3 damage each) and arrows reach it; drink Fire Resistance and dodge the Meteor Shower.",
      spawn: [
        `summon minecraft:blaze ~ ~3 ~ {Tags:["lb_boss"],${BOSS_BASE},CustomName:${tc("The Blaze Lord", "gold", ",bold:1b")},${attrs({ scale: 2.5, knockback_resistance: 0.5, follow_range: 64 })}}`,
      ],
      abilities: [
        {
          every: 80,
          say: "Meteor Shower!",
          lines: [[0, 0], [2, 1], [-2, -1]].map(
            ([dx, dz]) => `execute at @a[tag=lb_alive] run summon minecraft:small_fireball ~${dx} ~10 ~${dz} {Motion:[0.0,-1.0,0.0],acceleration_power:0.1d}`,
          ),
        },
        {
          every: 260,
          say: "The Blaze Lord summons its embers!",
          lines: [3, -3].map((d) => `execute if score #mc lb matches ..${minionCap - 1} run summon minecraft:blaze ~${d} ~1 ~ {Tags:["lb_minion"]}`),
        },
        // Don't let it hover out of reach.
        { every: 20, say: "", lines: [`execute if entity @s[y=${arenaFloorY + 14},dy=200] run tp @s ~ ${arenaFloorY + 8} ~`] },
      ],
    }),
    boss({
      key: "hexlord",
      name: "The Hexlord",
      color: "dark_purple",
      base: 130,
      sign: ["Sharpness & a Totem,", "kill the vexes fast"],
      hint: "An illager sorcerer: fangs from the ground and swarms of vexes. Hit hard with Sharpness, kill vexes quickly, and carry a Totem of Undying.",
      spawn: [
        `summon minecraft:evoker ~ ~ ~ {Tags:["lb_boss"],${BOSS_BASE},CustomName:${tc("The Hexlord", "dark_purple", ",bold:1b")},${attrs({ scale: 2.0, knockback_resistance: 0.6, follow_range: 64 })}}`,
      ],
      abilities: [
        {
          every: 140,
          say: "Fang Circle! Move!",
          lines: [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]].map(
            ([dx, dz]) => `execute at @a[tag=lb_alive] run summon minecraft:evoker_fangs ~${dx} ~ ~${dz} {Warmup:20}`,
          ),
        },
        {
          every: 320,
          say: "The Hexlord calls the guard!",
          lines: [2, -2].map(
            (d) => `execute if score #mc lb matches ..${minionCap - 1} run summon minecraft:vindicator ~${d} ~ ~ {Tags:["lb_minion"],equipment:{mainhand:{id:"minecraft:iron_axe",count:1}},drop_chances:{mainhand:0f}}`,
          ),
        },
      ],
    }),
    boss({
      key: "giant_king",
      name: "The Giant King",
      color: "dark_green",
      base: 220,
      sign: ["Smite, Strength II,", "golden apples, Totems"],
      hint: "FINAL BOSS: a giant that hits for 10 hearts and calls zombie waves. It's undead, so Smite works. Bring Strength II, golden apples and Totems, and keep moving.",
      spawn: [
        `function ${fn("call")} {fn:"giant:spawn"}`,
        // Vanilla fallback if the Giant Boss datapack isn't installed.
        `execute unless entity @e[tag=GiantBoss] run summon minecraft:zombie ~ ~ ~ {Tags:["GiantBoss"],equipment:{head:{id:"minecraft:leather_helmet",count:1}},drop_chances:{head:0f},${attrs({ scale: 6, attack_damage: 20, knockback_resistance: 1, follow_range: 64 })}}`,
        `execute as @e[tag=GiantBoss,limit=1,sort=nearest] run function ${fn("boss/giant_king/adopt")}`,
      ],
      abilities: [
        {
          every: 200,
          say: "GROUND SLAM!",
          lines: [
            "particle minecraft:explosion_emitter ~ ~ ~ 0 0 0 0 1 force",
            "playsound minecraft:entity.generic.explode hostile @a ~ ~ ~ 1 0.6",
            "execute as @a[tag=lb_alive,distance=..9] run damage @s 6 minecraft:mob_attack by @e[tag=lb_boss,limit=1]",
            "effect give @a[tag=lb_alive,distance=..9] minecraft:slowness 3 2",
          ],
        },
      ],
    }),
  ];
}

// ---------- traders ----------

const em = (count: number) => ({ id: "emerald", count });
const sell = (item: Partial<TradeItem> & { id: string }): TradeItem => ({ count: 1, ...item }) as TradeItem;
const t = (price: number, item: Partial<TradeItem> & { id: string }): Trade => ({ buy: em(price), sell: sell(item), maxUses: 9999 });

const LUCKY_BLOCK = `"minecraft:block_state":{type:"double"}`;

export function traders(): (TraderSpec & { at: Vec })[] {
  const at = (side: Side, u: number, v: number): Vec => {
    const [x, z] = frame(side, u, v);
    return [x, 1, z];
  };
  return [
    {
      at: at("north", 0, 2),
      profession: "weaponsmith",
      name: "Blades & Bows",
      color: "red",
      facing: "south",
      trades: [
        t(12, { id: "diamond_sword", name: "Undead Bane", color: "gold", enchantments: { smite: 5, unbreaking: 3 }, lore: ["Big damage vs Bone Baron & Giant King"] }),
        t(10, { id: "diamond_axe", name: "Spider Splitter", color: "dark_green", enchantments: { bane_of_arthropods: 5, unbreaking: 3 }, lore: ["Big damage vs the Broodmother"] }),
        t(12, { id: "diamond_sword", name: "Hexbreaker", color: "light_purple", enchantments: { sharpness: 5, sweeping_edge: 3, unbreaking: 3 }, lore: ["Sweeps through vexes"] }),
        t(10, { id: "bow", name: "Sky Piercer", color: "aqua", enchantments: { power: 4, punch: 1, unbreaking: 3 }, lore: ["Reaches the Blaze Lord"] }),
        t(3, { id: "shield", enchantments: { unbreaking: 3 } }),
        t(18, { id: "mace", name: "Lucky Hammer", color: "yellow", enchantments: { density: 3, wind_burst: 1 }, lore: ["Jump, then smash!"] }),
      ],
    },
    {
      at: at("east", 0, 2),
      profession: "armorer",
      name: "Gilded Armor",
      color: "yellow",
      facing: "west",
      trades: [
        t(3, { id: "iron_helmet", enchantments: { protection: 2 } }),
        t(6, { id: "iron_chestplate", enchantments: { protection: 2 } }),
        t(5, { id: "iron_leggings", enchantments: { protection: 2 } }),
        t(4, { id: "iron_boots", enchantments: { protection: 2, feather_falling: 3 } }),
        t(12, { id: "diamond_chestplate", name: "Fireguard Chestplate", color: "gold", enchantments: { fire_protection: 4, unbreaking: 3 }, lore: ["For the Blaze Lord"] }),
        t(10, { id: "diamond_leggings", name: "Arrowguard Leggings", color: "white", enchantments: { projectile_protection: 4, unbreaking: 3 }, lore: ["For the Bone Baron"] }),
        t(9, { id: "diamond_helmet", enchantments: { protection: 3 } }),
        t(9, { id: "diamond_boots", enchantments: { protection: 3, feather_falling: 4 } }),
      ],
    },
    {
      at: at("west", 0, 2),
      profession: "cleric",
      name: "Potions & Remedies",
      color: "light_purple",
      facing: "east",
      trades: [
        t(4, { id: "potion", potion: "long_fire_resistance" }),
        t(5, { id: "splash_potion", count: 2, potion: "strong_healing" }),
        t(7, { id: "potion", potion: "strong_strength" }),
        t(6, { id: "potion", potion: "strong_regeneration" }),
        t(2, { id: "milk_bucket" }),
        t(6, { id: "golden_apple", count: 2 }),
        t(20, { id: "totem_of_undying" }),
        t(32, { id: "enchanted_golden_apple" }),
      ],
    },
    {
      at: at("south", 0, 3),
      profession: "fletcher",
      name: "Quartermaster",
      color: "green",
      facing: "north",
      trades: [
        t(2, { id: "arrow", count: 32 }),
        t(2, { id: "snowball", count: 16, lore: ["3 damage to blazes!"] }),
        t(3, { id: "spectral_arrow", count: 16 }),
        t(5, { id: "wind_charge", count: 8 }),
        t(8, { id: "crossbow", enchantments: { multishot: 1, quick_charge: 2 } }),
        t(1, { id: "cooked_beef", count: 8 }),
      ],
    },
    {
      at: [0, 1, -5],
      profession: "wandering",
      name: "The Lucky Merchant",
      color: "yellow",
      facing: "south",
      trades: [
        t(3, { id: "petrified_oak_slab", name: "Lucky Block", color: "yellow", components: LUCKY_BLOCK, lore: ["Place it in the arena and break it!"] }),
        t(15, { id: "petrified_oak_slab", count: 6, name: "Lucky Block", color: "yellow", components: LUCKY_BLOCK }),
        // The lucky gear from Lucky Block Reborn (its abilities trigger on custom_data).
        t(10, {
          id: "golden_sword",
          name: "Lucky Sword",
          color: "yellow",
          components: `"minecraft:custom_data":{luckysword:1b},"minecraft:enchantment_glint_override":true,"minecraft:max_damage":285,"minecraft:attribute_modifiers":[{type:"minecraft:attack_damage",id:"minecraft:base_attack_damage",amount:2.0d,operation:"add_value",slot:"mainhand"},{type:"minecraft:attack_speed",id:"minecraft:base_attack_speed",amount:-2.4d,operation:"add_value",slot:"mainhand"}]`,
          lore: ["Every hit rolls a random effect"],
        }),
        t(12, {
          id: "bow",
          name: "Lucky Bow",
          color: "yellow",
          components: `"minecraft:custom_data":{luckybow:1b},"minecraft:enchantment_glint_override":true`,
          lore: ["Every arrow rolls a random effect"],
        }),
        t(6, { id: "ender_pearl", count: 4 }),
      ],
    },
  ];
}

// ---------- compile ----------

export interface CompiledLucky {
  files: { path: string; content: string }[];
  structures: { path: string; data: Buffer }[];
  commands: string[];
  points: Vec[];
}

/** Lucky Block Reborn outcomes that don't suit a friends' server, replaced (worldsmith_game loads after it). */
const LBR_OVERRIDES: Record<string, string[]> = {
  "wishing_well/northkorea": [
    'tellraw @a [{selector:"@p",color:"dark_red",italic:true},{text:"\'s wish for a big bang has come true!"}]',
    "summon minecraft:tnt ~ ~ ~ {fuse:60,explosion_power:4}",
    "summon minecraft:tnt ~ ~ ~ {fuse:100,explosion_power:4}",
  ],
  "wishing_well/whatyouare": ['tellraw @p {text:"The Wishing Well giggles and grants you... a cookie.",italic:true,color:"gray"}', "give @p minecraft:cookie 1"],
  "wishing_well/cannibalism": ['tellraw @a [{selector:"@p",color:"dark_red",italic:true},{text:"\'s wish for snacks came true... sort of!"}]', "loot spawn ~ ~5 ~ loot luckyblock:flesh"],
  // Same as the original, without `difficulty hard` (which would stick for the whole world).
  "wishing_well/deathwish": [
    'tellraw @a [{selector:"@p",color:"red",italic:true},{text:"\'s death wish has come true!"}]',
    "effect give @p minecraft:blindness 30 1",
    "effect give @p minecraft:weakness 30 1",
    "effect give @p minecraft:slowness 30 1",
    ...Array.from({ length: 4 }, () => "summon minecraft:zombie ~ ~5 ~"),
    ...Array.from({ length: 4 }, () => "summon minecraft:skeleton ~ ~5 ~"),
    ...Array.from({ length: 4 }, () => "summon minecraft:spider ~ ~5 ~"),
  ],
};

/** Compile the kit at absolute positions. Pure. */
export function compileLuckyBosses(op: LuckyBossesOp, origin: Vec, data?: McVersionData): CompiledLucky {
  const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const C = add(origin, op.arena); // arena center, standing height
  const Mk = add(origin, op.market); // market center, standing height
  const cFloor = C[1] - 1;
  const mFloor = Mk[1] - 1;
  const arenaAt = (v: Vec): Vec => [C[0] + v[0], cFloor + v[1], C[2] + v[2]];
  const marketAt = (v: Vec): Vec => [Mk[0] + v[0], mFloor + v[1], Mk[2] + v[2]];
  const center = p(C);
  const bossList = bosses(cFloor);
  const R = op.rounds;
  const L = op.luckySeconds;

  // Structures (content-hashed names: 26.x caches templates until restart).
  const dv = data?.dataVersion ?? 4903;
  const structures: CompiledLucky["structures"] = [];
  const template = (g: Grid, name: string, anchor: (v: Vec) => Vec) => {
    const s = g.toStructure();
    const nbt = buildStructure(s.size, s.blocks, dv);
    const id = `lb_${name}_${structureHash(nbt)}`;
    structures.push({ path: `${STRUCTURE_DIR}/${id}.nbt`, data: nbt });
    const corner = anchor(s.offset);
    return { place: `place template ${STRUCTURE_NAMESPACE}:${id} ${p(corner)}`, size: s.size, corner };
  };
  const arena = template(buildArena(), "arena", arenaAt);
  const market = template(buildMarket(), "market", marketAt);

  const { spots, starts } = arenaLayout();
  const arrival = marketAt([0, 1, 6]);
  const fountain = marketAt([0, 1, 0]);
  const viewpoint = arenaAt([0, 11, -(A.stands - 1)]);
  const arenaBox = `x=${C[0] - A.outer},y=${cFloor - 2},z=${C[2] - A.outer},dx=${2 * A.outer},dy=${A.air + 6},dz=${2 * A.outer}`;
  const home = `tp @s ${p(arrival)} facing ${p(fountain)}`;
  const gateAt = (u: number, v: number, y: number): Vec => {
    const [x, z] = frame("south", u, v);
    return marketAt([x, y, z]);
  };
  const nextSign = gateAt(-4, 0, 3);

  const files: CompiledLucky["files"] = [];
  const file = (name: string, lines: string[]) => files.push({ path: `${GAME_PACK}/data/${NS}/function/lb/${name}.mcfunction`, content: `${lines.join("\n")}\n` });
  const dispatch = (what: string) => bossList.map((b, i) => `execute if score #boss lb matches ${i + 1} run function ${fn(`boss/${b.key}/${what}`)}`);

  files.push({
    path: `${GAME_PACK}/pack.mcmeta`,
    content: data ? datapackMeta(data, "WorldSmith games") : JSON.stringify({ pack: { description: "WorldSmith games" } }),
  });
  files.push({ path: `${GAME_PACK}/data/minecraft/tags/function/tick.json`, content: JSON.stringify({ values: [fn("tick")] }, null, 2) });
  for (const [name, lines] of Object.entries(LBR_OVERRIDES)) {
    files.push({ path: `${GAME_PACK}/data/luckyblock/function/${name}.mcfunction`, content: `${lines.join("\n")}\n` });
  }

  file("call", ["# Call a function from another pack by name (a missing pack fails here, not at load).", "$function $(fn)"]);

  file("setup", [
    "# Generated by WorldSmith (lucky_bosses). Run once when the game is built.",
    "scoreboard objectives add lb dummy",
    "scoreboard objectives add lb_deaths deathCount",
    "scoreboard objectives add lb_mined minecraft.mined:minecraft.petrified_oak_slab",
    ...[10, 20, 35, 50, 100].map((n) => `scoreboard players set #c${n} lb ${n}`),
    `scoreboard players set #rounds lb ${R}`,
    `scoreboard players set #diff lb ${DIFF[op.difficulty]}`,
    `scoreboard players set #luckyT lb ${L * 20}`,
    `scoreboard players set #warnT lb ${Math.max(1, L - 10) * 20}`,
    `bossbar add ${NS}:lb_boss ${tc("Boss")}`,
    `bossbar set ${NS}:lb_boss color red`,
    `bossbar set ${NS}:lb_boss style notched_10`,
    `bossbar set ${NS}:lb_boss visible false`,
    `bossbar add ${NS}:lb_lucky ${tc("Lucky Blocks! The boss arrives when this runs out", "yellow")}`,
    `bossbar set ${NS}:lb_lucky color yellow`,
    `bossbar set ${NS}:lb_lucky max ${L}`,
    `bossbar set ${NS}:lb_lucky visible false`,
    "kill @e[type=minecraft:marker,tag=lb]",
    ...spots.map((s) => `summon minecraft:marker ${p(arenaAt(s))} {Tags:["lb","lb_spot"]}`),
    ...starts.map((s) => `summon minecraft:marker ${p(arenaAt(s))} {Tags:["lb","lb_start"]}`),
    `function ${fn("traders")}`,
    "scoreboard players set #state lb 0",
    `function ${fn("new_game")}`,
  ]);

  file("traders", [
    "kill @e[tag=lb_trader]",
    ...traders().map((tr) => {
      const e = traderEntity({ ...tr, tags: ["lb_trader"] });
      return `summon ${e.entity} ${p(marketAt(tr.at))} ${e.nbt}`;
    }),
  ]);

  file("new_game", [
    "scoreboard players set #state lb 0",
    "scoreboard players set #round lb 1",
    ...[1, 2, 3, 4].map((i) => `scoreboard players set #f${i} lb 0`),
    `bossbar set ${NS}:lb_boss visible false`,
    `bossbar set ${NS}:lb_lucky visible false`,
    `function ${fn("clean_arena")}`,
    "tag @a remove lb_player",
    "tag @a remove lb_alive",
    "clear @a[gamemode=!creative]",
    "effect clear @a[gamemode=!creative]",
    `execute as @a[gamemode=!creative] run function ${fn("home")}`,
    "give @a[gamemode=!creative] minecraft:emerald 12",
    `give @a[gamemode=!creative] minecraft:iron_axe[minecraft:custom_name=${tc("Lucky Breaker", "yellow", ",italic:0b")}] 1`,
    "give @a[gamemode=!creative] minecraft:cooked_beef 8",
    `tellraw @a ["",${tc("★ New Lucky Block Boss Rush! ", "gold", ",bold:1b")},${tc(`${R} rounds. Spend your 12 emeralds at the Bazaar, then press the gold FIGHT button at the Arena Gate.`, "yellow")}]`,
    `function ${fn("pick")}`,
  ]);

  file("pick", [
    "execute if score #round lb >= #rounds lb run return run function " + fn("pick_final"),
    "execute if score #f1 lb matches 1 if score #f2 lb matches 1 if score #f3 lb matches 1 if score #f4 lb matches 1 run function " + fn("unfight"),
    "execute store result score #pick lb run random value 1..4",
    ...[1, 2, 3, 4].map((i) => `execute if score #pick lb matches ${i} if score #f${i} lb matches 1 run return run function ${fn("pick")}`),
    "scoreboard players operation #boss lb = #pick lb",
    ...[1, 2, 3, 4].map((i) => `execute if score #boss lb matches ${i} run scoreboard players set #f${i} lb 1`),
    `function ${fn("announce")}`,
  ]);
  file("unfight", [1, 2, 3, 4].map((i) => `scoreboard players set #f${i} lb 0`));
  file("pick_final", ["scoreboard players set #boss lb 5", `function ${fn("announce")}`]);
  file("announce", dispatch("announce"));

  file("fight", [
    `execute if score #state lb matches 1.. run return run tellraw @s ${tc("A round is already running!", "red")}`,
    `execute if score #round lb > #rounds lb run return run tellraw @a ${tc("You already beat every boss! Press NEW GAME (iron button) to play again.", "gold")}`,
    "tag @a remove lb_player",
    "tag @a remove lb_alive",
    "tag @a[gamemode=!creative,gamemode=!spectator] add lb_player",
    `execute unless entity @a[tag=lb_player] run return run tellraw @a ${tc("Nobody to fight! (Players in creative mode sit out.)", "red")}`,
    "tag @a[tag=lb_player] add lb_alive",
    "execute store result score #players lb if entity @a[tag=lb_player]",
    `function ${fn("clean_arena")}`,
    arena.place,
    "tag @e[type=minecraft:marker,tag=lb_spot] remove lb_used",
    "tag @e[type=minecraft:marker,tag=lb_start] remove lb_taken",
    `execute as @a[tag=lb_player] run function ${fn("place_lucky")}`,
    `execute as @a[tag=lb_player] run function ${fn("tp_start")}`,
    "gamemode survival @a[tag=lb_player]",
    "scoreboard players reset * lb_deaths",
    "scoreboard players reset * lb_mined",
    "time set 6000",
    "scoreboard players set #t lb 0",
    "scoreboard players set #state lb 1",
    `bossbar set ${NS}:lb_lucky value ${L}`,
    `bossbar set ${NS}:lb_lucky players @a`,
    `bossbar set ${NS}:lb_lucky visible true`,
    `title @a[tag=lb_player] title [${tc("ROUND ", "gold", ",bold:1b")},{score:{name:"#round",objective:"lb"},color:"gold",bold:1b}]`,
    `title @a[tag=lb_player] subtitle ${tc("Break the lucky blocks!", "yellow")}`,
    "execute as @a[tag=lb_player] at @s run playsound minecraft:block.note_block.pling master @s ~ ~ ~ 1 1.5",
  ]);

  file("place_lucky", [
    `execute as @e[type=minecraft:marker,tag=lb_spot,tag=!lb_used,sort=random,limit=${op.luckyBlocksPerPlayer}] at @s run function ${fn("lucky_here")}`,
  ]);
  file("lucky_here", ["setblock ~ ~ ~ minecraft:petrified_oak_slab[type=double]", "tag @s add lb_used"]);
  file("tp_start", [
    "tag @e[type=minecraft:marker,tag=lb_start,tag=!lb_taken,sort=random,limit=1] add lb_pick",
    `execute unless entity @e[tag=lb_pick] run tp @s ${p(arenaAt(starts[0]!))}`,
    "tp @s @e[type=minecraft:marker,tag=lb_pick,limit=1]",
    `execute at @s run tp @s ~ ~ ~ facing ${center}`,
    "tag @e[tag=lb_pick] add lb_taken",
    "tag @e[tag=lb_pick] remove lb_pick",
  ]);

  file("tick", [
    `execute if score #state lb matches 0 run function ${fn("idle")}`,
    `execute if score #state lb matches 1 run function ${fn("lucky_tick")}`,
    `execute if score #state lb matches 2 run function ${fn("intro_tick")}`,
    `execute if score #state lb matches 3 run function ${fn("fight_tick")}`,
    `execute if score #state lb matches 4 run function ${fn("outro_tick")}`,
    `execute as @a[scores={lb_mined=1..}] run function ${fn("mined")}`,
  ]);
  file("idle", [
    `execute as @a[tag=lb_player,gamemode=spectator] run function ${fn("home")}`,
    `execute as @a[tag=lb_player,${arenaBox}] run function ${fn("home")}`,
  ]);
  file("home", ["gamemode adventure @s[gamemode=!creative]", home, "tag @s remove lb_alive"]);
  file("mined", ["give @s minecraft:emerald 1", "scoreboard players remove @s lb_mined 1", `title @s actionbar ${tc("+1 emerald", "green")}`]);

  file("lucky_tick", [
    "scoreboard players add #t lb 1",
    `execute as @e[type=minecraft:player,tag=lb_player,scores={lb_deaths=1..}] run function ${fn("back_in")}`,
    "scoreboard players operation #m lb = #t lb",
    "scoreboard players operation #m lb %= #c10 lb",
    `execute if score #m lb matches 0 run function ${fn("lucky_glow")}`,
    "scoreboard players operation #m lb = #t lb",
    "scoreboard players operation #m lb %= #c20 lb",
    "scoreboard players operation #left lb = #luckyT lb",
    "scoreboard players operation #left lb -= #t lb",
    "scoreboard players operation #left lb /= #c20 lb",
    `execute if score #m lb matches 0 store result bossbar ${NS}:lb_lucky value run scoreboard players get #left lb`,
    `execute if score #t lb = #warnT lb run title @a[tag=lb_player] actionbar ${tc("10 seconds until the boss arrives!", "red", ",bold:1b")}`,
    `execute if score #t lb matches 200.. unless entity @e[type=minecraft:marker,tag=lb_used] run return run function ${fn("all_opened")}`,
    `execute if score #t lb >= #luckyT lb run function ${fn("intro")}`,
  ]);
  file("lucky_glow", [
    "execute as @e[type=minecraft:marker,tag=lb_used] at @s unless block ~ ~ ~ minecraft:petrified_oak_slab run tag @s remove lb_used",
    "execute as @e[type=minecraft:marker,tag=lb_used] at @s run particle minecraft:happy_villager ~ ~0.8 ~ 0.35 0.35 0.35 0 3",
  ]);
  file("all_opened", [`tellraw @a ${tc("Every lucky block is open... the boss is coming early!", "gold")}`, `function ${fn("intro")}`]);
  file("back_in", [
    "scoreboard players reset @s lb_deaths",
    "gamemode survival @s",
    "tp @s @e[type=minecraft:marker,tag=lb_start,sort=random,limit=1]",
    `execute at @s run tp @s ~ ~ ~ facing ${center}`,
    `tellraw @s ${tc("Unlucky! Back into the arena you go.", "yellow")}`,
  ]);

  file("intro", [
    "scoreboard players set #state lb 2",
    "scoreboard players set #t lb 0",
    `bossbar set ${NS}:lb_lucky visible false`,
    "time set 18000",
    ...dispatch("title"),
    "execute as @a[tag=lb_player] at @s run playsound minecraft:entity.wither.spawn hostile @s ~ ~ ~ 0.5 1",
  ]);
  file("intro_tick", [
    "scoreboard players add #t lb 1",
    `execute as @e[type=minecraft:player,tag=lb_player,scores={lb_deaths=1..}] run function ${fn("back_in")}`,
    `execute if score #t lb matches 60 run function ${fn("spawn_boss")}`,
  ]);
  file("spawn_boss", [
    "scoreboard players set #state lb 3",
    "scoreboard players set #t lb 0",
    ...[1, 2, 3].map((i) => `scoreboard players set #a${i} lb 0`),
    `particle minecraft:explosion_emitter ${center} 0 0 0 0 1 force`,
    ...dispatch("spawn").map((l) => `execute positioned ${center} ${l.replace(/^execute /, "")}`),
    `execute as @e[tag=lb_boss,limit=1] run function ${fn("scale_hp")}`,
    `bossbar set ${NS}:lb_boss players @a`,
    `bossbar set ${NS}:lb_boss visible true`,
  ]);
  const step = (from: string, mul: string, add: number) => [
    `scoreboard players operation #f lb = ${from} lb`,
    "scoreboard players remove #f lb 1",
    `scoreboard players operation #f lb *= ${mul} lb`,
    `scoreboard players add #f lb ${add}`,
    "scoreboard players operation #hp lb *= #f lb",
    "scoreboard players operation #hp lb /= #c100 lb",
  ];
  file("scale_hp", [
    "# health = base × (1 + 35% per round after the first) × (1 + 50% per extra player) × difficulty",
    ...dispatch("base"),
    ...step("#round", "#c35", 100),
    ...step("#players", "#c50", 100),
    "scoreboard players operation #hp lb *= #diff lb",
    "scoreboard players operation #hp lb /= #c100 lb",
    "execute if score #hp lb matches 1025.. run scoreboard players set #hp lb 1024",
    `execute store result storage ${NS}:lb hp int 1 run scoreboard players get #hp lb`,
    `function ${fn("set_hp")} with storage ${NS}:lb`,
  ]);
  file("set_hp", [
    "$attribute @s minecraft:max_health base set $(hp)",
    "$data modify entity @s Health set value $(hp)f",
    `$bossbar set ${NS}:lb_boss max $(hp)`,
    `$bossbar set ${NS}:lb_boss value $(hp)`,
  ]);

  file("fight_tick", [
    "scoreboard players add #t lb 1",
    "execute store result score #mc lb if entity @e[tag=lb_minion]",
    `execute store result bossbar ${NS}:lb_boss value run data get entity @e[tag=lb_boss,limit=1] Health`,
    ...[1, 2, 3].map((i) => `scoreboard players add #a${i} lb 1`),
    `execute as @e[tag=lb_boss,limit=1] at @s run function ${fn("boss_tick")}`,
    `execute positioned ${center} as @e[tag=lb_boss,distance=${A.floor + 3}..] run tp @s ${center}`,
    `execute positioned ${center} as @e[tag=lb_minion,distance=${A.floor + 3}..] run tp @s ${center}`,
    // Keep the Giant's endless minion waves and the Hexlord's vexes in check.
    "execute store result score #gm lb if entity @e[tag=GiantMinion]",
    "execute if score #gm lb matches 13.. run kill @e[tag=GiantMinion,limit=4,sort=random]",
    "execute store result score #vx lb if entity @e[type=minecraft:vex]",
    "execute if score #vx lb matches 7.. run kill @e[type=minecraft:vex,limit=2,sort=random]",
    `execute as @e[type=minecraft:player,tag=lb_alive,scores={lb_deaths=1..}] run function ${fn("knocked_out")}`,
    `execute unless entity @e[tag=lb_boss] run return run function ${fn("win")}`,
    `execute unless entity @a[tag=lb_alive] run function ${fn("lose")}`,
  ]);
  file("boss_tick", dispatch("tick"));
  file("knocked_out", [
    "scoreboard players reset @s lb_deaths",
    "tag @s remove lb_alive",
    "gamemode spectator @s",
    `tp @s ${p(viewpoint)} facing ${center}`,
    `tellraw @a [{selector:"@s",color:"red"},${tc(" was knocked out! They'll be back next round.", "gray")}]`,
  ]);

  const killMobs = ["kill @e[tag=lb_boss]", "kill @e[tag=lb_minion]", "kill @e[tag=GiantBoss]", "kill @e[tag=GiantMinion]", `kill @e[type=minecraft:vex,${arenaBox}]`];
  file("win", [
    "scoreboard players set #state lb 4",
    "scoreboard players set #t lb 0",
    `bossbar set ${NS}:lb_boss visible false`,
    ...killMobs,
    `title @a title ${tc("BOSS DEFEATED!", "gold", ",bold:1b")}`,
    `title @a subtitle ${tc("Grab your loot: back to the Bazaar in 8 seconds", "yellow")}`,
    ...Array.from({ length: R }, (_, i) => `execute if score #round lb matches ${i + 1} run function ${fn(`reward/${i + 1}`)}`),
    ...[0, 90, 180, 270].map((deg) => {
      const a = (deg * Math.PI) / 180;
      const fx = C[0] + Math.round(Math.sin(a) * 24);
      const fz = C[2] - Math.round(Math.cos(a) * 24);
      return `summon minecraft:firework_rocket ${fx} ${cFloor + 12} ${fz} {LifeTime:15,FireworksItem:{id:"minecraft:firework_rocket",count:1,components:{"minecraft:fireworks":{flight_duration:1,explosions:[{shape:"large_ball",colors:[I;16766720,16777215],has_twinkle:true}]}}}}`;
    }),
    "scoreboard players add #round lb 1",
    `execute if score #round lb > #rounds lb run return run function ${fn("victory")}`,
    `function ${fn("pick")}`,
  ]);
  for (let r = 1; r <= R; r++) {
    const n = 6 + 4 * r;
    file(`reward/${r}`, [
      `give @a[tag=lb_player] minecraft:emerald ${n}`,
      "give @a[tag=lb_player] minecraft:golden_apple 1",
      `tellraw @a ${tc(`Reward: ${n} emeralds and a golden apple each!`, "green")}`,
    ]);
  }
  file("victory", [
    `title @a title ${tc("LUCKY LEGENDS!", "gold", ",bold:1b")}`,
    `title @a subtitle ${tc(`You beat all ${R} bosses!`, "yellow")}`,
    `tellraw @a ${tc("You won the Lucky Block Boss Rush! Press NEW GAME (iron button) to play again.", "gold", ",bold:1b")}`,
    `data modify block ${p(nextSign)} front_text.messages set value [${tc("ALL BOSSES", "gold", ",bold:1b")},${tc("DEFEATED!", "gold", ",bold:1b")},${tc("Press NEW GAME")},${tc("to play again")}]`,
  ]);
  file("lose", [
    "scoreboard players set #state lb 4",
    "scoreboard players set #t lb 0",
    `bossbar set ${NS}:lb_boss visible false`,
    ...killMobs,
    `title @a title ${tc("DEFEATED", "dark_red", ",bold:1b")}`,
    `title @a subtitle ${tc("Shop up and try the same boss again", "gray")}`,
  ]);
  file("outro_tick", ["scoreboard players add #t lb 1", `execute if score #t lb matches 160 run function ${fn("end_round")}`]);
  file("end_round", [
    "scoreboard players set #state lb 0",
    `function ${fn("clean_arena")}`,
    "time set 6000",
    `execute as @a[tag=lb_player] run function ${fn("home")}`,
    "effect clear @a[tag=lb_player]",
    "effect give @a[tag=lb_player] minecraft:instant_health 1 10 true",
    "effect give @a[tag=lb_player] minecraft:saturation 3 10 true",
    `execute if score #round lb <= #rounds lb run function ${fn("announce")}`,
  ]);
  file("clean_arena", [...killMobs, `kill @e[type=!minecraft:player,type=!minecraft:marker,${arenaBox}]`]);

  // Per-boss functions.
  bossList.forEach((b, i) => {
    const dir = `boss/${b.key}`;
    file(`${dir}/announce`, [
      `data modify block ${p(nextSign)} front_text.messages set value [${tc("NEXT BOSS", "dark_red", ",bold:1b")},${tc(b.name.replace(/^The /, ""), b.color === "white" ? "black" : b.color, ",bold:1b")},${tc(b.sign[0])},${tc(b.sign[1])}]`,
      `tellraw @a ["",${tc("Round ", "gold")},{score:{name:"#round",objective:"lb"},color:"gold"},${tc(` of ${R}: `, "gold")},${tc(b.name, b.color, ",bold:1b")},${tc(` — ${b.hint}`, "yellow")}]`,
    ]);
    file(`${dir}/title`, [
      `title @a[tag=lb_player] title ${tc(b.name, b.color, ",bold:1b")}`,
      `title @a[tag=lb_player] subtitle ${tc(i === bossList.length - 1 ? "The final boss approaches..." : "The boss approaches...", "gray")}`,
    ]);
    file(`${dir}/spawn`, [...b.spawn, `bossbar set ${NS}:lb_boss name ${tc(b.name, b.color === "white" ? "white" : b.color, ",bold:1b")}`]);
    file(`${dir}/base`, [`scoreboard players set #hp lb ${b.base}`]);
    file(
      `${dir}/tick`,
      b.abilities.map((a, k) => `execute if score #a${k + 1} lb matches ${a.every}.. run function ${fn(`${dir}/a${k + 1}`)}`),
    );
    b.abilities.forEach((a, k) =>
      file(`${dir}/a${k + 1}`, [
        `scoreboard players set #a${k + 1} lb 0`,
        ...(a.say ? [`title @a[tag=lb_player] actionbar ${tc(a.say, b.color === "white" ? "white" : b.color, ",bold:1b")}`] : []),
        ...a.lines,
      ]),
    );
  });
  file("boss/giant_king/adopt", [
    "tag @s add lb_boss",
    `data merge entity @s {PersistenceRequired:1b,CustomNameVisible:1b,CustomName:${tc("The Giant King", "dark_green", ",bold:1b")}}`,
    // Hide the Giant Boss pack's own health bar (ours shows the scaled health).
    `execute store result storage ${NS}:lb gid int 1 run scoreboard players get @s giant_id`,
    `function ${fn("boss/giant_king/hide_bar")} with storage ${NS}:lb`,
  ]);
  file("boss/giant_king/hide_bar", ["$bossbar set giant:health_$(gid) players"]);

  // Build-time commands: order the datapack after the lucky block pack, set the world up, place it all.
  const panel = (u: number, cmd: string): string => `setblock ${p(gateAt(u, 1, -1))} minecraft:command_block[facing=up]{Command:${snbtString(cmd)},auto:0b,TrackOutput:0b}`;
  const button = (u: number, block: string) => `setblock ${p(gateAt(u, 1, 1))} minecraft:${block}[face=floor,facing=north,powered=false]`;
  const wallSign = (at: Vec, lines: string[]) =>
    `setblock ${p(at)} minecraft:spruce_wall_sign[facing=north,waterlogged=false]{front_text:{messages:[${[...lines, "", "", "", ""].slice(0, 4).map((l) => tc(l)).join(",")}],color:"black",has_glowing_text:0b},is_waxed:1b}`;
  const stallSign = (side: Side, lines: string[]) => {
    const [x, z] = frame(side, 0, 0);
    return `setblock ${p(marketAt([x, 1, z]))} minecraft:oak_wall_sign[facing=${TOWARD[side]},waterlogged=false]{front_text:{messages:[${[...lines, "", "", "", ""].slice(0, 4).map((l, k) => tc(l, k === 0 ? "dark_red" : undefined, k === 0 ? ",bold:1b" : "")).join(",")}],color:"black",has_glowing_text:0b},is_waxed:1b}`;
  };
  const forceArena = `${C[0] - A.rim} ${C[2] - A.rim} ${C[0] + A.rim} ${C[2] + A.rim}`;
  const forceMarket = `${Mk[0] - M.rim} ${Mk[2] - M.rim} ${Mk[0] + M.rim} ${Mk[2] + M.rim}`;
  const commands = [
    "reload",
    `datapack disable "file/worldsmith_game"`,
    `datapack enable "file/worldsmith_game" last`,
    ...[
      ["keep_inventory", true],
      ["immediate_respawn", true],
      ["respawn_radius", 0],
      ["spawn_mobs", false],
      ["spawn_monsters", false],
      ["spawn_wandering_traders", false],
      ["spawn_patrols", false],
      ["spawn_phantoms", false],
      ["advance_time", false],
      ["advance_weather", false],
      ["mob_griefing", false],
      ["projectiles_can_break_blocks", false],
      ["pvp", false],
      ["command_blocks_work", true],
      ["command_block_output", false],
    ].map(([k, v]) => `gamerule ${k} ${v}`),
    "time set 6000",
    "weather clear",
    "defaultgamemode adventure",
    `forceload add ${forceMarket}`,
    `forceload add ${forceArena}`,
    market.place,
    arena.place,
    panel(2, `function ${fn("fight")}`),
    panel(-2, `function ${fn("new_game")}`),
    button(2, "polished_blackstone_button"),
    button(-2, "stone_button"),
    wallSign(gateAt(4, 0, 3), ["HOW TO PLAY", "Break lucky blocks,", "beat the boss,", "shop, repeat!"]),
    wallSign(gateAt(4, 0, 2), ["▶ FIGHT!", "Press the GOLD", "button to start", "the next round"]),
    wallSign(nextSign, ["NEXT BOSS", "?", "", ""]),
    wallSign(gateAt(-4, 0, 2), ["⟲ NEW GAME", "IRON button:", "back to round 1,", "clears inventories"]),
    stallSign("north", ["Blades & Bows", "Weapons for", "every boss"]),
    stallSign("east", ["Gilded Armor", "Protection, fire", "and arrow guards"]),
    stallSign("west", ["Potions", "& Remedies", "Fire res, strength,", "totems, milk"]),
    `setworldspawn ${p(arrival)}`,
    `function ${fn("setup")}`,
  ];

  const points: Vec[] = [
    [C[0] - A.rim, cFloor - A.depth, C[2] - A.rim],
    [C[0] + A.rim, cFloor + A.air, C[2] + A.rim],
    [Mk[0] - M.rim, mFloor - M.depth, Mk[2] - M.rim],
    [Mk[0] + M.rim, mFloor + M.air, Mk[2] + M.rim],
  ];
  return { files, structures, commands, points };
}
