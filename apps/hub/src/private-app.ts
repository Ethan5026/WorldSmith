// Private listener — the owner portal. Reachable only over the tailnet via `tailscale serve`
// (never Funnel). Tailscale injects the caller's identity headers; only the owner gets in.

import express from "express";
import { fileURLToPath } from "node:url";
import type { PushSubscription } from "web-push";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { OwnerApprovalOAuth } from "./oauth.ts";
import type { HubServices } from "./services.ts";
import { WorldProperties } from "@worldsmith/core";
import { audit, type Db } from "./db.ts";

const portalDir = fileURLToPath(new URL("../portal", import.meta.url));
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/);

export function createPrivateApp(config: Config, db: Db, oauth: OwnerApprovalOAuth, services: HubServices): express.Express {
  const { worlds, access, push } = services;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");

  app.use((req, res, next) => {
    const login = String(req.get("Tailscale-User-Login") ?? "").toLowerCase();
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    if (login !== config.ownerLogin) {
      res.status(403).type("text").send("WorldSmith portal: this Tailscale account isn't the owner.");
      return;
    }
    res.locals.ownerName = req.get("Tailscale-User-Name") ?? config.ownerName;
    next();
  });

  // Cross-site requests can't add custom headers without a CORS preflight we never allow.
  const csrf: express.RequestHandler = (req, res, next) => {
    if (req.get("X-WorldSmith") !== "1") return void res.status(403).json({ error: "Missing X-WorldSmith header" });
    next();
  };
  const handle =
    (fn: (req: express.Request) => Promise<unknown> | unknown): express.RequestHandler =>
    async (req, res) => {
      try {
        res.set("Cache-Control", "no-store").json((await fn(req)) ?? { ok: true });
      } catch (err) {
        const message = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
        res.status(err instanceof z.ZodError ? 400 : 409).json({ error: message });
      }
    };
  app.use("/api", express.json({ limit: "64kb" }));

  app.get("/api/me", (_req, res) => {
    res.json({ name: res.locals.ownerName, pushSubscriptions: push.count(), vapidPublicKey: push.publicKey });
  });

  // ---- worlds ----
  app.get(
    "/api/worlds",
    handle(async () => ({
      worlds: await worlds.views(),
      recipes: [...worlds.recipes.values()].map((r) => ({ id: r.id, name: r.name, description: r.description, tags: r.tags })),
    })),
  );
  app.get(
    "/api/world",
    handle(async () => {
      const slug = worlds.featuredSlug();
      return slug ? worlds.view(slug) : { state: "none" };
    }),
  );
  app.post(
    "/api/worlds",
    csrf,
    handle(async (req) => {
      const body = z.object({ recipe: z.string(), slug: Slug, name: z.string().min(1).max(60) }).parse(req.body);
      return worlds.createFromRecipe(body.recipe, body.slug, body.name);
    }),
  );
  app.post(
    "/api/worlds/:slug/adopt",
    csrf,
    handle(async (req) => {
      const body = z
        .object({ recipe: z.string(), name: z.string().min(1).max(60), properties: WorldProperties.optional() })
        .parse(req.body);
      return worlds.adopt(body.recipe, Slug.parse(req.params.slug), body.name, body.properties);
    }),
  );
  const WORLD_ACTIONS = ["start", "stop", "feature", "apply"];
  app.post(
    "/api/worlds/:slug/:action",
    csrf,
    // Only claim the simple actions; let /backups, /restore, /adopt fall through to their own routes.
    (req, _res, next) => next(WORLD_ACTIONS.includes(String(req.params.action)) ? undefined : "route"),
    handle(async (req) => {
      const slug = Slug.parse(req.params.slug);
      const action = z.enum(["start", "stop", "feature", "apply"]).parse(req.params.action);
      if (action === "start") await worlds.start(slug, "owner (portal)");
      if (action === "stop") await worlds.stop(slug, "owner (portal)");
      if (action === "feature") worlds.setFeatured(slug);
      if (action === "apply") return worlds.reapply(slug);
      return worlds.view(slug, true);
    }),
  );

  app.get(
    "/api/worlds/:slug/access",
    handle((req) => {
      const slug = Slug.parse(req.params.slug);
      worlds.spec(slug);
      return access.worldAccess(slug);
    }),
  );
  app.put(
    "/api/worlds/:slug/access",
    csrf,
    handle(async (req) => {
      const slug = Slug.parse(req.params.slug);
      worlds.spec(slug);
      const change = z
        .object({ mode: z.enum(["everyone", "picked"]).optional(), onlyWithMe: z.boolean().optional(), members: z.array(z.uuid()).max(500).optional() })
        .parse(req.body);
      access.setWorldAccess(slug, change);
      await worlds.syncAccess(slug);
      return access.worldAccess(slug);
    }),
  );

  // ---- backups ----
  app.get("/api/worlds/:slug/backups", handle((req) => worlds.listBackups(Slug.parse(req.params.slug))));
  app.post(
    "/api/worlds/:slug/backups",
    csrf,
    handle((req) => worlds.backup(Slug.parse(req.params.slug), "manual")),
  );
  app.post(
    "/api/worlds/:slug/restore",
    csrf,
    handle((req) => worlds.restore(Slug.parse(req.params.slug), z.object({ id: z.string().max(80) }).parse(req.body).id)),
  );

  // ---- invites ----
  app.get("/api/invites", handle(() => access.invites()));
  app.post(
    "/api/invites",
    csrf,
    handle((req) => {
      const body = z
        .object({ world: Slug.optional(), days: z.number().int().min(1).max(30).default(7), maxUses: z.number().int().min(1).max(20).default(1) })
        .parse(req.body ?? {});
      if (body.world) worlds.spec(body.world);
      const { token, invite } = access.createInvite({ worldSlug: body.world, days: body.days, maxUses: body.maxUses });
      return { url: new URL(`/invite/${token}`, config.publicBaseUrl).href, invite };
    }),
  );
  app.delete(
    "/api/invites/:id",
    csrf,
    handle((req) => access.revokeInvite(z.coerce.number().int().parse(req.params.id))),
  );

  // ---- settings ----
  app.get("/api/settings", handle(() => services.settings.all()));
  app.put(
    "/api/settings",
    csrf,
    handle((req) => {
      const body = z
        .object({ java_address: z.string().max(120).nullable().optional(), bedrock_address: z.string().max(120).nullable().optional() })
        .parse(req.body);
      for (const [k, v] of Object.entries(body)) services.settings.set(k as "java_address" | "bedrock_address", v ?? null);
      return services.settings.all();
    }),
  );

  // ---- friends ----
  app.get("/api/requests", handle(() => access.pendingRequests()));
  app.post(
    "/api/requests/:id/:decision",
    csrf,
    handle(async (req) => {
      const id = z.coerce.number().int().parse(req.params.id);
      const decision = z.enum(["approve", "deny"]).parse(req.params.decision);
      if (decision === "deny") return access.deny(id);
      const player = await access.approve(id);
      await worlds.syncAccessEverywhere();
      return player;
    }),
  );
  app.get("/api/players", handle(() => access.players()));
  app.post(
    "/api/players",
    csrf,
    handle(async (req) => {
      const { name, role } = z.object({ name: z.string().min(3).max(16), role: z.enum(["admin", "player"]).default("player") }).parse(req.body);
      const player = await access.addJavaPlayer(name, role);
      await worlds.syncAccessEverywhere();
      return player;
    }),
  );
  app.delete(
    "/api/players/:uuid",
    csrf,
    handle(async (req) => {
      access.removePlayer(z.uuid().parse(req.params.uuid));
      await worlds.syncAccessEverywhere();
    }),
  );

  // ---- Claude connections ----
  app.get("/api/connections", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ pending: oauth.listPending(), active: oauth.activeConnections() });
  });
  app.post("/api/connections/:id/:decision", csrf, (req, res) => {
    const id = String(req.params.id);
    const decision = String(req.params.decision);
    if (decision !== "approve" && decision !== "deny") return void res.status(400).json({ error: "Unknown decision" });
    const ok = oauth.decide(id, decision === "approve");
    res.status(ok ? 200 : 409).json({ ok, error: ok ? undefined : "This request already expired or was decided." });
  });
  app.post("/api/clients/:clientId/disconnect", csrf, (req, res) => {
    oauth.revokeClient(String(req.params.clientId));
    res.json({ ok: true });
  });

  // ---- notifications ----
  app.post("/api/push/subscribe", csrf, (req, res) => {
    const sub = req.body as PushSubscription;
    if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) {
      return void res.status(400).json({ error: "Invalid push subscription" });
    }
    push.subscribe(sub);
    audit(db, "push_subscribed", { host: new URL(sub.endpoint).host });
    res.json({ ok: true, count: push.count() });
  });
  app.post("/api/push/test", csrf, async (_req, res) => {
    const delivered = await push.notify({
      title: "WorldSmith",
      body: "Notifications work. You'll hear from me here when friends ask to join.",
      url: "/",
      tag: "test",
    });
    res.json({ delivered });
  });

  app.use(express.static(portalDir, { index: "index.html", maxAge: 0 }));
  app.use((_req, res) => void res.status(404).type("text").send("Not found"));
  return app;
}
