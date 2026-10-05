// Spike E: gatekeeper prototype — the front door every friend connects through.
//
//   status ping          → custom MOTD from world state (no backend needed)
//   wrong game version   → kick: "This world runs 26.2 — pick it in your launcher"
//   unknown player       → kick: "Request sent", log a join request
//   allowed player       → replay buffered handshake+login bytes to the backend, then pipe
//
// Config (env):
//   GK_LISTEN=127.0.0.1:25599  GK_BACKEND=127.0.0.1:25601  GK_PROTOCOL=776
//   GK_VERSION_NAME=26.2  GK_ALLOW=name1,name2  GK_OWNER=Ethan  GK_WORLD="Spike World"
//
// Phase 1 moves this into apps/hub with SQLite-backed access, Mojang UUID lookup,
// wake-on-join, and push notifications.

import net from "node:net";
import {
  encodeLoginDisconnect,
  encodePong,
  encodeStatusResponse,
  isLegacyPing,
  isValidUsername,
  MAX_PRELOGIN_FRAME,
  NextState,
  parseHandshake,
  parseLoginStart,
  ProtocolError,
  tryReadFrame,
  type Handshake,
  type TextComponent,
} from "../../packages/mcproto/src/index.ts";

function hostPort(value: string): { host: string; port: number } {
  const i = value.lastIndexOf(":");
  return { host: value.slice(0, i), port: Number(value.slice(i + 1)) };
}

const listen = hostPort(process.env.GK_LISTEN ?? "127.0.0.1:25599");
const backend = hostPort(process.env.GK_BACKEND ?? "127.0.0.1:25601");
const worldProtocol = Number(process.env.GK_PROTOCOL ?? 776);
const versionName = process.env.GK_VERSION_NAME ?? "26.2";
const owner = process.env.GK_OWNER ?? "the server owner";
const worldName = process.env.GK_WORLD ?? "Spike World";
const allow = new Set(
  (process.env.GK_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** Pre-login connections must finish the handshake quickly; real clients take milliseconds. */
const PRELOGIN_TIMEOUT_MS = 10_000;

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

function kick(client: net.Socket, reason: TextComponent): void {
  client.end(encodeLoginDisconnect(reason));
}

function lines(...parts: TextComponent[]): TextComponent {
  return { text: "", extra: parts };
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
            client.write(
              encodeStatusResponse({
                version: { name: versionName, protocol: worldProtocol },
                players: { max: 8, online: 0 },
                description: lines(
                  { text: "WorldSmith ", color: "gold", bold: true },
                  { text: `· ${worldName}\n`, color: "white" },
                  { text: "Featured world — join to play", color: "gray" },
                ),
              }),
            );
          } else if (f.packetId === 0x01) {
            client.end(encodePong(f.body.i64()));
          }
        } else if (state === "login" && handshake) {
          if (f.packetId !== 0x00) throw new ProtocolError("expected login start");
          const login = parseLoginStart(f.body, handshake.protocolVersion);
          replay.push(Buffer.from(raw));
          state = "decided";
          decide(handshake, login.username, login.uuid);
        }
      }
    } catch (err) {
      log("protocol_error", { remote, error: (err as Error).message });
      client.destroy();
    }
  };

  const decide = (h: Handshake, username: string, claimedUuid: string | undefined): void => {
    client.off("data", onData);
    client.pause();
    const base = { remote, username, claimedUuid, protocol: h.protocolVersion, host: h.serverAddress };

    if (!isValidUsername(username)) {
      log("reject_invalid_name", base);
      return kick(client, { text: "Invalid username.", color: "red" });
    }
    if (h.protocolVersion !== worldProtocol) {
      log("reject_version", { ...base, want: worldProtocol });
      return kick(
        client,
        lines(
          { text: `${worldName} runs Minecraft ${versionName}\n\n`, color: "gold", bold: true },
          { text: "In the Minecraft Launcher: Installations → New installation →\n", color: "white" },
          { text: `pick version ${versionName}, then join again.`, color: "white" },
        ),
      );
    }
    if (!allow.has(username.toLowerCase())) {
      log("join_request", base);
      return kick(
        client,
        lines(
          { text: "Request sent! ", color: "green", bold: true },
          { text: `${owner} has been asked to let you in.\n\n`, color: "white" },
          { text: "Try joining again once they approve.", color: "gray" },
        ),
      );
    }

    log("pipe", base);
    const upstream = net.connect(backend);
    upstream.setNoDelay(true);
    upstream.on("connect", () => {
      client.setTimeout(0);
      upstream.write(Buffer.concat([...replay, buf]));
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on("error", (err) => {
      log("backend_error", { ...base, error: err.message });
      if (client.writable) kick(client, { text: `${worldName} is starting up — try again in a minute.`, color: "yellow" });
    });
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  };

  client.on("data", onData);
}

net.createServer(handle).listen(listen.port, listen.host, () => {
  log("listening", { listen, backend, worldProtocol, versionName, allow: [...allow] });
});
