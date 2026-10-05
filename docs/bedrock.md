# Bedrock friends on WorldSmith worlds (research, 2026-10-05)

## Bottom line

Bedrock players can join any world whose content lives **on the server**: vanilla, Paper plugins, datapacks, and server-side Fabric mods (including many Polymer mods that add new blocks and items). Worlds built on **client-required content mods** (Create, big tech/magic packs) stay **Java-only**. The exception is Hydraulic, which is beta, Fabric-only, and handles simple item mods.

## Compatibility badge (computed by the resolver for every plan)

| Badge | When | How Bedrock connects |
|---|---|---|
| **Java + Bedrock** | Vanilla / Paper plugins / datapacks / Fabric mods whose version `environment` is `server_only` or `server_only_client_optional`, and Polymer mods that declare Geyser support | Geyser at the hub → gatekeeper → world (join requests, wake on join, version help all work) |
| **Bedrock: experimental** | Fabric content mods that Hydraulic handles (simple items/tools); Polymer mods without Geyser support (vanilla-looking stand-ins) | Geyser-Fabric + Floodgate + Hydraulic inside the world; Bedrock UDP forwarded straight to it (no Bedrock wake-on-join) |
| **Java only** | Any mod whose environment needs the client (`client_and_server`, …), NeoForge content packs (Hydraulic NeoForge is broken: issue #25), Polymania-style packs | — |

When you say Bedrock friends will play, the planner prefers server-side alternatives (e.g. Server-Side Waystones instead of Waystones).

## Architecture

```
Bedrock (phone/Win/console) ─UDP─► playit "Minecraft Bedrock" tunnel ─► Geyser Standalone (hub)
                                                                          │ Java protocol, Floodgate data in handshake
Java ──────────────────────────TCP─► playit "Minecraft Java" tunnel ────► gatekeeper ─► world (Floodgate installed)
```

- **Geyser Standalone at the hub** with `auth-type: floodgate` and `passthrough-motd` (Bedrock sees the gatekeeper's MOTD). It costs about 300–500 MB of RAM.
- **Floodgate** is on every world: Paper plugin, or Floodgate-Modded for Fabric/NeoForge (all on Modrinth, so itzg `MODRINTH_PROJECTS` installs them). The worker distributes the shared `key.pem`, which is a secret: anyone holding it can impersonate Bedrock players.
- **Gatekeeper changes:**
  - Accept Floodgate's long handshake hostname (`host\0<encrypted data>`, often 400+ chars, over the vanilla 255).
  - Show Bedrock players (`.` prefix) with a Bedrock badge in join requests.
  - On approval, resolve the gamertag through `api.geysermc.org/v2/xbox/xuid/{gamertag}` (XUID in decimal). Convert to the Floodgate UUID `00000000-0000-0000-XXXX-XXXXXXXXXXXX` (XUID in hex) and write it to `whitelist.json`.
- **Console friends** (Xbox/PlayStation/Switch can't type a server address): the MCXboxBroadcast Geyser extension, signed in with a **separate Microsoft account**, shows the server in their Friends tab. Phone and Windows Bedrock players can add `address:port` directly. BedrockConnect (DNS) is the fallback.
- **Custom item textures** for Bedrock (optional polish): Rainbow (GeyserMC's official converter, run from a Fabric Java client) or Bedframe (server-side, experimental). Neither handles display entities.

## How each Bedrock device joins

| Device | Best way in | Who sets it up | Fallback |
|---|---|---|---|
| Phone (iOS/Android), Windows | Servers tab → Add Server → Bedrock address + port | Friend, once | — |
| Xbox | Friends tab → our server (MCXboxBroadcast, separate Microsoft account) | Owner, once | BedrockConnect DNS; Phantom/BedrockTogether LAN proxy |
| PlayStation | Friends tab (MCXboxBroadcast; the PS profile must be signed in to Microsoft) | Owner, once | BedrockConnect DNS; BedrockTogether app (LAN) |
| Switch | Friends tab (MCXboxBroadcast) | Owner, once | BedrockConnect DNS (Switch has no LAN mode, so Phantom doesn't work) |

Friends who own **both** editions can link accounts once at link.geysermc.org (Floodgate Global Linking) and keep one inventory and position across Java and Bedrock. Linking hides their Bedrock-side data until they unlink, so move items first.

## Server-side workarounds we install for Bedrock players

| Gap | Workaround | Default |
|---|---|---|
| Armor stand poses, illusioners, offhand animation, particles, Java-style UI tweaks | GeyserIntegratedPack (built into Geyser) | On |
| Offhand items (food, tools) | `/geyser offhand`; **EmoteOffhand** extension (emote = swap hands) | On |
| 1.9+ combat cooldown | Geyser's cooldown indicator; **GeyserExtras** for cleaner cooldown and combat sounds | On |
| Chest-GUI menus (OneBlock, shops) | Work as inventories; plugins with Floodgate/Cumulus support show native Bedrock forms | Automatic |
| Custom player-head blocks (lucky blocks) | Geyser custom-skull mappings generated from the plan's head textures | Generated per world |
| Custom items/blocks from plugins and Polymer mods | Rainbow-converted pack + mappings (Bedframe experimental) | Per plan, when textures priority ≠ java_first |
| Bamboo/dripstone collision desync | **Hurricane** (exploitable, so only with trusted friends) | Off |
| Unfixable | Clickable chat links, tab-complete, glowing outline, banners past 6 layers, custom enchantments, behavior packs/add-ons | Listed as differences |

## Owner requirement: state differences, ask priorities

Whenever Bedrock players may join, every plan must:
1. List where the prompt's features differ between Java and Bedrock: the baseline Geyser differences plus each content item's own.
2. Ask the owner how strictly to enforce Bedrock compatibility, **separately** for:
   - **Textures** (custom blocks, items, resource packs): *Must look the same* / *Close enough* / *Java looks first*
   - **Mod behavior** (mods, plugins, rules): *Must play the same* / *Close enough* / *Java gameplay first*
3. Refuse approval until both are answered. Conflicting content gets a suggested Bedrock-friendly swap.

This is implemented in `packages/core/src/crossplay.ts` (`evaluateCrossplay`), with the owner's Lucky Block Challenge Games prompt as the test case.

## Version constraint

Geyser emulates one Java version: **26.2** today (26.3 support is in PR #6712, previews only). Bedrock-enabled worlds pin to Geyser's supported Java version. Paper worlds on newer versions can use ViaBackwards to accept Geyser's older protocol. Geyser must be updated often because Bedrock clients auto-update (it currently supports Bedrock 26.30–26.52).

## Sources

- Geyser supported versions: https://geysermc.org/wiki/geyser/supported-versions/
- Geyser 26.3 PR: https://github.com/GeyserMC/Geyser/pull/6712
- Hydraulic: https://geysermc.org/wiki/other/hydraulic/ and https://github.com/GeyserMC/Hydraulic (issue #25 NeoForge, #16 Polymer)
- Floodgate-Modded: https://github.com/GeyserMC/Floodgate-Modded
- Polymer: https://polymer.pb4.eu/latest/ · Rainbow: https://geysermc.org/wiki/other/rainbow/ · Bedframe: https://modrinth.com/mod/bedframe
- Floodgate long hostname: https://github.com/GeyserMC/Floodgate/issues/148
- Global API (XUID): https://geysermc.org/wiki/api/api.geysermc.org/global-api-web-api-xbox-controller-get-xuid-v-2/
- MCXboxBroadcast: https://github.com/MCXboxBroadcast/Broadcaster
- Modrinth environments: https://modrinth.com/news/article/new-environments/
- Consoles: https://geysermc.org/wiki/geyser/using-geyser-with-consoles/ · BedrockConnect: https://github.com/Pugmatt/BedrockConnect · Phantom: https://github.com/jhead/phantom
- Floodgate linking: https://geysermc.org/wiki/floodgate/linking/
- Limitations: https://geysermc.org/wiki/geyser/current-limitations/ · GeyserIntegratedPack: https://geysermc.org/wiki/other/geyserintegratedpack/ · Hurricane: https://geysermc.org/wiki/other/hurricane/ · EmoteOffhand: https://github.com/GeyserMC/EmoteOffhandExtension · Extensions list: https://github.com/GeyserMC/GeyserExtensionList
