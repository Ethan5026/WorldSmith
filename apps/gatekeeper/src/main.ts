// WorldSmith gatekeeper: the one address friends connect to (via playit).
//
//   status ping    → MOTD + version from the hub (cached briefly)
//   login attempt  → hub decides: pipe to the world, or kick with a friendly message
//                    (join request sent / waking up / wrong version)
//
// Deliberately dumb: no secrets, no database, no Docker access. If it's compromised, an attacker
// gets a TCP relay and nothing else. The backend world still enforces online-mode + whitelist.

import http from "node:http";
import net from "node:net";
import {
  encodeLoginDisconnect,
  encodePong,
  encodeStatusResponse,
  isLegacyPing,
  MAX_PRELOGIN_FRAME,
  NextState,
  parseHandshake,
  parseLoginStart,
  ProtocolError,
  tryReadFrame,
  type Handshake,
  type TextComponent,
} from "@worldsmith/mcproto";

const LISTEN_PORT = Number(process.env.GK_PORT ?? 25565);
const HUB_SOCKET = process.env.GK_HUB_SOCKET ?? "/ipc/hub.sock";
const PRELOGIN_TIMEOUT_MS = 10_000;
/** Only world containers on the internal network may be piped to. */
const BACKEND_RE = /^ws-world-[a-z0-9][a-z0-9-]{1,30}:25565$/;

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

function askHub<T>(path: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { socketPath: HUB_SOCKET, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": payload.length }, timeout: 8000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("hub timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

interface StatusAnswer {
  versionName: string;
  protocol: number;
  motd: TextComponent;
  players: { online: number; max: number };
}
type LoginDecision = { action: "pipe"; backend: string } | { action: "kick"; reason: TextComponent };

let statusCache: { at: number; value: StatusAnswer } | undefined;
async function hubStatus(protocol: number): Promise<StatusAnswer> {
  if (statusCache && Date.now() - statusCache.at < 2000) return statusCache.value;
  try {
    const value = await askHub<StatusAnswer>("/gate/status", { protocol });
    statusCache = { at: Date.now(), value };
    return value;
  } catch {
    return {
      versionName: "WorldSmith",
      protocol,
      motd: { text: "WorldSmith · starting up, try again in a minute", color: "gray" },
      players: { online: 0, max: 0 },
    };
  }
}

function handle(client: net.Socket): void {
  const remote = `${client.remoteAddress}:${client.remotePort}`;
  client.setNoDelay(true);
  client.setTimeout(PRELOGIN_TIMEOUT_MS, () => client.destroy());
  client.on("error", () => client.destroy());

  let buf = Buffer.alloc(0);
  let state: "handshake" | "status" | "login" | "decided" = "handshake";
  let handshake: Handshake | undefined;
  const replay: Buffer[] = [];

  const kick = (reason: TextComponent): void => void client.end(encodeLoginDisconnect(reason));

  const decide = async (h: Handshake, username: string, claimedUuid: string | undefined): Promise<void> => {
    client.off("data", onData);
    client.pause();
    let decision: LoginDecision;
    try {
      decision = await askHub<LoginDecision>("/gate/login", {
        protocol: h.protocolVersion,
        username,
        claimedUuid,
        host: h.serverAddress,
        platform: h.floodgate ? "bedrock" : "java",
        // Encrypted Bedrock identity from Geyser; only the hub holds the key to read it.
        floodgate: h.floodgate ? h.rawServerAddress : undefined,
      });
    } catch (err) {
      log("hub_unreachable", { remote, error: (err as Error).message });
      return kick({ text: "WorldSmith is starting up. Try again in a minute.", color: "yellow" });
    }
    if (decision.action === "kick") {
      log("kick", { remote, username, protocol: h.protocolVersion });
      return kick(decision.reason);
    }
    if (!BACKEND_RE.test(decision.backend)) {
      log("bad_backend", { remote, backend: decision.backend });
      return kick({ text: "Something went wrong. Try again in a minute.", color: "red" });
    }
    const [host, port] = decision.backend.split(":");
    log("pipe", { remote, username, backend: decision.backend });
    const upstream = net.connect({ host: host!, port: Number(port) });
    upstream.setNoDelay(true);
    upstream.on("connect", () => {
      client.setTimeout(0);
      upstream.write(Buffer.concat([...replay, buf]));
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on("error", (err) => {
      log("backend_error", { remote, backend: decision.backend, error: err.message });
      if (client.writable) kick({ text: "That world is still starting. Try again in a moment.", color: "yellow" });
    });
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  };

  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk]);
    if (state === "handshake" && isLegacyPing(buf[0])) return void client.destroy();
    try {
      for (let f = tryReadFrame(buf, MAX_PRELOGIN_FRAME); f && state !== "decided"; f = tryReadFrame(buf, MAX_PRELOGIN_FRAME)) {
        const raw = buf.subarray(0, f.size);
        buf = buf.subarray(f.size);
        if (state === "handshake") {
          if (f.packetId !== 0x00) throw new ProtocolError("expected handshake");
          handshake = parseHandshake(f.body);
          replay.push(Buffer.from(raw));
          state = handshake.nextState === NextState.Status ? "status" : "login";
        } else if (state === "status") {
          if (f.packetId === 0x00) {
            // Answer asynchronously, then continue with anything already buffered (usually the ping),
            // so the pong can never overtake the status response.
            const proto = handshake?.protocolVersion ?? 0;
            client.pause();
            void hubStatus(proto).then((s) => {
              client.write(
                encodeStatusResponse({ version: { name: s.versionName, protocol: s.protocol }, players: s.players, description: s.motd }),
              );
              client.resume();
              onData(Buffer.alloc(0));
            });
            return;
          } else if (f.packetId === 0x01) {
            client.end(encodePong(f.body.i64()));
          }
        } else if (state === "login" && handshake) {
          if (f.packetId !== 0x00) throw new ProtocolError("expected login start");
          const login = parseLoginStart(f.body, handshake.protocolVersion);
          replay.push(Buffer.from(raw));
          state = "decided";
          void decide(handshake, login.username, login.uuid);
        }
      }
    } catch (err) {
      log("protocol_error", { remote, error: (err as Error).message });
      client.destroy();
    }
  };
  client.on("data", onData);
}

net.createServer(handle).listen(LISTEN_PORT, "0.0.0.0", () => log("listening", { port: LISTEN_PORT, hub: HUB_SOCKET }));
