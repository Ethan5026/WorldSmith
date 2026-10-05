// Getting files into a world: download (hash-verified, cached) or inline, then packed as a tar
// for Docker's putArchive into the world's /data volume.

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { pack } from "tar-stream";
import type { WorldFile } from "@worldsmith/core";

const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** itzg runs the server as uid/gid 1000. */
const OWNER = { uid: 1000, gid: 1000 };

export class FileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileError";
  }
}

export interface ResolvedFile {
  path: string;
  data: Buffer;
  /** Skip if the world already has this file (seed configs). */
  onlyIfMissing?: boolean;
}

export async function resolveFile(file: WorldFile, cacheDir: string): Promise<ResolvedFile> {
  if (file.kind === "inline") {
    return {
      path: file.path,
      data: Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"),
      onlyIfMissing: file.onlyIfMissing,
    };
  }
  mkdirSync(cacheDir, { recursive: true });
  const expected = file.sha512 ? { algo: "sha512", hex: file.sha512 } : { algo: "sha256", hex: file.sha256 ?? "" };
  if (!expected.hex) throw new FileError(`No hash pinned for ${file.url}`);
  const cached = path.join(cacheDir, expected.hex);
  if (existsSync(cached)) return { path: file.path, data: readFileSync(cached) };

  const res = await fetch(file.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new FileError(`Download failed (${res.status}) for ${file.url}`);
  if (res.url && new URL(res.url).protocol !== "https:") throw new FileError(`Redirected off HTTPS: ${res.url}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new FileError(`${file.url} is too large (${declared} bytes)`);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) throw new FileError(`${file.url} exceeded ${MAX_DOWNLOAD_BYTES} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks);
  const actual = createHash(expected.algo).update(data).digest("hex");
  if (actual !== expected.hex) {
    throw new FileError(`Hash mismatch for ${file.url}: expected ${expected.hex.slice(0, 16)}…, got ${actual.slice(0, 16)}…`);
  }
  const tmp = `${cached}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, cached);
  return { path: file.path, data };
}

/** Tar archive rooted at /data, with parent directories and server-user ownership. */
export function buildTar(files: ResolvedFile[]): Promise<Buffer> {
  const p = pack();
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const mtime = new Date();
  for (const d of [...dirs].sort()) p.entry({ name: `${d}/`, type: "directory", mode: 0o755, mtime, ...OWNER });
  for (const f of files) p.entry({ name: f.path, size: f.data.length, mode: 0o644, mtime, ...OWNER }, f.data);
  p.finalize();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    p.on("data", (c: unknown) => chunks.push(c as Buffer));
    p.on("end", () => resolve(Buffer.concat(chunks)));
    p.on("error", reject);
  });
}
