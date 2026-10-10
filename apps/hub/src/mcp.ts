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
import { BuildScript, TemplateName, VOID_WORLD, WorldPlan } from "@worldsmith/core";
import { WorldFromMap } from "./proposals.ts";
import type { MapReport } from "./worker-client.ts";

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
        "gamerules, time and weather, and start or stop worlds. You cannot let new people in or delete worlds: new people " +
        "ask by trying to join, and the owner approves them in the WorldSmith portal. New worlds from public maps: " +
        "import_map (or the owner uploads the zip), then propose_world (or the shortcut propose_world_from_map); the owner " +
        "approves in the portal. Whole world ideas (base + plugins + builds) go in one propose_world plan; finished " +
        "games can be kept with save_minigame and copied later. " +
        "Commands run as the server console, so use player names or selectors instead of ~ coordinates relative to you. " +
        "Minecraft 26.x differs from older versions you may remember: game rules are snake_case and some were renamed " +
        "(keep_inventory, advance_time, spawn_mobs; pvp is a game rule) — check minecraft_reference; text components in " +
        "commands are SNBT like {text:'Hi',color:'gold'}; a bare number in `worldborder set <size> <time>` is game TICKS, " +
        "so always write a unit (300s); command blocks need enable-command-block and the command_blocks_work game rule. " +
        "Use view_area to look at the world: before building (to find a clear spot) and after (to check the result).",
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
    "set_dimensions",
    {
      title: "Void or normal Nether / End",
      description:
        "Make a world's Nether and/or End empty void (Skyblock style) or normal again. A void Nether still has " +
        "fortresses close to any portal (blazes and wither skeletons are needed to progress); a void End is empty; a " +
        "dragon End is void plus the obsidian spires with crystals, the exit portal and the dragon (no land). " +
        "The overworld is never touched. A dimension whose mode changes has its EXPLORED LAND CLEARED (anything built " +
        "or left there is gone; a safety backup is taken first, restorable in the portal), so get the owner's OK and " +
        "tell them that. The world restarts if it's running; refused while players are online unless allowRestart.",
      inputSchema: {
        slug: slugArg,
        nether: z.enum(["normal", "void"]).optional(),
        end: z.enum(["normal", "void", "dragon"]).optional().describe("dragon = void plus the obsidian spires, crystals, exit portal and dragon fight"),
        allowRestart: z.boolean().default(false),
      },
    },
    async ({ slug, nether, end, allowRestart }) => {
      if (!nether && !end) return { ...json({ error: "Say which dimension: nether and/or end." }), isError: true };
      const r = await worlds.setDimensions(resolve(slug), { nether, end }, { allowRestart });
      return json({
        world: r.world.slug,
        dimensions: { nether: nether ?? "unchanged", end: end ?? "unchanged" },
        clearedLand: r.reset,
        safetyBackup: r.safetyBackup,
        restarted: r.restarted,
      });
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
        "or any other console command. 'template' places a saved template (save_template / list_templates), rotated " +
        "or mirrored. 'voxels' draws a build as text layers with a legend (bottom layer first, rows north→south, " +
        "characters west→east, space keeps the world's block); use it for houses, arenas and anything detailed. " +
        "'hunger_games' sets up a whole game in one step: spawn pads around the center, center chests and buried hidden " +
        "barrels with loot tables, a world border that shrinks after a grace period, a countdown, eliminations and a " +
        "winner, run by a command-block control panel (Start, Reset, clock) placed at 'controls'. " +
        "'trader' places a villager (any job, or a wandering trader) with custom offers that never run out or change price. " +
        "'lucky_bosses' builds a whole Lucky Block Boss Rush (Pat & Jen style, 2-4 players): a floating Sky Colosseum and " +
        "a Lucky Bazaar market with themed traders, rounds of lucky blocks then a random boss, emerald rewards, and the Giant " +
        "King as the final boss; pair it with the Modrinth datapacks lbr and usrx-giant-boss, ideally in a void sky world " +
        `(properties levelType flat, generatorSettings ${VOID_WORLD}). ` +
        "Coordinates are relative to 'origin' (use player_position to build where " +
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

  const Vec = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
  server.registerTool(
    "save_template",
    {
      title: "Save a build as a template",
      description:
        "Copy a box of a world (exact blocks, plus chest, sign and command block contents) into the template " +
        "library, so it can be placed again anywhere, in any world, with the build tool's 'template' op (rotated " +
        "or mirrored). Corners are absolute coordinates, inclusive; up to about a million blocks. Entities (mobs, " +
        "armor stands, item frames) aren't copied. Commands inside command blocks keep their absolute coordinates, so " +
        "re-place teleport pads after pasting a template somewhere else. Saving under an existing name replaces it.",
      inputSchema: {
        slug: slugArg,
        name: TemplateName,
        from: Vec,
        to: Vec,
        dimension: z.string().regex(/^([a-z0-9_.-]+:)?[a-z0-9_.-]+$/).default("minecraft:overworld"),
        description: z.string().max(300).optional(),
      },
    },
    async ({ slug, name, from, to, dimension, description }) => {
      const s = resolve(slug);
      const data = loadVersion(worlds.spec(s).minecraft.version);
      if (!data) return { isError: true, content: [{ type: "text" as const, text: "No reference data for this world's Minecraft version." }] };
      const meta = await services.worker.captureTemplate(s, { name, from, to, dimension, description, dataVersion: data.dataVersion });
      audit(services.worlds.db, "template_saved", { name, world: s, by: `Claude (${clientId ?? "connector"})` });
      return json(meta);
    },
  );

  server.registerTool(
    "list_templates",
    {
      title: "List saved templates",
      description: "Templates in the library: size (x×y×z), block counts, what they're made of, and where they came from.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await services.worker.listTemplates()),
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

  const MARKER_COLORS = { red: [230, 40, 40], blue: [40, 110, 240], yellow: [250, 210, 30], white: [255, 255, 255], magenta: [220, 50, 220] } as const;
  const Coord = z.number().int().min(-30_000_000).max(30_000_000);
  server.registerTool(
    "view_area",
    {
      title: "See an area (top-down map)",
      description:
        "A top-down picture of part of a world, read from its saved files (works while the world sleeps; a running world " +
        "saves first so recent builds show). North is up and +x is to the right; dashed grid lines are labeled with x along " +
        "the top edge and z down the left edge. Glass is drawn see-through and water is shaded by depth. Set maxY to cut " +
        "the world off above that height, e.g. a floor's y + 3 to see a building's floor plan under its roof. Also lists " +
        "chests (with contents or loot table), signs (text), command blocks (commands) and other block entities in the " +
        "area. Give a center with a radius, two corners, or a player to look around. Up to 512×512 blocks per picture.",
      inputSchema: {
        slug: slugArg,
        around: z.string().regex(/^\.?[A-Za-z0-9_]{1,16}$/).optional().describe("Online player to center on (marked blue)"),
        center: z.object({ x: Coord, z: Coord }).optional(),
        radius: z.number().int().min(4).max(256).default(32),
        corners: z.object({ x1: Coord, z1: Coord, x2: Coord, z2: Coord }).optional().describe("Exact area instead of center/radius"),
        dimension: z.string().regex(/^([a-z0-9_.-]+:)?[a-z0-9_.-]+$/).default("minecraft:overworld"),
        maxY: z.number().int().min(-2048).max(2048).optional(),
        scale: z.number().int().min(1).max(8).optional().describe("Pixels per block; default fits about 768 px"),
        markers: z
          .array(z.object({ x: Coord, z: Coord, color: z.enum(["red", "blue", "yellow", "white", "magenta"]).default("red") }))
          .max(20)
          .optional()
          .describe("Crosses drawn at positions, e.g. where you plan to build"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ slug, around, center, radius, corners, dimension, maxY, scale, markers }) => {
      const s = resolve(slug);
      const marks = (markers ?? []).map((m) => ({ x: m.x, z: m.z, color: [...MARKER_COLORS[m.color]] as [number, number, number] }));
      let area = corners;
      let dim = dimension;
      if (around) {
        const [pos, d] = await services.worker.rcon(s, [`data get entity ${around} Pos`, `data get entity ${around} Dimension`]);
        const nums = /\[(-?[\d.]+)d?, (-?[\d.]+)d?, (-?[\d.]+)d?\]/.exec(pos ?? "");
        if (!nums) return { isError: true, content: [{ type: "text" as const, text: `${around} isn't online in this world.` }] };
        center = { x: Math.floor(Number(nums[1])), z: Math.floor(Number(nums[3])) };
        dim = /"([^"]+)"/.exec(d ?? "")?.[1] ?? dim;
        marks.push({ x: center.x, z: center.z, color: [...MARKER_COLORS.blue] as [number, number, number] });
      }
      if (!area && center) area = { x1: center.x - radius, z1: center.z - radius, x2: center.x + radius, z2: center.z + radius };
      if (!area) return { isError: true, content: [{ type: "text" as const, text: "Say where to look: around (a player), center + radius, or corners." }] };
      const r = await services.worker.render(s, { dimension: dim, ...area, maxY, scale, markers: marks });
      const [x1, x2] = [Math.min(area.x1, area.x2), Math.max(area.x1, area.x2)];
      const [z1, z2] = [Math.min(area.z1, area.z2), Math.max(area.z1, area.z2)];
      const lines = [
        `${dim} x ${x1}..${x2}, z ${z1}..${z2} at ${r.scale} px per block (north is up)${maxY !== undefined ? `, cut at y ${maxY}` : ""}. Grid every ${r.gridStep} blocks.`,
        `Ground/top y ranges ${r.stats.minY}..${r.stats.maxY}.${r.stats.missingChunks ? ` ${r.stats.missingChunks} chunk(s) not generated yet (checkered).` : ""}${r.flushed ? "" : " (World not running: showing the last save.)"}`,
        `Top surface blocks: ${r.stats.topBlocks.map(([b, n]) => `${b} ${n}`).join(", ") || "none"}.`,
        ...(r.stats.seeThrough.length ? [`Seen through: ${r.stats.seeThrough.map(([b, n]) => `${b} ${n}`).join(", ")}.`] : []),
        ...(r.features.length
          ? [`Block entities (${r.features.length}${r.features.length === 100 ? ", first 100" : ""}):`, ...r.features.map((f) => `- ${f.block} at ${f.x} ${f.y} ${f.z}${f.detail ? `: ${f.detail}` : ""}`)]
          : ["No chests, signs or command blocks here."]),
      ];
      return {
        content: [
          { type: "image" as const, data: r.pngBase64, mimeType: "image/png" },
          { type: "text" as const, text: lines.join("\n") },
        ],
      };
    },
  );

  // ---- public maps ----
  const mapSummary = (m: MapReport) => ({
    id: m.id,
    source: m.source,
    sizeMb: Math.round(m.zipBytes / 1024 / 1024),
    worlds: m.worlds.map((w) => ({
      root: w.root,
      name: w.levelName,
      minecraft: w.version ?? "1.8 or older",
      upgradedOnFirstStart: w.needsUpgrade,
      gameMode: w.gameMode,
      difficulty: w.difficulty,
      spawn: w.spawn,
      regionFiles: w.dimensions,
      datapacks: w.datapacks,
      savedStructures: w.structures,
      resourcePack: w.hasResourcePack,
    })),
    warnings: m.warnings,
    notInstalled: m.skippedCount ? `${m.skippedCount} file(s), e.g. ${m.skipped.slice(0, 5).map((s) => `${s.path} (${s.reason})`).join("; ")}` : "nothing",
  });

  server.registerTool(
    "import_map",
    {
      title: "Download a public map",
      description:
        "Download a Java Edition map zip from a direct https link (a CurseForge file download, a map maker's direct " +
        "link…) and check it: the worlds inside, the Minecraft version that saved it, game mode, spawn, datapacks, " +
        "size and anything suspicious. Nothing is installed or run. Sites that block automatic downloads (Planet " +
        "Minecraft and most map pages) need the owner to download the zip and upload it in the WorldSmith portal " +
        "(Maps); find it with list_maps afterwards. Then use propose_world_from_map. Respect map makers' terms: " +
        "keep maps private to this server and credit the author.",
      inputSchema: { url: z.url({ protocol: /^https$/ }) },
    },
    async ({ url }) => {
      const report = await services.worker.importMap(url);
      audit(services.worlds.db, "map_imported", { id: report.id, source: "url", url, by: `Claude (${clientId ?? "connector"})` });
      return json(mapSummary(report));
    },
  );

  server.registerTool(
    "list_maps",
    {
      title: "List downloaded maps",
      description: "Maps already downloaded or uploaded by the owner, newest first, with what's inside each.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json((await services.worker.listMaps()).map(mapSummary)),
  );

  server.registerTool(
    "propose_world_from_map",
    {
      title: "Propose a world from a map",
      description:
        "Ask the owner to create a new world from a downloaded map. New worlds need the owner's approval: they get a " +
        "notification and approve in the portal. If Bedrock players may join (bedrock: yes or unknown), the portal " +
        "also asks them how closely textures and behavior must match on Bedrock; relay the crossplay summary from " +
        "the result so they know what differs. Put your pitch and plans for the world (lobby, rules, chests…) in notes. " +
        "Check back with proposal_status; once approved, the world exists (asleep) and you can build in it.",
      inputSchema: WorldFromMap.shape,
    },
    async (args) => {
      const view = await services.proposals.proposeWorldFromMap(args, `Claude (${clientId ?? "connector"})`);
      return json({
        proposal: view.id,
        status: view.status,
        crossplay: { summary: view.crossplay.summary, questionsForOwner: view.crossplay.questions.map((q) => q.prompt), differences: view.crossplay.differences.map((d) => `${d.feature}: Java: ${d.java} Bedrock: ${d.bedrock}`) },
        next: "The owner was notified and decides in the WorldSmith portal. Use proposal_status to see the outcome.",
      });
    },
  );

  server.registerTool(
    "proposal_status",
    {
      title: "Check a proposal",
      description: "Whether the owner approved, declined, or is still deciding on a proposal (and the new world's slug once built).",
      inputSchema: { id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const v = await services.proposals.get(id);
      return json({
        id: v.id,
        title: v.title,
        status: v.status,
        world: v.result?.slug,
        error: v.result?.error,
        ownerNote: v.result?.replacedBy ? undefined : v.result?.note,
        replacedBy: v.result?.replacedBy,
        builds: v.result?.builds,
        next: v.result?.replacedBy
          ? `You replaced this plan with #${v.result.replacedBy}; follow that one instead.`
          : v.status === "declined" && v.result?.note
            ? "The owner sent this back with a note: revise the plan and propose it again."
            : v.status === "approved"
              ? v.result?.error
                ? "The world exists (asleep), but see the error: check it with view_area and finish it with build."
                : "The world exists (asleep). Use view_area to look at it and build to change it."
              : undefined,
      });
    },
  );

  server.registerTool(
    "search_catalog",
    {
      title: "Search plugins, mods and datapacks",
      description:
        "Search Modrinth for content that has a build for the given Minecraft version (default: the version WorldSmith " +
        "runs, 26.2). Plugins work on Paper worlds (all current recipes); datapacks work everywhere; mods need a modded " +
        "base. Results say whether friends must install anything. Use the project slug in a world plan's content.",
      inputSchema: {
        query: z.string().min(2).max(100),
        kind: z.enum(["plugin", "datapack", "mod"]).default("plugin"),
        minecraft: z.string().regex(/^\d+(\.\d+){1,2}$/).default("26.2"),
        limit: z.number().int().min(1).max(20).default(8),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, kind, minecraft, limit }) => json(await services.proposals.catalog.search(query, kind, minecraft, limit)),
  );

  server.registerTool(
    "propose_world",
    {
      title: "Propose a world plan",
      description:
        "Propose a whole new world in one card the owner approves once: a base (a recipe from list_recipes, a downloaded " +
        "map from list_maps, or a saved minigame from list_minigames), extra Modrinth content (search_catalog; versions " +
        "and dependencies are resolved and hash-pinned for you), settings, game rules, and build steps (same format as " +
        "the build tool: lobbies, templates, voxels, hunger_games…) that run right after the world is created. " +
        "Everything is checked first; if something needs fixing you get the list and nothing is filed. Relay the " +
        "crossplay summary to the owner when Bedrock players may join; the portal asks them the texture/behavior " +
        "questions. Then watch proposal_status: the owner may approve, decline, or send it back with a note. To revise a " +
        "plan the owner hasn't acted on yet, propose again with the same slug: the new card replaces your old one.",
      inputSchema: WorldPlan.shape,
    },
    async (args) => {
      const v = await services.proposals.proposeWorldPlan(args, `Claude (${clientId ?? "connector"})`);
      return json({
        proposal: v.id,
        status: v.status,
        minecraft: v.minecraft,
        content: v.content.map((c) => `${c.title} ${c.version} · ${c.label}${c.requiredBy ? ` (needed by ${c.requiredBy})` : ""}`),
        builds: v.builds,
        crossplay: {
          badge: v.crossplay.badge,
          summary: v.crossplay.summary,
          questionsForOwner: v.crossplay.questions.map((q) => q.prompt),
          differences: v.crossplay.differences.map((d) => `${d.feature}: Java: ${d.java} Bedrock: ${d.bedrock}`),
        },
        next: "The owner was notified and decides in the WorldSmith portal. Use proposal_status to see the outcome.",
      });
    },
  );

  server.registerTool(
    "save_minigame",
    {
      title: "Save a world as a minigame",
      description:
        "Save a world as a reusable minigame: the map, builds, game kits, plugins and their settings. Player data and " +
        "access lists are left out, so every copy starts fresh. Copies are made with propose_world using base " +
        "{kind: 'saved', game: <name>} (the owner approves each copy). Saving under an existing name replaces it.",
      inputSchema: {
        slug: slugArg,
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe("Short id, e.g. disney-hunger-games"),
        title: z.string().min(1).max(60),
        description: z.string().max(500).optional(),
      },
    },
    async ({ slug, name, title, description }) => {
      const s = resolve(slug);
      const g = await worlds.saveAsGame(s, { name, title, description });
      return json({ name: g.name, title: g.title, savedFrom: g.source, sizeMb: Math.max(1, Math.round(g.bytes / 1024 / 1024)) });
    },
  );

  server.registerTool(
    "list_minigames",
    {
      title: "List saved minigames",
      description: "Saved minigames that can be copied into new worlds.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      json(
        (await services.worker.listGames()).map((g) => ({
          name: g.name,
          title: g.title,
          description: g.description,
          savedFrom: g.source,
          savedAt: g.createdAt,
          minecraft: g.spec.minecraft.version,
          sizeMb: Math.max(1, Math.round(g.bytes / 1024 / 1024)),
        })),
      ),
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
