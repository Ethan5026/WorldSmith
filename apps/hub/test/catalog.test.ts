import { test } from "node:test";
import assert from "node:assert/strict";
import { Catalog } from "../src/catalog.ts";

// Modrinth's v2 API reports datapacks as project_type "mod" with a "datapack" loader.
const projects: Record<string, unknown> = {
  lbr: { id: "P1", slug: "lbr", title: "Lucky Block Reborn", description: "", project_type: "mod", client_side: "optional", server_side: "required", loaders: ["datapack", "fabric", "forge", "neoforge", "quilt"] },
  bentobox: { id: "P2", slug: "bentobox", title: "BentoBox", description: "", project_type: "plugin", client_side: "unsupported", server_side: "required", loaders: ["paper", "spigot"] },
};
const version = (id: string, loaders: string[], filename: string) => ({
  id,
  project_id: "x",
  version_number: "1.0",
  version_type: "release",
  loaders,
  game_versions: ["26.2"],
  files: [{ url: `https://cdn.modrinth.com/${filename}`, filename, primary: true, size: 1, hashes: { sha512: "a".repeat(128) } }],
  dependencies: [],
});

const asked: string[] = [];
const catalog = new Catalog(async (url) => {
  asked.push(url);
  const m = /\/project\/([^/?]+)(\/version\?loaders=([^&]+))?/.exec(url)!;
  if (!m[2]) return projects[decodeURIComponent(m[1]!)];
  const want = JSON.parse(decodeURIComponent(m[3]!)) as string[];
  if (m[1] === "P1") return [version("DPVER001", ["datapack"], "LuckyBlock_DP.zip"), version("FABVER01", ["fabric"], "lbr.jar")].filter((v) => v.loaders.some((l) => want.includes(l)));
  if (m[1] === "P2") return [version("PLUGIN01", ["paper"], "BentoBox.jar")].filter((v) => v.loaders.some((l) => want.includes(l)));
  return [];
});

test("catalog: a datapack listed as a 'mod' installs as a datapack on Paper", async () => {
  const r = await catalog.resolve([{ source: "modrinth", project: "lbr", why: "lucky blocks" }], "26.2", "PAPER");
  assert.deepEqual(r.issues, []);
  assert.equal(r.items[0]!.file.path, "world/datapacks/LuckyBlock_DP.zip");
  assert.equal(r.items[0]!.label, "No install needed");
});

test("catalog: on Fabric the same project loads as a mod; plugins still go to plugins/ on Paper", async () => {
  const fabric = await catalog.resolve([{ source: "modrinth", project: "lbr", why: "lucky blocks" }], "26.2", "FABRIC");
  assert.equal(fabric.items[0]!.file.path, "mods/lbr.jar");
  const paper = await catalog.resolve([{ source: "modrinth", project: "bentobox", why: "islands" }], "26.2", "PAPER");
  assert.equal(paper.items[0]!.file.path, "plugins/BentoBox.jar");
});
