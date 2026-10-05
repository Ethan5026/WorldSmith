# Builder notes: verified facts for building inside worlds (Minecraft 26.2)

Everything here was **run on a live Paper 26.2 server** over RCON (the "Builder Lab" world, flat, command blocks enabled) unless marked otherwise. Version-exact data lives in `packages/mcdata/versions/26.2.json`. It is generated from the server jar's own data generator, so block states and game rules are never guessed.

## Regenerating the version reference

```sh
# inside any running world container of that version (itzg caches the vanilla jar):
docker exec -w /tmp ws-world-<slug> sh -c 'java -DbundlerMainClass=net.minecraft.data.Main \
  -jar /data/cache/mojang_<ver>.jar --reports --output /tmp/gen/out'
docker cp ws-world-<slug>:/tmp/gen/out/reports data/mc-reports/<ver>
docker exec ws-world-<slug> unzip -p /data/cache/mojang_<ver>.jar version.json > data/mc-reports/<ver>/version.json
node scripts/gen-mcdata.ts <ver>
```

26.2 facts: protocol **776**, DataVersion **4903** (put this in generated structure `.nbt` files), data pack format **107.1**, resource pack format **88.0**, Java **25**. There are 59 game rules, 1,196 blocks and 92 commands.

## Command blocks ✅ verified

- **Server switches:** `enable-command-block=true` (WorldSpec `properties.enableCommandBlock`) **and** game rule `command_blocks_work` (new in 26.x; the worldsmith datapack sets it when command blocks are enabled).
- **Block states** (in `[...]`) are `facing` (north/east/south/west/up/down) and `conditional` (true/false). **Block entity data** (in `{...}`) is `Command`, `auto` (1b = Always Active), `TrackOutput`, `SuccessCount`, `LastOutput`, `CustomName`. Text components are SNBT (`{text:"..."}`), not JSON strings, since 1.21.5.
- **Impulse, powered by a redstone block:**
  `setblock 0 -60 0 command_block[facing=up]{Command:"…",auto:0b}` then `setblock 1 -60 0 redstone_block` → ran once (`SuccessCount 1`).
- **Repeating → conditional chain → chain:** a repeating block (`auto:1b`) with a failing `execute if entity …` left the **conditional** chain block idle (correct). The unconditional chain ran **50 times in about 2.5 s**, i.e. every tick. Stop a clock with `data merge block <pos> {auto:0b}`.
- **Read back for verification:** `data get block <pos> SuccessCount` and `… LastOutput`. Scoreboard counters (`scoreboard players add #x lab 1`) are the most reliable proof that something ran.

## Redstone ✅ verified

- **Lever → redstone dust → repeater → dust → command block** fired when the lever was flipped with `setblock … lever[face=floor,facing=east,powered=true]`. Setblock sends neighbor updates, so circuits react like a player flipped them.
- **Repeater:** `repeater[facing=east,delay=2]` carried a signal from east to west. `facing` points toward the **input** side.
- **Valid states come from the reference:** `repeater` has delay 1–4, facing north/south/west/east, plus locked and powered. `checkBlockState()` rejects anything else with suggestions.
- **Chunks must be loaded:** `forceload add <x1> <z1> <x2> <z2>` before building. Release it afterward unless the contraption must run while no player is near.

## Game rules: renamed in 26.x ⚠️ verified

`gamerule commandBlockOutput`, `keepInventory`, `doDaylightCycle` and `doMobSpawning` are **rejected** by 26.2. The new names are snake_case and some are reworded:

| Old (≤1.21) | 26.x |
|---|---|
| commandBlockOutput | command_block_output |
| keepInventory | keep_inventory |
| doDaylightCycle | **advance_time** |
| doWeatherCycle | **advance_weather** |
| doMobSpawning | **spawn_mobs** |
| commandModificationBlockLimit | **max_block_modifications** |
| maxCommandChainLength | **max_command_sequence_length** |
| disableRaids | **raids** (inverted) |

There's a full table in `LEGACY_GAMERULES` (`packages/mcdata`). WorldSmith translates old names automatically. **`pvp` is a game rule in 26.x**, not a server property; the worldsmith datapack sets it. Game rules are applied by the per-world **worldsmith datapack** load function (✅ verified: format 107.1 accepted, function ran on `/reload`).

## Other 26.x changes that affect building (from release notes, not yet live-tested)

- **Signs (26.3):** click events and commands in sign text don't run unless the sign has `allow_op_features:1b`. Newly placed signs need it set explicitly.
- **Structures:** data pack folder is `data/<ns>/structure/` (singular since 26.1). `/place template` has no size limit (the 48³ limit is the structure block UI only), but every target chunk must be loaded.

## What this means for the builder (Phase 2)

1. **Prefer functions over command blocks** for game logic (timers, teleport pads, game flow). They live in the worldsmith datapack, survive restarts, can't be broken by players, and are easy to diff. Use **command blocks** when the owner asks for them, for map-maker style contraptions players interact with, or for redstone-triggered events.
2. **Validate before running:** block states and game rules via `@worldsmith/mcdata`. Command syntax is checked by running it in the builder instance and reading the output.
3. **Verify after running:** scoreboard probes, `data get block`, and renders/images so Claude sees the result.

## Game orchestration with command blocks ✅ verified (Hunger Games pattern)

The owner's acceptance prompt: *"Disneyland Hunger Games: chests around the center, a shrinking boundary, hidden chests with tools to fight other players; command blocks orchestrate the rules, countdown and automation."* These parts were proven live in the lab (not built out fully, on purpose):

- **Start chain:** impulse `command_block` (`auto:0b`) + `chain_command_block`s (`auto:1b`, same `facing`) set `#state hg 1`, reset the timer, `worldborder center 0 0`, `worldborder set 200`, and announce. Triggered by a redstone block or button next to the impulse block.
- **Countdown clock:** `repeating_command_block` (`auto:1b`) running `execute if score #state hg matches 1 run scoreboard players add #t hg 1`. Chain blocks fire on exact ticks (`if score #t hg matches 1/21/41/61/81/101`) → `title @a title {text:'5',color:'gold'}` … `GO!` → shrink border → `#state hg 2`. Measured: GO at tick 101, state switched, border shrank.
- **Text components in commands are SNBT:** `{text:'GO!',color:'green',bold:true}`.
- **Loot:** custom loot tables in the worldsmith datapack (`data/worldsmith/loot_table/hg/center.json`, `hidden.json`). Chests and barrels get `{LootTable:"worldsmith:hg/center"}`, which fills when a player first opens them. Preview contents without a player using `loot insert <pos> loot <table>` + `data get block <pos> Items`. Hidden chests are barrels buried a block under the surface.
- **⚠️ `worldborder set <size> <time>`: a bare number is GAME TICKS in 26.x.** `worldborder set 20 100` shrinks over 5 s. Always write a unit: `worldborder set 20 300s`.
- **Chain block `LastOutput`** is often absent (no feedback, or `title` with nobody online). Verify with scoreboard state, `worldborder get`, and `data get block … Items` instead.

## Getting public maps

- **Automatic:** CurseForge Worlds API (owner's free API key; only files whose authors allow third-party download), direct zip links, GitHub releases.
- **Assisted:** Planet Minecraft, where most Java fan maps live (e.g. 185 Java "Disneyland" maps), returns **403 to automated clients** (bot protection). We **don't bypass it**. Claude finds the map and gives the owner the link; the owner downloads it in a browser and drops the zip into a watched folder on the PC, or uploads it in the portal. Then WorldSmith validates and imports it.
- Fan maps of real brands (Disney) are "All Rights Reserved" fan works, fine for private play on a whitelisted server. Never redistribute them.
