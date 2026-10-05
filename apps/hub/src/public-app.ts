// Public listener — the only thing Tailscale Funnel exposes to the internet.
// Mounted here: OAuth metadata/endpoints, the connect-approval waiting flow, and /mcp.
// Nothing from the owner portal is mounted on this app.

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Config } from "./config.ts";
import { SCOPE, type OwnerApprovalOAuth } from "./oauth.ts";
import { createMcpServer } from "./mcp.ts";
import { audit } from "./db.ts";
import type { HubServices } from "./services.ts";
import { mountInvitePages } from "./invite-pages.ts";

export function createPublicApp(config: Config, oauth: OwnerApprovalOAuth, services: HubServices): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback"); // tailscaled proxies from 127.0.0.1 and sets X-Forwarded-For
  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    next();
  });

  // Advertise Client ID Metadata Document support on top of the SDK's metadata (it doesn't by default).
  const asMetadata = {
    ...createOAuthMetadata({ provider: oauth, issuerUrl: config.publicBaseUrl, scopesSupported: [SCOPE] }),
    client_id_metadata_document_supported: true,
  };
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300").json(asMetadata);
  });

  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: config.publicBaseUrl,
      resourceServerUrl: config.mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: "WorldSmith",
    }),
  );

  // Waiting page polling + completion (see oauth.ts). The id is the only credential and is
  // single-use; issuing a code still requires the owner's approval in the portal.
  app.get("/connect/status", (req, res) => {
    const status = oauth.pendingStatus(String(req.query.id ?? ""));
    res.set("Cache-Control", "no-store").json({ status: status ?? "unknown" });
  });
  app.get("/connect/complete", (req, res) => {
    const target = oauth.complete(String(req.query.id ?? ""));
    if (!target) return void res.status(409).type("text").send("This connection request isn't ready or was already used.");
    res.set("Cache-Control", "no-store").redirect(302, target);
  });

  const bearer = requireBearerAuth({
    verifier: oauth,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
    expectedResource: config.mcpUrl,
  });

  // Stateless Streamable HTTP: a fresh server + transport per request.
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    if (body?.method === "tools/call") {
      audit(oauth.db, "mcp_tool_call", { tool: body.params?.name, clientId: req.auth?.clientId });
    }
    const server = createMcpServer(config, services, req.auth?.clientId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("mcp request failed", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });
  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", bearer, methodNotAllowed);
  app.delete("/mcp", bearer, methodNotAllowed);

  mountInvitePages(app, services, config.ownerName);

  app.get("/", (_req, res) => void res.type("text").send("WorldSmith"));
  app.use((_req, res) => void res.status(404).type("text").send("Not found"));
  return app;
}
