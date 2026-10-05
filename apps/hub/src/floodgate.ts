// Reading the Bedrock player data Geyser attaches to each connection (Floodgate format).
//
// Geyser appends "\0^Floodgate^" + version char + base64(iv) + "!" + base64(AES-GCM ciphertext+tag)
// to the handshake address. The plaintext is "\0"-separated BedrockData:
//   version, username (gamertag), xuid, deviceOs, languageCode, uiProfile, inputMode, ip, …
// Decrypting with the shared Floodgate key both authenticates it (GCM tag) and gives us the real XUID,
// so Bedrock approvals don't depend on GeyserMC's public gamertag lookup.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IDENTIFIER = "^Floodgate^";
const VERSION_OFFSET = 0x3e; // Floodgate writes (char)(VERSION + 0x3E); VERSION is 0 → '>'
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface BedrockIdentity {
  gamertag: string;
  xuid: string;
  deviceOs: string;
}

/** The Floodgate payload (starting at "^Floodgate^") from a raw handshake address, if any. */
export function floodgatePayload(rawAddress: string): string | undefined {
  const at = rawAddress.indexOf(`\0${IDENTIFIER}`);
  if (at < 0) return undefined;
  return rawAddress.slice(at + 1).split("\0")[0];
}

/** Decrypt and authenticate. Returns undefined if it isn't valid for this key (forged or wrong key). */
export function decodeFloodgate(payload: string, keyB64: string): BedrockIdentity | undefined {
  try {
    if (!payload.startsWith(IDENTIFIER)) return undefined;
    const version = payload.charCodeAt(IDENTIFIER.length) - VERSION_OFFSET;
    if (version !== 0) return undefined;
    const body = payload.slice(IDENTIFIER.length + 1);
    const sep = body.indexOf("!");
    if (sep < 0) return undefined;
    const iv = Buffer.from(body.slice(0, sep), "base64");
    const sealed = Buffer.from(body.slice(sep + 1), "base64");
    if (iv.length !== IV_LENGTH || sealed.length <= TAG_LENGTH) return undefined;
    const key = Buffer.from(keyB64, "base64");
    if (key.length !== 16) return undefined; // Floodgate keys are AES-128
    const decipher = createDecipheriv("aes-128-gcm", key, iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_LENGTH)), decipher.final()]).toString("utf8");
    const parts = plain.split("\0");
    const [, gamertag, xuid, deviceOs] = parts;
    if (!gamertag || !xuid || !/^\d{1,20}$/.test(xuid)) return undefined;
    return { gamertag, xuid, deviceOs: deviceOs ?? "" };
  } catch {
    return undefined; // bad base64, wrong key, or tampered: not a genuine Geyser login
  }
}

/** Test helper: produce a payload exactly like Geyser does. */
export function encodeFloodgateForTest(fields: string[], keyB64: string): string {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-128-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(fields.join("\0"), "utf8")), cipher.final(), cipher.getAuthTag()]);
  return `${IDENTIFIER}${String.fromCharCode(VERSION_OFFSET)}${iv.toString("base64")}!${ct.toString("base64")}`;
}
