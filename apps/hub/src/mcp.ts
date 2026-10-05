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
import { checkBlockState, checkGamerule, LEGACY_GAMERULES, loadVersion, type McVersionData } from "@worldsmith/mcdata";
import { BuildScript } from "@worldsmith/core";

/**
 * Check and normalize one console command against the world's exact Minecraft version.
 * Translates pre-26.x game rule names; rejects invalid block states before they run.
 */
export function prepareCommand(data: McVersionData | undefined, raw: string): { command: string; note?: string } | { error: string } {
  const command = raw.trim().replace(/^\//, "");
  if (!data) return { command };
  const gr = /^gamerule\s+(\S+)(.*)$/s.exec(command);
  if (gr) {
    const r = checkGamerule(data, gr[1]!);
    if (!r.ok) return { error: `${r.error}${r.suggestions.length ? ` Did you mean: ${r.suggestions.join(", ")}?` : ""}` };
    if (r.translatedFrom) {
      let rest = gr[2] ?? "";
      if (r.note === "inverted") rest = rest.replace(/\b(true|false)\b/, (b) => (b === "true" ? "false" : "true"));
      return { command: `gamerule ${r.name}${rest}`, note: `"${r.translatedFrom}" is called "${r.name}" in ${data.version}${r.note === "inverted" ? " (meaning inverted, value flipped)" : ""}.` };
    }
    return { command };
  }
  const block =
    /^setblock\s+\S+\s+\S+\s+\S+\s+([a-z0-9_:./-]+(?:\[[^\]]*\])?)/.exec(command)?.[1] ??
    /^fill\s+(?:\S+\s+){6}([a-z0-9_:./-]+(?:\[[^\]]*\])?)/.exec(command)?.[1];
  if (block) {
    const issues = checkBlockState(data, block);
    if (issues.length) {
      return { error: issues.map((i) => `${i.error}${i.suggestions.length ? ` Valid: ${i.suggestions.slice(0, 8).join(", ")}` : ""}`).join(" ") };
    }
  }
  return { command };
}

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
        "Commands run as the server console, so use player names or selectors instead of ~ coordinates relative to you. " +
        "Minecraft 26.x differs from older versions you may remember: game rules are snake_case and some were renamed " +
        "(keep_inventory, advance_time, spawn_mobs; pvp is a game rule) — check minecraft_reference; text components in " +
        "commands are SNBT like {text:'Hi',color:'gold'}; a bare number in `worldborder set <size> <time>` is game TICKS, " +
        "so always write a unit (300s); command blocks need enable-command-block and the command_blocks_work game rule.",
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
    { title: "Start world", description: "Wake a world up. It takes about a minute to be joinable.", inputSchema: { slug: slugArg } },
    async ({ slug }) => {
      const s = resolve(slug);
      await worlds.start(s, `Claude (${clientId ?? "connector"})`);
      return json({ started: s, note: "Joinable in about a minute." });
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
        const hit = BLOCKED.find((b) => b.re.test(c.trim().replace(/^\//, "")));
        if (hit) return { isError: true, content: [{ type: "text", text: `Not allowed: "${c}". ${hit.why}` }] };
      }
      // Validate everything first, so a typo in command 7 doesn't leave commands 1–6 half-built.
      const data = loadVersion(worlds.spec(s).minecraft.version);
      const prepared = commands.map((c) => ({ original: c, ...prepareCommand(data, c) }));
      const bad = prepared.filter((p): p is { original: string; error: string } => "error" in p);
      if (bad.length) {
        return {
          isError: true,
          content: [{ type: "text", text: `Nothing was run. Fix these first:\n${bad.map((b) => `- ${b.original}: ${b.error}`).join("\n")}` }],
        };
      }
      const view = await worlds.view(s, true);
      if (view.state !== "online") {
        return { isError: true, content: [{ type: "text", text: `${view.name} is ${view.state}. Start it first (start_world), then retry.` }] };
      }
      const ready = prepared as { original: string; command: string; note?: string }[];
      const outputs = await services.worker.rcon(s, ready.map((p) => p.command));
      audit(services.worlds.db, "claude_commands", { slug: s, clientId, commands: ready.map((p) => p.command) });
      return json(
        ready.map((p, i) => ({
          command: p.command,
          ...(p.note ? { note: p.note } : {}),
          output: (outputs[i] ?? "").replace(/§./g, ""),
        })),
      );
    },
  );

  server.registerTool(
    "build",
    {
      title: "Build in a world",
      description:
        "Set up an area: floors/walls/rooms (fill, mode hollow for rooms), single blocks (set), chests with items or a " +
        "loot table, signs (up to 4 lines, plain or {text,color,bold}), command blocks (impulse/repeating/chain), " +
        "teleport pads (pressure plate + hidden command block), vanilla structures (place structure, e.g. " +
        "minecraft:village_plains), features (e.g. minecraft:oak), entities (summon), the world spawn, game rules, " +
        "or any other console command. Coordinates are relative to 'origin' (use player_position to build where " +
        "someone stands; y is the block they stand in). Everything is validated against the world's exact Minecraft " +
        "version before anything runs, a backup is taken first (the owner can restore it to undo), and the report " +
        "says what changed and what failed. If command blocks are needed and are off, the world restarts to enable " +
        "them; that's refused while players are online unless allowRestart is true (ask first).",
      inputSchema: {
        slug: slugArg,
        script: BuildScript,
        allowRestart: z.boolean().default(false),
      },
    },
    async ({ slug, script, allowRestart }) => {
      const report = await services.builds.run(resolve(slug), script, { allowRestart, by: `Claude (${clientId ?? "connector"})` });
      return { ...json(report), isError: !report.ok };
    },
  );

  server.registerTool(
    "player_position",
    {
      title: "Where is a player?",
      description: "Block position and dimension of an online player (Bedrock players have a '.' prefix, e.g. .Ethan5026). Use it as a build origin.",
      inputSchema: { slug: slugArg, player: z.string().regex(/^\.?[A-Za-z0-9_]{1,16}$/) },
      annotations: { readOnlyHint: true },
    },
    async ({ slug, player }) => {
      const s = resolve(slug);
      const [pos, dim] = await services.worker.rcon(s, [`data get entity ${player} Pos`, `data get entity ${player} Dimension`]);
      const nums = /\[(-?[\d.]+)d?, (-?[\d.]+)d?, (-?[\d.]+)d?\]/.exec(pos ?? "");
      if (!nums) return { isError: true, content: [{ type: "text" as const, text: `${player} isn't online in this world. (${(pos ?? "").slice(0, 120)})` }] };
      const block = [Math.floor(Number(nums[1])), Math.floor(Number(nums[2])), Math.floor(Number(nums[3]))];
      return json({ player, block, dimension: /"([^"]+)"/.exec(dim ?? "")?.[1] ?? "unknown" });
    },
  );

  server.registerTool(
    "backup_world",
    {
      title: "Back up a world",
      description: "Save a backup of a world now (safe while people play). Do this before big changes. Restoring backups is done by the owner in the portal.",
      inputSchema: { slug: slugArg, label: z.string().max(24).regex(/^[a-z0-9-]+$/).optional().describe("Short label, e.g. before-arena") },
    },
    async ({ slug, label }) => json(await worlds.backup(resolve(slug), label ?? "claude")),
  );

  server.registerTool(
    "list_backups",
    { title: "List backups", description: "Backups of a world, newest first.", inputSchema: { slug: slugArg }, annotations: { readOnlyHint: true } },
    async ({ slug }) => json(await worlds.listBackups(resolve(slug))),
  );

  server.registerTool(
    "minecraft_reference",
    {
      title: "Minecraft reference",
      description:
        "Exact facts for the world's Minecraft version (generated from the server itself): a block's valid " +
        "states, all game rule names and types (26.x renamed many, e.g. keepInventory → keep_inventory), " +
        "or the list of commands. Use before building with setblock/fill or changing game rules.",
      inputSchema: {
        slug: slugArg,
        kind: z.enum(["block", "gamerules", "commands", "version"]),
        name: z.string().max(64).optional().describe("Block id for kind=block, e.g. repeater or minecraft:chain_command_block"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ slug, kind, name }) => {
      const version = worlds.spec(resolve(slug)).minecraft.version;
      const data = loadVersion(version);
      if (!data) return { isError: true, content: [{ type: "text", text: `No reference data for Minecraft ${version} yet.` }] };
      if (kind === "version") {
        return json({ version: data.version, protocol: data.protocol, dataVersion: data.dataVersion, dataPackFormat: data.dataPack, javaVersion: data.javaVersion });
      }
      if (kind === "commands") return json(data.commands);
      if (kind === "gamerules") {
        return json({
          gamerules: data.gamerules,
          renamedFromOlderVersions: Object.fromEntries(Object.entries(LEGACY_GAMERULES).map(([k, v]) => [k, v.note ? `${v.name} (${v.note})` : v.name])),
        });
      }
      const id = (name ?? "").replace(/^minecraft:/, "");
      const def = data.blocks[id];
      if (!def) {
        const issues = checkBlockState(data, id || "?");
        return { isError: true, content: [{ type: "text", text: `${issues[0]?.error ?? "Unknown block"} Close matches: ${issues[0]?.suggestions.join(", ")}` }] };
      }
      return json({ block: `minecraft:${id}`, states: def.props ?? {}, default: def.default ?? {} });
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
