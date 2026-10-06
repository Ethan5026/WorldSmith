import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extract, pack } from "tar-stream";
import type Docker from "dockerode";
import type { WorldSpec } from "@worldsmith/core";
import { SavedGames } from "../src/games.ts";

function fakeWorld(files: Record<string, string>) {
  const received: string[] = [];
  const container = {
    getArchive: async () => {
      const p = pack();
      for (const [name, body] of Object.entries(files)) p.entry({ name, size: Buffer.byteLength(body) }, body);
      p.finalize();
      return p;
    },
    putArchive: async (stream: NodeJS.ReadableStream) => {
      const ex = extract();
      ex.on("entry", (h, s, next) => {
        received.push(h.name);
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
  return { container, received };
}

test("a saved minigame keeps the world and plugin setup, but no players, access lists or jars", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ws-games-"));
  try {
    const games = new SavedGames(dir);
    const source = fakeWorld({
      "data/world/level.dat": "level",
      "data/world/dimensions/minecraft/overworld/region/r.0.0.mca": "region",
      "data/world/datapacks/worldsmith_game/pack.mcmeta": "{}",
      "data/world/players/data/abc.dat": "inventory",
      "data/ops.json": "[]",
      "data/whitelist.json": "[]",
      "data/plugins/BentoBox-3.23.3.jar": "jar",
      "data/plugins/BentoBox/config.yml": "settings",
      "data/logs/latest.log": "log",
    });
    const spec = { slug: "hg", name: "HG", minecraft: { version: "26.2", protocol: 776, type: "PAPER" } } as unknown as WorldSpec;
    const saved = await games.save(source.container, { name: "disney-hg", title: "Disney Hunger Games", source: "hg", spec });
    assert.equal(saved.title, "Disney Hunger Games");
    assert.equal(games.list().length, 1);
    assert.equal(games.get("disney-hg").spec.slug, "hg");

    const copy = fakeWorld({});
    await games.install(copy.container, "disney-hg");
    assert.deepEqual(copy.received.sort(), [
      "data/plugins/BentoBox/config.yml",
      "data/world/datapacks/worldsmith_game/pack.mcmeta",
      "data/world/dimensions/minecraft/overworld/region/r.0.0.mca",
      "data/world/level.dat",
    ]);
    games.remove("disney-hg");
    assert.equal(games.list().length, 0);
    assert.throws(() => games.get("disney-hg"), /No saved minigame/);
    assert.throws(() => games.get("../etc"), /lowercase/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
