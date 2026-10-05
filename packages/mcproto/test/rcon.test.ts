import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { RconClient, RconError, rcon } from "../src/index.ts";

/**
 * Fake Minecraft RCON server, as strict as vanilla: a read containing more than one packet drops
 * the connection. Password "secret"; "big" replies in two fragments (4096 + 10 bytes).
 */
function fakeServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let authed = false;
      const send = (id: number, type: number, body: string) => {
        const p = Buffer.from(body, "utf8");
        const b = Buffer.alloc(14 + p.length);
        b.writeInt32LE(10 + p.length, 0);
        b.writeInt32LE(id, 4);
        b.writeInt32LE(type, 8);
        p.copy(b, 12);
        sock.write(b);
      };
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 4 && buf.length > 4 + buf.readInt32LE(0)) return void sock.destroy(); // pipelined
        while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
          const len = buf.readInt32LE(0);
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          const body = buf.subarray(12, 4 + len - 2).toString("utf8");
          buf = buf.subarray(4 + len);
          if (type === 3) {
            authed = body === "secret";
            send(authed ? id : -1, 2, "");
          } else if (!authed) {
            sock.destroy();
          } else if (body === "big") {
            send(id, 0, "a".repeat(4096));
            send(id, 0, "b".repeat(10));
          } else {
            send(id, 0, `ran: ${body}`);
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }),
    );
  });
}

test("authenticates, runs commands in order, reassembles split replies", async () => {
  const srv = await fakeServer();
  try {
    const out = await rcon("127.0.0.1", srv.port, "secret", ["op Ethan5026", "big", "list"]);
    assert.equal(out[0], "ran: op Ethan5026");
    assert.equal(out[1], "a".repeat(4096) + "b".repeat(10));
    assert.equal(out[2], "ran: list");
  } finally {
    srv.close();
  }
});

test("concurrent commands on one connection don't interleave", async () => {
  const srv = await fakeServer();
  const c = await RconClient.connect("127.0.0.1", srv.port, "secret");
  try {
    const results = await Promise.all(["one", "two", "three"].map((x) => c.command(x)));
    assert.deepEqual(results, ["ran: one", "ran: two", "ran: three"]);
  } finally {
    c.close();
    srv.close();
  }
});

test("wrong password is rejected", async () => {
  const srv = await fakeServer();
  try {
    await assert.rejects(RconClient.connect("127.0.0.1", srv.port, "nope"), RconError);
  } finally {
    srv.close();
  }
});
