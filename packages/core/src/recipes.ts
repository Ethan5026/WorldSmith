// Recipes: curated, known-good world templates (OneBlock, Vanilla, …). A recipe plus a few
// overrides becomes a WorldSpec. Phase 2's planner can start from a recipe or from scratch.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { WorldSpec, type WorldProperties } from "./world.ts";

export const Recipe = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  description: z.string(),
  /** Shown on the portal card, e.g. "Java + Bedrock · No install needed". */
  tags: z.array(z.string()).default([]),
  /** Everything except identity: slug/name come from the instance. */
  spec: WorldSpec.omit({ slug: true, name: true, recipe: true }),
  /** Commands run once over RCON after the first successful start (e.g. world setup). */
  firstStartCommands: z.array(z.string().max(32_000)).default([]),
});
export type Recipe = z.infer<typeof Recipe>;

export function loadRecipes(dir: string): Map<string, Recipe> {
  const out = new Map<string, Recipe>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const raw = parseYaml(readFileSync(path.join(dir, file), "utf8"));
    const recipe = Recipe.parse(raw);
    if (`${recipe.id}.yaml` !== file) throw new Error(`${file}: recipe id "${recipe.id}" must match its file name`);
    out.set(recipe.id, recipe);
  }
  return out;
}

export interface RecipeInstance {
  slug: string;
  name: string;
  properties?: WorldProperties;
}

export function instantiateRecipe(recipe: Recipe, inst: RecipeInstance): WorldSpec {
  return WorldSpec.parse({
    ...recipe.spec,
    slug: inst.slug,
    name: inst.name,
    recipe: recipe.id,
    properties: { ...recipe.spec.properties, motd: inst.name, ...inst.properties },
  });
}
