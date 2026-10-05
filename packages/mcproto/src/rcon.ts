// Minimal Source-RCON client for Minecraft's remote console.
// Packet: int32 LE length | int32 LE request id | int32 LE type | ASCII body | \0 | \0
//
// Vanilla's RCON server is strict: each TCP read must contain exactly one packet, or it drops the
// connection. So we never pipeline: one command at a time, waiting for its full reply. Replies over
// 4096 bytes arrive as several 4096-byte fragments with the same id; a shorter fragment ends the
// reply, and if the last fragment is exactly 4096 bytes a short idle timer ends it instead.

import net from "node:net";

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
const MAX_PACKET = 4096 + 14 + 1024;
const FRAGMENT = 4096;
const FRAGMENT_IDLE_MS = 150;

function encode(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  // two trailing NULs already zero-filled
  return buf;
}

interface Packet {
  id: number;
  type: number;
  body: string;
}

export class RconError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RconError";
  }
}

export class RconClient {
  private sock: net.Socket;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private waiters = new Map<number, (p: Packet) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", (chunk) => this.onData(chunk));
    sock.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.values()) w({ id: -2, type: -1, body: "" });
      this.waiters.clear();
    });
    sock.on("error", () => sock.destroy());
  }

  static async connect(host: string, port: number, password: string, timeoutMs = 5000): Promise<RconClient> {
    const sock = net.connect({ host, port });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        sock.destroy();
        reject(new RconError(`RCON connect to ${host}:${port} timed out`));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(t);
        resolve();
      });
      sock.once("error", (e) => {
        clearTimeout(t);
        reject(new RconError(`RCON connect to ${host}:${port} failed: ${e.message}`));
      });
    });
    const client = new RconClient(sock);
    const id = client.nextId++;
    const reply = client.wait(id, timeoutMs);
    sock.write(encode(id, TYPE_AUTH, password));
    const p = await reply;
    if (p.id === -1) {
      client.close();
      throw new RconError("RCON authentication failed");
    }
    return client;
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (len < 10 || len > MAX_PACKET) {
        this.sock.destroy();
        return;
      }
      if (this.buf.length < 4 + len) return;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const body = this.buf.subarray(12, 4 + len - 2).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      // Failed auth answers with id -1, which matches no waiter: route it to the oldest one.
      const key = id === -1 ? [...this.waiters.keys()][0] : id;
      if (key !== undefined) this.waiters.get(key)?.({ id, type, body });
    }
  }

  private wait(id: number, timeoutMs: number): Promise<Packet> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(id);
        reject(new RconError("RCON response timed out"));
      }, timeoutMs);
      this.waiters.set(id, (p) => {
        clearTimeout(t);
        this.waiters.delete(id);
        if (p.id === -2) reject(new RconError("RCON connection closed"));
        else resolve(p);
      });
    });
  }

  /** Run one console command and return its full output. Commands run one at a time. */
  command(cmd: string, timeoutMs = 10_000): Promise<string> {
    if (Buffer.byteLength(cmd) > 1446) throw new RconError("command too long for one RCON packet (1446 bytes max)");
    const run = async (): Promise<string> => {
      if (this.closed) throw new RconError("RCON connection closed");
      const id = this.nextId++;
      const parts: string[] = [];
      const done = new Promise<void>((resolve, reject) => {
        let idle: NodeJS.Timeout | undefined;
        const t = setTimeout(() => {
          this.waiters.delete(id);
          reject(new RconError(`RCON command timed out: ${cmd.slice(0, 60)}`));
        }, timeoutMs);
        const finish = (): void => {
          clearTimeout(t);
          if (idle) clearTimeout(idle);
          this.waiters.delete(id);
          resolve();
        };
        const collect = (p: Packet): void => {
          if (p.id === -2) {
            clearTimeout(t);
            if (idle) clearTimeout(idle);
            return reject(new RconError("RCON connection closed"));
          }
          parts.push(p.body);
          if (idle) clearTimeout(idle);
          if (Buffer.byteLength(p.body) < FRAGMENT) return finish();
          this.waiters.set(id, collect); // a full-size fragment: more may follow
          idle = setTimeout(finish, FRAGMENT_IDLE_MS);
        };
        this.waiters.set(id, collect);
      });
      this.sock.write(encode(id, TYPE_EXEC, cmd));
      await done;
      return parts.join("");
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  close(): void {
    this.closed = true;
    this.sock.end();
  }
}

/** Connect, run commands, disconnect. */
export async function rcon(host: string, port: number, password: string, commands: string[]): Promise<string[]> {
  const client = await RconClient.connect(host, port, password);
  try {
    const out: string[] = [];
    for (const c of commands) out.push(await client.command(c));
    return out;
  } finally {
    client.close();
  }
}
