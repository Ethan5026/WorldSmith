// World backups: a gzipped tar of the world's /data, minus things the recipe re-creates
// (server jars, libraries, caches, logs). Restore wipes the volume and unpacks a backup; the hub
// then re-applies the world's spec, which puts the jars back.

import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { extract, pack } from "tar-stream";
import type Docker from "dockerode";

/** Paths inside the archive (prefixed "data/") that are regenerated, not backed up. */
const EXCLUDE = [
  /^data\/(libraries|cache|versions|logs|crash-reports|\.cache|\.rcon-cli\.env|\.rcon-cli\.yaml)(\/|$)/,
  /\.jar$/,
  /(^|\/)session\.lock$/,
];
const KEEP = 15;
const ID_RE = /^\d{8}-\d{6}-[a-z0-9-]{1,32}\.tar\.gz$/;

export interface BackupInfo {
  id: string;
  label: string;
  createdAt: string;
  bytes: number;
}

export function isBackupId(id: string): boolean {
  return ID_RE.test(id);
}

export class Backups {
  root: string;

  constructor(root: string) {
    this.root = root;
  }

  private dir(slug: string): string {
    const d = path.join(this.root, slug);
    mkdirSync(d, { recursive: true });
    return d;
  }

  list(slug: string): BackupInfo[] {
    return readdirSync(this.dir(slug))
      .filter((f) => ID_RE.test(f))
      .sort()
      .reverse()
      .map((id) => {
        const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.tar\.gz$/.exec(id)!;
        return {
          id,
          label: m[7]!,
          createdAt: new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)).toISOString(),
          bytes: statSync(path.join(this.dir(slug), id)).size,
        };
      });
  }

  /** Archive the container's /data (running or stopped). The caller handles save-off/flush. */
  async create(container: Docker.Container, slug: string, label: string): Promise<BackupInfo> {
    const safeLabel =
      label
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "manual";
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const id = `${stamp}-${safeLabel}.tar.gz`;
    const final = path.join(this.dir(slug), id);
    const tmp = `${final}.partial`;

    const source = (await container.getArchive({ path: "/data" })) as NodeJS.ReadableStream;
    const ex = extract();
    const out = pack();
    ex.on("entry", (header, stream, next) => {
      if (EXCLUDE.some((re) => re.test(header.name))) {
        stream.on("end", next);
        stream.resume();
        return;
      }
      stream.pipe(out.entry(header, next));
    });
    ex.on("finish", () => out.finalize());
    ex.on("error", (e) => out.destroy(e));
    source.pipe(ex);
    await pipeline(out, createGzip({ level: 6 }), createWriteStream(tmp));
    renameSync(tmp, final);
    this.prune(slug);
    return this.list(slug).find((b) => b.id === id)!;
  }

  private prune(slug: string): void {
    for (const old of this.list(slug).slice(KEEP)) unlinkSync(path.join(this.dir(slug), old.id));
  }

  /** Unpack a backup into the container's (empty) /data. */
  async unpack(container: Docker.Container, slug: string, id: string): Promise<void> {
    if (!ID_RE.test(id)) throw new Error("Not a backup id");
    const file = path.join(this.dir(slug), id);
    statSync(file); // throws if missing
    await container.putArchive(createReadStream(file).pipe(createGunzip()), { path: "/" });
  }
}
