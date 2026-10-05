# WorldSmith feasibility (2026-10-05)

**Verdict: feasible.** Claude plans; proven engines build. The LLM writes parameters and configs for existing tools (itzg/minecraft-server env, Modrinth version pins, AOneBlock phase YAML, worldgen datapack templates). It never writes raw world data or shell commands. Every plan is resolved, validated, and test-booted before anything goes live.

## Measured on the laptop (Phase 0 spikes)

| Check | Result |
|---|---|
| Paper 26.2 (build 129, stable) | `Done (13.562s)!`; ~35 s wall time on first boot including downloads; ~2.5 GiB RSS with a 2 GB heap; protocol **776** |
| Paper 26.3 (build 152, **beta**) | `Done (17.511s)!`; ~2.5 GiB; protocol **777** |
| `@worldsmith/mcproto` against live servers | status ping, pong, and Login Start all accepted (server replies Encryption Request) |
| Gatekeeper prototype | approved player piped to the backend ✔; unknown player gets a "Request sent" kick and a logged request ✔; wrong version gets launcher instructions ✔; garbage bytes are dropped ✔ |
| Docker Desktop budget | 8 GiB by default (WSL 50%), so two Paper worlds at once is about 5 GiB |

## Capability ladder

| Capability | Approach | Confidence |
|---|---|---|
| Curated mod/plugin worlds | Modrinth/Hangar/CurseForge search, then a resolver (version intersection, hashes, dependencies, client/server split), then itzg env | High |
| Known modes (OneBlock, Skyblock, Manhunt, Death Swap, randomizers) | Recipe library: BentoBox AOneBlock, ChallengeUtil, BasedChallenges, Death Swap | High |
| Customized modes | Claude edits known config schemas (e.g. AOneBlock phases), then test-boots | High–Med |
| Downloaded maps | CurseForge Worlds (classId 17, `allowModDistribution`), or paste a link and upload the zip | Med |
| Terrain from a prompt | Parameterized worldgen datapack templates plus Terralith/Tectonic (cf. Mindcraft) | Med–High |
| Free-form worldgen, "Minecraft but…" datapacks | Claude-written JSON/mcfunction, checked by test-boot and preview render | Med–Low (experimental) |
| Structures | block JSON → .schem/.nbt → WorldEdit/structure paste | Med |
| Real-world places | Arnis (OpenStreetMap) | Med |

## Constraints

- Plugins lag Minecraft releases: Paper 26.3 is beta and BentoBox is tested only up to 26.2. The resolver picks the newest version that all content supports, and the gatekeeper tells friends which version to pick.
- Geyser (Bedrock crossplay) supports up to 26.2.
- Claude "MCP tunnels" are Enterprise-only, so the connector uses Tailscale Funnel (public HTTPS) with OAuth, restricted to a few paths.
- The HP t240 (2 GB soldered RAM, Atom) can't host worlds. The laptop runs everything for now, and the mini PC takes over later.
- Wake-on-LAN on Modern Standby laptops is unreliable, so it's deferred.

## Sources

- itzg docs: https://docker-minecraft-server.readthedocs.io/
- mc-router: https://github.com/itzg/mc-router
- Minecraft 26.3: https://mcreference.com/latest
- AOneBlock: https://docs.bentobox.world/en/latest/gamemodes/AOneBlock/
- Mindcraft: https://github.com/soapantelope/mindcraft
- Claude connectors: https://claude.com/docs/connectors/custom/remote-mcp
- MCP tunnels: https://claude.com/docs/connectors/mcp-tunnels/overview
- CurseForge API: https://docs.curseforge.com/rest-api/
- uNmINeD CLI: https://unmined.net/docs/cli/getting-started/
- playit.gg: https://playit.gg/
- PendingWhitelist: https://modrinth.com/plugin/pending-whitelist
