// Every world gets a generated "worldsmith" data pack. Its load function re-applies the world's
// game rules on every boot and /reload, so settings can't drift. The builder (Phase 2) adds its
// functions, structures and loot tables to the same pack.

import { checkGamerule, datapackMeta, loadVersion } from "@worldsmith/mcdata";
import type { WorldFile, WorldSpec } from "./world.ts";

/** itzg's default level name; data packs live in <level>/datapacks. */
export const LEVEL_NAME = "world";
export const DATAPACK_DIR = `${LEVEL_NAME}/datapacks/worldsmith`;

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

/** Game rules as the world's version spells them (legacy names translated, unknown ones rejected). */
export function resolveGamerules(spec: WorldSpec): Record<string, boolean | number> {
  const data = loadVersion(spec.minecraft.version);
  const wanted: Record<string, boolean | number> = { ...spec.gamerules };
  // In 26.x PvP moved from server.properties to a game rule.
  if (spec.properties.pvp !== undefined && data?.gamerules.pvp) wanted.pvp = spec.properties.pvp;
  if (spec.properties.enableCommandBlock && data?.gamerules.command_blocks_work) wanted.command_blocks_work = true;
  if (!data) return wanted; // no reference for this version: pass through, the server will validate
  const out: Record<string, boolean | number> = {};
  for (const [raw, value] of Object.entries(wanted)) {
    const r = checkGamerule(data, raw);
    if (!r.ok) throw new SpecError(`${r.error}${r.suggestions.length ? ` Did you mean ${r.suggestions.join(", ")}?` : ""}`);
    if ((r.type === "bool") !== (typeof value === "boolean")) {
      throw new SpecError(`Game rule ${r.name} takes ${r.type === "bool" ? "true/false" : "a whole number"}, not ${JSON.stringify(value)}.`);
    }
    out[r.name] = r.note === "inverted" && typeof value === "boolean" ? !value : value;
  }
  return out;
}

const VOID_LAYERS = [{ block: "minecraft:air", height: 1 }];
const flat = (biome: string, structureSets: string[]) => ({
  type: "minecraft:flat",
  settings: { layers: VOID_LAYERS, biome, structure_overrides: structureSets, features: false, lakes: false },
});
/**
 * Dimension definitions for the Nether and the End. 26.x keeps no generator in the world folder: it
 * builds them from data packs at every start, so these files decide how new land generates. "normal"
 * writes the vanilla definitions back (a pack file can't be removed by re-applying, only replaced).
 */
/**
 * A void Nether has no land between structures, so vanilla's spacing (one fortress-or-bastion per
 * ~430-block region) can leave the nearest fortress 450+ blocks from a portal. Void Nethers place
 * fortresses on their own tight grid instead: one start in every 8×8-chunk cell, offset at most 4
 * chunks, so no point is more than ~140 blocks from a fortress start. Bastions keep vanilla spacing.
 */
export const VOID_FORTRESS_SPACING = { spacing: 8, separation: 4 } as const;
const VOID_STRUCTURE_SETS = {
  void_fortresses: { placement: { type: "minecraft:random_spread", salt: 14357621, ...VOID_FORTRESS_SPACING }, structures: [{ structure: "minecraft:fortress", weight: 1 }] },
  void_bastions: { placement: { type: "minecraft:random_spread", salt: 30084232, spacing: 27, separation: 4 }, structures: [{ structure: "minecraft:bastion_remnant", weight: 1 }] },
};

const DIMENSIONS = {
  nether: {
    file: "the_nether",
    void: { type: "minecraft:the_nether", generator: flat("minecraft:nether_wastes", ["worldsmith:void_fortresses", "worldsmith:void_bastions"]) },
    normal: {
      type: "minecraft:the_nether",
      generator: { type: "minecraft:noise", settings: "minecraft:nether", biome_source: { type: "minecraft:multi_noise", preset: "minecraft:nether" } },
    },
  },
  end: {
    file: "the_end",
    void: { type: "minecraft:the_end", generator: flat("minecraft:the_end", []) },
    normal: { type: "minecraft:the_end", generator: { type: "minecraft:noise", settings: "minecraft:end", biome_source: { type: "minecraft:the_end" } } },
  },
} as const;

/** Folder names a dimension's land lives under (26.x layout, then the pre-26 layout of older maps). */
export const DIMENSION_DIRS: Record<"nether" | "end", string[]> = {
  nether: [`${LEVEL_NAME}/dimensions/minecraft/the_nether`, `${LEVEL_NAME}/DIM-1`],
  end: [`${LEVEL_NAME}/dimensions/minecraft/the_end`, `${LEVEL_NAME}/DIM1`],
};

export function dimensionFiles(spec: WorldSpec): WorldFile[] {
  const dims = spec.properties.dimensions ?? {};
  return (["nether", "end"] as const).flatMap((d) => {
    const mode = dims[d];
    if (!mode) return [];
    const def = DIMENSIONS[d];
    const file = (path: string, value: unknown): WorldFile => ({ kind: "inline", encoding: "utf8", path: `${DATAPACK_DIR}/${path}`, content: JSON.stringify(value, null, 2) });
    return [
      file(`data/minecraft/dimension/${def.file}.json`, def[mode]),
      ...(d === "nether" ? Object.entries(VOID_STRUCTURE_SETS).map(([name, set]) => file(`data/worldsmith/worldgen/structure_set/${name}.json`, set)) : []),
    ];
  });
}

export function worldDatapack(spec: WorldSpec): WorldFile[] {
  const data = loadVersion(spec.minecraft.version);
  const gamerules = resolveGamerules(spec);
  const load = [
    "# Generated by WorldSmith. Re-applied on every start and /reload.",
    ...Object.entries(gamerules).map(([k, v]) => `gamerule ${k} ${v}`),
    "",
  ].join("\n");
  const meta = data
    ? datapackMeta(data, `WorldSmith settings for ${spec.name}`)
    : JSON.stringify({ pack: { description: `WorldSmith settings for ${spec.name}` } });
  return [
    { kind: "inline", encoding: "utf8", path: `${DATAPACK_DIR}/pack.mcmeta`, content: meta },
    { kind: "inline", encoding: "utf8", path: `${DATAPACK_DIR}/data/minecraft/tags/function/load.json`, content: JSON.stringify({ values: ["worldsmith:load"] }) },
    { kind: "inline", encoding: "utf8", path: `${DATAPACK_DIR}/data/worldsmith/function/load.mcfunction`, content: load },
    ...dimensionFiles(spec),
  ];
}
