// Spike E probe: talk to a real Minecraft server with @worldsmith/mcproto to prove our
// encoders/decoders match the live protocol.
//   node spikes/spike-e-gatekeeper/probe.ts 127.0.0.1 25601 [username] [protocol]
// 1) status ping  → prints the server's real protocol number + MOTD
// 2) login start  → an online-mode server must answer Encryption Request (0x01);
//                   a Disconnect (0x00) here would mean our Login Start layout is wrong
//                   (or, through the gatekeeper, shows the kick message it chose).

import net from "node:net";
import {
  encodeHandshake,
  encodeLoginStart,
  encodePingRequest,
  encodeStatusRequest,
  MAX_PRELOGIN_FRAME,
  NextState,
  tryReadFrame,
  type Frame,
} from "../../packages/mcproto/src/index.ts";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 25565);
const username = process.argv[4] ?? "WorldSmithProbe";
const protocolOverride = process.argv[5] ? Number(process.argv[5]) : undefined;
const claimedUuid = process.argv[6] ?? "00000000-0000-0000-0000-000000000000";

function exchange(packets: Buffer[], wantFrames: number, maxFrame = 1 << 21): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const frames: Frame[] = [];
    sock.setTimeout(10_000, () => sock.destroy(new Error("timeout")));
    sock.on("connect", () => sock.write(Buffer.concat(packets)));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (let f = tryReadFrame(buf, maxFrame); f; f = tryReadFrame(buf, maxFrame)) {
        frames.push(f);
        buf = buf.subarray(f.size);
        if (frames.length >= wantFrames) {
          sock.destroy();
          return resolve(frames);
        }
      }
    });
    sock.on("error", reject);
    sock.on("close", () => resolve(frames));
  });
}

// --- 1. status ---------------------------------------------------------------
const statusFrames = await exchange(
  [
    encodeHandshake({ protocolVersion: -1, rawServerAddress: host, serverPort: port, nextState: NextState.Status }),
    encodeStatusRequest(),
    encodePingRequest(42n),
  ],
  2,
);
const statusFrame = statusFrames[0];
if (!statusFrame || statusFrame.packetId !== 0x00) throw new Error("no status response");
const status = JSON.parse(statusFrame.body.string(32767));
const pong = statusFrames[1];
console.log("status.version     :", status.version);
console.log("status.description :", JSON.stringify(status.description));
console.log("status.players     :", JSON.stringify(status.players));
console.log("pong echoes 42     :", pong?.packetId === 0x01 && pong.body.i64() === 42n);

// --- 2. login start -----------------------------------------------------------
const protocol: number = protocolOverride ?? status.version.protocol;
const loginFrames = await exchange(
  [
    encodeHandshake({ protocolVersion: protocol, rawServerAddress: host, serverPort: port, nextState: NextState.Login }),
    encodeLoginStart(username, claimedUuid),
  ],
  1,
  MAX_PRELOGIN_FRAME * 4,
);
const first = loginFrames[0];
if (!first) throw new Error("server closed without replying to Login Start");
if (first.packetId === 0x01) {
  console.log("login reply        : Encryption Request (0x01) ✔ Login Start layout accepted");
} else if (first.packetId === 0x00) {
  console.log("login reply        : Disconnect ✘", first.body.string(262144));
  process.exitCode = 1;
} else {
  console.log("login reply        : unexpected packet id", first.packetId);
  process.exitCode = 1;
}
