// Minecraft NBT (Java Edition): big-endian binary tags, optionally gzip/zlib compressed.
// Decoded into plain JS with explicit wrappers where JS types would lose information.

import { gunzipSync, inflateSync, gzipSync } from "node:zlib";

export const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
} as const;

/** Typed numbers so a round-trip writes the same tag type back. */
export class NbtByte {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}
export class NbtShort {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}
export class NbtFloat {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}
export class NbtDouble {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** Ints are plain numbers; longs are bigint; arrays are typed. */
export type NbtValue =
  | NbtByte
  | NbtShort
  | number
  | bigint
  | NbtFloat
  | NbtDouble
  | Int8Array
  | string
  | NbtList
  | NbtCompound
  | Int32Array
  | BigInt64Array;

export interface NbtCompound {
  [key: string]: NbtValue;
}
export class NbtList {
  type: number;
  items: NbtValue[];
  constructor(type: number, items: NbtValue[]) {
    this.type = type;
    this.items = items;
  }
}

export class NbtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NbtError";
  }
}

const MAX_DEPTH = 512;

class Reader {
  buf: Buffer;
  pos = 0;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  need(n: number): void {
    if (this.pos + n > this.buf.length) throw new NbtError("NBT data ends early");
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  i8(): number {
    this.need(1);
    return this.buf.readInt8(this.pos++);
  }
  i16(): number {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }
  str(): string {
    const len = this.buf.readUInt16BE((this.need(2), this.pos));
    this.pos += 2;
    this.need(len);
    const s = this.buf.toString("utf8", this.pos, this.pos + len); // Java "modified UTF-8"; fine for real-world names
    this.pos += len;
    return s;
  }
  count(): number {
    const n = this.i32();
    if (n < 0 || n > this.buf.length) throw new NbtError(`bad array length ${n}`);
    return n;
  }
  payload(type: number, depth: number): NbtValue {
    if (depth > MAX_DEPTH) throw new NbtError("NBT nested too deeply");
    switch (type) {
      case TAG.Byte:
        return new NbtByte(this.i8());
      case TAG.Short:
        return new NbtShort(this.i16());
      case TAG.Int:
        return this.i32();
      case TAG.Long:
        return this.i64();
      case TAG.Float:
        return new NbtFloat(this.f32());
      case TAG.Double:
        return new NbtDouble(this.f64());
      case TAG.ByteArray: {
        const n = this.count();
        this.need(n);
        const out = new Int8Array(this.buf.buffer.slice(this.buf.byteOffset + this.pos, this.buf.byteOffset + this.pos + n));
        this.pos += n;
        return out;
      }
      case TAG.String:
        return this.str();
      case TAG.List: {
        const itemType = this.u8();
        const n = this.count();
        const items: NbtValue[] = [];
        for (let i = 0; i < n; i++) items.push(this.payload(itemType, depth + 1));
        return new NbtList(itemType, items);
      }
      case TAG.Compound: {
        const out: NbtCompound = {};
        for (;;) {
          const t = this.u8();
          if (t === TAG.End) return out;
          const name = this.str();
          out[name] = this.payload(t, depth + 1);
        }
      }
      case TAG.IntArray: {
        const n = this.count();
        const out = new Int32Array(n);
        for (let i = 0; i < n; i++) out[i] = this.i32();
        return out;
      }
      case TAG.LongArray: {
        const n = this.count();
        const out = new BigInt64Array(n);
        for (let i = 0; i < n; i++) out[i] = this.i64();
        return out;
      }
      default:
        throw new NbtError(`unknown tag type ${type}`);
    }
  }
}

/** Decode NBT bytes (auto-detects gzip / zlib / raw). Returns the root compound and its name. */
export function readNbt(data: Buffer): { name: string; root: NbtCompound } {
  let buf = data;
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  else if (buf[0] === 0x78) buf = inflateSync(buf);
  const r = new Reader(buf);
  const type = r.u8();
  if (type !== TAG.Compound) throw new NbtError(`root tag is ${type}, expected a compound`);
  const name = r.str();
  return { name, root: r.payload(TAG.Compound, 0) as NbtCompound };
}

// ---- writing ----------------------------------------------------------------------------------

function typeOf(v: NbtValue): number {
  if (v instanceof NbtByte) return TAG.Byte;
  if (v instanceof NbtShort) return TAG.Short;
  if (typeof v === "number") return TAG.Int;
  if (typeof v === "bigint") return TAG.Long;
  if (v instanceof NbtFloat) return TAG.Float;
  if (v instanceof NbtDouble) return TAG.Double;
  if (v instanceof Int8Array) return TAG.ByteArray;
  if (typeof v === "string") return TAG.String;
  if (v instanceof NbtList) return TAG.List;
  if (v instanceof Int32Array) return TAG.IntArray;
  if (v instanceof BigInt64Array) return TAG.LongArray;
  return TAG.Compound;
}

class Writer {
  chunks: Buffer[] = [];
  push(b: Buffer): void {
    this.chunks.push(b);
  }
  u8(v: number): void {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    this.push(b);
  }
  i8(v: number): void {
    const b = Buffer.alloc(1);
    b.writeInt8(v);
    this.push(b);
  }
  i16(v: number): void {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.push(b);
  }
  i32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.push(b);
  }
  i64(v: bigint): void {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(v);
    this.push(b);
  }
  str(s: string): void {
    const b = Buffer.from(s, "utf8");
    if (b.length > 0xffff) throw new NbtError("string too long for NBT");
    this.i16(b.length);
    this.push(b);
  }
  payload(v: NbtValue): void {
    if (v instanceof NbtByte) return this.i8(v.value);
    if (v instanceof NbtShort) return this.i16(v.value);
    if (typeof v === "number") return this.i32(v);
    if (typeof v === "bigint") return this.i64(v);
    if (v instanceof NbtFloat) {
      const b = Buffer.alloc(4);
      b.writeFloatBE(v.value);
      return this.push(b);
    }
    if (v instanceof NbtDouble) {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(v.value);
      return this.push(b);
    }
    if (v instanceof Int8Array) {
      this.i32(v.length);
      return this.push(Buffer.from(v.buffer, v.byteOffset, v.length));
    }
    if (typeof v === "string") return this.str(v);
    if (v instanceof NbtList) {
      const t = v.items.length ? v.type : TAG.End;
      this.u8(t);
      this.i32(v.items.length);
      for (const item of v.items) this.payload(item);
      return;
    }
    if (v instanceof Int32Array) {
      this.i32(v.length);
      for (const x of v) this.i32(x);
      return;
    }
    if (v instanceof BigInt64Array) {
      this.i32(v.length);
      for (const x of v) this.i64(x);
      return;
    }
    for (const [k, child] of Object.entries(v)) {
      this.u8(typeOf(child));
      this.str(k);
      this.payload(child);
    }
    this.u8(TAG.End);
  }
}

/** Encode a root compound (gzipped by default, as structure files and level.dat use). */
export function writeNbt(root: NbtCompound, opts: { name?: string; gzip?: boolean } = {}): Buffer {
  const w = new Writer();
  w.u8(TAG.Compound);
  w.str(opts.name ?? "");
  w.payload(root);
  const raw = Buffer.concat(w.chunks);
  return opts.gzip === false ? raw : gzipSync(raw);
}

/** Small helpers for reading decoded NBT without casts everywhere. */
export const nbt = {
  compound(v: NbtValue | undefined): NbtCompound | undefined {
    return v && typeof v === "object" && !(v instanceof NbtList) && !ArrayBuffer.isView(v) && !(v instanceof NbtByte) && !(v instanceof NbtShort) && !(v instanceof NbtFloat) && !(v instanceof NbtDouble)
      ? (v as NbtCompound)
      : undefined;
  },
  list(v: NbtValue | undefined): NbtValue[] {
    return v instanceof NbtList ? v.items : [];
  },
  num(v: NbtValue | undefined): number | undefined {
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    if (v instanceof NbtByte || v instanceof NbtShort || v instanceof NbtFloat || v instanceof NbtDouble) return v.value;
    return undefined;
  },
  str(v: NbtValue | undefined): string | undefined {
    return typeof v === "string" ? v : undefined;
  },
  longs(v: NbtValue | undefined): BigInt64Array | undefined {
    return v instanceof BigInt64Array ? v : undefined;
  },
};
