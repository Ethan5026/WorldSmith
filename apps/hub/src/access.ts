// Who may play: approved players, join requests, and keeping every world's whitelist/ops in sync.
// The backend whitelist (by UUID, online-mode) is the real lock; the gatekeeper's check is the
// friendly front door that turns strangers into join requests instead of silent rejections.

import type { WorldFile } from "@worldsmith/core";
import { audit, type Db } from "./db.ts";
import { lookupJavaProfile } from "./mojang.ts";

export type Role = "owner" | "admin" | "player";

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

const NOTIFY_EVERY_MS = 10 * 60 * 1000;

export class AccessService {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  players(): Player[] {
    return this.db.prepare("SELECT * FROM players ORDER BY role, lower(name)").all() as unknown as Player[];
  }

  /** Approved player matching this login, or undefined. A claimed UUID must match when present. */
  findApproved(name: string, claimedUuid?: string): Player | undefined {
    const byName = this.db.prepare("SELECT * FROM players WHERE lower(name) = lower(?)").get(name) as unknown as Player | undefined;
    if (!byName) {
      // Name changed since approval? Match by account id instead.
      return claimedUuid
        ? (this.db.prepare("SELECT * FROM players WHERE uuid = ?").get(claimedUuid) as unknown as Player | undefined)
        : undefined;
    }
    if (claimedUuid && byName.uuid !== claimedUuid) return undefined;
    return byName;
  }

  isDenied(name: string): boolean {
    const row = this.db
      .prepare("SELECT status FROM join_requests WHERE lower(name) = lower(?) ORDER BY id DESC LIMIT 1")
      .get(name) as { status: string } | undefined;
    return row?.status === "denied";
  }

  /** Record an attempt. Returns the request and whether the owner should be notified now. */
  recordAttempt(name: string, claimedUuid: string | undefined, worldSlug: string | undefined): { request: JoinRequest; notify: boolean } {
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
        .prepare("INSERT INTO join_requests (name, claimed_uuid, world_slug, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)")
        .run(name, claimedUuid ?? null, worldSlug ?? null, now, now);
      audit(this.db, "join_request", { name, worldSlug });
    }
    const request = this.db
      .prepare("SELECT * FROM join_requests WHERE lower(name) = lower(?) AND status = 'pending'")
      .get(name) as unknown as JoinRequest;
    const notify = !request.last_notified || now - request.last_notified > NOTIFY_EVERY_MS;
    if (notify) this.db.prepare("UPDATE join_requests SET last_notified = ? WHERE id = ?").run(now, request.id);
    return { request, notify };
  }

  pendingRequests(): JoinRequest[] {
    return this.db.prepare("SELECT * FROM join_requests WHERE status = 'pending' ORDER BY last_seen DESC").all() as unknown as JoinRequest[];
  }

  /** Approve a request: resolve the real account and add them. Owner-only (portal). */
  async approve(requestId: number, role: Role = "player"): Promise<Player> {
    const req = this.db.prepare("SELECT * FROM join_requests WHERE id = ?").get(requestId) as unknown as JoinRequest | undefined;
    if (!req || req.status !== "pending") throw new Error("That request was already handled.");
    const player = await this.addJavaPlayer(req.name, role);
    this.db.prepare("UPDATE join_requests SET status = 'approved', decided_at = ? WHERE id = ?").run(Date.now(), requestId);
    return player;
  }

  deny(requestId: number): void {
    const r = this.db.prepare("UPDATE join_requests SET status = 'denied', decided_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), requestId);
    if (r.changes !== 1) throw new Error("That request was already handled.");
    audit(this.db, "join_denied", { requestId });
  }

  async addJavaPlayer(name: string, role: Role = "player"): Promise<Player> {
    const profile = await lookupJavaProfile(name);
    if (!profile) throw new Error(`No Minecraft: Java Edition account is named "${name}".`);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO players (uuid, name, platform, role, approved_at) VALUES (?, ?, 'java', ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, role = CASE WHEN players.role = 'owner' THEN 'owner' ELSE excluded.role END`,
      )
      .run(profile.uuid, profile.name, role, now);
    audit(this.db, "player_approved", { name: profile.name, uuid: profile.uuid, role });
    return this.db.prepare("SELECT * FROM players WHERE uuid = ?").get(profile.uuid) as unknown as Player;
  }

  removePlayer(uuid: string): void {
    const p = this.db.prepare("SELECT role, name FROM players WHERE uuid = ?").get(uuid) as { role: Role; name: string } | undefined;
    if (!p) return;
    if (p.role === "owner") throw new Error("The owner can't be removed.");
    this.db.prepare("DELETE FROM players WHERE uuid = ?").run(uuid);
    audit(this.db, "player_removed", { name: p.name, uuid });
  }

  /** whitelist.json + ops.json for every world (Phase 1.2: all approved players may join all worlds). */
  accessFiles(): WorldFile[] {
    const players = this.players();
    const whitelist = players.map((p) => ({ uuid: p.uuid, name: p.name }));
    const ops = players
      .filter((p) => p.role === "owner" || p.role === "admin")
      .map((p) => ({ uuid: p.uuid, name: p.name, level: p.role === "owner" ? 4 : 3, bypassesPlayerLimit: true }));
    return [
      { kind: "inline", path: "whitelist.json", content: JSON.stringify(whitelist, null, 2), encoding: "utf8" },
      { kind: "inline", path: "ops.json", content: JSON.stringify(ops, null, 2), encoding: "utf8" },
    ];
  }

  /** Console commands that make a running server match the files (ops.json has no reload command). */
  liveSyncCommands(): string[] {
    const ops = this.players().filter((p) => p.role === "owner" || p.role === "admin");
    return ["whitelist reload", ...ops.map((p) => `op ${p.name}`)];
  }
}
