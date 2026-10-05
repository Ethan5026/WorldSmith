import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extract } from "tar-stream";
import { buildTar, FileError, resolveFile } from "../src/files.ts";

async function entries(tar: Buffer): Promise<{ name: string; type: string; uid: number; body: string }[]> {
  const ex = extract();
  const out: { name: string; type: string; uid: number; body: string }[] = [];
  ex.on("entry", (h, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: unknown) => chunks.push(c as Buffer));
    stream.on("end", () => {
      out.push({ name: h.name, type: h.type ?? "file", uid: h.uid ?? -1, body: Buffer.concat(chunks).toString() });
      next();
    });
  });
  const done = new Promise<void>((r) => ex.on("finish", () => r()));
  ex.end(tar);
  await done;
  return out;
}

test("tar has parent directories first and everything owned by the server user", async () => {
  const tar = await buildTar([
    { path: "plugins/BentoBox/addons/AOneBlock.jar", data: Buffer.from("jar") },
    { path: "whitelist.json", data: Buffer.from("[]") },
  ]);
  const e = await entries(tar);
  assert.deepEqual(
    e.map((x) => `${x.type}:${x.name}`),
    [
      "directory:plugins/",
      "directory:plugins/BentoBox/",
      "directory:plugins/BentoBox/addons/",
      "file:plugins/BentoBox/addons/AOneBlock.jar",
      "file:whitelist.json",
    ],
  );
  assert.ok(e.every((x) => x.uid === 1000));
  assert.equal(e.find((x) => x.name === "whitelist.json")?.body, "[]");
});

test("downloads are rejected when the hash doesn't match, and cached when it does", async () => {
  const cache = mkdtempSync(path.join(tmpdir(), "ws-cache-"));
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("plugin bytes");
  }) as typeof fetch;
  try {
    const good = createHash("sha512").update("plugin bytes").digest("hex");
    const file = { kind: "download", source: "url", url: "https://example.com/p.jar", sha512: good, path: "plugins/p.jar" } as const;
    assert.equal((await resolveFile(file, cache)).data.toString(), "plugin bytes");
    await resolveFile(file, cache);
    assert.equal(calls, 1, "second resolve comes from the cache");
    await assert.rejects(resolveFile({ ...file, sha512: "0".repeat(128) }, cache), FileError);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(cache, { recursive: true, force: true });
  }
});
