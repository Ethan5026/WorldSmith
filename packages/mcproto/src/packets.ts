// Packets of the pre-encryption phase that the gatekeeper reads or writes.
// Layouts: https://minecraft.wiki/w/Java_Edition_protocol (handshaking, status, login states).

import {
  encodeFrame,
  encodeI64,
  encodeString,
  encodeU16,
  encodeUuid,
  encodeVarInt,
  ProtocolError,
  type Reader,
} from "./codec.ts";

export const NextState = {
  Status: 1,
  Login: 2,
  /** 1.20.5+: client was sent here by a Transfer packet; otherwise behaves like Login. */
  Transfer: 3,
} as const;

/** First protocol version whose Login Start always carries the player UUID (1.20.2). */
export const PROTOCOL_LOGIN_START_HAS_UUID = 764;

/**
 * Pre-login frames are small. Vanilla handshakes stay well under 300 bytes; Geyser/Floodgate
 * handshakes carry encrypted player data in the address field and run to roughly 1–2 KB.
 */
export const MAX_PRELOGIN_FRAME = 4096;

/** Vanilla's limit for the address field. Only Floodgate-tagged handshakes may exceed it. */
const VANILLA_ADDRESS_MAX = 255;
const FLOODGATE_ADDRESS_MAX = 3000;
/** Floodgate appends "\0^Floodgate^<encrypted data>" to the address (see FloodgateCipher.IDENTIFIER). */
const FLOODGATE_MARKER = "\0^Floodgate^";

export interface Handshake {
  protocolVersion: number;
  /** Hostname the player typed, normalized for routing (lowercase, no trailing dot, no Forge marker). */
  serverAddress: string;
  /** Raw address field as sent, kept so a proxied backend sees exactly what the client sent. */
  rawServerAddress: string;
  serverPort: number;
  nextState: number;
  /**
   * The connection comes from Geyser on behalf of a Bedrock player. Unverified here (the data is
   * encrypted with the Floodgate key); the world's Floodgate rejects forgeries.
   */
  floodgate: boolean;
}

export function parseHandshake(body: Reader): Handshake {
  const protocolVersion = body.varInt();
  const rawServerAddress = body.string(FLOODGATE_ADDRESS_MAX);
  const floodgate = rawServerAddress.includes(FLOODGATE_MARKER);
  if (!floodgate && rawServerAddress.length > VANILLA_ADDRESS_MAX) {
    throw new ProtocolError(`handshake address is ${rawServerAddress.length} chars (max ${VANILLA_ADDRESS_MAX})`);
  }
  const serverPort = body.u16();
  const nextState = body.varInt();
  // Forge clients append "\0FML3\0" and Floodgate "\0^Floodgate^…"; strip it for routing.
  const host = rawServerAddress.split("\0")[0] ?? "";
  return {
    protocolVersion,
    serverAddress: host.replace(/\.$/, "").toLowerCase(),
    rawServerAddress,
    serverPort,
    nextState,
    floodgate,
  };
}

export function encodeHandshake(
  h: Pick<Handshake, "protocolVersion" | "rawServerAddress" | "serverPort" | "nextState">,
): Buffer {
  return encodeFrame(
    0x00,
    encodeVarInt(h.protocolVersion),
    encodeString(h.rawServerAddress),
    encodeU16(h.serverPort),
    encodeVarInt(h.nextState),
  );
}

export interface LoginStart {
  /** Claimed username. Unverified until the backend completes online-mode auth. */
  username: string;
  /** Claimed UUID (protocol >= 764). Unverified; resolve the real one via Mojang by username. */
  uuid?: string;
}

export function parseLoginStart(body: Reader, protocolVersion: number): LoginStart {
  const username = body.string(16);
  if (protocolVersion >= PROTOCOL_LOGIN_START_HAS_UUID && body.remaining >= 16) {
    return { username, uuid: body.uuid() };
  }
  // Older layouts (signature data / optional UUID) aren't needed: we only route by username.
  return { username };
}

export function encodeLoginStart(username: string, uuid: string): Buffer {
  return encodeFrame(0x00, encodeString(username), encodeUuid(uuid));
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

/** Mojang account names are 3-16 chars of [A-Za-z0-9_]. Anything else is never a real Java account. */
export function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(name);
}

/** JSON text component (the subset we emit). */
export interface TextComponent {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  extra?: TextComponent[];
}

export interface StatusResponse {
  version: { name: string; protocol: number };
  players: { max: number; online: number; sample?: { name: string; id: string }[] };
  description: TextComponent;
  favicon?: string;
  enforcesSecureChat?: boolean;
}

/** Clientbound Status Response (status state, 0x00). */
export function encodeStatusResponse(status: StatusResponse): Buffer {
  return encodeFrame(0x00, encodeString(JSON.stringify(status)));
}

/** Clientbound Pong (status state, 0x01) — echo the client's payload. */
export function encodePong(payload: bigint): Buffer {
  return encodeFrame(0x01, encodeI64(payload));
}

/** Clientbound Disconnect (login state, 0x00). Login-state reasons are JSON text, not NBT. */
export function encodeLoginDisconnect(reason: TextComponent): Buffer {
  return encodeFrame(0x00, encodeString(JSON.stringify(reason)));
}

/** Serverbound Status Request (status state, 0x00) — used by test clients and health probes. */
export function encodeStatusRequest(): Buffer {
  return encodeFrame(0x00);
}

/** Serverbound Ping Request (status state, 0x01). */
export function encodePingRequest(payload: bigint): Buffer {
  return encodeFrame(0x01, encodeI64(payload));
}

/** Pre-1.7 clients open with 0xFE ("legacy server list ping"); we just close those. */
export function isLegacyPing(firstByte: number | undefined): boolean {
  return firstByte === 0xfe;
}
