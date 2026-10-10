# WorldSmith: session handoff

Last updated 2026-10-10. Branch `phase-1`. Remote: `https://github.com/Ethan5026/WorldSmith.git`.

The goal of this document: let a fresh session pick up the work without re-deriving anything.
It gives the product and the owner's rules, how to run and ship changes, what's done, what's next, and the traps already found.

---

## 1. What WorldSmith is

A personal Minecraft server for the owner (Ethan, Minecraft name `Ethan5026`) and friends.

The owner describes a world in the **Claude app** on their phone. Claude plans and builds it through WorldSmith's **custom MCP connector**. The owner approves things and manages friends in a **tailnet-only portal (PWA)**, and friends join on **Java or Bedrock** through one public address.

The owner's stated priority is **the Claude world builder**: finding and loading public maps, and editing worlds (areas, chests, signs, lobbies, command blocks, minigames). Hosting polish comes last.

## 2. Owner rules (non-negotiable)

These also live in Claude's auto-memory. The code enforces them; keep it that way.

- **Autonomy: "anything on my worlds, instantly".** Through MCP, Claude may change anything inside a world without confirmation: commands, op, gamemode, game rules, builds, start/stop. Three things need the owner's tap in the portal:
  - letting a **new person** in (whitelist/access);
  - **deleting a world** (portal only; MCP has no delete);
  - **approving a new world** (proposals / world plans).

  MCP `run_commands` and build `command` ops block `whitelist|op|deop|pardon|stop|restart|ban`.
- **Crossplay requirement.** Whenever Bedrock players may join, the plan must list the Java/Bedrock differences and ask the owner to prioritize **textures** and **behavior** separately (must match / close enough / Java first). Approval is blocked until both are answered (`packages/core/src/crossplay.ts`, enforced in `apps/hub/src/proposals.ts`).
- **Mods are labeled** "No install needed" or "Friends install pack".
- **Wake on join; one featured address.** Approved friends can wake and play any time. The owner gets a quiet "X is playing" push, and each world can be set to "only when I'm playing".
- **Secrets.**
  - `deploy/.env` (gitignored) holds `WORKER_TOKEN`, `PLAYIT_SECRET` and `FLOODGATE_KEY_B64`.
  - **Never print or paste them.** Scripts read them from the file.
- **Tailscale.** Use only the owner's tailnet `tail072963.ts.net` (never "Lee's" tailnet). Don't change the laptop's own Tailscale login.
- **Map sources.** Never bypass bot protection (Planet Minecraft returns 403 to bots). The owner downloads the zip and uploads it in the portal. CurseForge CDN direct links are fine. Keep "All Rights Reserved" maps private, and never republish them.
- **Licensing.** Don't redistribute uNmINeD; we have our own renderer.
- **Laptop care.**
  - Don't restart WSL/Docker while the owner may have terminals open.
  - Don't restart background watchers that were killed for low memory unless asked.
  - Docker has about 10 GB (`.wslconfig`).
- **Process.**
  - Commit as you go and push to `phase-1`.
  - Run with `set -o pipefail`; commit only when tests show `ℹ fail 0`.
  - End commit messages with the co-author lines from the session's system reminder.
- **Communication.** Keep the owner updated in plain language at each checkpoint. Ask them to do the steps that need their phone or accounts.

## 3. Hardware and network

- **Now:** the **laptop** (Windows 11, i7-11800H, 16 GB, Docker Desktop) runs everything as one box: hub + worker.
- **Later:**
  - A **mini PC** (Linux) takes over as the single box. Moving there must stay a supported operation (Phase 4).
  - The HP t240 is optional or retired.
- **Laptop network quirks:**
  - The Wi-Fi address is `192.168.40.177` (DHCP). It's saved in the portal's `lan_address` setting.
  - **NordVPN** (NordLynx adapter) is installed; its "Invisibility on LAN" setting can block Wi-Fi play.
  - Windows marks the Wi-Fi as **Public**. Docker Desktop's inbound rules already allow TCP and UDP on Public.
- **Addresses:**
  - **Java (playit):** `pgsql-bucks.tun.ply.gg`.
  - **Bedrock:** `147.185.221.214:23224`.
  - **Portal:** `https://worldsmith.tail072963.ts.net:8443` (tailnet only).
  - **Claude connector:** `https://worldsmith.tail072963.ts.net/mcp` (Tailscale Funnel, OAuth).

## 4. Architecture (as built)

```
Phone ─ Claude app ─(OAuth, Funnel :443)─► hub public listener :3001  (/mcp, /oauth, /.well-known, /invite)
Phone ─ portal PWA ─(tailnet :8443)──────► hub private listener :3000 (owner only, Tailscale identity headers)
Friends ─ playit (Java TCP + Bedrock UDP) ─► gatekeeper netns:
      gatekeeper :25565 (+ Wi-Fi ports 25570-25579)  ◄─ Geyser :19132 (Bedrock → Java, Floodgate)
      gatekeeper ⇄ hub over a Unix socket (/ipc/hub.sock): status + login decisions
      gatekeeper pipes approved players to ws-world-<slug>:25565 on the internal "worlds" network
hub ─(HTTP, bearer token)─► worker :7070 (docker.sock) ─► one itzg/minecraft-server container per world
```

**Compose services** (`deploy/compose.yaml`, project `worldsmith`):
- `ts`: Tailscale sidecar, kernel tun mode (required, otherwise identity headers can be forged).
- `hub`: `network_mode: service:ts`.
- `gatekeeper`.
- `playit` and `geyser`: both `network_mode: service:gatekeeper`.
- `worker`: profile `worker`.

**Workspace (pnpm, Node 24 running TypeScript directly, zod v4, `node:test`):**

| Path | What |
|---|---|
| `packages/mcproto` | Minecraft protocol codec (handshake/status/login), status ping, RCON client (non-pipelined) |
| `packages/mcdata` | Generated 26.2 data (blocks, commands, game rules, data versions); `checkBlockState`, `checkGamerule`, `datapackMeta` |
| `packages/mcworld` | NBT read/write; Anvil region/chunk reader; top-down PNG renderer; block-entity summaries; structure templates (capture, voxels, build) |
| `packages/core` | `WorldSpec` → itzg env compiler (incl. `generatorSettings`, `VOID_WORLD`); recipes; per-world datapack; crossplay evaluation; `BuildScript` compiler; Hunger Games kit (`games.ts`); Lucky Block Boss Rush kit (`lucky.ts`); traders (`trade.ts`); `WorldPlan` (`plan.ts`) |
| `apps/hub` | OAuth AS; MCP server (`mcp.ts`); portal API (`private-app.ts`) and PWA (`portal/`); gate decisions (`gate.ts`); access/friends/invites; worlds; builds; proposals (world plans); Modrinth catalog (`catalog.ts`); push; SQLite (`db.ts`) |
| `apps/worker` | Docker runtime per world; backups; map import (`maps.ts`); render; template library; saved minigames (`games.ts`) |
| `apps/gatekeeper` | TCP front door (no secrets); listens on 25565 + Wi-Fi ports |
| `apps/geyser` | Geyser Standalone image + config (auth-type floodgate) |
| `recipes/` | `oneblock.yaml`, `vanilla.yaml`, `map.yaml` |
| `scripts/` | `security-check.sh`, `dev-worker.ts`, `gen-mcdata.ts`, `lan-announce.ts` + `install-lan-announcer.ps1` |
| `docs/` | `feasibility.md`, `spikes.md`, `bedrock.md`, **`builder-notes.md`** (verified in-game mechanics: read it before building), this file |

**MCP tools** (`apps/hub/src/mcp.ts`):
- **Basics:** ping, list_worlds, world_status, start_world, stop_world, run_commands, build, player_position, view_area.
- **Templates:** save_template, list_templates.
- **Maps:** import_map, list_maps, propose_world_from_map.
- **Plans and catalog:** search_catalog, propose_world, proposal_status.
- **Minigames:** save_minigame, list_minigames.
- **Backups:** backup_world, list_backups.
- **Reference:** minecraft_reference, list_players, list_recipes.

**BuildScript ops:**
- **Blocks and areas:** fill, set, voxels.
- **Containers and text:** chest, sign.
- **Logic and movement:** command_block, teleport_pad.
- **Vanilla features:** structure, feature, template.
- **World setup:** summon, spawnpoint, gamerule.
- **Anything else:** command.
- **Traders:** trader (villager or wandering trader with fixed custom offers).
- **Game kits:** hunger_games, lucky_bosses.

## 5. Run, test, deploy

```sh
pnpm install
pnpm typecheck
pnpm test                      # 121 tests, all should pass
# deploy hub + worker (most changes):
docker compose -f deploy/compose.yaml -f deploy/compose.dev.yaml --profile hub --profile worker up -d --build hub worker
# gatekeeper changes MUST include its namespace sharers, or playit/geyser are left on a dead network:
docker compose -f deploy/compose.yaml -f deploy/compose.dev.yaml --profile hub --profile worker up -d --build gatekeeper playit geyser
bash scripts/security-check.sh
```

**Reaching things from the laptop:**
- **Portal API (as the owner, over the tailnet):**
  - `curl https://worldsmith.tail072963.ts.net:8443/api/... -H "X-WorldSmith: 1"`. The header is CSRF protection and is required for POST, PUT and DELETE.
  - Useful routes: `/api/worlds/<slug>/start|stop|build|lan|save-game`, `/api/proposals/<id>/approve`, `/api/maps/import`.
- **Worker API (dev port):**
  - `http://127.0.0.1:7070`, with `Authorization: Bearer <WORKER_TOKEN>`.
  - Read the token from `deploy/.env` inside the script and never print it.
  - The pattern is a small `.ts` script that reads the file with a regex (see the git history for examples).
- **RCON:** call the worker's `POST /worlds/<slug>/rcon {commands: [...]}`.

**Containers:**
- World containers are `ws-world-<slug>`, with volumes `ws-world-<slug>-data`.
- To inspect a stopped world's files: `MSYS_NO_PATHCONV=1 docker run --rm -v ws-world-<slug>-data:/data:ro alpine ...`.

## 6. State right now

**Stack:** up and healthy (hub, worker, gatekeeper, playit, Geyser, ts).

**Worlds** (2026-10-10 evening; the owner deleted ,  and ):

| Slug | What it is |
|---|---|
|  | **Featured** (where friends join). The owner's OneBlock (BentoBox/AOneBlock, crossplay), Wi-Fi port 25571 |
|  | "Hunger Games Test": an MIT CurseForge map, creative mode as the author saved it |
|  | **Classic Skyblock** (proposal #6), being played. Void sky world, plains biome so mobs spawn. L island at 0,64,0 with an oak and a chest (lava bucket + ice); sand island at 60,64,0 (sandstone base so the sand can't fall) with a cactus and a chest (10 obsidian, melon + pumpkin seeds). Spawn 1,67,4, respawn_radius 0, spawn protection 0, Wi-Fi port 25570. Its build was cut off by a hub redeploy and re-run by Claude; the card's "may not have finished" warning is stale. |
|  | **Lucky Block Boss Rush** (proposal #7, approved with textures best_effort / behavior required).  kit: market 0,100,0, arena 0,100,90;  +  datapacks; optional Java resource pack (LuckyBlock_RP). Not played yet. |

**Libraries on the worker:**
- **Template library:** `lobby`.
- **Saved minigames:** `lab-games`, and `skyblock` ("Classic Skyblock", saved fresh before anyone played: copy it to start over).
- **Map imports:** the HG map and the SG6 map (its world was deleted; the import is still on the worker).

**Also on the laptop:**
- **Java Wi-Fi announcer:** a Startup shortcut named "WorldSmith Wi-Fi play.lnk" that runs `conhost --headless node scripts/lan-announce.ts`.

**Owner accounts:**
- **Java:** Ethan5026.
- **Bedrock (iPhone):** an admin account with Floodgate UUID `00000000-0000-0000-0009-01f7e8b0e639`.

## 7. What's done

- **Phase 0–1 (foundation):**
  - **Connector:** OAuth with owner approval.
  - **Portal PWA:** push notifications.
  - **Joining:** gatekeeper wake-on-join and idle sleep; join requests and a declined bucket; invites; per-world access with "only when I'm playing".
  - **Crossplay:** Bedrock via Geyser + Floodgate (verified Floodgate decode).
  - **Data:** backups and restore.
  - **Access:** the security checklist.
  - **Wi-Fi play:** per-world LAN ports, Java discovery announcer, Bedrock LAN Games for the featured world.
- **Phase 2 (world builder):**
  - **Seeing:** `view_area` renders with grid labels, see-through glass, `maxY` cuts and block-entity lists.
  - **Building:**
    - BuildScript compiler with validation against 26.2 data.
    - Templates: capture, save, place rotated or mirrored.
    - Voxel drawings.
  - **Maps:**
    - Import by link or upload: allow-listed extraction, network guard, zip-bomb checks.
    - Old-map upgrade boot: vanilla `--forceUpgrade`, then back to Paper.
  - **Minigames:**
    - Hunger Games kit: datapack, pads, chests, hidden barrels, countdown, grace period, border shrink, eliminations, control panel.
    - Saved minigames: snapshot and copy.
  - **Plans:** world plans: base (recipe, map or saved) + Modrinth content (resolver: hash-pinned, dependencies, labels) + build steps. Approve, send back with a note, or decline.
  - **Portal:** world delete with a final backup.

## 8. What's next

**Checkpoints that need the owner** (nobody has done these yet):
1. In the Claude app: *"OneBlock for me and my friend on Bedrock and Java"* → a plan card with the Bedrock questions → approve → the world is built.
2. A real Hunger Games round with a friend on `hg-test`. Ask Claude to find the arena center with `view_area`, place the kit, and switch the world to adventure/survival. **The border shrink with players present is still unverified live**; the zero-player test ended the game before the shrink.
3. If the connector shows an error in the app, reconnect it. Redeploys restart the hub briefly and cause a short 502.

**Lucky Block Boss Rush (Phase 3 showcase, built):** after approval, play it with 2+ players: lucky block breaking (Lucky Block Reborn needs a player near the dropped item), deaths and knock-outs, boss balance, and how Bedrock sees the scaled bosses are not verified yet. Tune with a rebuild (`difficulty`, `luckySeconds`, `rounds`, `luckyBlocksPerPlayer`).

**Phase 3, showcase content.** North star: *"Lucky Block Challenge Games like Pat & Jen, with villager trades, a fun boss and a surprise lucky block, for me (Java) and a Bedrock friend."*
- **Crossplay build:**
  - Paper 26.2 + a lucky-block datapack or plugin (Modrinth `luckyblock-ashkiano` resolves for 26.2).
  - A Claude-designed lucky block outcome table.
  - Villager traders: a `summon` op with Offers NBT. Consider a `trader` BuildScript op.
  - A boss: MythicMobs or a vanilla-NBT boss.
  - An arena via voxels/templates.
  - A game-flow kit like `hunger_games`: start kit, timer, boss phase. Generalize `games.ts` into a kit registry.
- **Java-only classic variant:** a Fabric recipe plus a `.mrpack` "Friends install pack" served from the hub's public `/packs/*` path (not built yet).
- **Also:** worldgen preset templates, AOneBlock phase authoring, "Minecraft but…" challenge datapacks.

**Phase 4, hosting polish (deprioritized):**
- Mini PC migration (same Tailscale node name, restore the hub DB, move the worlds).
- Per-world addresses.
- Bedrock custom-item textures.
- An MCP Apps plan card.

**Known gaps and nice-to-haves:**
- **Entities aren't copied:** template capture skips armor stands, item frames and mobs.
- **Commands keep absolute coordinates:** command blocks inside pasted templates still point at the original spot.
- **Map discovery:** no CurseForge API search yet; that needs the owner's free API key.
- **Plan card:** it doesn't show `view_area` previews of the result yet.
- **Bedrock Wi-Fi:** LAN Games only reaches the featured world (Bedrock only discovers port 19132).
- **Saved minigames** keep only the latest save per name; there's no history.

## 9. Traps already found (read before touching these areas)

**Minecraft 26.x / Paper 26.2:**
- **Game rules** are snake_case and some were renamed (`keep_inventory`, `advance_time`, `command_blocks_work`). `pvp` is a game rule now.
- **Text components** in commands and NBT are SNBT, e.g. `{text:'Hi',color:'gold'}`.
- **`worldborder set <size> <time>`:** a bare number is **ticks**. Always write `300s`.
- **World layout:** `world/dimensions/<ns>/<dim>/region`. Older maps use `world/region` and `DIM-1`; the renderer handles both.
- **Structure templates:**
  - `/place template ns:name` reads `world/generated/<ns>/structure/` (**singular**).
  - Once loaded, a template is **cached until restart**, so in-world template ids carry a content hash.
- **Paper refuses `--forceUpgrade`** ("not yet implemented") and exits. WorldSmith runs the one upgrade boot as `TYPE=VANILLA`.
- **Upgraded chunks lack modern heightmaps** until played. The renderer computes the surface from the blocks.
- **Paper's per-IP connection throttle must be 0**, because every player arrives from the gatekeeper's IP (handled by a patch + a seeded `bukkit.yml`).
- **Vanilla RCON** accepts one packet per read, so never pipeline.
- **Floodgate UUIDs** aren't RFC 4122. Use `z.guid()`, not `z.uuid()`. Bedrock names have a `.` prefix on the server.

**Windows / Git Bash / tooling:**
- **Heredocs collapse backslashes.** Bash heredocs passed through the tool turn `\\` into `\`, which breaks regexes and `"\n"` in generated code. Write edit scripts with the Write tool (a `.cjs` file in the scratchpad) or use the Edit tool. Avoid apostrophes inside `node -e '...'`.
- **Path rewriting.** Git Bash rewrites `/paths` in arguments; prefix docker or node commands with `MSYS_NO_PATHCONV=1`.
- **File locks.** Windows sometimes locks a file briefly (EBUSY/UNKNOWN on write); just retry.
- **Node's `https` `lookup` hook** may be asked for *all* addresses (`opts.all`) and must answer with an array.

**Claude connector:**
- **JSON keys that differ only in case** (a voxels legend with both "S" and "s") make claude.ai reject the whole tool call: "Request body contains duplicate JSON keys". The legend description says so.

**Modrinth:**
- **Datapacks are usually `project_type: "mod"`** in the v2 API, with `"datapack"` among their loaders. The resolver uses the datapack build when the server can't load the project as a mod or plugin (`catalog.ts`).

**Deploy:**
- **The gatekeeper network namespace.** Recreating the gatekeeper strands playit and Geyser in the old namespace. Always recreate them together.
- **Restarts cause a brief 502** on the connector, which is expected.
- **Never redeploy the hub while a proposal is building.** The build runs inside the hub process, so a restart kills it (this happened to Skyblock, #6: the world was created empty). Check first: `docker logs worldsmith-hub-1 --since 30m | grep -E "proposal_|world_built"`, or `proposal_status`. If it happens anyway, the hub marks the card on its next start (world created → approved with a warning; no world → failed), and Claude finishes the plan's build steps with `build`.
- **Docker Desktop can quit on its own** (2026-10-10, cause unknown; logs rotate on restart). Everything is down then and the connector shows 502. Start Docker Desktop if no WSL terminals are open; the compose services restart by themselves, and a world that was running is cut off (exit 255) and wakes again on the next join.
- **The laptop's own Tailscale app may be logged out**, so the portal/tailnet URLs fail from the laptop itself (curl gets "couldn't connect"). Don't log it in (owner rule); check the hub from inside the container instead (`docker exec worldsmith-hub-1 wget -qO- http://127.0.0.1:3000/...`).

**Portal (iPhone):**
- **Form controls need 16 px text,** or Safari zooms in.
- **Background refreshes must not rebuild a list while a picker is open.** Use `shouldRender`, which skips focused lists and unchanged data.
