import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { extract, pack } from "tar-stream";
import type Docker from "dockerode";
import { Backups, isBackupId } from "../src/backups.ts";

/** What Docker's getArchive("/data") returns: a tar with entries prefixed "data/". */
function fakeDataArchive(files: Record<string, string>): Readable {
  const p = pack();
  for (const [name, body] of Object.entries(files)) p.entry({ name, uid: 1000, gid: 1000 }, body);
  p.finalize();
  return p as unknown as Readable;
}

async function namesIn(stream: NodeJS.ReadableStream): Promise<Record<string, string>> {
  const ex = extract();
  const out: Record<string, string> = {};
  ex.on("entry", (h, s, next) => {
    const chunks: Buffer[] = [];
    s.on("data", (c: unknown) => chunks.push(c as Buffer));
    s.on("end", () => {
      out[h.name] = Buffer.concat(chunks).toString();
      next();
    });
  });
  const done = new Promise<void>((r) => ex.on("finish", () => r()));
  stream.pipe(ex);
  await done;
  return out;
}

test("backups keep the world and plugin data, drop jars/libraries/logs/locks, and restore round-trips", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ws-backups-"));
  try {
    const backups = new Backups(root);
    let restored: NodeJS.ReadableStream | undefined;
    const container = {
      getArchive: async () =>
        fakeDataArchive({
          "data/world/level.dat": "LEVEL",
          "data/world/region/r.0.0.mca": "REGION",
          "data/world/session.lock": "LOCK",
          "data/plugins/BentoBox-3.23.3.jar": "JAR",
          "data/plugins/BentoBox/config.yml": "bentobox: config",
          "data/libraries/com/x.jar": "LIB",
          "data/logs/latest.log": "LOG",
          "data/whitelist.json": "[]",
        }),
      putArchive: async (s: NodeJS.ReadableStream) => {
        restored = s;
      },
    } as unknown as Docker.Container;

    const info = await backups.create(container, "oneblock", "Before Arena!");
    assert.ok(isBackupId(info.id));
    assert.equal(info.label, "before-arena");
    assert.deepEqual(backups.list("oneblock").map((b) => b.id), [info.id]);

    await backups.unpack(container, "oneblock", info.id);
    const contents = await namesIn(restored!);
    assert.deepEqual(Object.keys(contents).sort(), [
      "data/plugins/BentoBox/config.yml",
      "data/whitelist.json",
      "data/world/level.dat",
      "data/world/region/r.0.0.mca",
    ]);
    assert.equal(contents["data/world/region/r.0.0.mca"], "REGION");
    await assert.rejects(backups.unpack(container, "oneblock", "../../etc/passwd"), /Not a backup id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup ids can't be used for path traversal", () => {
  assert.ok(isBackupId("20261005-221500-sleep.tar.gz"));
  for (const bad of ["../x.tar.gz", "20261005-221500-a/b.tar.gz", "20261005-221500-sleep.tar.gz.partial", "x"]) assert.ok(!isBackupId(bad), bad);
});

// Keep the gunzip import used for readers who extend these tests to real files.
void createGunzip;
