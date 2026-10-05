// OAuth 2.1 authorization server for the Claude connector.
//
// There is no password. When Claude starts a connection, the browser shows a short match code
// and waits; the owner approves that code in the tailnet-only portal (proven by Tailscale identity).
// Only then is an authorization code issued to Claude's callback. PKCE, redirect-URI allowlisting,
// single-use codes, hashed tokens, refresh rotation with reuse detection, and audience-bound
// tokens cover the rest.

import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { audit, type Db } from "./db.ts";

export const SCOPE = "worldsmith";
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

/** Claude's OAuth callback lives on these hosts. Nothing else may receive codes. */
const CLAUDE_HOSTS = ["claude.ai", "claude.com"];
/** Hosts allowed to publish a Client ID Metadata Document (Claude's "published identity"). */
const CIMD_HOSTS = ["claude.ai", "claude.com", "anthropic.com"];
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_CACHE_MS = 60 * 60 * 1000;

const MATCH_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no 0/O/1/I

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const token = (): string => randomBytes(32).toString("base64url");
const sameResource = (a: string, b: string): boolean => a.replace(/#.*$/, "").replace(/\/$/, "") === b.replace(/#.*$/, "").replace(/\/$/, "");

function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((h) => host === h || host.endsWith(`.${h}`));
}

function matchCode(): string {
  return [...randomBytes(6)].map((b) => MATCH_ALPHABET[b & 31]).join("");
}

export interface PendingConnection {
  id: string;
  matchCode: string;
  clientName: string;
  createdAt: number;
}

interface StoredParams {
  state?: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource: string;
}

export interface OAuthOptions {
  resourceUrl: URL;
  allowLocalRedirects: boolean;
  /** Called when a connection starts waiting for approval (sends the push notification). */
  onPending: (p: PendingConnection) => void;
}

export class OwnerApprovalOAuth implements OAuthServerProvider {
  db: Db;
  opts: OAuthOptions;
  cimdCache = new Map<string, { info: OAuthClientInformationFull; until: number }>();

  constructor(db: Db, opts: OAuthOptions) {
    this.db = db;
    this.opts = opts;
  }

  // ---- clients ---------------------------------------------------------------------------

  redirectAllowed(uri: string): boolean {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    if (u.protocol === "https:" && hostAllowed(u.hostname, CLAUDE_HOSTS)) return true;
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return this.opts.allowLocalRedirects && u.protocol === "http:" && local;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        if (clientId.startsWith("https://")) return this.fetchClientMetadataDocument(clientId);
        const row = this.db.prepare("SELECT info FROM oauth_clients WHERE client_id = ?").get(clientId) as
          | { info: string }
          | undefined;
        return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined;
      },
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        const uris = full.redirect_uris ?? [];
        if (uris.length === 0 || !uris.every((u) => this.redirectAllowed(String(u)))) {
          throw new InvalidClientMetadataError("redirect_uris must be Claude's OAuth callback");
        }
        if (full.client_name && full.client_name.length > 100) full.client_name = full.client_name.slice(0, 100);
        this.db
          .prepare("INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)")
          .run(full.client_id, JSON.stringify(full), Date.now());
        audit(this.db, "oauth_client_registered", { clientId: full.client_id, name: full.client_name });
        return full;
      },
    };
  }

  /** Client ID Metadata Documents: the client_id is an https URL serving the client's metadata. */
  async fetchClientMetadataDocument(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const cached = this.cimdCache.get(clientId);
    if (cached && cached.until > Date.now()) return cached.info;
    const url = new URL(clientId);
    if (url.protocol !== "https:" || !hostAllowed(url.hostname, CIMD_HOSTS)) return undefined;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!res.ok) return undefined;
      const text = await res.text();
      if (text.length > CIMD_MAX_BYTES) return undefined;
      const doc = JSON.parse(text) as Partial<OAuthClientInformationFull>;
      const uris = (doc.redirect_uris ?? []).map(String);
      if (doc.client_id !== clientId || uris.length === 0 || !uris.every((u) => this.redirectAllowed(u))) {
        return undefined;
      }
      const info: OAuthClientInformationFull = {
        client_id: clientId,
        redirect_uris: uris,
        client_name: (doc.client_name ?? "Claude").slice(0, 100),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
      this.cimdCache.set(clientId, { info, until: Date.now() + CIMD_CACHE_MS });
      return info;
    } catch {
      return undefined;
    }
  }

  // ---- authorization (owner approval) ---------------------------------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = params.resource?.href ?? this.opts.resourceUrl.href;
    if (!sameResource(resource, this.opts.resourceUrl.href)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.opts.resourceUrl.href}`);
    }
    const scopes = params.scopes?.length ? params.scopes : [SCOPE];
    if (!scopes.every((s) => s === SCOPE)) throw new InvalidScopeError(`Only the "${SCOPE}" scope exists`);

    const pending: PendingConnection = {
      id: token(),
      matchCode: matchCode(),
      clientName: client.client_name ?? "Claude",
      createdAt: Date.now(),
    };
    const stored: StoredParams = {
      state: params.state,
      scopes,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource,
    };
    this.db
      .prepare(
        `INSERT INTO oauth_pending (id, client_id, client_name, params, match_code, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(pending.id, client.client_id, pending.clientName, JSON.stringify(stored), pending.matchCode, pending.createdAt);
    audit(this.db, "oauth_pending", { clientId: client.client_id, matchCode: pending.matchCode });
    this.opts.onPending(pending);

    const nonce = randomBytes(16).toString("base64");
    res
      .status(200)
      .set({
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "Referrer-Policy": "no-referrer",
      })
      .type("html")
      .send(waitingPage(pending, nonce));
  }

  private expireStale(): void {
    this.db
      .prepare("UPDATE oauth_pending SET status = 'expired' WHERE status IN ('pending','approved') AND created_at < ?")
      .run(Date.now() - PENDING_TTL_MS);
  }

  pendingStatus(id: string): string | undefined {
    this.expireStale();
    const row = this.db.prepare("SELECT status FROM oauth_pending WHERE id = ?").get(id) as { status: string } | undefined;
    return row?.status;
  }

  listPending(): PendingConnection[] {
    this.expireStale();
    const rows = this.db
      .prepare("SELECT id, match_code, client_name, created_at FROM oauth_pending WHERE status = 'pending' ORDER BY created_at DESC")
      .all() as { id: string; match_code: string; client_name: string; created_at: number }[];
    return rows.map((r) => ({ id: r.id, matchCode: r.match_code, clientName: r.client_name, createdAt: r.created_at }));
  }

  /** Owner decision from the portal. Returns false if the request is gone or already decided. */
  decide(id: string, approve: boolean): boolean {
    this.expireStale();
    const result = this.db
      .prepare("UPDATE oauth_pending SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(approve ? "approved" : "denied", Date.now(), id);
    if (result.changes === 1) audit(this.db, approve ? "oauth_approved" : "oauth_denied", { id: id.slice(0, 6) });
    return result.changes === 1;
  }

  /** Called by the waiting page once decided. Returns where to send the browser, or undefined if not ready. */
  complete(id: string): string | undefined {
    this.expireStale();
    const row = this.db.prepare("SELECT client_id, params, status FROM oauth_pending WHERE id = ?").get(id) as
      | { client_id: string; params: string; status: string }
      | undefined;
    if (!row || row.status === "pending" || row.status === "completed") return undefined;
    const params = JSON.parse(row.params) as StoredParams;
    const target = new URL(params.redirectUri);
    if (params.state !== undefined) target.searchParams.set("state", params.state);

    // Mark consumed first so a second call can't mint a second code.
    const consumed = this.db
      .prepare("UPDATE oauth_pending SET status = 'completed' WHERE id = ? AND status = ?")
      .run(id, row.status);
    if (consumed.changes !== 1) return undefined;

    if (row.status !== "approved") {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set(
        "error_description",
        row.status === "expired" ? "The request expired before it was approved" : "The owner declined this connection",
      );
      return target.href;
    }
    const code = token();
    this.db
      .prepare("INSERT INTO oauth_codes (code_hash, client_id, params, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(code), row.client_id, row.params, Date.now() + CODE_TTL_MS);
    target.searchParams.set("code", code);
    return target.href;
  }

  // ---- codes and tokens ------------------------------------------------------------------------

  private loadCode(client: OAuthClientInformationFull, code: string): StoredParams {
    const row = this.db.prepare("SELECT client_id, params, expires_at FROM oauth_codes WHERE code_hash = ?").get(sha256(code)) as
      | { client_id: string; params: string; expires_at: number }
      | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return JSON.parse(row.params) as StoredParams;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.loadCode(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const params = this.loadCode(client, code);
    this.db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(sha256(code)); // single use
    if (redirectUri !== undefined && redirectUri !== params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    if (resource && !sameResource(resource.href, params.resource)) throw new InvalidTargetError("resource mismatch");
    return this.issueTokens(client.client_id, params.scopes, params.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.db
      .prepare("SELECT client_id, scopes, resource, expires_at, revoked FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
      .get(sha256(refreshToken)) as
      | { client_id: string; scopes: string; resource: string; expires_at: number; revoked: number }
      | undefined;
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    if (row.revoked) {
      // A rotated-out refresh token came back: assume theft and cut the whole connection.
      this.revokeClient(client.client_id, "refresh_token_reuse");
      throw new InvalidGrantError("Refresh token was already used; connection revoked");
    }
    if (row.expires_at < Date.now()) throw new InvalidGrantError("Refresh token expired");
    if (resource && !sameResource(resource.href, row.resource)) throw new InvalidTargetError("resource mismatch");
    const granted = row.scopes.split(" ");
    if (scopes?.some((s) => !granted.includes(s))) throw new InvalidScopeError("Cannot widen scopes on refresh");
    this.db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?").run(sha256(refreshToken));
    return this.issueTokens(client.client_id, scopes?.length ? scopes : granted, row.resource);
  }

  private issueTokens(clientId: string, scopes: string[], resource: string): OAuthTokens {
    const access = token();
    const refresh = token();
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes, resource, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(sha256(access), "access", clientId, scopes.join(" "), resource, now + ACCESS_TTL_S * 1000, now);
    insert.run(sha256(refresh), "refresh", clientId, scopes.join(" "), resource, now + REFRESH_TTL_S * 1000, now);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const row = this.db
      .prepare("SELECT client_id, scopes, resource, expires_at, revoked FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
      .get(sha256(accessToken)) as
      | { client_id: string; scopes: string; resource: string; expires_at: number; revoked: number }
      | undefined;
    if (!row || row.revoked || row.expires_at < Date.now()) throw new InvalidTokenError("Invalid or expired token");
    return {
      token: accessToken,
      clientId: row.client_id,
      scopes: row.scopes.split(" "),
      expiresAt: Math.floor(row.expires_at / 1000),
      resource: new URL(row.resource),
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.db
      .prepare("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ?")
      .run(sha256(request.token), client.client_id);
  }

  // ---- portal views ----------------------------------------------------------------------------

  activeConnections(): { clientId: string; clientName: string; since: number }[] {
    const rows = this.db
      .prepare(
        `SELECT t.client_id, MIN(t.created_at) AS since, c.info
           FROM oauth_tokens t LEFT JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.kind = 'refresh' AND t.revoked = 0 AND t.expires_at > ?
          GROUP BY t.client_id`,
      )
      .all(Date.now()) as { client_id: string; since: number; info: string | null }[];
    return rows.map((r) => ({
      clientId: r.client_id,
      clientName: r.info ? ((JSON.parse(r.info) as OAuthClientInformationFull).client_name ?? "Claude") : "Claude",
      since: r.since,
    }));
  }

  revokeClient(clientId: string, reason = "owner_disconnected"): void {
    this.db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ?").run(clientId);
    audit(this.db, "oauth_client_revoked", { clientId, reason });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function waitingPage(p: PendingConnection, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Claude to WorldSmith</title>
<style nonce="${nonce}">
  :root { --ground:#edf1f0; --surface:#f9fbfa; --ink:#17201e; --muted:#56655f; --line:#cdd8d4; --accent:#1b7564; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --ground:#111715; --surface:#182120; --ink:#e2eae7; --muted:#97a8a2; --line:#2b3734; --accent:#5bc0a7; } }
  body { margin:0; background:var(--ground); color:var(--ink); font:16px/1.55 system-ui, "Segoe UI", sans-serif; padding:32px 18px; }
  main { max-width:28rem; margin:auto; display:grid; gap:18px; }
  h1 { font-size:1.45rem; margin:0; line-height:1.2; }
  .code { font:600 2.4rem/1 ui-monospace, Consolas, monospace; letter-spacing:.18em; background:var(--surface); border:1px solid var(--line); padding:18px; text-align:center; color:var(--accent); }
  p { margin:0; color:var(--muted); }
  #state { color:var(--ink); }
</style></head>
<body><main>
  <h1>Approve this connection in your WorldSmith portal</h1>
  <p><strong>${escapeHtml(p.clientName)}</strong> wants to manage your Minecraft worlds. Open the portal (or tap the notification on your phone) and approve the request showing this code:</p>
  <div class="code" aria-label="Match code">${p.matchCode}</div>
  <p id="state" role="status">Waiting for approval…</p>
  <p>If you didn't start this, ignore it. It expires in 10 minutes.</p>
</main>
<script nonce="${nonce}">
  const id = ${JSON.stringify(p.id)};
  const state = document.getElementById("state");
  async function poll() {
    try {
      const r = await fetch("/connect/status?id=" + encodeURIComponent(id), { cache: "no-store" });
      const { status } = await r.json();
      if (status === "approved" || status === "denied" || status === "expired") {
        state.textContent = status === "approved" ? "Approved. Returning to Claude…" : "This request was " + status + ".";
        location.replace("/connect/complete?id=" + encodeURIComponent(id));
        return;
      }
    } catch {}
    setTimeout(poll, 2000);
  }
  poll();
</script></body></html>`;
}
