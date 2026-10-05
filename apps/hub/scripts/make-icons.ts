// Generates the portal's PWA icons (pixel-art oxidized-copper block) without image dependencies.
//   node apps/hub/scripts/make-icons.ts

import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";

type RGB = [number, number, number];
const GROUND: RGB = [0x18, 0x21, 0x20];
const TOP: RGB = [0x5b, 0xc0, 0xa7];
const FACE: RGB = [0x1b, 0x75, 0x64];
const SHADE: RGB = [0x13, 0x55, 0x49];
const SPECK: RGB = [0xb8, 0x6a, 0x3c]; // un-oxidized copper showing through

// 16x16 design: a block whose top band is lighter, with a few copper specks.
function pixel(x: number, y: number): RGB {
  if (x < 3 || x > 12 || y < 3 || y > 12) return GROUND;
  const h = (x * 73856093) ^ (y * 19349663);
  if (y <= 5) return (h & 7) === 0 ? FACE : TOP;
  if ((h & 15) === 0) return SPECK;
  return x === 12 || y === 12 ? SHADE : FACE;
}

function png(size: number, maskable: boolean): Buffer {
  // Maskable icons need the art inside the central 80% safe zone.
  const art = maskable ? Math.floor(size * 0.8) : size;
  const offset = Math.floor((size - art) / 2);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const ax = x - offset;
      const ay = y - offset;
      const inside = ax >= 0 && ay >= 0 && ax < art && ay < art;
      const [r, g, b] = inside ? pixel(Math.floor((ax * 16) / art), Math.floor((ay * 16) / art)) : GROUND;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../portal/", import.meta.url);
writeFileSync(new URL("icon-192.png", out), png(192, false));
writeFileSync(new URL("icon-512.png", out), png(512, false));
writeFileSync(new URL("icon-maskable-512.png", out), png(512, true));
writeFileSync(new URL("apple-touch-icon.png", out), png(180, false));
console.log("icons written to", out.pathname);
