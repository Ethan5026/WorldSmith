import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type Db } from "../src/db.ts";
import { WorldService, LAN_PORTS } from "../src/worlds.ts";
import { GateService } from "../src/gate.ts";
import type { WorkerClient } from "../src/worker-client.ts";
import type { AccessService } from "../src/access.ts";
import type { Push } from "../src/push.ts";

const recipesDir = fileURLToPath(new URL("../../../recipes", import.meta.url));
let dir: string;
let db: Db;
let worlds: WorldService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws-lan-"));
  db = openDb(dir);
  const worker = { status: async (slug: string) => ({ slug, container: "exited", backend: `ws-world-${slug}:25565` }) } as unknown as WorkerClient;
  worlds = new WorldService(db, worker, {} as AccessService, recipesDir);
  const spec = (slug: string) => JSON.stringify({ slug, name: slug, minecraft: { version: "26.2", protocol: 776, type: "PAPER" }, memoryMb: 2048 });
  for (let i = 0; i < 12; i++) {
    db.prepare("INSERT INTO worlds (slug, name, recipe, spec, created_at) VALUES (?, ?, 'vanilla', ?, ?)").run(`w${i}`, `World ${i}`, spec(`w${i}`), Date.now());
  }
  worlds.setFeatured("w0");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("Wi-Fi ports: lowest free port, stable while on, freed when off, limited", () => {
  assert.equal(worlds.setLan("w1", true), 25570);
  assert.equal(worlds.setLan("w2", true), 25571);
  assert.equal(worlds.setLan("w1", true), 25570, "turning it on again keeps the port");
  assert.equal(worlds.setLan("w1", false), null);
  assert.equal(worlds.slugForLanPort(25570), undefined);
  assert.equal(worlds.setLan("w3", true), 25570, "freed port is reused");
  for (let i = 4; i < 12; i++) worlds.setLan(`w${i}`, true);
  assert.equal(worlds.slugForLanPort(LAN_PORTS.at(-1)!), "w11");
  assert.throws(() => worlds.setLan("w1", true), /already/);
  assert.throws(() => worlds.setLan("nope", true), /No world/);
});

test("the gate routes Wi-Fi ports to their world and hangs up on unused ones", async () => {
  const gate = new GateService(db, {} as AccessService, worlds, {} as Push, "Ethan");
  worlds.setLan("w2", true); // 25570
  const main = await gate.status(776, 25565);
  assert.match(JSON.stringify(main), /World 0/, "the main port leads to the featured world");
  const lan = await gate.status(776, 25570);
  assert.match(JSON.stringify(lan), /World 2 \(Wi-Fi\)/);
  assert.equal(await gate.status(776, 25571), null, "unused Wi-Fi port: no answer");
  const login = await gate.login({ protocol: 776, username: "Steve", host: "x", port: 25571 });
  assert.equal(login.action, "kick");
  assert.match(JSON.stringify(login), /Wi-Fi play is off/);
});

test("deleting a world keeps a final backup, frees its Wi-Fi port and moves the featured world", async () => {
  const calls: string[] = [];
  worlds.worker = {
    status: async (slug: string) => ({ slug, container: "exited", backend: "" }),
    stop: async () => void calls.push("stop"),
    backup: async (_slug: string, label: string) => (calls.push(`backup:${label}`), { id: "20261006-000000-before-delete.tar.gz", label, createdAt: "", bytes: 1 }),
    remove: async (slug: string, purge: boolean) => void calls.push(`remove:${slug}:${purge}`),
  } as unknown as WorkerClient;
  worlds.setLan("w0", true);
  const r = await worlds.remove("w0");
  assert.equal(r.finalBackup, "20261006-000000-before-delete.tar.gz");
  assert.deepEqual(calls, ["backup:before-delete", "remove:w0:true"]);
  assert.equal(worlds.row("w0"), undefined);
  assert.equal(worlds.slugForLanPort(25570), undefined);
  assert.equal(worlds.featuredSlug(), "w1", "the next world becomes featured");
});
