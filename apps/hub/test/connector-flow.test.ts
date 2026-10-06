// End-to-end: Claude-style connector sign-in with owner approval, then MCP tool calls.
// Runs both listeners in-process on random ports with a throwaway data dir.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dataDir = mkdtempSync(path.join(tmpdir(), "worldsmith-hub-"));
Object.assign(process.env, {
  PUBLIC_BASE_URL: "https://worldsmith.example.ts.net",
  PORTAL_URL: "https://worldsmith.example.ts.net:8443",
  OWNER_LOGIN: "owner@example.com",
  OWNER_NAME: "Owner",
  DATA_DIR: dataDir,
  WORLD_STATUS_TARGET: "127.0.0.1:1", // nothing listens: world reports offline
});

const { config } = await import("../src/config.ts");
const { openDb } = await import("../src/db.ts");
const { Push } = await import("../src/push.ts");
const { OwnerApprovalOAuth } = await import("../src/oauth.ts");
const { createPublicApp } = await import("../src/public-app.ts");
const { createPrivateApp } = await import("../src/private-app.ts");
const { WorkerClient } = await import("../src/worker-client.ts");
const { AccessService } = await import("../src/access.ts");
const { WorldService } = await import("../src/worlds.ts");
const { Settings } = await import("../src/settings.ts");
const { BuildService } = await import("../src/builds.ts");
const { ProposalService } = await import("../src/proposals.ts");

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = "https://worldsmith.example.ts.net/mcp";
const OWNER = { "Tailscale-User-Login": "owner@example.com", "Tailscale-User-Name": "Owner Person" };

let pub = "";
let priv = "";
const servers: Server[] = [];
const pendingNotified: string[] = [];
let closeDb = (): void => {};

before(async () => {
  const db = openDb(config.dataDir);
  closeDb = () => db.close();
  const push = new Push(db, config.dataDir, config.portalUrl.origin);
  const oauth = new OwnerApprovalOAuth(db, {
    resourceUrl: config.mcpUrl,
    allowLocalRedirects: false,
    onPending: (p) => pendingNotified.push(p.matchCode),
  });
  const listen = (app: { listen: (port: number, host: string) => Server }) =>
    new Promise<string>((resolve) => {
      const s = app.listen(0, "127.0.0.1");
      servers.push(s);
      s.on("listening", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    });
  // No worlds exist in this test, so the worker is never called.
  const worker = new WorkerClient(new URL("http://127.0.0.1:1"), "x".repeat(32));
  const access = new AccessService(db, async (name) =>
    name.toLowerCase() === "sam" ? { uuid: "11111111-1111-1111-1111-111111111111", name: "Sam" } : null,
  );
  const worldsSvc = new WorldService(db, worker, access, config.recipesDir);
  const services = { worker, access, push, settings: new Settings(db), worlds: worldsSvc, builds: new BuildService(worldsSvc), proposals: new ProposalService(db, worldsSvc, push) };
  pub = await listen(createPublicApp(config, oauth, services));
  priv = await listen(createPrivateApp(config, db, oauth, services));
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

// Bodies are asserted field by field, so loose typing is fine in this test.
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
});

const mcp = (token: string, body: unknown) =>
  fetch(`${pub}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

test("metadata advertises the MCP resource, PKCE, DCR and client metadata documents", async () => {
  const as = await json(fetch(`${pub}/.well-known/oauth-authorization-server`));
  assert.equal(as.issuer, "https://worldsmith.example.ts.net/");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.ok(as.registration_endpoint);
  const pr = await json(fetch(`${pub}/.well-known/oauth-protected-resource/mcp`));
  assert.equal(pr.resource, RESOURCE);
});

test("unauthenticated MCP calls get 401 pointing at resource metadata", async () => {
  const res = await mcp("nope", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=".*oauth-protected-resource\/mcp"/);
});

test("portal routes are not reachable on the public listener", async () => {
  for (const p of ["/api/connections", "/api/me", "/index.html", "/app.js"]) {
    assert.equal((await fetch(`${pub}${p}`)).status, 404, p);
  }
});

test("portal rejects anyone who isn't the owner's Tailscale identity", async () => {
  assert.equal((await fetch(`${priv}/api/me`)).status, 403);
  assert.equal((await fetch(`${priv}/api/me`, { headers: { "Tailscale-User-Login": "someone@else.com" } })).status, 403);
  assert.equal((await fetch(`${priv}/api/me`, { headers: OWNER })).status, 200);
});

test("client registration only accepts Claude's callback", async () => {
  const bad = await fetch(`${pub}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
  });
  assert.equal(bad.status, 400);
});

test("full sign-in: owner approval in portal, PKCE token exchange, tool call, refresh rotation", async () => {
  // 1. Register like Claude does (DCR).
  const reg = await fetch(`${pub}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }),
  });
  assert.equal(reg.status, 201);
  const { client_id } = await json(reg);

  // 2. Start authorization with PKCE; the browser lands on the waiting page.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = new URL(`${pub}/authorize`);
  Object.entries({
    response_type: "code",
    client_id,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource: RESOURCE,
    scope: "worldsmith",
  }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const page = await fetch(authUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  const id = /const id = "([^"]+)"/.exec(html)?.[1];
  const shownCode = /class="code"[^>]*>([A-Z2-9]{6})</.exec(html)?.[1];
  assert.ok(id && shownCode, "waiting page shows id and match code");
  assert.deepEqual(pendingNotified, [shownCode], "owner was notified with the same code");

  // 3. Nothing is issued before approval.
  assert.equal((await fetch(`${pub}/connect/complete?id=${id}`, { redirect: "manual" })).status, 409);

  // 4. Owner sees the same code in the portal and approves (CSRF header required).
  const { pending } = await json(fetch(`${priv}/api/connections`, { headers: OWNER }));
  assert.equal(pending[0].matchCode, shownCode);
  const noCsrf = await fetch(`${priv}/api/connections/${pending[0].id}/approve`, { method: "POST", headers: OWNER });
  assert.equal(noCsrf.status, 403);
  const approve = await fetch(`${priv}/api/connections/${pending[0].id}/approve`, {
    method: "POST",
    headers: { ...OWNER, "X-WorldSmith": "1" },
  });
  assert.equal(approve.status, 200);

  // 5. Waiting page completes: redirect to Claude's callback with code + state, exactly once.
  const done = await fetch(`${pub}/connect/complete?id=${id}`, { redirect: "manual" });
  assert.equal(done.status, 302);
  const location = new URL(done.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, CALLBACK);
  assert.equal(location.searchParams.get("state"), "state-123");
  const code = location.searchParams.get("code")!;
  assert.equal((await fetch(`${pub}/connect/complete?id=${id}`, { redirect: "manual" })).status, 409);

  // 6. Wrong PKCE verifier fails; the right one gets tokens; the code can't be replayed.
  const tokenReq = (v: string) =>
    fetch(`${pub}/token`, form({ grant_type: "authorization_code", code, code_verifier: v, redirect_uri: CALLBACK, client_id, resource: RESOURCE }));
  assert.equal((await tokenReq(randomBytes(32).toString("base64url"))).status, 400);
  const tokRes = await tokenReq(verifier);
  assert.equal(tokRes.status, 200);
  const tokens = (await tokRes.json()) as { access_token: string; refresh_token: string; token_type: string };
  assert.equal(tokens.token_type, "Bearer");
  assert.equal((await tokenReq(verifier)).status, 400, "authorization code is single-use");

  // 7. MCP works with the token.
  const list = await json(mcp(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const toolNames = list.result.tools.map((t: { name: string }) => t.name).sort();
  for (const t of ["list_players", "list_recipes", "list_worlds", "ping", "run_commands", "start_world", "stop_world", "world_status"]) {
    assert.ok(toolNames.includes(t), `tool ${t}`);
  }
  assert.ok(!toolNames.some((t: string) => /approve|whitelist|delete|create/.test(t)), "no tools that let people in or delete/create worlds");
  const call = await json(
    mcp(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_recipes", arguments: {} } }),
  );
  assert.match(call.result.content[0].text, /oneblock/);
  const blocked = await json(
    mcp(tokens.access_token, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "run_commands", arguments: { slug: "nope", commands: ["whitelist add Stranger"] } },
    }),
  );
  assert.equal(blocked.result.isError, true, "unknown world or blocked command is an error, never executed");

  // 8. Portal shows the active connection.
  const { active } = await json(fetch(`${priv}/api/connections`, { headers: OWNER }));
  assert.equal(active.length, 1);

  // 9. Refresh rotates; replaying the old refresh token revokes everything.
  const refresh = (rt: string) => fetch(`${pub}/token`, form({ grant_type: "refresh_token", refresh_token: rt, client_id }));
  const r1 = await refresh(tokens.refresh_token);
  assert.equal(r1.status, 200);
  const rotated = (await r1.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.equal((await mcp(rotated.access_token, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status, 200);
  assert.equal((await refresh(tokens.refresh_token)).status, 400, "old refresh token rejected");
  assert.equal((await mcp(rotated.access_token, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status, 401, "reuse revoked the connection");
});

test("declined requests send Claude an access_denied error", async () => {
  const reg = (await (
    await fetch(`${pub}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }),
    })
  ).json()) as { client_id: string };
  const authUrl = new URL(`${pub}/authorize`);
  Object.entries({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: CALLBACK,
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
    state: "s",
  }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const id = /const id = "([^"]+)"/.exec(await (await fetch(authUrl)).text())![1]!;
  const { pending } = (await json(fetch(`${priv}/api/connections`, { headers: OWNER }))) as {
    pending: { id: string }[];
  };
  const mine = pending.find((p) => p.id === id)!;
  await fetch(`${priv}/api/connections/${mine.id}/deny`, { method: "POST", headers: { ...OWNER, "X-WorldSmith": "1" } });
  const done = await fetch(`${pub}/connect/complete?id=${id}`, { redirect: "manual" });
  assert.equal(new URL(done.headers.get("location")!).searchParams.get("error"), "access_denied");
});

test("invite link: friend opens it, enters their name, gets the address; link then expires", async () => {
  // Owner sets the public address and creates a one-time invite in the portal.
  const OWNER_POST = { ...OWNER, "X-WorldSmith": "1", "Content-Type": "application/json" };
  await fetch(`${priv}/api/settings`, { method: "PUT", headers: OWNER_POST, body: JSON.stringify({ java_address: "lucky-cat.joinmc.link" }) });
  const created = await json(fetch(`${priv}/api/invites`, { method: "POST", headers: OWNER_POST, body: JSON.stringify({ days: 3, maxUses: 1 }) }));
  const url = new URL(created.url);
  assert.equal(url.origin, "https://worldsmith.example.ts.net", "invite URLs use the public (Funnel) address");
  const invitePath = url.pathname;

  const pageRes = await fetch(`${pub}${invitePath}`);
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await pageRes.text(), /Java username or Xbox gamertag/);

  const bad = await fetch(`${pub}${invitePath}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "name=No%20Spaces" });
  assert.equal(bad.status, 400);

  const ok = await fetch(`${pub}${invitePath}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "name=Sam" });
  assert.equal(ok.status, 200);
  const okHtml = await ok.text();
  assert.match(okHtml, /You're in, Sam!/);
  assert.match(okHtml, /lucky-cat.joinmc.link/);

  const players = await json(fetch(`${priv}/api/players`, { headers: OWNER }));
  assert.ok(players.some((p: { name: string }) => p.name === "Sam"));

  assert.equal((await fetch(`${pub}${invitePath}`)).status, 410, "used up");
  assert.equal((await fetch(`${pub}/invite/made-up-token`)).status, 410);
  assert.equal((await fetch(`${priv}/api/invites`, { headers: { "Tailscale-User-Login": "x@y.z" } })).status, 403, "only the owner makes invites");
});

test("world sub-routes reach their own handlers (not the generic start/stop/feature route)", async () => {
  const OWNER_POST = { ...OWNER, "X-WorldSmith": "1", "Content-Type": "application/json" };
  // No world "ghost" exists: each specific route must answer with its own "No world" error, never the
  // generic route's "Invalid option: expected one of start|stop|feature|apply".
  for (const sub of ["backups", "restore"]) {
    const r = await json(fetch(`${priv}/api/worlds/ghost/${sub}`, { method: "POST", headers: OWNER_POST, body: JSON.stringify({ id: "20261005-000000-x.tar.gz" }) }));
    assert.doesNotMatch(String(r.error), /expected one of/, sub);
    assert.match(String(r.error), /No world called "ghost"/, sub);
  }
  const bogus = await fetch(`${priv}/api/worlds/ghost/explode`, { method: "POST", headers: OWNER_POST });
  assert.equal(bogus.status, 404, "unknown actions fall through to 404");
});

test("Bedrock (Floodgate) UUIDs are accepted by the portal API (they aren't RFC 4122)", async () => {
  const OWNER_PUT = { ...OWNER, "X-WorldSmith": "1", "Content-Type": "application/json" };
  const r = await fetch(`${priv}/api/players/00000000-0000-0000-0009-01f7e8b0e639/role`, { method: "PUT", headers: OWNER_PUT, body: JSON.stringify({ role: "admin" }) });
  const body = (await r.json()) as { error?: string };
  assert.doesNotMatch(String(body.error ?? ""), /Invalid UUID/, "validation must accept Floodgate UUIDs");
  assert.match(String(body.error ?? ""), /No such friend/, "reaches the handler");
});
