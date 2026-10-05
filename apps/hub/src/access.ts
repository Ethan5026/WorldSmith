// Who may play where: approved players, per-world guest lists, join requests, invite links, and
// keeping each world's whitelist/ops in sync. The backend whitelist (by UUID, online-mode) is the
// real lock; the gatekeeper's check is the friendly front door that turns "no" into a request.

import { createHash, randomBytes } from "node:crypto";
import type { WorldFile } from "@worldsmith/core";
import { audit, type Db } from "./db.ts";
import { floodgateUuid, lookupBedrockXuid, lookupJavaProfile } from "./mojang.ts";

export type Role = "owner" | "admin" | "player";
export type AccessMode = "everyone" | "picked";

export interface Player {
  uuid: string;
  name: string;
  platform: "java" | "bedrock";
  role: Role;
  approved_at: number;
}

export interface JoinRequest {
  id: number;
  name: string;
  claimed_uuid: string | null;
  platform: string;
  world_slug: string | null;
  attempts: number;
  first_seen: number;
  last_seen: number;
  last_notified: number | null;
  status: "pending" | "approved" | "denied";
}

export interface Invite {
  id: number;
  world_slug: string | null;
  created_at: number;
  expires_at: number;
  max_uses: number;
  uses: number;
  revoked: number;
}

const NOTIFY_EVERY_MS = 10 * 60 * 1000;
/** Floodgate UUIDs are new UUID(0, xuid); anything else on a Bedrock request is unverified. */
const floodgateShaped = (uuid: string | null): string | undefined =>
  uuid && /^00000000-0000-0000-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid) ? uuid : undefined;
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export type ProfileLookup = (name: string) => Promise<{ uuid: string; name: string } | null>;
export type XuidLookup = (gamertag: string) => Promise<string | null>;
export type Platform = "java" | "bedrock";
export interface Preapproval {
  preapproved: true;
  name: string;
  platform: "bedrock";
  role: Role;
}

export class AccessService {
  db: Db;
  lookup: ProfileLookup;
  lookupXuid: XuidLookup;

  constructor(db: Db, lookup: ProfileLookup = lookupJavaProfile, lookupXuid: XuidLookup = lookupBedrockXuid) {
    this.db = db;
    this.lookup = lookup;
    this.lookupXuid = lookupXuid;
  }

  // ---- players --------------------------------------------------------------------------------

  players(): Player[] {
    return this.db.prepare("SELECT * FROM players ORDER BY role, lower(name)").all() as unknown as Player[];
  }

  player(uuid: string): Player | undefined {
    return this.db.prepare("SELECT * FROM players WHERE uuid = ?").get(uuid) as unknown as Player | undefined;
  }

  owner(): Player | undefined {
    return this.db.prepare("SELECT * FROM players WHERE role = 'owner' LIMIT 1").get() as unknown as Player | undefined;
  }

  /**
   * Approved player matching this login, or undefined. Java: a claimed UUID must match when present.
   * Bedrock: matched by gamertag; Floodgate on the world verifies the real Xbox identity.
   */
  findApproved(name: string, claimedUuid?: string, platform: Platform = "java"): Player | undefined {
    if (platform === "bedrock") {
      // With a verified Floodgate UUID, match the account exactly; otherwise fall back to the gamertag.
      if (claimedUuid) return this.db.prepare("SELECT * FROM players WHERE platform = 'bedrock' AND uuid = ?").get(claimedUuid) as unknown as Player | undefined;
      return this.db.prepare("SELECT * FROM players WHERE platform = 'bedrock' AND lower(name) = lower(?)").get(name) as unknown as
        | Player
        | undefined;
    }
    const byName = this.db.prepare("SELECT * FROM players WHERE platform = 'java' AND lower(name) = lower(?)").get(name) as unknown as Player | undefined;
    if (!byName) return claimedUuid ? this.player(claimedUuid) : undefined; // renamed account
    if (claimedUuid && byName.uuid !== claimedUuid) return undefined;
    return byName;
  }

  async addJavaPlayer(name: string, role: Role = "player"): Promise<Player> {
    const profile = await this.lookup(name);
    if (!profile) throw new Error(`No Minecraft: Java Edition account is named "${name}".`);
    this.db
      .prepare(
        `INSERT INTO players (uuid, name, platform, role, approved_at) VALUES (?, ?, 'java', ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET name = excluded.name,
           role = CASE WHEN players.role IN ('owner','admin') THEN players.role ELSE excluded.role END`,
      )
      .run(profile.uuid, profile.name, role, Date.now());
    audit(this.db, "player_approved", { name: profile.name, uuid: profile.uuid, role });
    return this.player(profile.uuid)!;
  }

  /** Add a Bedrock player by Xbox gamertag (Geyser replaces spaces with underscores). */
  async addBedrockPlayer(gamertag: string, role: Role = "player", verifiedUuid?: string): Promise<Player> {
    const name = gamertag.trim().replace(/ /g, "_");
    let uuid = verifiedUuid;
    if (!uuid) {
      const xuid = await this.lookupXuid(gamertag.trim());
      if (!xuid) throw new Error(`No Xbox account has the gamertag "${gamertag}".`);
      uuid = floodgateUuid(xuid);
    }
    this.db
      .prepare(
        `INSERT INTO players (uuid, name, platform, role, approved_at) VALUES (?, ?, 'bedrock', ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET name = excluded.name`,
      )
      .run(uuid, name, role, Date.now());
    audit(this.db, "player_approved", { name, uuid, role, platform: "bedrock" });
    return this.player(uuid)!;
  }

  // ---- Bedrock pre-approvals --------------------------------------------------------------------

  preapproveBedrock(gamertag: string, role: Role = "player", worldSlug?: string): Preapproval {
    const name = gamertag.trim().replace(/ /g, "_");
    this.db
      .prepare(
        `INSERT INTO bedrock_preapprovals (gamertag_key, gamertag, role, world_slug, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(gamertag_key) DO UPDATE SET role = excluded.role, world_slug = excluded.world_slug`,
      )
      .run(name.toLowerCase(), name, role, worldSlug ?? null, Date.now());
    audit(this.db, "bedrock_preapproved", { gamertag: name, role, worldSlug });
    return { preapproved: true, name, platform: "bedrock", role };
  }

  preapprovals(): { gamertag: string; role: Role; world_slug: string | null; created_at: number }[] {
    return this.db.prepare("SELECT gamertag, role, world_slug, created_at FROM bedrock_preapprovals ORDER BY created_at DESC").all() as never;
  }

  /**
   * Called only for VERIFIED Bedrock logins (gamertag + XUID decrypted from Geyser's data with our key),
   * so trusting the gamertag here is safe. Turns a waiting approval into a real player.
   */
  async claimPreapproval(gamertag: string, verifiedUuid: string): Promise<Player | undefined> {
    const key = gamertag.trim().replace(/ /g, "_").toLowerCase();
    const row = this.db.prepare("SELECT * FROM bedrock_preapprovals WHERE gamertag_key = ?").get(key) as
      | { gamertag: string; role: Role; world_slug: string | null }
      | undefined;
    if (!row) return undefined;
    const player = await this.addBedrockPlayer(row.gamertag, row.role, verifiedUuid);
    if (row.role === "admin" && player.role === "player") this.setRole(player.uuid, "admin");
    if (row.world_slug) this.addMember(row.world_slug, player.uuid);
    this.db.prepare("DELETE FROM bedrock_preapprovals WHERE gamertag_key = ?").run(key);
    audit(this.db, "bedrock_preapproval_claimed", { gamertag: row.gamertag, uuid: verifiedUuid, role: row.role });
    return this.player(player.uuid);
  }

  removePlayer(uuid: string): void {
    const p = this.player(uuid);
    if (!p) return;
    if (p.role === "owner") throw new Error("The owner can't be removed.");
    this.db.prepare("DELETE FROM players WHERE uuid = ?").run(uuid);
    this.db.prepare("DELETE FROM world_members WHERE player_uuid = ?").run(uuid);
    audit(this.db, "player_removed", { name: p.name, uuid });
  }

  // ---- per-world access -----------------------------------------------------------------------

  worldAccess(slug: string): { mode: AccessMode; onlyWithMe: boolean; members: string[] } {
    const w = this.db.prepare("SELECT access_mode, only_with_me FROM worlds WHERE slug = ?").get(slug) as
      | { access_mode: AccessMode; only_with_me: number }
      | undefined;
    const members = (this.db.prepare("SELECT player_uuid FROM world_members WHERE world_slug = ?").all(slug) as { player_uuid: string }[]).map(
      (m) => m.player_uuid,
    );
    return { mode: w?.access_mode ?? "everyone", onlyWithMe: w?.only_with_me === 1, members };
  }

  setWorldAccess(slug: string, change: { mode?: AccessMode; onlyWithMe?: boolean; members?: string[] }): void {
    if (change.mode) this.db.prepare("UPDATE worlds SET access_mode = ? WHERE slug = ?").run(change.mode, slug);
    if (change.onlyWithMe !== undefined) this.db.prepare("UPDATE worlds SET only_with_me = ? WHERE slug = ?").run(change.onlyWithMe ? 1 : 0, slug);
    if (change.members) {
      this.db.prepare("DELETE FROM world_members WHERE world_slug = ?").run(slug);
      const add = this.db.prepare("INSERT OR IGNORE INTO world_members (world_slug, player_uuid) VALUES (?, ?)");
      for (const uuid of change.members) if (this.player(uuid)) add.run(slug, uuid);
    }
    audit(this.db, "world_access_changed", { slug, ...change });
  }

  addMember(slug: string, uuid: string): void {
    this.db.prepare("INSERT OR IGNORE INTO world_members (world_slug, player_uuid) VALUES (?, ?)").run(slug, uuid);
  }

  /** Owner and admins can join every world; others depend on the world's mode. */
  canJoin(player: Player, slug: string): boolean {
    if (player.role === "owner" || player.role === "admin") return true;
    const access = this.worldAccess(slug);
    return access.mode === "everyone" || access.members.includes(player.uuid);
  }

  allowedPlayers(slug: string): Player[] {
    return this.players().filter((p) => this.canJoin(p, slug));
  }

  /** whitelist.json + ops.json for one world. */
  accessFiles(slug: string): WorldFile[] {
    const allowed = this.allowedPlayers(slug);
    const whitelist = allowed.map((p) => ({ uuid: p.uuid, name: p.platform === "bedrock" ? `.${p.name}` : p.name }));
    const ops = allowed
      .filter((p) => p.role === "owner" || p.role === "admin")
      .map((p) => ({ uuid: p.uuid, name: p.name, level: p.role === "owner" ? 4 : 3, bypassesPlayerLimit: true }));
    return [
      { kind: "inline", path: "whitelist.json", content: JSON.stringify(whitelist, null, 2), encoding: "utf8" },
      { kind: "inline", path: "ops.json", content: JSON.stringify(ops, null, 2), encoding: "utf8" },
    ];
  }

  /** Console commands that make a running server match the files (ops.json has no reload command). */
  liveSyncCommands(slug: string): string[] {
    const ops = this.allowedPlayers(slug).filter((p) => p.role === "owner" || p.role === "admin");
    return ["whitelist reload", ...ops.map((p) => `op ${p.name}`)];
  }

  // ---- join requests --------------------------------------------------------------------------

  /** Declines are per edition: a Java "Sam" and a Bedrock "Sam" are different people. */
  isDenied(name: string, platform: Platform = "java"): boolean {
    const row = this.db
      .prepare("SELECT status FROM join_requests WHERE lower(name) = lower(?) AND platform = ? ORDER BY id DESC LIMIT 1")
      .get(name, platform) as { status: string } | undefined;
    return row?.status === "denied";
  }

  /** A declined person tried again: count it on their declined request, without notifying anyone. */
  recordDeclinedAttempt(name: string, claimedUuid: string | undefined, platform: Platform): void {
    this.db
      .prepare(
        `UPDATE join_requests SET attempts = attempts + 1, last_seen = ?, claimed_uuid = coalesce(?, claimed_uuid)
         WHERE id = (SELECT max(id) FROM join_requests WHERE lower(name) = lower(?) AND platform = ? AND status = 'denied')`,
      )
      .run(Date.now(), claimedUuid ?? null, name, platform);
  }

  /** Everyone currently declined (latest decision per name + edition), most recent attempt first. */
  declinedRequests(): JoinRequest[] {
    return this.db
      .prepare(
        `SELECT * FROM join_requests jr WHERE status = 'denied'
           AND id = (SELECT max(id) FROM join_requests WHERE lower(name) = lower(jr.name) AND platform = jr.platform)
         ORDER BY last_seen DESC`,
      )
      .all() as unknown as JoinRequest[];
  }

  /** Undo a decline: the request goes back to pending so it can be approved. Owner-only. */
  reopen(requestId: number): void {
    const r = this.db.prepare("UPDATE join_requests SET status = 'pending', decided_at = NULL WHERE id = ? AND status = 'denied'").run(requestId);
    if (r.changes !== 1) throw new Error("Only declined requests can be reopened.");
    audit(this.db, "join_reopened", { requestId });
  }

  setRole(uuid: string, role: "admin" | "player"): Player {
    const p = this.player(uuid);
    if (!p) throw new Error("No such friend.");
    if (p.role === "owner") throw new Error("The owner's role can't be changed.");
    this.db.prepare("UPDATE players SET role = ? WHERE uuid = ?").run(role, uuid);
    audit(this.db, "player_role_changed", { name: p.name, uuid, role });
    return this.player(uuid)!;
  }

  /** Record an attempt. Returns the request and whether the owner should be notified now. */
  recordAttempt(
    name: string,
    claimedUuid: string | undefined,
    worldSlug: string | undefined,
    platform: Platform = "java",
  ): { request: JoinRequest; notify: boolean } {
    const now = Date.now();
    const open = this.db
      .prepare("SELECT * FROM join_requests WHERE lower(name) = lower(?) AND status = 'pending'")
      .get(name) as unknown as JoinRequest | undefined;
    if (open) {
      this.db
        .prepare("UPDATE join_requests SET attempts = attempts + 1, last_seen = ?, claimed_uuid = coalesce(?, claimed_uuid), world_slug = coalesce(?, world_slug) WHERE id = ?")
        .run(now, claimedUuid ?? null, worldSlug ?? null, open.id);
    } else {
      this.db
        .prepare("INSERT INTO join_requests (name, claimed_uuid, world_slug, platform, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
        .run(name, claimedUuid ?? null, worldSlug ?? null, platform, now, now);
      audit(this.db, "join_request", { name, worldSlug, platform });
    }
    const request = this.db
      .prepare("SELECT * FROM join_requests WHERE lower(name) = lower(?) AND status = 'pending'")
      .get(name) as unknown as JoinRequest;
    const notify = !request.last_notified || now - request.last_notified > NOTIFY_EVERY_MS;
    if (notify) this.db.prepare("UPDATE join_requests SET last_notified = ? WHERE id = ?").run(now, request.id);
    return { request, notify };
  }

  pendingRequests(): (JoinRequest & { knownPlayer: boolean })[] {
    const rows = this.db.prepare("SELECT * FROM join_requests WHERE status = 'pending' ORDER BY last_seen DESC").all() as unknown as JoinRequest[];
    return rows.map((r) => ({ ...r, knownPlayer: Boolean(this.findApproved(r.name, undefined, r.platform as Platform)) }));
  }

  /** Approve a request: add the player (if new) and give them the world they asked for. Owner-only. */
  async approve(requestId: number, role: "admin" | "player" = "player"): Promise<Player | Preapproval> {
    const req = this.db.prepare("SELECT * FROM join_requests WHERE id = ?").get(requestId) as unknown as JoinRequest | undefined;
    if (!req || req.status !== "pending") throw new Error("That request was already handled.");
    const platform = req.platform as Platform;
    if (platform === "bedrock" && !floodgateShaped(req.claimed_uuid) && !this.findApproved(req.name, undefined, "bedrock")) {
      // Not verified yet. Try GeyserMC's gamertag lookup; if it can't help, save the approval and let
      // their next verified Bedrock login in.
      const looked = await this.addBedrockPlayer(req.name, role).catch(() => undefined);
      if (looked) {
        if (req.world_slug) this.addMember(req.world_slug, looked.uuid);
        this.db.prepare("UPDATE join_requests SET status = 'approved', decided_at = ? WHERE id = ?").run(Date.now(), requestId);
        audit(this.db, "join_approved", { requestId, name: looked.name, worldSlug: req.world_slug });
        return looked;
      }
      const pre = this.preapproveBedrock(req.name, role, req.world_slug ?? undefined);
      this.db.prepare("UPDATE join_requests SET status = 'approved', decided_at = ? WHERE id = ?").run(Date.now(), requestId);
      audit(this.db, "join_approved", { requestId, name: req.name, worldSlug: req.world_slug, pending: "first verified login" });
      return pre;
    }
    // Bedrock requests carry the Floodgate UUID verified from Geyser's encrypted login data.
    const player =
      this.findApproved(req.name, platform === "bedrock" ? (req.claimed_uuid ?? undefined) : undefined, platform) ??
      (platform === "bedrock"
        ? await this.addBedrockPlayer(req.name, role, floodgateShaped(req.claimed_uuid))
        : await this.addJavaPlayer(req.name, role));
    if (role === "admin" && player.role === "player") this.setRole(player.uuid, "admin");
    if (req.world_slug) this.addMember(req.world_slug, player.uuid);
    this.db.prepare("UPDATE join_requests SET status = 'approved', decided_at = ? WHERE id = ?").run(Date.now(), requestId);
    audit(this.db, "join_approved", { requestId, name: player.name, worldSlug: req.world_slug });
    return player;
  }

  deny(requestId: number): void {
    const r = this.db.prepare("UPDATE join_requests SET status = 'denied', decided_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), requestId);
    if (r.changes !== 1) throw new Error("That request was already handled.");
    audit(this.db, "join_denied", { requestId });
  }

  // ---- invite links ---------------------------------------------------------------------------

  createInvite(opts: { worldSlug?: string; days: number; maxUses: number }): { token: string; invite: Invite } {
    const token = randomBytes(18).toString("base64url");
    const now = Date.now();
    this.db
      .prepare("INSERT INTO invites (token_hash, world_slug, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), opts.worldSlug ?? null, now, now + opts.days * 86_400_000, opts.maxUses);
    const invite = this.db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha256(token)) as unknown as Invite;
    audit(this.db, "invite_created", { id: invite.id, worldSlug: opts.worldSlug, days: opts.days, maxUses: opts.maxUses });
    return { token, invite };
  }

  invites(): Invite[] {
    return this.db
      .prepare("SELECT id, world_slug, created_at, expires_at, max_uses, uses, revoked FROM invites WHERE revoked = 0 AND expires_at > ? AND uses < max_uses ORDER BY id DESC")
      .all(Date.now()) as unknown as Invite[];
  }

  revokeInvite(id: number): void {
    this.db.prepare("UPDATE invites SET revoked = 1 WHERE id = ?").run(id);
    audit(this.db, "invite_revoked", { id });
  }

  /** A usable invite for this token, or undefined (unknown, used up, expired or revoked). */
  checkInvite(token: string): Invite | undefined {
    const inv = this.db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha256(token)) as unknown as Invite | undefined;
    if (!inv || inv.revoked || inv.expires_at < Date.now() || inv.uses >= inv.max_uses) return undefined;
    return inv;
  }

  /** Redeem: the token is the owner's approval. Adds the player (and the invite's world). */
  async redeemInvite(token: string, name: string, platform: Platform = "java"): Promise<{ player: Player; invite: Invite }> {
    const inv = this.checkInvite(token);
    if (!inv) throw new Error("This invite link has expired or was already used. Ask for a new one.");
    // Claim a use first, atomically, so two simultaneous redemptions can't exceed max_uses.
    const claimed = this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked = 0").run(inv.id);
    if (claimed.changes !== 1) throw new Error("This invite link was just used up. Ask for a new one.");
    try {
      const player =
        this.findApproved(name, undefined, platform) ??
        (platform === "bedrock" ? await this.addBedrockPlayer(name) : await this.addJavaPlayer(name));
      if (inv.world_slug) this.addMember(inv.world_slug, player.uuid);
      audit(this.db, "invite_redeemed", { id: inv.id, name: player.name, worldSlug: inv.world_slug });
      return { player, invite: inv };
    } catch (err) {
      this.db.prepare("UPDATE invites SET uses = uses - 1 WHERE id = ?").run(inv.id); // give the use back
      throw err;
    }
  }
}
