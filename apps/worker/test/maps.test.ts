import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { extract } from "tar-stream";
import yazl from "yazl";
import type Docker from "dockerode";
import { NbtByte, writeNbt, type NbtCompound } from "@worldsmith/mcworld";
import { MapStore, downloadPublic, isPublicAddress, isWorldFile, readLevelDat } from "../src/maps.ts";

function zipOf(files: Record<string, Buffer | string>): Promise<Buffer> {
  const z = new yazl.ZipFile();
  for (const [name, data] of Object.entries(files)) z.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), name);
  z.end();
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    z.outputStream.on("data", (d: Buffer) => parts.push(d));
    z.outputStream.on("end", () => resolve(Buffer.concat(parts)));
    z.outputStream.on("error", reject);
  });
}

const modernLevel = (): Buffer =>
  writeNbt({
    Data: {
      LevelName: "Castle Games",
      DataVersion: 4903,
      Version: { Name: "26.2", Id: 4903 },
      GameType: 2,
      allowCommands: new NbtByte(1),
      difficulty_settings: { difficulty: "hard", hardcore: new NbtByte(0) },
      spawn: { pos: new Int32Array([10, 70, -5]), dimension: "minecraft:overworld" },
    } as NbtCompound,
  });

const oldLevel = (): Buffer =>
  writeNbt({ Data: { LevelName: "Survival Games 1.8", GameType: 0, Difficulty: new NbtByte(2), SpawnX: 0, SpawnY: 64, SpawnZ: 0 } as NbtCompound });

test("level.dat: 26.x and pre-1.9 layouts", () => {
  const modern = readLevelDat(modernLevel());
  assert.equal(modern.levelName, "Castle Games");
  assert.equal(modern.version, "26.2");
  assert.equal(modern.gameMode, "adventure");
  assert.equal(modern.difficulty, "hard");
  assert.deepEqual(modern.spawn, { x: 10, y: 70, z: -5 });
  assert.equal(modern.allowCommands, true);
  assert.equal(modern.needsUpgrade, false);
  const old = readLevelDat(oldLevel());
  assert.equal(old.version, undefined);
  assert.equal(old.needsUpgrade, true);
  assert.equal(old.difficulty, "normal");
  assert.deepEqual(old.spawn, { x: 0, y: 64, z: 0 });
});

test("only world data counts as installable", () => {
  for (const ok of [
    "level.dat",
    "region/r.0.-1.mca",
    "DIM-1/region/r.0.0.mca",
    "DIM1/entities/r.-2.3.mca",
    "dimensions/minecraft/overworld/region/r.0.0.mca",
    "dimensions/mypack/sky/poi/r.0.0.mca",
    "data/scoreboard.dat",
    "data/minecraft/world_clocks.dat",
    "datapacks/game.zip",
    "datapacks/game/pack.mcmeta",
    "datapacks/game/data/hg/function/start.mcfunction",
    "generated/minecraft/structures/arena.nbt",
  ]) assert.ok(isWorldFile(ok), ok);
  for (const bad of ["setup.exe", "playerdata/1234.dat", "region/r.0.0.mcr", "resources.zip", "session.lock", "datapacks/game/run.sh", "mods/thing.jar", "README.txt"]) {
    assert.ok(!isWorldFile(bad), bad);
  }
});

test("network guard: private, tailnet, loopback and mapped addresses are refused", () => {
  for (const a of ["10.1.2.3", "192.168.1.1", "172.20.0.5", "127.0.0.1", "100.101.102.103", "169.254.169.254", "::1", "fd7a:115c:a1e0::1", "::ffff:192.168.0.1", "0.0.0.0"]) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ["8.8.8.8", "104.16.0.1", "2606:4700::1111"]) assert.equal(isPublicAddress(a), true, a);
});

test("downloads must be https and public", async () => {
  await assert.rejects(downloadPublic("http://example.com/map.zip", "x"), /Only https/);
  await assert.rejects(downloadPublic("https://localhost/map.zip", "x"), /private network/);
});

async function withStore(fn: (store: MapStore) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "ws-maps-"));
  try {
    await fn(new MapStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const castleZip = () =>
  zipOf({
    "Castle Games/level.dat": modernLevel(),
    "Castle Games/region/r.0.0.mca": Buffer.alloc(8192),
    "Castle Games/region/r.-1.0.mca": Buffer.alloc(8192),
    "Castle Games/DIM-1/region/r.0.0.mca": Buffer.alloc(8192),
    "Castle Games/data/scoreboard.dat": Buffer.from("sb"),
    "Castle Games/datapacks/hg/pack.mcmeta": "{}",
    "Castle Games/datapacks/hg/data/hg/function/start.mcfunction": "say go",
    "Castle Games/generated/minecraft/structures/arena.nbt": Buffer.from("nbt"),
    "Castle Games/playerdata/0000.dat": Buffer.from("p"),
    "Castle Games/session.lock": Buffer.from("l"),
    "Castle Games/resources.zip": Buffer.from("PK"),
    "Install Shaders.exe": Buffer.from("MZ"),
    "__MACOSX/Castle Games/._level.dat": Buffer.from("x"),
  });

test("import: report lists the world, what's skipped and why, and warnings", async () => {
  await withStore(async (store) => {
    // One zip, imported twice below: zip entries carry timestamps, so building it again could differ.
    const zip = await castleZip();
    const report = await store.importUpload(Readable.from(zip), "castle.zip");
    assert.equal(report.worlds.length, 1);
    const w = report.worlds[0]!;
    assert.equal(w.root, "Castle Games");
    assert.equal(w.levelName, "Castle Games");
    assert.deepEqual(w.dimensions, { "minecraft:overworld": 2, "minecraft:the_nether": 1 });
    assert.deepEqual(w.datapacks, ["hg"]);
    assert.equal(w.structures, 1);
    assert.equal(w.hasResourcePack, true);
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.path, s.reason]));
    assert.match(reasons["Castle Games/playerdata/0000.dat"]!, /player data/);
    assert.match(reasons["Castle Games/resources.zip"]!, /resource pack/);
    assert.match(report.warnings.join(" "), /programs \(Install Shaders\.exe\)/);
    assert.match(report.warnings.join(" "), /resource pack/);
    // Same file again: same import, no duplicate.
    const again = await store.importUpload(Readable.from(zip), "castle-copy.zip");
    assert.equal(again.id, report.id);
    assert.equal(store.list().length, 1);
  });
});

test("import: old maps are flagged for upgrade; Bedrock, nested and non-zips are refused", async () => {
  await withStore(async (store) => {
    const old = await store.importUpload(Readable.from(await zipOf({ "level.dat": oldLevel(), "region/r.0.0.mca": Buffer.alloc(8192) })), "sg.zip");
    assert.equal(old.worlds[0]!.root, "");
    assert.equal(old.worlds[0]!.needsUpgrade, true);
    assert.match(old.warnings.join(" "), /1\.8 or older; it will be upgraded/);

    await assert.rejects(store.importUpload(Readable.from(await zipOf({ "level.dat": Buffer.from("x"), "db/CURRENT": "MANIFEST" })), "b.mcworld"), /Bedrock world/);
    await assert.rejects(store.importUpload(Readable.from(await zipOf({ "Map v2.zip": Buffer.from("PK") })), "n.zip"), /contains another zip/);
    await assert.rejects(store.importUpload(Readable.from(Buffer.from("<html>nope</html>")), "page.zip"), /isn't a zip/);
    await assert.rejects(store.importUpload(Readable.from(await zipOf({ "notes.txt": "hi" })), "e.zip"), /no level\.dat/);
    assert.equal(store.list().length, 1, "failed imports leave nothing behind");
  });
});

test("install copies only world data into world/, owned by the server user", async () => {
  await withStore(async (store) => {
    const report = await store.importUpload(Readable.from(await castleZip()), "castle.zip");
    const got: { name: string; uid: number; type: string }[] = [];
    const container = {
      putArchive: async (stream: NodeJS.ReadableStream, opts: { path: string }) => {
        assert.equal(opts.path, "/data");
        const ex = extract();
        ex.on("entry", (h, s, next) => {
          got.push({ name: h.name, uid: h.uid ?? -1, type: h.type ?? "file" });
          s.on("end", next);
          s.resume();
        });
        await new Promise((resolve, reject) => {
          ex.on("finish", () => resolve(undefined));
          ex.on("error", reject);
          stream.pipe(ex);
        });
      },
    } as unknown as Docker.Container;
    const result = await store.install(report.id, "Castle Games", container);
    const files = got.filter((g) => g.type === "file").map((g) => g.name).sort();
    assert.deepEqual(files, [
      "world/DIM-1/region/r.0.0.mca",
      "world/data/scoreboard.dat",
      "world/datapacks/hg/data/hg/function/start.mcfunction",
      "world/datapacks/hg/pack.mcmeta",
      "world/generated/minecraft/structures/arena.nbt",
      "world/level.dat",
      "world/region/r.-1.0.mca",
      "world/region/r.0.0.mca",
    ]);
    assert.equal(result.files, 8);
    assert.ok(got.every((g) => g.uid === 1000));
    assert.ok(got.some((g) => g.type === "directory" && g.name === "world/datapacks/hg/data/hg/function/"));
  });
});
