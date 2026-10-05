import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeHandshake,
  encodeLoginDisconnect,
  encodeLoginStart,
  encodePong,
  encodeStatusResponse,
  isLegacyPing,
  isValidUsername,
  MAX_PRELOGIN_FRAME,
  NextState,
  parseHandshake,
  parseLoginStart,
  tryReadFrame,
} from "../src/index.ts";

function frameOf(buf: Buffer) {
  const f = tryReadFrame(buf, MAX_PRELOGIN_FRAME);
  assert.ok(f, "expected a complete frame");
  return f;
}

test("handshake round-trips and normalizes the routing host", () => {
  const buf = encodeHandshake({
    protocolVersion: 777,
    rawServerAddress: "OneBlock.Example.NET.\0FML3\0",
    serverPort: 25565,
    nextState: NextState.Login,
  });
  const f = frameOf(buf);
  assert.equal(f.packetId, 0);
  const h = parseHandshake(f.body);
  assert.equal(h.protocolVersion, 777);
  assert.equal(h.serverAddress, "oneblock.example.net");
  assert.equal(h.rawServerAddress, "OneBlock.Example.NET.\0FML3\0");
  assert.equal(h.serverPort, 25565);
  assert.equal(h.nextState, NextState.Login);
});

test("login start carries username and UUID on modern protocols", () => {
  const uuid = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
  const f = frameOf(encodeLoginStart("Notch", uuid));
  assert.deepEqual(parseLoginStart(f.body, 777), { username: "Notch", uuid });
});

test("login start on pre-1.20.2 protocols yields just the username", () => {
  const f = frameOf(encodeLoginStart("Notch", "069a79f4-44e9-4726-a5be-fca90e38aaf5"));
  assert.deepEqual(parseLoginStart(f.body, 763), { username: "Notch" });
});

test("handshake followed by login start in one TCP chunk parses sequentially", () => {
  const chunk = Buffer.concat([
    encodeHandshake({ protocolVersion: 777, rawServerAddress: "a.b", serverPort: 1, nextState: 2 }),
    encodeLoginStart("Steve", "00000000-0000-0000-0000-000000000001"),
  ]);
  const first = frameOf(chunk);
  parseHandshake(first.body);
  const second = frameOf(chunk.subarray(first.size));
  assert.equal(parseLoginStart(second.body, 777).username, "Steve");
});

test("clientbound status, pong, and disconnect encode as JSON/long payloads", () => {
  const status = frameOf(
    encodeStatusResponse({
      version: { name: "26.2", protocol: 777 },
      players: { max: 8, online: 0 },
      description: { text: "asleep — join to wake" },
    }),
  );
  assert.equal(status.packetId, 0);
  assert.equal(JSON.parse(status.body.string(32767)).version.protocol, 777);

  const pong = frameOf(encodePong(123456789n));
  assert.equal(pong.packetId, 1);
  assert.equal(pong.body.i64(), 123456789n);

  const kick = frameOf(encodeLoginDisconnect({ text: "Request sent", color: "gold" }));
  assert.equal(kick.packetId, 0);
  assert.deepEqual(JSON.parse(kick.body.string(262144)), { text: "Request sent", color: "gold" });
});

test("username validation matches Mojang rules", () => {
  for (const ok of ["Notch", "abc", "a_b_c", "ABCDEFGHIJKLMNOP"]) assert.ok(isValidUsername(ok), ok);
  for (const bad of ["ab", "ABCDEFGHIJKLMNOPQ", "with space", "dash-name", "ünï", ""]) {
    assert.ok(!isValidUsername(bad), bad);
  }
});

test("legacy ping detection", () => {
  assert.ok(isLegacyPing(0xfe));
  assert.ok(!isLegacyPing(0x10));
  assert.ok(!isLegacyPing(undefined));
});

test("Geyser/Floodgate handshakes may carry long encrypted data; plain ones may not", () => {
  const floodgateAddr = `play.example.net\0^Floodgate^${"A".repeat(900)}`;
  const f = frameOf(encodeHandshake({ protocolVersion: 776, rawServerAddress: floodgateAddr, serverPort: 25565, nextState: 2 }));
  const h = parseHandshake(f.body);
  assert.equal(h.floodgate, true);
  assert.equal(h.serverAddress, "play.example.net");
  assert.equal(h.rawServerAddress, floodgateAddr, "raw address is kept intact for the backend");

  const plain = frameOf(encodeHandshake({ protocolVersion: 776, rawServerAddress: "x".repeat(300), serverPort: 25565, nextState: 2 }));
  assert.throws(() => parseHandshake(plain.body), /max 255/);
  const normal = frameOf(encodeHandshake({ protocolVersion: 776, rawServerAddress: "play.example.net", serverPort: 25565, nextState: 2 }));
  assert.equal(parseHandshake(normal.body).floodgate, false);
});
