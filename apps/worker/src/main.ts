import { WorldRuntime } from "./runtime.ts";
import { createWorkerApp } from "./api.ts";

const token = process.env.WORKER_TOKEN ?? "";
if (token.length < 32) throw new Error("WORKER_TOKEN must be set (32+ chars) — see deploy/.env.example");

const runtime = new WorldRuntime({
  network: process.env.WORLDS_NETWORK ?? "worldsmith_worlds",
  cacheDir: process.env.CACHE_DIR ?? "/cache",
  backupsDir: process.env.BACKUPS_DIR ?? "/backups",
  floodgateKey: process.env.FLOODGATE_KEY_B64 || undefined,
});

const port = Number(process.env.PORT ?? 7070);
createWorkerApp(runtime, token).listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ t: new Date().toISOString(), event: "worker_listening", port, network: runtime.network }));
});
