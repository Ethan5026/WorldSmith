// Hub configuration from environment (deploy/.env). Fails fast on anything missing.

import { fileURLToPath } from "node:url";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see deploy/.env.example)`);
  return v;
}

function hostPort(value: string): { host: string; port: number } {
  const i = value.lastIndexOf(":");
  if (i < 1) throw new Error(`Expected host:port, got ${value}`);
  return { host: value.slice(0, i), port: Number(value.slice(i + 1)) };
}

const publicBaseUrl = new URL(required("PUBLIC_BASE_URL"));
if (publicBaseUrl.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must be https (Claude requires it)");

export const config = {
  /** Funnel URL Claude reaches, e.g. https://worldsmith.tail072963.ts.net */
  publicBaseUrl,
  /** The MCP endpoint; also the OAuth "resource" every token is bound to. */
  mcpUrl: new URL("/mcp", publicBaseUrl),
  /** Tailnet-only portal URL (used in notifications). */
  portalUrl: new URL(required("PORTAL_URL")),
  /** Tailscale login of the only person allowed into the portal. */
  ownerLogin: required("OWNER_LOGIN").toLowerCase(),
  ownerName: process.env.OWNER_NAME ?? "the owner",
  /** Both listeners bind to loopback: only tailscaled (same network namespace) can reach them. */
  publicPort: Number(process.env.PUBLIC_PORT ?? 3001),
  privatePort: Number(process.env.PRIVATE_PORT ?? 3000),
  dataDir: process.env.DATA_DIR ?? "./data",
  worldStatusTarget: hostPort(process.env.WORLD_STATUS_TARGET ?? "host.docker.internal:25601"),
  workerUrl: new URL(process.env.WORKER_URL ?? "http://worker:7070"),
  workerToken: process.env.WORKER_TOKEN ?? "",
  /** The owner's Minecraft account; always approved, always an operator. */
  ownerMinecraft: process.env.OWNER_MC_USERNAME ?? "",
  recipesDir: process.env.RECIPES_DIR ?? fileURLToPath(new URL("../../../recipes", import.meta.url)),
  /** Unix socket the gatekeeper uses to ask for join decisions (shared volume, no network). */
  gateSocket: process.env.GATE_SOCKET ?? "/ipc/hub.sock",
  /** Shared with Geyser/Floodgate; lets the hub verify Bedrock logins and read the real XUID. */
  floodgateKey: process.env.FLOODGATE_KEY_B64 || undefined,
  /** Only for local testing with MCP Inspector; never set in deployment. */
  allowLocalRedirects: process.env.DEV_ALLOW_LOCAL_REDIRECTS === "1",
} as const;

export type Config = typeof config;
