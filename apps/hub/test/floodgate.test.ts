import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decodeFloodgate, encodeFloodgateForTest, floodgatePayload } from "../src/floodgate.ts";

const KEY = randomBytes(16).toString("base64");
const FIELDS = ["0", "Ethan5026", "2535432196048835", "2", "en_US", "0", "2", "203.0.113.5", "null", "0", "0", "0"];

test("decodes and authenticates Geyser's Bedrock identity from the handshake address", () => {
  const raw = `147.185.221.214\0${encodeFloodgateForTest(FIELDS, KEY)}`;
  const payload = floodgatePayload(raw);
  assert.ok(payload?.startsWith("^Floodgate^"));
  assert.deepEqual(decodeFloodgate(payload!, KEY), { gamertag: "Ethan5026", xuid: "2535432196048835", deviceOs: "2" });
});

test("rejects forgeries: wrong key, tampered data, junk", () => {
  const payload = encodeFloodgateForTest(FIELDS, KEY);
  assert.equal(decodeFloodgate(payload, randomBytes(16).toString("base64")), undefined, "wrong key");
  const i = payload.length - 6;
  const tampered = payload.slice(0, i) + (payload[i] === "A" ? "B" : "A") + payload.slice(i + 1);
  assert.equal(decodeFloodgate(tampered, KEY), undefined, "GCM tag catches tampering");
  assert.equal(decodeFloodgate("^Floodgate^>garbage", KEY), undefined);
  assert.equal(decodeFloodgate("not floodgate", KEY), undefined);
  assert.equal(floodgatePayload("play.example.net"), undefined);
});
