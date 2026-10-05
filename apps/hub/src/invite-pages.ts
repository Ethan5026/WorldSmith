// Public invite pages (served through Funnel at /invite/<token>). A friend opens the link, types
// their Minecraft username, and gets the address + version + steps. The token is the owner's
// approval; it is single-purpose, expiring, use-limited, and stored only as a hash.

import express from "express";
import { randomBytes } from "node:crypto";
import { isValidUsername } from "@worldsmith/mcproto";
import type { HubServices } from "./services.ts";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, { count: number; since: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.since > WINDOW_MS) {
    hits.set(ip, { count: 1, since: now });
    return false;
  }
  h.count++;
  return h.count > MAX_PER_WINDOW;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(res: express.Response, status: number, title: string, body: string): void {
  const nonce = randomBytes(16).toString("base64");
  res
    .status(status)
    .set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    })
    .type("html")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style nonce="${nonce}">
  :root { --ground:#edf1f0; --surface:#f9fbfa; --ink:#17201e; --muted:#56655f; --line:#cdd8d4; --accent:#1b7564; --risk:#a23a2b; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --ground:#111715; --surface:#182120; --ink:#e2eae7; --muted:#97a8a2; --line:#2b3734; --accent:#5bc0a7; --risk:#ea7b67; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ground); color:var(--ink); font:16px/1.55 system-ui, "Segoe UI", sans-serif; padding:32px 18px; }
  main { max-width:30rem; margin:auto; display:grid; gap:16px; }
  h1 { font-size:1.5rem; margin:0; line-height:1.2; }
  p, ol { margin:0; } .muted { color:var(--muted); } .error { color:var(--risk); font-weight:600; }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px 16px; display:grid; gap:10px; }
  label { font-weight:600; }
  input { width:100%; min-height:46px; font:inherit; padding:0 12px; border-radius:10px; border:1px solid var(--line); background:var(--ground); color:var(--ink); }
  button { min-height:46px; font:inherit; font-weight:700; border:0; border-radius:10px; background:var(--accent); color:#fff; }
  code { font:600 1.15rem ui-monospace, Consolas, monospace; color:var(--accent); word-break:break-all; }
  ol { padding-left:1.2em; display:grid; gap:6px; }
</style></head><body><main>${body}</main></body></html>`);
}

export function mountInvitePages(app: express.Express, services: HubServices, ownerName: string): void {
  const { access, worlds } = services;
  const address = (): string | undefined => services.settings.get("java_address");

  const worldLabel = (slug: string | null): { name: string; version: string } | undefined => {
    const target = slug ?? worlds.featuredSlug();
    if (!target || !worlds.row(target)) return undefined;
    const spec = worlds.spec(target);
    return { name: spec.name, version: spec.minecraft.version };
  };

  const form = (token: string, worldName: string | undefined, error?: string): string => `
    <h1>${esc(ownerName)} invited you to play Minecraft</h1>
    <p class="muted">${worldName ? `World: <strong>${esc(worldName)}</strong>. ` : ""}This link lets you onto ${esc(ownerName)}'s private server.</p>
    <form class="card" method="post" action="/invite/${esc(token)}">
      <label for="name">Your Minecraft: Java Edition username</label>
      <input id="name" name="name" required minlength="3" maxlength="16" pattern="[A-Za-z0-9_]{3,16}" autocomplete="username" autocapitalize="off" spellcheck="false">
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
      <button type="submit">Let me in</button>
    </form>
    <p class="muted">Playing on Xbox, PlayStation, Switch or a phone (Bedrock)? Ask ${esc(ownerName)}; that's coming soon.</p>`;

  app.get("/invite/:token", (req, res) => {
    if (rateLimited(req.ip ?? "?")) return page(res, 429, "Slow down", "<h1>Too many tries</h1><p>Wait a few minutes and try again.</p>");
    const inv = access.checkInvite(String(req.params.token));
    if (!inv) return page(res, 410, "Invite expired", `<h1>This invite has expired</h1><p class="muted">Ask ${esc(ownerName)} for a new link.</p>`);
    page(res, 200, "You're invited", form(String(req.params.token), worldLabel(inv.world_slug)?.name));
  });

  app.post("/invite/:token", express.urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
    if (rateLimited(req.ip ?? "?")) return page(res, 429, "Slow down", "<h1>Too many tries</h1><p>Wait a few minutes and try again.</p>");
    const token = String(req.params.token);
    const inv = access.checkInvite(token);
    if (!inv) return page(res, 410, "Invite expired", `<h1>This invite has expired</h1><p class="muted">Ask ${esc(ownerName)} for a new link.</p>`);
    const world = worldLabel(inv.world_slug);
    const name = String(req.body?.name ?? "").trim();
    if (!isValidUsername(name)) {
      return page(res, 400, "You're invited", form(token, world?.name, "Minecraft usernames are 3–16 letters, numbers or underscores."));
    }
    try {
      const { player } = await access.redeemInvite(token, name);
      await worlds.syncAccessEverywhere();
      void services.push.notify({
        title: `${player.name} joined your friends list`,
        body: `They used an invite link${world ? ` for ${world.name}` : ""}.`,
        url: "/",
        tag: `invite-${player.uuid}`,
      });
      const addr = address();
      page(
        res,
        200,
        "You're in",
        `<h1>You're in, ${esc(player.name)}!</h1>
        <div class="card">
          <p class="muted">Server address</p>
          ${addr ? `<code>${esc(addr)}</code>` : `<p>Ask ${esc(ownerName)} for the server address.</p>`}
          ${world ? `<p class="muted">Minecraft version: <strong>${esc(world.version)}</strong></p>` : ""}
        </div>
        <ol>
          ${world ? `<li>In the Minecraft Launcher, pick (or add) version <strong>${esc(world.version)}</strong>.</li>` : ""}
          <li>Open <strong>Multiplayer → Add Server</strong> and paste the address.</li>
          <li>Join. If the world is asleep, it wakes up; join again after about a minute.</li>
        </ol>`,
      );
    } catch (err) {
      page(res, 400, "You're invited", form(token, world?.name, (err as Error).message));
    }
  });
}
