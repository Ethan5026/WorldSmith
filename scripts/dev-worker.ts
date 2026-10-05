// Developer CLI for the worker API (needs deploy/compose.dev.yaml so the worker is on 127.0.0.1:7070).
//   node scripts/dev-worker.ts health
//   node scripts/dev-worker.ts apply <recipe> <slug> "<name>" ['{"enableCommandBlock":true}']
//   node scripts/dev-worker.ts start|stop|status|logs <slug>
//   node scripts/dev-worker.ts rcon <slug> "<command>" ["<command>" ...]

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { instantiateRecipe, loadRecipes } from "../packages/core/src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = Object.fromEntries(
  readFileSync(`${root}/deploy/.env`, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const base = process.env.WORKER_URL ?? "http://127.0.0.1:7070";

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.WORKER_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const [cmd, a, b, ...rest] = process.argv.slice(2);
let out: unknown;
switch (cmd) {
  case "health":
    out = await call("GET", "/health");
    break;
  case "apply": {
    const recipe = loadRecipes(`${root}/recipes`).get(a!);
    if (!recipe) throw new Error(`No recipe ${a}`);
    const spec = instantiateRecipe(recipe, { slug: b!, name: rest[0] ?? recipe.name, properties: rest[1] ? JSON.parse(rest[1]) : undefined });
    out = await call("PUT", `/worlds/${b}`, { spec, rconPassword: randomBytes(24).toString("base64url") });
    break;
  }
  case "start":
  case "stop":
    out = await call("POST", `/worlds/${a}/${cmd}`);
    break;
  case "status":
    out = await call("GET", `/worlds/${a}`);
    break;
  case "logs":
    out = await call("GET", `/worlds/${a}/logs?tail=${b ?? 60}`);
    break;
  case "rcon":
    out = await call("POST", `/worlds/${a}/rcon`, { commands: [b, ...rest] });
    break;
  default:
    throw new Error("usage: health | apply <recipe> <slug> <name> | start|stop|status|logs <slug> | rcon <slug> <cmd...>");
}
console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
