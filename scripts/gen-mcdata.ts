// Build a compact, committed Minecraft reference for one version from the server's own data
// generator output (see docs/builder-notes.md for how to produce data/mc-reports/<version>/).
//   node scripts/gen-mcdata.ts 26.2

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) throw new Error("usage: node scripts/gen-mcdata.ts <version>");
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = `${root}/data/mc-reports/${version}`;
const read = (f: string) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));

const meta = read("version.json");
const commands = read("commands.json");
const blocksReport = read("blocks.json") as Record<string, { properties?: Record<string, string[]>; states: { default?: boolean; properties?: Record<string, string> }[] }>;

const gamerules: Record<string, "bool" | "int"> = {};
for (const [name, node] of Object.entries<{ children?: Record<string, { parser?: string }> }>(commands.children.gamerule.children)) {
  if (name.startsWith("minecraft:")) continue;
  const parser = Object.values(node.children ?? {})[0]?.parser;
  gamerules[name] = parser === "brigadier:integer" ? "int" : "bool";
}

const blocks: Record<string, { props?: Record<string, string[]>; default?: Record<string, string> }> = {};
for (const [name, b] of Object.entries(blocksReport)) {
  const entry: { props?: Record<string, string[]>; default?: Record<string, string> } = {};
  if (b.properties) {
    entry.props = b.properties;
    entry.default = b.states.find((s) => s.default)?.properties;
  }
  blocks[name.replace(/^minecraft:/, "")] = entry;
}

const out = {
  version: meta.id,
  protocol: meta.protocol_version,
  dataVersion: meta.world_version,
  dataPack: [meta.pack_version.data_major, meta.pack_version.data_minor],
  resourcePack: [meta.pack_version.resource_major, meta.pack_version.resource_minor],
  javaVersion: meta.java_version,
  commands: Object.keys(commands.children).sort(),
  gamerules,
  blocks,
};
mkdirSync(`${root}/packages/mcdata/versions`, { recursive: true });
writeFileSync(`${root}/packages/mcdata/versions/${version}.json`, JSON.stringify(out));
console.log(
  `wrote packages/mcdata/versions/${version}.json: ${Object.keys(gamerules).length} gamerules, ` +
    `${Object.keys(blocks).length} blocks, ${out.commands.length} commands, dataVersion ${out.dataVersion}`,
);
