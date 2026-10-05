import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { compileWorld, instantiateRecipe, loadRecipes, WorldFile, WorldSpec } from "../src/index.ts";

const recipesDir = fileURLToPath(new URL("../../../recipes", import.meta.url));
const RCON = "x".repeat(32);

test("every recipe in recipes/ loads and validates", () => {
  const recipes = loadRecipes(recipesDir);
  assert.ok(recipes.has("oneblock"));
  assert.ok(recipes.has("vanilla"));
});

test("OneBlock recipe instantiates with pinned, hash-checked plugin files in the right folders", () => {
  const spec = instantiateRecipe(loadRecipes(recipesDir).get("oneblock")!, { slug: "oneblock", name: "Ethan's OneBlock" });
  assert.equal(spec.minecraft.version, "26.2");
  assert.equal(spec.minecraft.protocol, 776);
  assert.equal(spec.properties.motd, "Ethan's OneBlock");
  const paths = spec.files.map((f) => f.path);
  assert.ok(paths.includes("plugins/BentoBox-3.23.3.jar"));
  assert.ok(paths.includes("plugins/BentoBox/addons/AOneBlock-1.28.0.jar"), "add-on goes in BentoBox/addons");
  for (const f of spec.files) if (f.kind === "download") assert.match(f.sha512 ?? f.sha256 ?? "", /^[0-9a-f]{64,128}$/);
});

test("compiled worlds always enforce online-mode, whitelist and RCON secret", () => {
  const spec = instantiateRecipe(loadRecipes(recipesDir).get("oneblock")!, { slug: "ob", name: "OB" });
  const c = compileWorld(spec, { rconPassword: RCON });
  assert.equal(c.env.ONLINE_MODE, "TRUE");
  assert.equal(c.env.ENABLE_WHITELIST, "TRUE");
  assert.equal(c.env.ENFORCE_WHITELIST, "TRUE");
  assert.equal(c.env.RCON_PASSWORD, RCON);
  assert.equal(c.env.TYPE, "PAPER");
  assert.equal(c.env.MEMORY, "3072M");
  assert.equal(c.env.ENFORCE_SECURE_PROFILE, "FALSE", "Bedrock (Floodgate) players can't sign chat");
  assert.equal(c.memoryLimitBytes, (3072 + 1280) * 1024 * 1024);
  assert.throws(() => compileWorld(spec, { rconPassword: "short" }));
});

test("world files reject path traversal, absolute paths, plain http and missing hashes", () => {
  const ok = { kind: "download", source: "url", url: "https://example.com/a.jar", sha512: "a".repeat(128), path: "plugins/a.jar" };
  assert.ok(WorldFile.safeParse(ok).success);
  for (const bad of [
    { ...ok, path: "../etc/passwd" },
    { ...ok, path: "/data/plugins/a.jar" },
    { ...ok, path: "plugins/../../a.jar" },
    { ...ok, path: "plugins\\a.jar" },
    { ...ok, url: "http://example.com/a.jar" },
    { ...ok, sha512: undefined },
  ]) {
    assert.equal(WorldFile.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("slugs are DNS/container safe", () => {
  const base = { name: "x", minecraft: { version: "26.2", protocol: 776, type: "PAPER" }, memoryMb: 2048 };
  assert.ok(WorldSpec.safeParse({ ...base, slug: "lucky-blocks-2" }).success);
  for (const slug of ["Lucky", "a", "-x", "x_y", "a".repeat(40)]) {
    assert.equal(WorldSpec.safeParse({ ...base, slug }).success, false, slug);
  }
});

test("every world gets a worldsmith datapack that re-applies its game rules (26.x names)", async () => {
  const { worldDatapack, resolveGamerules, SpecError } = await import("../src/index.ts");
  const base = instantiateRecipe(loadRecipes(recipesDir).get("vanilla")!, {
    slug: "lab",
    name: "Lab",
    properties: { pvp: false, enableCommandBlock: true },
  });
  const spec = { ...base, gamerules: { keepInventory: true, doDaylightCycle: false, disableRaids: true, random_tick_speed: 6 } };
  assert.deepEqual(resolveGamerules(spec), {
    keep_inventory: true,
    advance_time: false,
    raids: false, // disableRaids=true is the inverted rule raids=false
    random_tick_speed: 6,
    pvp: false,
    command_blocks_work: true,
  });
  const files = worldDatapack(spec);
  const load = files.find((f) => f.path.endsWith("load.mcfunction"));
  assert.ok(load && load.kind === "inline" && load.content.includes("gamerule keep_inventory true"));
  const meta = files.find((f) => f.path.endsWith("pack.mcmeta"));
  assert.ok(meta && meta.kind === "inline" && JSON.parse(meta.content).pack.min_format[0] === 107);
  assert.throws(() => resolveGamerules({ ...spec, gamerules: { keepInventry: true } }), SpecError);
  assert.throws(() => resolveGamerules({ ...spec, gamerules: { keep_inventory: 3 } }), /true\/false/);
});

test("downloads accept sha256 (GeyserMC/Hangar) or sha512 (Modrinth), never neither", () => {
  const base = { kind: "download", source: "geysermc", url: "https://download.geysermc.org/x.jar", path: "plugins/x.jar" };
  assert.ok(WorldFile.safeParse({ ...base, sha256: "a".repeat(64) }).success);
  assert.ok(WorldFile.safeParse({ ...base, sha512: "a".repeat(128) }).success);
  assert.equal(WorldFile.safeParse(base).success, false);
  assert.equal(WorldFile.safeParse({ ...base, sha256: "a".repeat(63) }).success, false);
});
