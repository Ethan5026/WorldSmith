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
  app.post(
    "/api/worlds/:slug/:action",
    csrf,
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
