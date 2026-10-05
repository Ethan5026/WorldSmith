// Version-exact Minecraft facts for validating what Claude (or a recipe) asks for, before it runs.
// Data comes from the server jar's own data generator (scripts/gen-mcdata.ts), so it's never stale
// for the versions we host.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface McVersionData {
  version: string;
  protocol: number;
  /** Goes into structure .nbt files and level data (DataVersion). */
  dataVersion: number;
  /** Data pack format [major, minor]. */
  dataPack: [number, number];
  resourcePack: [number, number];
  javaVersion: number;
  commands: string[];
  gamerules: Record<string, "bool" | "int">;
  blocks: Record<string, { props?: Record<string, string[]>; default?: Record<string, string> }>;
}

const cache = new Map<string, McVersionData | null>();

export function loadVersion(version: string): McVersionData | undefined {
  if (!cache.has(version)) {
    const file = fileURLToPath(new URL(`../versions/${version}.json`, import.meta.url));
    cache.set(version, existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as McVersionData) : null);
  }
  return cache.get(version) ?? undefined;
}

/**
 * Pre-26.x camelCase game rule names → 26.x names. Most are a plain snake_case rename; the ones
 * marked "renamed" changed meaning or wording, and "inverted" ones flipped true/false.
 */
export const LEGACY_GAMERULES: Record<string, { name: string; note?: "renamed" | "inverted" }> = {
  announceAdvancements: { name: "show_advancement_messages", note: "renamed" },
  blockExplosionDropDecay: { name: "block_explosion_drop_decay" },
  commandBlockOutput: { name: "command_block_output" },
  commandModificationBlockLimit: { name: "max_block_modifications", note: "renamed" },
  disableElytraMovementCheck: { name: "elytra_movement_check", note: "inverted" },
  disablePlayerMovementCheck: { name: "player_movement_check", note: "inverted" },
  disableRaids: { name: "raids", note: "inverted" },
  doDaylightCycle: { name: "advance_time", note: "renamed" },
  doEntityDrops: { name: "entity_drops", note: "renamed" },
  doImmediateRespawn: { name: "immediate_respawn" },
  doInsomnia: { name: "spawn_phantoms", note: "renamed" },
  doLimitedCrafting: { name: "limited_crafting" },
  doMobLoot: { name: "mob_drops", note: "renamed" },
  doMobSpawning: { name: "spawn_mobs", note: "renamed" },
  doPatrolSpawning: { name: "spawn_patrols", note: "renamed" },
  doTileDrops: { name: "block_drops", note: "renamed" },
  doTraderSpawning: { name: "spawn_wandering_traders", note: "renamed" },
  doVinesSpread: { name: "spread_vines", note: "renamed" },
  doWardenSpawning: { name: "spawn_wardens", note: "renamed" },
  doWeatherCycle: { name: "advance_weather", note: "renamed" },
  drowningDamage: { name: "drowning_damage" },
  enderPearlsVanishOnDeath: { name: "ender_pearls_vanish_on_death" },
  fallDamage: { name: "fall_damage" },
  fireDamage: { name: "fire_damage" },
  forgiveDeadPlayers: { name: "forgive_dead_players" },
  freezeDamage: { name: "freeze_damage" },
  globalSoundEvents: { name: "global_sound_events" },
  keepInventory: { name: "keep_inventory" },
  lavaSourceConversion: { name: "lava_source_conversion" },
  locatorBar: { name: "locator_bar" },
  logAdminCommands: { name: "log_admin_commands" },
  maxCommandChainLength: { name: "max_command_sequence_length", note: "renamed" },
  maxCommandForkCount: { name: "max_command_forks", note: "renamed" },
  maxEntityCramming: { name: "max_entity_cramming" },
  minecartMaxSpeed: { name: "max_minecart_speed", note: "renamed" },
  mobExplosionDropDecay: { name: "mob_explosion_drop_decay" },
  mobGriefing: { name: "mob_griefing" },
  naturalRegeneration: { name: "natural_health_regeneration", note: "renamed" },
  playersNetherPortalCreativeDelay: { name: "players_nether_portal_creative_delay" },
  playersNetherPortalDefaultDelay: { name: "players_nether_portal_default_delay" },
  playersSleepingPercentage: { name: "players_sleeping_percentage" },
  projectilesCanBreakBlocks: { name: "projectiles_can_break_blocks" },
  randomTickSpeed: { name: "random_tick_speed" },
  reducedDebugInfo: { name: "reduced_debug_info" },
  sendCommandFeedback: { name: "send_command_feedback" },
  showDeathMessages: { name: "show_death_messages" },
  snowAccumulationHeight: { name: "max_snow_accumulation_height", note: "renamed" },
  spawnRadius: { name: "respawn_radius", note: "renamed" },
  spawnerBlocksEnabled: { name: "spawner_blocks_work", note: "renamed" },
  spectatorsGenerateChunks: { name: "spectators_generate_chunks" },
  tntExplodes: { name: "tnt_explodes" },
  tntExplosionDropDecay: { name: "tnt_explosion_drop_decay" },
  universalAnger: { name: "universal_anger" },
  waterSourceConversion: { name: "water_source_conversion" },
};

export type GameruleCheck =
  | { ok: true; name: string; type: "bool" | "int"; translatedFrom?: string; note?: "renamed" | "inverted" }
  | { ok: false; error: string; suggestions: string[] };

/** Resolve a game rule name for this version, translating legacy names. */
export function checkGamerule(data: McVersionData, raw: string): GameruleCheck {
  const name = raw.replace(/^minecraft:/, "");
  const type = data.gamerules[name];
  if (type) return { ok: true, name, type };
  const legacy = LEGACY_GAMERULES[name];
  const legacyType = legacy ? data.gamerules[legacy.name] : undefined;
  if (legacy && legacyType) return { ok: true, name: legacy.name, type: legacyType, translatedFrom: name, note: legacy.note };
  return { ok: false, error: `No game rule "${raw}" in Minecraft ${data.version}.`, suggestions: closest(name, Object.keys(data.gamerules)) };
}

export interface ParsedBlockState {
  block: string;
  props: Record<string, string>;
  /** Raw SNBT block entity data, if present ({...}); not parsed here. */
  nbt?: string;
}

/** Parse "minecraft:repeater[facing=east,delay=2]{...}" (the NBT part is kept raw). */
export function parseBlockState(input: string): ParsedBlockState {
  const m = /^(?:minecraft:)?([a-z0-9_./-]+)(?:\[([^\]]*)\])?(\{[\s\S]*\})?$/.exec(input.trim());
  if (!m) throw new Error(`Not a block state: ${input}`);
  const props: Record<string, string> = {};
  for (const pair of (m[2] ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (!k || v === undefined) throw new Error(`Bad block property "${pair}" in ${input}`);
    props[k] = v;
  }
  return { block: m[1]!, props, nbt: m[3] };
}

export interface BlockStateIssue {
  error: string;
  suggestions: string[];
}

/** Check a block id and its properties against this version's block registry. */
export function checkBlockState(data: McVersionData, input: string): BlockStateIssue[] {
  let parsed: ParsedBlockState;
  try {
    parsed = parseBlockState(input);
  } catch (err) {
    return [{ error: (err as Error).message, suggestions: [] }];
  }
  const def = data.blocks[parsed.block];
  if (!def) {
    return [{ error: `Unknown block "${parsed.block}" in Minecraft ${data.version}.`, suggestions: closest(parsed.block, Object.keys(data.blocks)) }];
  }
  const issues: BlockStateIssue[] = [];
  for (const [k, v] of Object.entries(parsed.props)) {
    const values = def.props?.[k];
    if (!values) {
      issues.push({
        error: `${parsed.block} has no property "${k}".`,
        suggestions: Object.keys(def.props ?? {}).map((p) => `${p}=${def.props![p]!.join("|")}`),
      });
    } else if (!values.includes(v)) {
      issues.push({ error: `${parsed.block}[${k}=${v}] isn't valid.`, suggestions: values.map((x) => `${k}=${x}`) });
    }
  }
  return issues;
}

/** pack.mcmeta for a data pack targeting exactly this version. */
export function datapackMeta(data: McVersionData, description: string): string {
  return JSON.stringify(
    { pack: { description, min_format: data.dataPack, max_format: data.dataPack } },
    null,
    2,
  );
}

function closest(target: string, candidates: string[], n = 3): string[] {
  const dist = (a: string, b: string): number => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length]![b.length]!;
  };
  const t = target.toLowerCase().replace(/[^a-z0-9]/g, "");
  return candidates
    .map((c) => ({ c, d: dist(t, c.replace(/[^a-z0-9]/g, "")) - (c.includes(target) || target.includes(c) ? 3 : 0) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.c);
}
