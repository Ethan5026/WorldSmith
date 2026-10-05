import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeFrame,
  encodeString,
  encodeVarInt,
  formatUuid,
  encodeUuid,
  IncompleteError,
  ProtocolError,
  Reader,
  tryReadFrame,
} from "../src/index.ts";

// Reference vectors from the protocol wiki's VarInt table.
const VARINTS: [number, number[]][] = [
  [0, [0x00]],
  [1, [0x01]],
  [127, [0x7f]],
  [128, [0x80, 0x01]],
  [255, [0xff, 0x01]],
  [25565, [0xdd, 0xc7, 0x01]],
  [2097151, [0xff, 0xff, 0x7f]],
  [2147483647, [0xff, 0xff, 0xff, 0xff, 0x07]],
  [-1, [0xff, 0xff, 0xff, 0xff, 0x0f]],
  [-2147483648, [0x80, 0x80, 0x80, 0x80, 0x08]],
];

test("VarInt encodes and decodes reference vectors", () => {
  for (const [value, bytes] of VARINTS) {
    assert.deepEqual([...encodeVarInt(value)], bytes, `encode ${value}`);
    assert.equal(new Reader(Buffer.from(bytes)).varInt(), value, `decode ${value}`);
  }
});

test("VarInt longer than 5 bytes is a protocol error", () => {
  assert.throws(() => new Reader(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])).varInt(), ProtocolError);
});

test("truncated VarInt is incomplete, not an error", () => {
  assert.throws(() => new Reader(Buffer.from([0x80])).varInt(), IncompleteError);
});

test("strings round-trip including multi-byte UTF-8", () => {
  for (const s of ["", "localhost", "ünïcødé ⛏"]) {
    assert.equal(new Reader(encodeString(s)).string(255), s);
  }
});

test("string over its char limit is rejected", () => {
  assert.throws(() => new Reader(encodeString("a".repeat(17))).string(16), ProtocolError);
});

test("UUID formats and parses", () => {
  const id = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
  assert.equal(formatUuid(encodeUuid(id)), id);
  assert.throws(() => encodeUuid("not-a-uuid"), ProtocolError);
});

test("tryReadFrame waits for a complete frame", () => {
  const frame = encodeFrame(0x00, encodeString("hello"));
  for (let cut = 0; cut < frame.length; cut++) {
    assert.equal(tryReadFrame(frame.subarray(0, cut), 1024), null, `cut at ${cut}`);
  }
  const parsed = tryReadFrame(frame, 1024);
  assert.ok(parsed);
  assert.equal(parsed.packetId, 0);
  assert.equal(parsed.size, frame.length);
  assert.equal(parsed.body.string(255), "hello");
});

test("tryReadFrame reports size so trailing bytes can be kept", () => {
  const a = encodeFrame(0x00);
  const b = encodeFrame(0x01, Buffer.alloc(8));
  const both = Buffer.concat([a, b]);
  const first = tryReadFrame(both, 1024);
  assert.ok(first);
  assert.equal(first.size, a.length);
  const second = tryReadFrame(both.subarray(first.size), 1024);
  assert.ok(second);
  assert.equal(second.packetId, 1);
});

test("tryReadFrame rejects oversize and zero-length frames", () => {
  assert.throws(() => tryReadFrame(encodeVarInt(5000), 1024), ProtocolError);
  assert.throws(() => tryReadFrame(Buffer.from([0x00]), 1024), ProtocolError);
});
