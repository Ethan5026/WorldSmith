import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.ts";
import { ProposalService } from "../src/proposals.ts";
import type { MapReport } from "../src/worker-client.ts";
import type { WorldService } from "../src/worlds.ts";
import type { Push } from "../src/push.ts";

const report: MapReport = {
  id: "20261005-120000-abc123",
  createdAt: new Date().toISOString(),
  source: { kind: "upload", filename: "disney.zip" },
  zipBytes: 50_000_000,
  sha256: "0".repeat(64),
  worlds: [
    {
      root: "Disney HG",
      levelName: "Disneyland Hunger Games",
      dataVersion: 1343,
      version: "1.12.2",
      needsUpgrade: true,
      gameMode: "adventure",
      hardcore: false,
      allowCommands: true,
      difficulty: "normal",
      spawn: { x: 0, y: 70, z: 0 },
      dimensions: { "minecraft:overworld": 9 },
      datapacks: [],
      structures: 0,
      hasResourcePack: false,
      worldBytes: 120_000_000,
    },
  ],
  skipped: [],
  skippedCount: 0,
  warnings: ["Disneyland Hunger Games was saved by Minecraft 1.12.2; it will be upgraded on first start."],
};

let dir: string;
let db: Db;
let created: { slug: string; bedrock: boolean }[];
let failNext: string | undefined;
let notified: string[];
let proposals: ProposalService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws-proposals-"));
  db = openDb(dir);
  created = [];
  failNext = undefined;
  notified = [];
  const worlds = {
    db,
    worker: { getMap: async (id: string) => (id === report.id ? report : Promise.reject(new Error("no such import"))) },
    row: (slug: string) => (slug === "taken" ? { slug } : undefined),
    createFromMap: async (_r: MapReport, _root: string, opts: { slug: string; bedrock: boolean }) => {
      if (failNext) throw new Error(failNext);
      created.push({ slug: opts.slug, bedrock: opts.bedrock });
      return { slug: opts.slug };
    },
  } as unknown as WorldService;
  const push = { notify: async (m: { body: string }) => (notified.push(m.body), 1) } as unknown as Push;
  proposals = new ProposalService(db, worlds, push);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = { mapId: report.id, root: "Disney HG", slug: "disney-hg", name: "Disney Hunger Games" };

test("a proposal notifies the owner and asks the Bedrock questions", async () => {
  const v = await proposals.proposeWorldFromMap({ ...base, notes: "Add a lobby and loot chests." }, "Claude (test)");
  assert.equal(v.status, "pending");
  assert.equal(v.map?.version, "1.12.2");
  assert.equal(v.map?.needsUpgrade, true);
  assert.deepEqual(v.crossplay.questions.map((q) => q.id), ["bedrock_players", "textures", "behavior"]);
  assert.ok(v.crossplay.differences.length > 0, "baseline Java/Bedrock differences are listed");
  assert.match(notified[0]!, /Disney Hunger Games, from the map "Disneyland Hunger Games"/);
});

test("approval waits for crossplay answers, then builds once", async () => {
  const v = await proposals.proposeWorldFromMap(base, "Claude (test)");
  await assert.rejects(proposals.approve(v.id, {}), /Answer first/);
  await assert.rejects(proposals.approve(v.id, { bedrockPlayers: "yes", textures: "best_effort" }), /closely should mods/);
  const done = await proposals.approve(v.id, { bedrockPlayers: "yes", textures: "best_effort", behavior: "required" });
  assert.equal(done.status, "approved");
  assert.equal(done.result?.slug, "disney-hg");
  assert.deepEqual(created, [{ slug: "disney-hg", bedrock: true }]);
  await assert.rejects(proposals.approve(v.id, {}), /already approved/);
});

test("Java-only proposals need no Bedrock answers", async () => {
  const v = await proposals.proposeWorldFromMap({ ...base, bedrock: "no" }, "Claude (test)");
  assert.equal(v.crossplay.status, "ok");
  assert.equal((await proposals.approve(v.id, {})).status, "approved");
  assert.deepEqual(created, [{ slug: "disney-hg", bedrock: false }]);
});

test("names must be free, maps must exist, and failures are recorded", async () => {
  await assert.rejects(proposals.proposeWorldFromMap({ ...base, slug: "taken" }, "Claude"), /already exists/);
  await assert.rejects(proposals.proposeWorldFromMap({ ...base, root: "Other" }, "Claude"), /no world at "Other"/);
  await assert.rejects(proposals.proposeWorldFromMap({ ...base, mapId: "20261005-120000-ffffff" }, "Claude"), /no such import/);
  const v = await proposals.proposeWorldFromMap({ ...base, bedrock: "no" }, "Claude");
  await assert.rejects(proposals.proposeWorldFromMap({ ...base, bedrock: "no" }, "Claude"), /Another proposal already uses/);
  failNext = "disk full";
  const failed = await proposals.approve(v.id, {});
  assert.equal(failed.status, "failed");
  assert.equal(failed.result?.error, "disk full");
  const declined = await proposals.decline((await proposals.proposeWorldFromMap({ ...base, slug: "disney-2", bedrock: "no" }, "Claude")).id);
  assert.equal(declined.status, "declined");
  assert.deepEqual((await proposals.list()).map((p) => p.status), ["declined", "failed"]);
});
