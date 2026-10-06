// WorldPlan: one card for a whole world idea. Claude writes it; the owner approves it once in the
// portal. A base (recipe or downloaded map), extra content from Modrinth (plugins, datapacks), settings,
// and build steps (lobbies, game kits…) that run right after the world is created.

import { z } from "zod";
import { BuildScript } from "./build.ts";
import { BehaviorCompat, TextureCompat } from "./crossplay.ts";
import { WorldProperties } from "./world.ts";

export const PlanContent = z.object({
  source: z.literal("modrinth"),
  /** Modrinth project slug or id, e.g. "luckyblock-ashkiano". */
  project: z.string().regex(/^[A-Za-z0-9_-]{2,64}$/),
  why: z.string().max(300).describe("What it adds to this world, in a sentence"),
  /** Pin a specific version id; default: newest release for the world's Minecraft version. */
  version: z.string().regex(/^[A-Za-z0-9]{8}$/).optional(),
  crossplay: z
    .object({ textures: TextureCompat, behavior: BehaviorCompat, note: z.string().max(200).optional() })
    .optional()
    .describe("Your read on how it works for Bedrock players (Geyser); default is a cautious guess"),
});
export type PlanContent = z.infer<typeof PlanContent>;

export const WorldPlan = z.object({
  name: z.string().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/, "lowercase letters, digits and dashes (2-31)"),
  pitch: z.string().min(1).max(2000).describe("What the owner gets, in plain words"),
  base: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("recipe"), recipe: z.string().regex(/^[a-z0-9-]+$/) }),
    z.object({ kind: z.literal("map"), mapId: z.string().regex(/^\d{8}-\d{6}-[0-9a-f]{6}$/), root: z.string().max(300).default("") }),
    z.object({ kind: z.literal("saved"), game: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe("A saved minigame (list_minigames)") }),
  ]),
  bedrock: z.enum(["yes", "no", "unknown"]).default("unknown").describe("Will anyone join from Bedrock?"),
  content: z.array(PlanContent).max(30).default([]),
  properties: WorldProperties.optional(),
  gamerules: z.record(z.string().regex(/^[a-z_]+$/), z.union([z.boolean(), z.number().int()])).optional(),
  builds: z.array(BuildScript).max(10).default([]).describe("Run in order right after the world is created"),
});
export type WorldPlan = z.infer<typeof WorldPlan>;
