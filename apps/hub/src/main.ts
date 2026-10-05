// WorldSmith hub entry point.
//   :443 (Funnel, public)  → publicPort   Claude connector (OAuth + MCP)
//   :8443 (tailnet only)   → privatePort  owner portal
//   /ipc/hub.sock          → gate API      join decisions for the gatekeeper

import { config } from "./config.ts";
import { audit, openDb } from "./db.ts";
import { Push } from "./push.ts";
import { OwnerApprovalOAuth } from "./oauth.ts";
import { createPublicApp } from "./public-app.ts";
import { createPrivateApp } from "./private-app.ts";
import { WorkerClient } from "./worker-client.ts";
import { AccessService } from "./access.ts";
import { WorldService } from "./worlds.ts";
import { GateService, listenGate } from "./gate.ts";
import { Settings } from "./settings.ts";
import { BuildService } from "./builds.ts";

if (config.workerToken.length < 32) throw new Error("WORKER_TOKEN must be set (32+ chars)");

const db = openDb(config.dataDir);
const push = new Push(db, config.dataDir, config.portalUrl.origin);
const worker = new WorkerClient(config.workerUrl, config.workerToken);
const access = new AccessService(db);
const worlds = new WorldService(db, worker, access, config.recipesDir);
const gate = new GateService(db, access, worlds, push, config.ownerName, config.floodgateKey);

const oauth = new OwnerApprovalOAuth(db, {
  resourceUrl: config.mcpUrl,
  allowLocalRedirects: config.allowLocalRedirects,
  onPending: (p) => {
    void push.notify({
      title: "Approve Claude connection?",
      body: `${p.clientName} wants to connect to WorldSmith. Code ${p.matchCode}`,
      url: "/#connections",
      tag: `connect-${p.matchCode}`,
    });
  },
});

const services = { worlds, access, push, worker, settings: new Settings(db), builds: new BuildService(worlds) };

createPublicApp(config, oauth, services).listen(config.publicPort, "127.0.0.1", () => {
  console.log(`public listener on 127.0.0.1:${config.publicPort} → ${config.publicBaseUrl.href}`);
});
createPrivateApp(config, db, oauth, services).listen(config.privatePort, "127.0.0.1", () => {
  console.log(`portal listener on 127.0.0.1:${config.privatePort} → ${config.portalUrl.href}`);
});
listenGate(gate, config.gateSocket);

// The owner's Minecraft account is always approved and always an operator.
if (config.ownerMinecraft) {
  access
    .addJavaPlayer(config.ownerMinecraft, "owner")
    .then(() => worlds.syncAccessEverywhere())
    .catch((err) => console.error("couldn't register the owner's Minecraft account", err));
}

setInterval(() => {
  worlds.sleepIdleWorlds().catch((err) => console.error("idle check failed", err));
}, 60_000);

audit(db, "hub_started", { worlds: worlds.rows().length, recipes: [...worlds.recipes.keys()] });
