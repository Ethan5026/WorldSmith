// Low-level Minecraft Java wire codec: VarInt, strings, framing.
// Only the uncompressed, unencrypted framing is needed — the gatekeeper never
// looks past Login Start, which is the last packet before encryption begins.

/** Thrown when the buffer ends mid-value; the caller should wait for more bytes. */
export class IncompleteError extends Error {
  constructor() {
    super("incomplete packet");
    this.name = "IncompleteError";
  }
}

/** Thrown when bytes can never form a valid packet; the caller should drop the connection. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class Reader {
  buf: Buffer;
  pos: number;

  constructor(buf: Buffer, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (this.remaining < n) throw new IncompleteError();
  }

  varInt(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      this.need(1);
      const byte = this.buf[this.pos++]!;
      value |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) return value;
    }
    throw new ProtocolError("VarInt longer than 5 bytes");
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }

  bool(): boolean {
    this.need(1);
    return this.buf[this.pos++] !== 0;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Protocol strings: VarInt byte length + UTF-8. `maxChars` mirrors the vanilla limit for the field. */
  string(maxChars: number): string {
    const byteLength = this.varInt();
    if (byteLength < 0 || byteLength > maxChars * 3) {
      throw new ProtocolError(`string length ${byteLength} exceeds limit for ${maxChars} chars`);
    }
    const text = this.bytes(byteLength).toString("utf8");
    if (text.length > maxChars) throw new ProtocolError(`string exceeds ${maxChars} chars`);
    return text;
  }

  uuid(): string {
    return formatUuid(this.bytes(16));
  }
}

export function encodeVarInt(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0; // negative ints encode as their unsigned 32-bit form (5 bytes), like Java
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return Buffer.from(out);
}

export function encodeString(text: string): Buffer {
  const utf8 = Buffer.from(text, "utf8");
  return Buffer.concat([encodeVarInt(utf8.length), utf8]);
}

export function encodeU16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value);
  return b;
}

export function encodeI64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(value);
  return b;
}

export function encodeUuid(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new ProtocolError(`invalid UUID ${uuid}`);
  return Buffer.from(hex, "hex");
}

export function formatUuid(bytes: Buffer): string {
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Wrap a packet: VarInt(length) + VarInt(packetId) + payload. */
export function encodeFrame(packetId: number, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat([encodeVarInt(packetId), ...payload]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

export interface Frame {
  packetId: number;
  /** Reader positioned just after the packet id. */
  body: Reader;
  /** Total bytes the frame occupied in the input, including the length prefix. */
  size: number;
}

/**
 * Try to read one frame from the start of `buf`.
 * Returns null if more bytes are needed; throws ProtocolError on garbage or oversize frames.
 */
export function tryReadFrame(buf: Buffer, maxLength: number): Frame | null {
  const head = new Reader(buf);
  let length: number;
  try {
    length = head.varInt();
  } catch (err) {
    if (err instanceof IncompleteError) return null;
    throw err;
  }
  if (length <= 0 || length > maxLength) throw new ProtocolError(`frame length ${length} out of range`);
  if (head.remaining < length) return null;

  const body = new Reader(buf.subarray(head.pos, head.pos + length));
  const packetId = body.varInt();
  return { packetId, body, size: head.pos + length };
}
