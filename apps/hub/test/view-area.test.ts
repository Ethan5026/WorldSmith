import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import type { Config } from "../src/config.ts";
import type { HubServices } from "../src/services.ts";
import type { RenderRequest, RenderResponse } from "../src/worker-client.ts";

async function connect(worker: Partial<HubServices["worker"]>) {
  const services = {
    worlds: { featuredSlug: () => "lab", spec: () => ({}) },
    worker,
  } as unknown as HubServices;
  const server = createMcpServer({ ownerName: "Ethan" } as Config, services, "test");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return client;
}

const fake: RenderResponse = {
  pngBase64: Buffer.from("png").toString("base64"),
  width: 520,
  height: 520,
  scale: 8,
  gridStep: 10,
  regionDir: "world/dimensions/minecraft/the_nether/region",
  flushed: true,
  stats: { minY: 30, maxY: 41, missingChunks: 2, topBlocks: [["netherrack", 900]], seeThrough: [["glass", 4]] },
  features: [{ block: "oak_sign", x: 12, y: 40, z: -3, detail: '"Welcome"' }],
};

test("view_area centers on a player, marks them, follows their dimension and returns an image", async () => {
  let got: RenderRequest | undefined;
  const client = await connect({
    rcon: async () => ["Ethan5026 has the following entity data: [10.5d, 40.0d, -3.2d]", 'Ethan5026 has the following entity data: "minecraft:the_nether"'],
    render: async (_slug: string, req: RenderRequest) => {
      got = req;
      return fake;
    },
  });
  const res = (await client.callTool({ name: "view_area", arguments: { around: "Ethan5026", radius: 16, maxY: 45 } })) as {
    content: { type: string; data?: string; mimeType?: string; text?: string }[];
    isError?: boolean;
  };
  assert.ok(!res.isError);
  assert.deepEqual({ x1: got!.x1, z1: got!.z1, x2: got!.x2, z2: got!.z2 }, { x1: -6, z1: -20, x2: 26, z2: 12 });
  assert.equal(got!.dimension, "minecraft:the_nether");
  assert.equal(got!.maxY, 45);
  assert.deepEqual(got!.markers, [{ x: 10, z: -4, color: [40, 110, 240] }]);
  assert.equal(res.content[0]!.type, "image");
  assert.equal(res.content[0]!.mimeType, "image/png");
  const text = res.content[1]!.text!;
  assert.match(text, /x -6\.\.26, z -20\.\.12/);
  assert.match(text, /cut at y 45/);
  assert.match(text, /2 chunk\(s\) not generated/);
  assert.match(text, /oak_sign at 12 40 -3: "Welcome"/);
});

test("view_area needs a place to look and reports offline players", async () => {
  const client = await connect({ rcon: async () => ["No entity was found"], render: async () => fake });
  const none = (await client.callTool({ name: "view_area", arguments: {} })) as { isError?: boolean; content: { text?: string }[] };
  assert.ok(none.isError);
  assert.match(none.content[0]!.text!, /Say where to look/);
  const offline = (await client.callTool({ name: "view_area", arguments: { around: "Nobody" } })) as { isError?: boolean; content: { text?: string }[] };
  assert.ok(offline.isError);
  assert.match(offline.content[0]!.text!, /isn't online/);
});

test("propose_world accepts a full plan (base, content, builds) through MCP and lists its schema", async () => {
  let got: unknown;
  const services = {
    worlds: { featuredSlug: () => "lab", spec: () => ({}) },
    proposals: {
      proposeWorldPlan: async (plan: unknown) => {
        got = plan;
        return { id: 7, status: "pending", minecraft: "26.2", content: [], builds: [{ name: "lobby", steps: 1, kinds: ["sign"] }], crossplay: { badge: "java_bedrock", summary: "ok", questions: [], differences: [] } };
      },
    },
  } as unknown as HubServices;
  const server = createMcpServer({ ownerName: "Ethan" } as Config, services, "test");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const tools = await client.listTools();
  const tool = tools.tools.find((t) => t.name === "propose_world")!;
  assert.ok(JSON.stringify(tool.inputSchema).includes("saved"), "base kinds are in the schema");
  const res = (await client.callTool({
    name: "propose_world",
    arguments: {
      name: "OneBlock Duo",
      slug: "oneblock-duo",
      pitch: "OneBlock for you (Java) and Sam (Bedrock).",
      base: { kind: "recipe", recipe: "oneblock" },
      bedrock: "yes",
      builds: [{ name: "lobby", origin: [0, 64, 0], ops: [{ op: "sign", at: [0, 0, 0], lines: ["Hi"] }] }],
    },
  })) as { isError?: boolean; content: { text?: string }[] };
  assert.ok(!res.isError, res.content[0]?.text);
  assert.equal((got as { base: { kind: string } }).base.kind, "recipe");
  assert.match(res.content[0]!.text!, /"proposal": 7/);
});
