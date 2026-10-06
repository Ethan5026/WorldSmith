// Public map import. A map zip (from a link or an upload) is inspected without trusting it, and
// installing it copies only world data (level.dat, region files, datapacks, saved structures)
// into the world. Nothing in a map zip is ever run, and files that aren't world data (installers,
// scripts, jars, player files) never reach the server.

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import https from "node:https";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type Docker from "dockerode";
import { pack } from "tar-stream";
import yauzl from "yauzl";
import { nbt, readNbt, type NbtCompound } from "@worldsmith/mcworld";

export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_WORLD_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_LEVEL_DAT = 4 * 1024 * 1024;
const OWNER = { uid: 1000, gid: 1000 };
const ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

export class MapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MapError";
  }
}

export interface MapWorldInfo {
  /** Folder inside the zip that holds level.dat ("" = the zip's top level). */
  root: string;
  levelName: string;
  dataVersion?: number;
  /** Minecraft version that last saved the map, e.g. "1.12.2" (missing on 1.8 and older). */
  version?: string;
  /** 1.18+ maps load as they are; older ones are upgraded to the server's version on first start. */
  needsUpgrade: boolean;
  gameMode: "survival" | "creative" | "adventure" | "spectator";
  hardcore: boolean;
  allowCommands: boolean;
  difficulty?: string;
  spawn?: { x: number; y: number; z: number };
  /** Region files per dimension, e.g. { "minecraft:overworld": 12 }. */
  dimensions: Record<string, number>;
  datapacks: string[];
  /** Structures saved with structure blocks (generated/<ns>/structures/*.nbt). */
  structures: number;
  hasResourcePack: boolean;
  worldBytes: number;
}

export interface MapReport {
  id: string;
  createdAt: string;
  source: { kind: "url"; url: string } | { kind: "upload"; filename: string };
  zipBytes: number;
  sha256: string;
  worlds: MapWorldInfo[];
  /** Files that won't be installed, with why (first 40). */
  skipped: { path: string; reason: string }[];
  skippedCount: number;
  warnings: string[];
}

// ---- what counts as world data ------------------------------------------------------------------

const DIM = String.raw`(?:DIM-?1/|dimensions/[a-z0-9_.-]+/[a-z0-9_./-]+/)?`;
const WORLD_FILES: RegExp[] = [
  /^level\.dat$/,
  /^icon\.png$/,
  new RegExp(String.raw`^${DIM}(?:region|entities|poi)/r\.-?\d+\.-?\d+\.mca$`),
  new RegExp(String.raw`^${DIM}data/[A-Za-z0-9_./-]+\.dat$`),
  /^datapacks\/[^/]+\.zip$/,
  /^datapacks\/[^/]+\/(?:pack\.mcmeta|pack\.png|.+\.(?:json|mcfunction|nbt|mcmeta|png|txt))$/,
  /^generated\/[a-z0-9_.-]+\/structures?\/[a-z0-9_./-]+\.nbt$/,
];
const PROGRAMS = /\.(exe|dll|bat|cmd|ps1|vbs|vbe|js|jse|wsf|jar|msi|scr|com|lnk|sh|app|dmg|py|reg|hta)$/i;
const PLAYER_DATA = /^(playerdata|players|stats|advancements)\//;

function skipReason(rel: string): string {
  if (PROGRAMS.test(rel)) return "program or script (never installed)";
  if (PLAYER_DATA.test(rel)) return "the map maker's player data";
  if (/\.mcr$/.test(rel)) return "pre-1.2 McRegion file (too old to load)";
  if (rel === "resources.zip") return "resource pack (offered to players separately)";
  if (/^(session\.lock|uid\.dat|level\.dat_old)$/.test(rel)) return "temporary file";
  return "not world data";
}

export function isWorldFile(rel: string): boolean {
  return WORLD_FILES.some((re) => re.test(rel));
}

// ---- level.dat --------------------------------------------------------------------------------

const GAME_MODES = ["survival", "creative", "adventure", "spectator"] as const;
const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"];

/** DataVersion 2860 = 1.18, the first version with today's chunk format. */
const MODERN_DATA_VERSION = 2860;

export function readLevelDat(raw: Buffer): Omit<MapWorldInfo, "root" | "dimensions" | "datapacks" | "structures" | "hasResourcePack" | "worldBytes"> {
  const { root } = readNbt(raw);
  const data = nbt.compound(root.Data);
  if (!data) throw new MapError("level.dat has no Data section");
  const dataVersion = nbt.num(data.DataVersion);
  const version = nbt.str(nbt.compound(data.Version)?.Name);
  const diff = nbt.compound(data.difficulty_settings);
  const spawn = nbt.compound(data.spawn);
  const pos = spawn?.pos instanceof Int32Array ? spawn.pos : undefined;
  const sx = pos ? pos[0] : nbt.num(data.SpawnX);
  const sy = pos ? pos[1] : nbt.num(data.SpawnY);
  const sz = pos ? pos[2] : nbt.num(data.SpawnZ);
  const legacyDifficulty = nbt.num(data.Difficulty);
  return {
    levelName: nbt.str(data.LevelName) ?? "Untitled map",
    dataVersion,
    version,
    needsUpgrade: (dataVersion ?? 0) < MODERN_DATA_VERSION,
    gameMode: GAME_MODES[nbt.num(data.GameType) ?? 0] ?? "survival",
    hardcore: (nbt.num(diff?.hardcore) ?? nbt.num(data.hardcore) ?? 0) === 1,
    allowCommands: nbt.num(data.allowCommands) === 1,
    difficulty: nbt.str(diff?.difficulty) ?? (legacyDifficulty !== undefined ? DIFFICULTIES[legacyDifficulty] : undefined),
    spawn: sx !== undefined && sy !== undefined && sz !== undefined ? { x: sx, y: sy, z: sz } : undefined,
  };
}

function dimensionOf(rel: string): string | undefined {
  const m = /^(?:(DIM-1)\/|(DIM1)\/|dimensions\/([a-z0-9_.-]+)\/([a-z0-9_./-]+)\/)?region\/r\.-?\d+\.-?\d+\.mca$/.exec(rel);
  if (!m) return undefined;
  if (m[1]) return "minecraft:the_nether";
  if (m[2]) return "minecraft:the_end";
  if (m[3]) return `${m[3]}:${m[4]}`;
  return "minecraft:overworld";
}

// ---- zip reading ------------------------------------------------------------------------------

async function* entries(zip: yauzl.ZipFile): AsyncGenerator<yauzl.Entry> {
  const queue: (yauzl.Entry | null | Error)[] = [];
  let wake: (() => void) | undefined;
  zip.on("entry", (e: yauzl.Entry) => (queue.push(e), wake?.()));
  zip.on("end", () => (queue.push(null), wake?.()));
  zip.on("error", (err: Error) => (queue.push(err), wake?.()));
  zip.readEntry();
  for (;;) {
    if (!queue.length) await new Promise<void>((r) => (wake = r));
    wake = undefined;
    const next = queue.shift()!;
    if (next === null) return;
    if (next instanceof Error) throw new MapError(`The zip is damaged: ${next.message}`);
    yield next;
    zip.readEntry();
  }
}

async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, max: number): Promise<Buffer> {
  if (entry.uncompressedSize > max) throw new MapError(`${entry.fileName} is unexpectedly large`);
  const stream = await zip.openReadStreamPromise(entry);
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > max) throw new MapError(`${entry.fileName} is unexpectedly large`);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  // Defaults validate names: absolute paths and ".." are refused, backslashes become "/".
  return yauzl.openPromise(file, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }).catch((err: Error) => {
    throw new MapError(`That isn't a readable zip file (${err.message})`);
  });
}

/** Inspect a map zip: find every world in it (folders with level.dat) and what would be installed. */
export async function inspectZip(file: string): Promise<Omit<MapReport, "id" | "createdAt" | "source" | "zipBytes" | "sha256">> {
  const zip = await openZip(file);
  try {
    if (zip.entryCount > MAX_ENTRIES) throw new MapError(`The zip has ${zip.entryCount} files; maps have far fewer. Refusing it.`);
    const names: { name: string; size: number }[] = [];
    const levelDats = new Map<string, Buffer>();
    let total = 0;
    let bedrock = false;
    const nested: string[] = [];
    const programs = new Set<string>();
    for await (const e of entries(zip)) {
      if (e.fileName.endsWith("/") || e.fileName.startsWith("__MACOSX/")) continue;
      if (e.isEncrypted()) throw new MapError("The zip is password-protected.");
      total += e.uncompressedSize;
      if (total > MAX_WORLD_BYTES) throw new MapError("The map unpacks to more than 4 GB. Refusing it.");
      // Zip bombs: real world files compress maybe 2-20x; reject absurd ratios on big entries.
      if (e.uncompressedSize > 64 * 1024 * 1024 && e.uncompressedSize / Math.max(1, e.compressedSize) > 200) {
        throw new MapError(`${e.fileName} expands suspiciously (${Math.round(e.uncompressedSize / Math.max(1, e.compressedSize))}x). Refusing it.`);
      }
      names.push({ name: e.fileName, size: e.uncompressedSize });
      if (PROGRAMS.test(e.fileName)) programs.add(path.posix.basename(e.fileName));
      if (path.posix.basename(e.fileName) === "level.dat") levelDats.set(path.posix.dirname(e.fileName).replace(/^\.$/, ""), await readEntry(zip, e, MAX_LEVEL_DAT));
      if (/(^|\/)db\/CURRENT$/.test(e.fileName)) bedrock = true;
      if (/\.zip$/i.test(e.fileName) && !/(^|\/)(datapacks\/[^/]+|resources)\.zip$/i.test(e.fileName)) nested.push(e.fileName);
    }

    const warnings: string[] = [];
    if (bedrock) throw new MapError("This is a Bedrock world (.mcworld). WorldSmith worlds are Java worlds; look for the Java Edition download of the map.");
    if (!levelDats.size) {
      if (nested.length) throw new MapError(`No world in this zip, but it contains another zip (${nested.slice(0, 3).join(", ")}). Unzip it once and upload the inner file.`);
      throw new MapError("No Minecraft world in this zip (no level.dat).");
    }

    // A world root that sits inside another world root (e.g. a backup copy) isn't a separate world.
    const roots = [...levelDats.keys()].sort((a, b) => a.length - b.length).filter((r, i, all) => !all.slice(0, i).some((p) => p === "" || r.startsWith(`${p}/`)));
    const worlds: MapWorldInfo[] = [];
    const skipped: { path: string; reason: string }[] = [];
    let skippedCount = 0;
    for (const root of roots) {
      let info: ReturnType<typeof readLevelDat>;
      try {
        info = readLevelDat(levelDats.get(root)!);
      } catch (err) {
        warnings.push(`Couldn't read ${root || "the"} level.dat: ${(err as Error).message}`);
        continue;
      }
      const dimensions: Record<string, number> = {};
      const datapacks = new Set<string>();
      let structures = 0;
      let worldBytes = 0;
      let hasResourcePack = false;
      for (const { name, size } of names) {
        if (root && !name.startsWith(`${root}/`)) continue;
        const rel = root ? name.slice(root.length + 1) : name;
        if (roots.some((r) => r !== root && r.startsWith(root ? `${root}/` : "") && name.startsWith(`${r}/`))) continue;
        if (rel === "resources.zip") hasResourcePack = true;
        if (isWorldFile(rel)) {
          worldBytes += size;
          const dim = dimensionOf(rel);
          if (dim) dimensions[dim] = (dimensions[dim] ?? 0) + 1;
          const dp = /^datapacks\/([^/]+?)(?:\.zip)?(?:\/|$)/.exec(rel)?.[1];
          if (dp) datapacks.add(dp);
          if (rel.startsWith("generated/")) structures++;
        } else {
          skippedCount++;
          if (skipped.length < 40) skipped.push({ path: name, reason: skipReason(rel) });
        }
      }
      if (!Object.keys(dimensions).length) {
        warnings.push(`${info.levelName}: level.dat without region files (an empty or broken world). Skipping it.`);
        continue;
      }
      worlds.push({ root, ...info, dimensions, datapacks: [...datapacks], structures, hasResourcePack, worldBytes });
    }
    if (!worlds.length) throw new MapError(`No usable world in this zip. ${warnings.join(" ")}`);
    if (programs.size) {
      warnings.push(`The zip also contains programs (${[...programs].slice(0, 4).join(", ")}). WorldSmith never installs them; don't run them on your PC.`);
    }
    for (const w of worlds) {
      if (w.needsUpgrade) {
        warnings.push(
          `${w.levelName} was saved by Minecraft ${w.version ?? "1.8 or older"}; it will be upgraded on first start. Terrain and builds carry over; old command blocks may use command syntax that no longer works.`,
        );
      }
      if (w.hasResourcePack) warnings.push(`${w.levelName} comes with a resource pack (resources.zip); it isn't installed automatically.`);
    }
    return { worlds, skipped, skippedCount, warnings };
  } finally {
    zip.close();
  }
}

// ---- fetching ---------------------------------------------------------------------------------

/** Never fetch from the LAN, the tailnet, Docker networks or loopback (a link could point anywhere). */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(net, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  return !PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

async function publicAddressFor(host: string): Promise<{ address: string; family: number }> {
  const all = await lookup(host, { all: true }).catch(() => {
    throw new MapError(`Couldn't find the website ${host}.`);
  });
  const good = all.find((a) => isPublicAddress(a.address));
  if (!good || all.some((a) => !isPublicAddress(a.address))) throw new MapError(`${host} points at a private network address; WorldSmith only downloads from the public internet.`);
  return good;
}

/** HTTPS GET to a file, re-checking every redirect hop and pinning each connection to the vetted IP. */
export async function downloadPublic(url: string, dest: string, maxBytes = MAX_ZIP_BYTES, hops = 0): Promise<{ finalUrl: string; bytes: number; sha256: string }> {
  if (hops > 5) throw new MapError("Too many redirects.");
  const u = new URL(url);
  if (u.protocol !== "https:") throw new MapError("Only https:// links can be imported.");
  if (u.username || u.password) throw new MapError("Links with passwords can't be imported.");
  const { address, family } = await publicAddressFor(u.hostname);
  const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = https.get(
      u,
      {
        headers: { "User-Agent": "WorldSmith map importer (personal server)", Accept: "application/zip,application/octet-stream,*/*" },
        // Pin the connection to the vetted address (Node may ask for one address or a list).
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as unknown as import("node:net").LookupFunction,
        timeout: 30_000,
      },
      resolve,
    );
    req.on("timeout", () => req.destroy(new MapError("The download timed out.")));
    req.on("error", reject);
  });
  if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    res.resume();
    return downloadPublic(new URL(res.headers.location, u).href, dest, maxBytes, hops + 1);
  }
  if (res.statusCode !== 200) {
    res.resume();
    const hint = res.statusCode === 403 || res.statusCode === 401 ? " The site blocks automatic downloads: download the map yourself and upload it in the WorldSmith portal." : "";
    throw new MapError(`The download failed (HTTP ${res.statusCode}).${hint}`);
  }
  const type = String(res.headers["content-type"] ?? "");
  if (/text\/html/i.test(type)) {
    res.resume();
    throw new MapError("That link opens a web page, not a zip file. Download the map yourself and upload it in the WorldSmith portal, or find the direct download link.");
  }
  if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
    res.resume();
    throw new MapError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  const saved = await saveStream(res, dest, maxBytes);
  return { finalUrl: u.href, ...saved };
}

/** Stream to a file with a size cap, hashing as it goes. */
export async function saveStream(stream: Readable, dest: string, maxBytes = MAX_ZIP_BYTES): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) return cb(new MapError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, meter, createWriteStream(dest));
  } catch (err) {
    rmSync(dest, { force: true });
    throw err;
  }
  return { bytes, sha256: hash.digest("hex") };
}

// ---- the import store -------------------------------------------------------------------------

export class MapStore {
  dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private newId(): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    return `${stamp}-${randomBytes(3).toString("hex")}`;
  }

  private zipPath(id: string): string {
    if (!ID_RE.test(id)) throw new MapError("Not a map import id");
    return path.join(this.dir, id, "map.zip");
  }

  private async finish(id: string, source: MapReport["source"], saved: { bytes: number; sha256: string }): Promise<MapReport> {
    const zip = this.zipPath(id);
    const head = readFileSync(zip).subarray(0, 4);
    if (head.toString("latin1") !== "PK\u0003\u0004") {
      rmSync(path.dirname(zip), { recursive: true, force: true });
      throw new MapError("That file isn't a zip archive.");
    }
    const dupe = this.list().find((r) => r.sha256 === saved.sha256);
    if (dupe) {
      rmSync(path.dirname(zip), { recursive: true, force: true });
      return dupe;
    }
    let inspected: Awaited<ReturnType<typeof inspectZip>>;
    try {
      inspected = await inspectZip(zip);
    } catch (err) {
      rmSync(path.dirname(zip), { recursive: true, force: true });
      throw err;
    }
    const report: MapReport = { id, createdAt: new Date().toISOString(), source, zipBytes: saved.bytes, sha256: saved.sha256, ...inspected };
    writeFileSync(path.join(this.dir, id, "report.json"), JSON.stringify(report, null, 2));
    return report;
  }

  async importUrl(url: string): Promise<MapReport> {
    const id = this.newId();
    mkdirSync(path.join(this.dir, id));
    const tmp = `${this.zipPath(id)}.partial`;
    try {
      const saved = await downloadPublic(url, tmp);
      renameSync(tmp, this.zipPath(id));
      return await this.finish(id, { kind: "url", url }, saved);
    } catch (err) {
      rmSync(path.join(this.dir, id), { recursive: true, force: true });
      throw err;
    }
  }

  async importUpload(stream: Readable, filename: string): Promise<MapReport> {
    const id = this.newId();
    mkdirSync(path.join(this.dir, id));
    const tmp = `${this.zipPath(id)}.partial`;
    try {
      const saved = await saveStream(stream, tmp);
      renameSync(tmp, this.zipPath(id));
      return await this.finish(id, { kind: "upload", filename: filename.slice(0, 120) }, saved);
    } catch (err) {
      rmSync(path.join(this.dir, id), { recursive: true, force: true });
      throw err;
    }
  }

  list(): MapReport[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((id) => ID_RE.test(id) && existsSync(path.join(this.dir, id, "report.json")))
      .map((id) => JSON.parse(readFileSync(path.join(this.dir, id, "report.json"), "utf8")) as MapReport)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): MapReport {
    const file = path.join(path.dirname(this.zipPath(id)), "report.json");
    if (!existsSync(file)) throw new MapError(`No map import ${id}`);
    return JSON.parse(readFileSync(file, "utf8")) as MapReport;
  }

  remove(id: string): void {
    rmSync(path.dirname(this.zipPath(id)), { recursive: true, force: true });
  }

  /**
   * Copy one world from an import into a world container's /data/world. Only world data is copied
   * (see WORLD_FILES), owned by the server user. The container should be new and never started.
   */
  async install(id: string, root: string, container: Docker.Container): Promise<{ files: number; bytes: number }> {
    const report = this.get(id);
    if (!report.worlds.some((w) => w.root === root)) throw new MapError(`Import ${id} has no world at "${root}"`);
    const zip = await openZip(this.zipPath(id));
    const tar = pack();
    const upload = container.putArchive(tar as unknown as NodeJS.ReadableStream, { path: "/data" });
    const mtime = new Date();
    const dirs = new Set<string>();
    const addDirs = (p: string) => {
      const parts = p.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const d = parts.slice(0, i).join("/");
        if (dirs.has(d)) continue;
        dirs.add(d);
        tar.entry({ name: `${d}/`, type: "directory", mode: 0o755, mtime, ...OWNER });
      }
    };
    let files = 0;
    let bytes = 0;
    try {
      const otherRoots = report.worlds.map((w) => w.root).filter((r) => r !== root);
      for await (const e of entries(zip)) {
        if (e.fileName.endsWith("/")) continue;
        if (root && !e.fileName.startsWith(`${root}/`)) continue;
        if (otherRoots.some((r) => r.startsWith(root ? `${root}/` : "") && e.fileName.startsWith(`${r}/`))) continue;
        const rel = root ? e.fileName.slice(root.length + 1) : e.fileName;
        if (!isWorldFile(rel)) continue;
        const name = `world/${rel}`;
        addDirs(name);
        const src = await zip.openReadStreamPromise(e);
        await new Promise<void>((resolve, reject) => {
          const sink = tar.entry({ name, size: e.uncompressedSize, mode: 0o644, mtime, ...OWNER }, (err) => (err ? reject(err) : resolve()));
          src.on("error", reject);
          src.pipe(sink);
        });
        files++;
        bytes += e.uncompressedSize;
      }
      tar.finalize();
      await upload;
    } catch (err) {
      tar.destroy(err as Error);
      await upload.catch(() => undefined);
      throw err;
    } finally {
      zip.close();
    }
    return { files, bytes };
  }
}

