import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.ts";
import { AccessService } from "../src/access.ts";

const PROFILES: Record<string, string> = {
  ethan5026: "01cc1dfd-c796-48f0-a345-23918634d648",
  sam: "11111111-1111-1111-1111-111111111111",
  alex: "22222222-2222-2222-2222-222222222222",
};
const fakeLookup = async (name: string) => {
  const uuid = PROFILES[name.toLowerCase()];
  return uuid ? { uuid, name: name[0]!.toUpperCase() + name.slice(1) } : null;
};

let dir: string;
let db: Db;
let access: AccessService;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ws-access-"));
  db = openDb(dir);
  access = new AccessService(db, fakeLookup);
  for (const slug of ["oneblock", "lab"]) {
    db.prepare("INSERT INTO worlds (slug, name, spec, created_at) VALUES (?, ?, '{}', ?)").run(slug, slug, Date.now());
  }
  await access.addJavaPlayer("Ethan5026", "owner");
  await access.addJavaPlayer("Sam");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const whitelistNames = (slug: string): string[] => {
  const f = access.accessFiles(slug).find((x) => x.path === "whitelist.json");
  return f && f.kind === "inline" ? (JSON.parse(f.content) as { name: string }[]).map((p) => p.name).sort() : [];
};

test("everyone-mode worlds let every approved friend in; picked-mode only the guest list (+ owner)", () => {
  const sam = access.findApproved("Sam")!;
  assert.ok(access.canJoin(sam, "lab"));
  assert.deepEqual(whitelistNames("lab"), ["Ethan5026", "Sam"]);

  access.setWorldAccess("lab", { mode: "picked" });
  assert.ok(!access.canJoin(sam, "lab"));
  assert.deepEqual(whitelistNames("lab"), ["Ethan5026"], "owner is always on the list");

  access.setWorldAccess("lab", { members: [sam.uuid] });
  assert.ok(access.canJoin(sam, "lab"));
  assert.deepEqual(whitelistNames("lab"), ["Ethan5026", "Sam"]);
  assert.deepEqual(whitelistNames("oneblock"), ["Ethan5026", "Sam"], "other worlds unaffected");
});

test("only the owner (and admins) are operators", () => {
  const ops = access.accessFiles("oneblock").find((f) => f.path === "ops.json");
  assert.ok(ops && ops.kind === "inline");
  assert.deepEqual((JSON.parse(ops.content) as { name: string; level: number }[]).map((o) => [o.name, o.level]), [["Ethan5026", 4]]);
});

test("a friend asking for a picked-mode world gets added to that world when approved", async () => {
  access.setWorldAccess("lab", { mode: "picked" });
  const { request } = access.recordAttempt("Sam", undefined, "lab");
  assert.equal(access.pendingRequests()[0]?.knownPlayer, true);
  await access.approve(request.id);
  assert.ok(access.canJoin(access.findApproved("Sam")!, "lab"));
});

test("a stranger's request adds them as a friend when approved", async () => {
  const { request, notify } = access.recordAttempt("Alex", undefined, "oneblock");
  assert.equal(notify, true);
  assert.equal(access.recordAttempt("Alex", undefined, "oneblock").notify, false, "no repeat notification within 10 min");
  await access.approve(request.id);
  assert.ok(access.findApproved("Alex"));
  await assert.rejects(access.approve(request.id), /already handled/);
});

test("claimed UUID must match the approved account", () => {
  assert.ok(access.findApproved("Sam", PROFILES.sam));
  assert.equal(access.findApproved("Sam", "99999999-9999-9999-9999-999999999999"), undefined);
});

test("invite links: single use, world grant, expiry, revocation, bad names don't burn a use", async () => {
  access.setWorldAccess("lab", { mode: "picked" });
  const { token } = access.createInvite({ worldSlug: "lab", days: 7, maxUses: 1 });
  await assert.rejects(access.redeemInvite(token, "NotARealAccount"), /No Minecraft/);
  assert.ok(access.checkInvite(token), "failed redemption gave the use back");

  const { player } = await access.redeemInvite(token, "Alex");
  assert.ok(access.canJoin(player, "lab"));
  assert.equal(access.checkInvite(token), undefined, "used up");
  await assert.rejects(access.redeemInvite(token, "Sam"), /expired or was already used/);

  const expiring = access.createInvite({ days: 1, maxUses: 5 });
  db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").run(Date.now() - 1, expiring.invite.id);
  assert.equal(access.checkInvite(expiring.token), undefined);

  const revoked = access.createInvite({ days: 1, maxUses: 5 });
  access.revokeInvite(revoked.invite.id);
  assert.equal(access.checkInvite(revoked.token), undefined);
  assert.equal(access.checkInvite("made-up-token"), undefined);
});

test("two people racing for the last use of an invite: exactly one gets in", async () => {
  const { token } = access.createInvite({ days: 1, maxUses: 1 });
  const results = await Promise.allSettled([access.redeemInvite(token, "Alex"), access.redeemInvite(token, "Sam")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

test("the owner can't be removed; removing a friend drops their world memberships", () => {
  assert.throws(() => access.removePlayer(PROFILES.ethan5026!), /owner/);
  access.setWorldAccess("lab", { mode: "picked", members: [PROFILES.sam!] });
  access.removePlayer(PROFILES.sam!);
  assert.deepEqual(access.worldAccess("lab").members, []);
});

test("Bedrock players: XUID → Floodgate UUID, separate from Java names, dot-prefixed in whitelists", async () => {
  const { floodgateUuid } = await import("../src/mojang.ts");
  assert.equal(floodgateUuid("2535432196048835"), "00000000-0000-0000-0009-01f64f65c7c3");

  const bedrock = new AccessService(db, fakeLookup, async (tag) => (tag.toLowerCase() === "sam" || tag === "Sky Rider" ? "2535432196048835" : null));
  const p = await bedrock.addBedrockPlayer("Sky Rider");
  assert.equal(p.platform, "bedrock");
  assert.equal(p.name, "Sky_Rider", "Geyser replaces spaces with underscores");
  assert.equal(p.uuid, "00000000-0000-0000-0009-01f64f65c7c3");
  assert.ok(bedrock.findApproved("sky_rider", undefined, "bedrock"));
  assert.equal(bedrock.findApproved("Sky_Rider", undefined, "java"), undefined, "a Java account with that name is someone else");
  assert.equal(bedrock.findApproved("Sam", undefined, "bedrock"), undefined, "Java Sam is not Bedrock Sam");

  const wl = bedrock.accessFiles("oneblock").find((f) => f.path === "whitelist.json");
  assert.ok(wl && wl.kind === "inline" && wl.content.includes('".Sky_Rider"'));
  await assert.rejects(bedrock.addBedrockPlayer("NobodyHere"), /No Xbox account/);
});

test("a Bedrock stranger's request becomes a Bedrock friend when approved", async () => {
  const bedrock = new AccessService(db, fakeLookup, async () => "1234567890123456");
  const { request } = bedrock.recordAttempt("Blocky", undefined, "oneblock", "bedrock");
  assert.equal(request.platform, "bedrock");
  const p = await bedrock.approve(request.id);
  assert.equal(p.platform, "bedrock");
  assert.match(p.uuid, /^00000000-0000-0000-/);
});

test("a verified Bedrock request (Floodgate UUID from the login) is approved without any gamertag lookup", async () => {
  let lookups = 0;
  const bedrock = new AccessService(db, fakeLookup, async () => (lookups++, null));
  const verified = "00000000-0000-0000-0009-01f64f65c7c3";
  const { request } = bedrock.recordAttempt("Ethan5026", verified, "oneblock", "bedrock");
  const p = await bedrock.approve(request.id);
  assert.equal(lookups, 0, "no GeyserMC API call needed");
  assert.equal(p.uuid, verified);
  assert.equal(p.platform, "bedrock");
  assert.ok(bedrock.findApproved("anything", verified, "bedrock"), "matched by verified UUID, not name");
  assert.equal(bedrock.findApproved("Ethan5026", undefined, "java")?.role, "owner", "the Java owner account is untouched");
});
