// Client side of the status protocol: ask a Minecraft server for its server-list info.
// Used for world health checks and the "world_status" tool.

import net from "node:net";
import { IncompleteError, tryReadFrame } from "./codec.ts";
import {
  encodeHandshake,
  encodePingRequest,
  encodeStatusRequest,
  NextState,
  type TextComponent,
} from "./packets.ts";

export interface ServerStatus {
  version: { name: string; protocol: number };
  players: { max: number; online: number; sample?: { name: string; id: string }[] };
  /** Vanilla sends a plain string for simple MOTDs and a component for formatted ones. */
  description: TextComponent | string;
  enforcesSecureChat?: boolean;
}

export interface StatusPingResult {
  status: ServerStatus;
  latencyMs: number;
}

const MAX_STATUS_FRAME = 1 << 20; // favicons can make status JSON large

export function statusPing(host: string, port: number, timeoutMs = 5000): Promise<StatusPingResult> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let status: ServerStatus | undefined;
    let pingSentAt = 0n;
    const fail = (err: Error): void => {
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(timeoutMs, () => fail(new Error(`status ping to ${host}:${port} timed out`)));
    sock.on("error", fail);
    sock.on("connect", () => {
      sock.write(
        Buffer.concat([
          encodeHandshake({ protocolVersion: -1, rawServerAddress: host, serverPort: port, nextState: NextState.Status }),
          encodeStatusRequest(),
        ]),
      );
    });
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (let f = tryReadFrame(buf, MAX_STATUS_FRAME); f; f = tryReadFrame(buf, MAX_STATUS_FRAME)) {
          buf = buf.subarray(f.size);
          if (!status && f.packetId === 0x00) {
            status = JSON.parse(f.body.string(MAX_STATUS_FRAME)) as ServerStatus;
            pingSentAt = process.hrtime.bigint();
            sock.write(encodePingRequest(pingSentAt));
          } else if (status && f.packetId === 0x01) {
            const latencyMs = Number(process.hrtime.bigint() - pingSentAt) / 1e6;
            sock.end();
            return resolve({ status, latencyMs: Math.round(latencyMs * 10) / 10 });
          }
        }
      } catch (err) {
        if (!(err instanceof IncompleteError)) fail(err as Error);
      }
    });
    sock.on("close", () => {
      if (!status) reject(new Error(`${host}:${port} closed before answering`));
    });
  });
}

/** Flatten a status description to plain text (drops formatting). */
export function descriptionText(d: TextComponent | string): string {
  if (typeof d === "string") return d.replace(/§./g, "");
  return (d.text ?? "") + (d.extra ?? []).map(descriptionText).join("");
}
