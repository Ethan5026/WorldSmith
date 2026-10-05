// The MCP server Claude talks to.
//
// Owner's autonomy choice (2026-10-05): Claude applies ANY in-world change instantly (commands,
// cheats/op, gamemode, gamerules, starting/stopping worlds). Only letting a new person in,
// deleting a world, and approving a new world plan need a tap in the portal — so those are
// either absent here or blocked.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { HubServices } from "./services.ts";
import { audit } from "./db.ts";

/** Commands that would let someone new in or remove the owner's control: portal only. */
const BLOCKED: { re: RegExp; why: string }[] = [
  { re: /^\/?whitelist\b/i, why: "Letting people in is done by approving join requests in the WorldSmith portal." },
  { re: /^\/?(pardon|pardon-ip)\b/i, why: "Unbanning lets someone back in; do it from the portal." },
  { re: /^\/?(stop|restart)\b/i, why: "Use the stop_world tool so WorldSmith knows the world is asleep." },
];

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function createMcpServer(config: Config, services: HubServices, clientId?: string): McpServer {
  const { worlds, access } = services;
  const server = new McpServer(
    { name: "worldsmith", title: "WorldSmith", version: "0.2.0" },
    {
      instructions:
        `WorldSmith runs ${config.ownerName}'s personal Minecraft Java server (Bedrock friends join through Geyser). ` +
        "You may change anything inside the worlds right away: run console commands, op players, change gamemodes, " +
        "gamerules, time and weather, and start or stop worlds. You cannot let new people in, delete worlds, or create " +
        "new worlds yet: new people ask by trying to join, and the owner approves them in the WorldSmith portal. " +
        "Commands run as the server console, so use player names or selectors instead of ~ coordinates relative to you.",
    },
  );
  const slugArg = z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/).optional().describe("World slug; defaults to the featured world");
  const resolve = (slug?: string): string => {
    const s = slug ?? worlds.featuredSlug();
    if (!s) throw new Error("No world is featured yet.");
    worlds.spec(s);
    return s;
  };

  server.registerTool(
    "ping",
    { title: "Ping WorldSmith", description: "Check that the WorldSmith hub is reachable.", annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: `pong from WorldSmith hub 0.2.0 at ${new Date().toISOString()}` }] }),
  );

  server.registerTool(
    "list_worlds",
    {
      title: "List worlds",
      description: "All worlds with their state (online/asleep/waking), Minecraft version, players, and which one is featured.",
      annotations: { readOnlyHint: true },
    },
    async () => json(await worlds.views()),
  );

  server.registerTool(
    "world_status",
    {
      title: "World status",
      description: "Live status of one world: online or asleep, version, and how many players are on.",
      inputSchema: { slug: slugArg },
      annotations: { readOnlyHint: true },
    },
    async ({ slug }) => json(await worlds.view(resolve(slug), true)),
  );

  server.registerTool(
    "start_world",
    { title: "Start world", description: "Wake a world up. It takes about 30 seconds to be joinable.", inputSchema: { slug: slugArg } },
    async ({ slug }) => {
      const s = resolve(slug);
      await worlds.start(s, `Claude (${clientId ?? "connector"})`);
      return json({ started: s, note: "Joinable in about 30 seconds." });
    },
  );

  server.registerTool(
    "stop_world",
    { title: "Stop world", description: "Save and put a world to sleep. Players online are disconnected.", inputSchema: { slug: slugArg } },
    async ({ slug }) => {
      const s = resolve(slug);
      await worlds.stop(s, `Claude (${clientId ?? "connector"})`);
      return json({ stopped: s });
    },
  );

  server.registerTool(
    "run_commands",
    {
      title: "Run server commands",
      description:
        "Run Minecraft console commands on a running world, in order, and return each output. Use for cheats " +
        "(op, gamemode, give, tp, time, weather, gamerule, difficulty, effect, summon, fill, setblock…). " +
        "No leading slash needed. Whitelist changes and stop/restart are not allowed here.",
      inputSchema: {
        slug: slugArg,
        commands: z.array(z.string().min(1).max(1400)).min(1).max(100).describe("Console commands, e.g. \"op Ethan5026\""),
      },
    },
    async ({ slug, commands }) => {
      const s = resolve(slug);
      for (const c of commands) {
        const hit = BLOCKED.find((b) => b.re.test(c.trim()));
        if (hit) return { isError: true, content: [{ type: "text", text: `Not allowed: "${c}". ${hit.why}` }] };
      }
      const view = await worlds.view(s, true);
      if (view.state !== "online") {
        return { isError: true, content: [{ type: "text", text: `${view.name} is ${view.state}. Start it first (start_world), then retry.` }] };
      }
      const outputs = await services.worker.rcon(s, commands.map((c) => c.trim().replace(/^\//, "")));
      audit(services.worlds.db, "claude_commands", { slug: s, clientId, commands });
      return json(commands.map((c, i) => ({ command: c, output: (outputs[i] ?? "").replace(/§./g, "") })));
    },
  );

  server.registerTool(
    "list_players",
    {
      title: "List approved players",
      description: "Everyone who is allowed to join, with their role (owner/admin/player), plus pending join requests.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      json({
        approved: access.players().map((p) => ({ name: p.name, platform: p.platform, role: p.role })),
        pendingRequests: access.pendingRequests().map((r) => ({ name: r.name, attempts: r.attempts, lastSeen: new Date(r.last_seen).toISOString() })),
        note: "Approve or decline requests in the WorldSmith portal.",
      }),
  );

  server.registerTool(
    "list_recipes",
    {
      title: "List world recipes",
      description: "World templates WorldSmith can create (e.g. OneBlock). Creating a world from one is done in the portal for now.",
      annotations: { readOnlyHint: true },
    },
    async () => json([...worlds.recipes.values()].map((r) => ({ id: r.id, name: r.name, description: r.description, tags: r.tags }))),
  );

  return server;
}
