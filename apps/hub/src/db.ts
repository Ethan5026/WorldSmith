// Hub state in one SQLite file (node:sqlite). Moving the hub = moving this file + .env.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "hub.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id   TEXT PRIMARY KEY,
      info        TEXT NOT NULL,          -- OAuthClientInformationFull JSON
      created_at  INTEGER NOT NULL
    );

    -- A Claude connection waiting for the owner to approve it in the portal.
    CREATE TABLE IF NOT EXISTS oauth_pending (
      id          TEXT PRIMARY KEY,       -- random, known only to the browser doing the flow
      client_id   TEXT NOT NULL,
      client_name TEXT,
      params      TEXT NOT NULL,          -- AuthorizationParams JSON
      match_code  TEXT NOT NULL,          -- short code shown on both screens
      status      TEXT NOT NULL CHECK (status IN ('pending','approved','denied','completed','expired')),
      created_at  INTEGER NOT NULL,
      decided_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash   TEXT PRIMARY KEY,
      client_id   TEXT NOT NULL,
      params      TEXT NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash  TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('access','refresh')),
      client_id   TEXT NOT NULL,
      scopes      TEXT NOT NULL,
      resource    TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint     TEXT PRIMARY KEY,
      subscription TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );

    -- Worlds the hub manages. spec = WorldSpec JSON (the single source of truth for the worker).
    CREATE TABLE IF NOT EXISTS worlds (
      slug            TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      recipe          TEXT,
      spec            TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      last_active_at  INTEGER,
      only_with_me    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );

    -- Approved players. UUID is the real account id (Mojang for Java, Floodgate-derived for Bedrock).
    CREATE TABLE IF NOT EXISTS players (
      uuid         TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      platform     TEXT NOT NULL DEFAULT 'java' CHECK (platform IN ('java','bedrock')),
      role         TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('owner','admin','player')),
      approved_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS players_name ON players (lower(name));

    -- People who tried to join without access.
    CREATE TABLE IF NOT EXISTS join_requests (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      claimed_uuid   TEXT,
      platform       TEXT NOT NULL DEFAULT 'java',
      world_slug     TEXT,
      attempts       INTEGER NOT NULL DEFAULT 1,
      first_seen     INTEGER NOT NULL,
      last_seen      INTEGER NOT NULL,
      last_notified  INTEGER,
      status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
      decided_at     INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS join_requests_open ON join_requests (lower(name)) WHERE status = 'pending';

    -- Per-world guest list, used when a world's access_mode is 'picked'.
    CREATE TABLE IF NOT EXISTS world_members (
      world_slug   TEXT NOT NULL,
      player_uuid  TEXT NOT NULL,
      PRIMARY KEY (world_slug, player_uuid)
    );

    -- Invite links. The token itself is the owner's approval, so only its hash is stored.
    CREATE TABLE IF NOT EXISTS invites (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash  TEXT NOT NULL UNIQUE,
      world_slug  TEXT,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      max_uses    INTEGER NOT NULL,
      uses        INTEGER NOT NULL DEFAULT 0,
      revoked     INTEGER NOT NULL DEFAULT 0
    );

    -- Bedrock approvals waiting for the player's first verified login (gives us their real XUID).
    CREATE TABLE IF NOT EXISTS bedrock_preapprovals (
      gamertag_key  TEXT PRIMARY KEY,     -- lowercased, spaces → underscores (Geyser's form)
      gamertag      TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'player',
      world_slug    TEXT,
      created_at    INTEGER NOT NULL
    );

    -- Things Claude suggests that only the owner can approve (new worlds), decided in the portal.
    CREATE TABLE IF NOT EXISTS proposals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('world_from_map')),
      title       TEXT NOT NULL,
      payload     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','building','approved','declined','failed')),
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      decided_at  INTEGER,
      result      TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      event   TEXT NOT NULL,
      detail  TEXT
    );
  `);
  // Additive migrations for databases created by earlier versions.
  addColumn(db, "worlds", "last_backup_at", "last_backup_at INTEGER");
  addColumn(db, "worlds", "lan_port", "lan_port INTEGER");
  addColumn(db, "worlds", "access_mode", "access_mode TEXT NOT NULL DEFAULT 'everyone' CHECK (access_mode IN ('everyone','picked'))");
  return db;
}

function addColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function audit(db: Db, event: string, detail: Record<string, unknown> = {}): void {
  db.prepare("INSERT INTO audit_log (at, event, detail) VALUES (?, ?, ?)").run(Date.now(), event, JSON.stringify(detail));
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...detail }));
}
