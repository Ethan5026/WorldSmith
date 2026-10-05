// Worker HTTP API. Only the hub calls it (bearer token); it is never published to the LAN,
// tailnet or internet. Whoever holds the token controls Docker, so keep the surface small.

import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WorldFile, WorldSpec } from "@worldsmith/core";
import type { WorldRuntime } from "./runtime.ts";

const SlugParam = z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/);

class BadRequest extends Error {}

export function createWorkerApp(runtime: WorldRuntime, token: string): express.Express {
  const app = express();
  app.disable("x-powered-by");
  const want = createHash("sha256").update(token).digest();

  app.use((req, res, next) => {
    const got = createHash("sha256").update(String(req.get("authorization") ?? "").replace(/^Bearer /, "")).digest();
    if (!timingSafeEqual(want, got)) return void res.status(401).json({ error: "unauthorized" });
    next();
  });
  app.use(express.json({ limit: "20mb" }));

  const slugOf = (req: express.Request): string => SlugParam.parse(req.params.slug);
  const handle =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    async (req, res) => {
      try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json(out ?? { ok: true });
      } catch (err) {
        const message = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
        console.error(JSON.stringify({ t: new Date().toISOString(), event: "worker_error", path: req.path, message }));
        if (!res.headersSent) res.status(err instanceof z.ZodError || err instanceof BadRequest ? 400 : 500).json({ error: message });
      }
    };

  app.get("/health", handle(async () => ({ ok: true, docker: (await runtime.docker.version()).Version })));
  app.get("/worlds", handle(async () => runtime.list()));
  app.get("/worlds/:slug", handle(async (req) => runtime.status(slugOf(req))));

  app.put(
    "/worlds/:slug",
    handle(async (req) => {
      const body = z
        .object({ spec: WorldSpec, rconPassword: z.string().min(24), extraFiles: z.array(WorldFile).default([]) })
        .parse(req.body);
      if (body.spec.slug !== slugOf(req)) throw new BadRequest("slug in the URL and in the spec differ");
      await runtime.apply(body.spec, body.rconPassword, body.extraFiles);
      return runtime.status(body.spec.slug);
    }),
  );
  app.post(
    "/worlds/:slug/files",
    handle(async (req) => {
      const { files } = z.object({ files: z.array(WorldFile).min(1) }).parse(req.body);
      await runtime.putFiles(slugOf(req), files);
    }),
  );
  app.post("/worlds/:slug/start", handle(async (req) => runtime.start(slugOf(req))));
  app.post("/worlds/:slug/stop", handle(async (req) => runtime.stop(slugOf(req))));
  app.post(
    "/worlds/:slug/rcon",
    handle(async (req) => {
      const { commands } = z.object({ commands: z.array(z.string().min(1).max(1446)).min(1).max(500) }).parse(req.body);
      return { outputs: await runtime.rcon(slugOf(req), commands) };
    }),
  );
  app.get("/worlds/:slug/backups", handle(async (req) => runtime.listBackups(slugOf(req))));
  app.post(
    "/worlds/:slug/backups",
    handle(async (req) => {
      const { label } = z.object({ label: z.string().max(32).default("manual") }).parse(req.body ?? {});
      return runtime.backup(slugOf(req), label);
    }),
  );
  app.post(
    "/worlds/:slug/restore",
    handle(async (req) => {
      const { id } = z.object({ id: z.string().max(80) }).parse(req.body);
      return { safetyBackup: await runtime.restore(slugOf(req), id) };
    }),
  );
  app.get(
    "/worlds/:slug/logs",
    handle(async (req, res) => {
      const tail = z.coerce.number().int().min(1).max(5000).default(200).parse(req.query.tail);
      res.type("text").send(await runtime.logs(slugOf(req), tail));
    }),
  );
  app.delete(
    "/worlds/:slug",
    handle(async (req) => runtime.remove(slugOf(req), req.query.purge === "true")),
  );
  return app;
}
