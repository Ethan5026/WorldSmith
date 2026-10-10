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
import type { Catalog } from "../src/catalog.ts";
import type { BuildService } from "../src/builds.ts";
import { loadRecipes } from "@worldsmith/core";
import { fileURLToPath } from "node:url";

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
let failUpgrade: string | undefined;
let upgraded: string[];
let ran: string[];
let stopped: string[];
let resolveIssues: string[];
let fromRecipe: { slug: string; files: number; bedrock?: boolean }[];
let notified: string[];
let proposals: ProposalService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws-proposals-"));
  db = openDb(dir);
  created = [];
  failNext = undefined;
  failUpgrade = undefined;
  upgraded = [];
  ran = [];
  stopped = [];
  resolveIssues = [];
  fromRecipe = [];
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
    createFromRecipe: async (_recipe: string, slug: string, _name: string, extras: { files?: unknown[]; bedrock?: boolean }) => {
      fromRecipe.push({ slug, files: extras.files?.length ?? 0, bedrock: extras.bedrock });
      return { slug };
    },
    stop: async (slug: string) => void stopped.push(slug),
    runUpgradeBoot: async (slug: string) => {
      if (failUpgrade) throw new Error(failUpgrade);
      upgraded.push(slug);
    },
    recipes: loadRecipes(fileURLToPath(new URL("../../../recipes", import.meta.url))),
  } as unknown as WorldService;
  const push = { notify: async (m: { body: string }) => (notified.push(m.body), 1) } as unknown as Push;
  const catalog = {
    resolve: async (content: { project: string }[]) => ({
      minecraft: "26.2",
      serverType: "PAPER",
      issues: resolveIssues,
      items: content.map((c) => ({
        project: { id: c.project, slug: c.project, title: `Plugin ${c.project}`, type: "plugin", url: `https://modrinth.com/plugin/${c.project}`, clientSide: "unsupported", serverSide: "required" },
        version: { id: "abcdefgh", number: "1.0", type: "release" },
        file: { kind: "download", source: "modrinth", url: "https://cdn.modrinth.com/x.jar", sha512: "0".repeat(128), path: `plugins/${c.project}.jar` },
        label: "No install needed",
        why: "test",
        crossplay: { id: c.project, name: c.project, textures: "native", behavior: "approximate", differences: [] },
      })),
    }),
  } as unknown as Catalog;
  const builds = { run: async (slug: string, script: { name: string }) => (ran.push(`${slug}:${script.name}`), { ok: true, failed: [] }) } as unknown as BuildService;
  proposals = new ProposalService(db, worlds, push, catalog, builds);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = { mapId: report.id, root: "Disney HG", slug: "disney-hg", name: "Disney Hunger Games" };

test("a proposal notifies the owner and asks the Bedrock questions", async () => {
  const v = await proposals.proposeWorldFromMap({ ...base, notes: "Add a lobby and loot chests." }, "Claude (test)");
  assert.equal(v.status, "pending");
  assert.equal(v.base.kind === "map" && v.base.version, "1.12.2");
  assert.equal(v.base.kind === "map" && v.base.needsUpgrade, true);
  assert.deepEqual(v.crossplay.questions.map((q) => q.id), ["bedrock_players", "textures", "behavior"]);
  assert.ok(v.crossplay.differences.length > 0, "baseline Java/Bedrock differences are listed");
  assert.match(notified[0]!, /Disney Hunger Games: Add a lobby and loot chests\./);
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
  const v = await proposals.proposeWorldFromMap({ ...base, bedrock: "no" }, "owner (portal)");
  await assert.rejects(proposals.proposeWorldFromMap({ ...base, bedrock: "no" }, "Claude"), /Another proposal already uses/, "Claude never replaces the owner's own card");
  failNext = "disk full";
  const failed = await proposals.approve(v.id, {});
  assert.equal(failed.status, "failed");
  assert.equal(failed.result?.error, "disk full");
  const declined = await proposals.decline((await proposals.proposeWorldFromMap({ ...base, slug: "disney-2", bedrock: "no" }, "Claude")).id);
  assert.equal(declined.status, "declined");
  assert.deepEqual((await proposals.list()).map((p) => p.status), ["declined", "failed"]);
});

test("approval runs the old-map upgrade; an upgrade failure keeps the world and says so", async () => {
  const v = await proposals.proposeWorldFromMap({ ...base, bedrock: "no" }, "Claude");
  assert.equal((await proposals.approve(v.id, {})).status, "approved");
  assert.deepEqual(upgraded, ["disney-hg"]);
  failUpgrade = "The map upgrade stopped early";
  const w = await proposals.proposeWorldFromMap({ ...base, slug: "disney-2", bedrock: "no" }, "Claude");
  const r = await proposals.approve(w.id, {});
  assert.equal(r.status, "failed");
  assert.equal(r.result?.slug, "disney-2");
  assert.match(r.result!.error!, /was created, but: The map upgrade stopped early/);
});

test("the portal does not wait for the build", async () => {
  const v = await proposals.proposeWorldFromMap({ ...base, bedrock: "no" }, "Claude");
  const r = await proposals.approve(v.id, {}, { wait: false });
  assert.equal(r.status, "building");
  await new Promise((done) => setTimeout(done, 20));
  assert.equal((await proposals.get(v.id)).status, "approved");
});

const plan = {
  name: "Lucky Islands",
  slug: "lucky-islands",
  pitch: "OneBlock with lucky blocks for you and Sam.",
  base: { kind: "recipe", recipe: "oneblock" },
  bedrock: "yes",
  content: [{ source: "modrinth", project: "luckyblock-ashkiano", why: "Lucky blocks" }],
  builds: [{ name: "spawn-sign", origin: [0, 64, 0], ops: [{ op: "sign", at: [0, 0, 0], lines: ["Welcome"] }] }],
};

test("world plans: content is pinned, Bedrock questions asked, builds run after approval", async () => {
  const v = await proposals.proposeWorldPlan(plan, "Claude");
  assert.equal(v.base.kind, "recipe");
  assert.deepEqual(v.content.map((c) => [c.title, c.label]), [["Plugin luckyblock-ashkiano", "No install needed"]]);
  assert.deepEqual(v.builds, [{ name: "spawn-sign", steps: 1, kinds: ["sign"] }]);
  assert.equal(v.crossplay.badge, "bedrock_experimental", "a server plugin may act differently on Bedrock");
  await assert.rejects(proposals.approve(v.id, { textures: "required", behavior: "required" }), /fit your Bedrock priorities/);
  const done = await proposals.approve(v.id, { textures: "required", behavior: "best_effort" });
  assert.equal(done.status, "approved");
  assert.deepEqual(fromRecipe, [{ slug: "lucky-islands", files: 1, bedrock: true }]);
  assert.deepEqual(ran, ["lucky-islands:spawn-sign"]);
  assert.deepEqual(stopped, ["lucky-islands"], "the world goes back to sleep after its builds");
  assert.deepEqual(done.result?.builds, [{ name: "spawn-sign", ok: true, failed: 0 }]);
});

test("Claude can revise its own pending plan: the new card replaces the old one; never one that's building", async () => {
  const first = await proposals.proposeWorldPlan(plan, "Claude");
  // A plan that needs fixing doesn't touch the pending one.
  resolveIssues = ["nope has no build for Minecraft 26.2 (Paper)."];
  await assert.rejects(proposals.proposeWorldPlan(plan, "Claude"), /Fix these/);
  resolveIssues = [];
  assert.equal((await proposals.get(first.id)).status, "pending");
  const second = await proposals.proposeWorldPlan({ ...plan, pitch: "Now with a lobby." }, "Claude");
  const old = await proposals.get(first.id);
  assert.equal(old.status, "declined");
  assert.equal(old.result?.note, `Replaced by #${second.id}`);
  assert.equal(old.result?.replacedBy, second.id);
  assert.equal((await proposals.get(second.id)).status, "pending");
  await assert.rejects(proposals.approve(first.id, { textures: "required", behavior: "best_effort" }), /already declined|declined/);
});

test("builds cut off by a hub restart don't stay 'Building…' forever", async () => {
  const made = await proposals.proposeWorldPlan(plan, "Claude");
  const early = await proposals.proposeWorldPlan({ ...plan, slug: "lucky-two" }, "Claude");
  // Simulate a restart mid-build: both were claimed, only the first world got created.
  db.prepare("UPDATE proposals SET status = 'building' WHERE id IN (?, ?)").run(made.id, early.id);
  proposals.worlds.row = ((slug: string) => (slug === "lucky-islands" ? { slug } : undefined)) as typeof proposals.worlds.row;
  const restarted = new ProposalService(db, proposals.worlds, proposals.push, proposals.catalog, proposals.builds);
  const a = await restarted.get(made.id);
  assert.equal(a.status, "approved", "the owner already approved it and the world exists");
  assert.equal(a.result?.slug, "lucky-islands");
  assert.match(a.result?.error ?? "", /hub restarted while this world was being built/);
  const b = await restarted.get(early.id);
  assert.equal(b.status, "failed");
  assert.match(b.result?.error ?? "", /propose it again/);
});

test("world plans that need fixing are never filed; owners can send plans back with a note", async () => {
  resolveIssues = ["nope has no build for Minecraft 26.2 (Paper)."];
  await assert.rejects(proposals.proposeWorldPlan(plan, "Claude"), /Fix these before proposing:\n- nope has no build/);
  resolveIssues = [];
  const broken = { ...plan, builds: [{ name: "bad", origin: [0, 0, 0], ops: [{ op: "set", at: [0, 0, 0], block: "minecraft:not_a_block" }] }] };
  await assert.rejects(proposals.proposeWorldPlan(broken, "Claude"), /Build "bad"/);
  await assert.rejects(proposals.proposeWorldPlan({ ...plan, base: { kind: "recipe", recipe: "nope" } }, "Claude"), /No recipe called "nope"/);
  assert.equal((await proposals.list()).length, 0);
  const v = await proposals.proposeWorldPlan(plan, "Claude");
  const back = await proposals.decline(v.id, "Make it Java only and add a lobby.");
  assert.equal(back.status, "declined");
  assert.equal(back.result?.note, "Make it Java only and add a lobby.");
});
