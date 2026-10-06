// Typed client for the worker API (apps/worker). The hub is its only caller.

import type { WorldFile, WorldSpec } from "@worldsmith/core";

export interface WorkerWorldStatus {
  slug: string;
  container: "missing" | "created" | "running" | "restarting" | "exited" | "paused" | "dead" | "removing";
  health?: "starting" | "healthy" | "unhealthy";
  startedAt?: string;
  backend: string;
  mc?: { online: true; version: string; protocol: number; motd: string; players: { online: number; max: number } } | { online: false };
}

export interface BackupInfo {
  id: string;
  label: string;
  createdAt: string;
  bytes: number;
}

export interface RenderRequest {
  dimension?: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  scale?: number;
  maxY?: number;
  grid?: boolean;
  markers?: { x: number; z: number; color?: [number, number, number] }[];
}

export interface RenderFeature {
  block: string;
  x: number;
  y: number;
  z: number;
  detail?: string;
}

export interface RenderResponse {
  pngBase64: string;
  width: number;
  height: number;
  scale: number;
  gridStep: number;
  regionDir: string;
  flushed: boolean;
  stats: { minY: number; maxY: number; missingChunks: number; topBlocks: [string, number][]; seeThrough: [string, number][] };
  features: RenderFeature[];
}

export interface MapWorldInfo {
  root: string;
  levelName: string;
  dataVersion?: number;
  version?: string;
  needsUpgrade: boolean;
  gameMode: "survival" | "creative" | "adventure" | "spectator";
  hardcore: boolean;
  allowCommands: boolean;
  difficulty?: string;
  spawn?: { x: number; y: number; z: number };
  dimensions: Record<string, number>;
  datapacks: string[];
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
  skipped: { path: string; reason: string }[];
  skippedCount: number;
  warnings: string[];
}

export class WorkerClient {
  base: URL;
  token: string;

  constructor(base: URL, token: string) {
    this.base = base;
    this.token = token;
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000, raw?: { stream: AsyncIterable<Uint8Array>; type: string }): Promise<T> {
    const res = await fetch(new URL(path, this.base), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(raw ? { "Content-Type": raw.type } : body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: raw ? (raw.stream as unknown as ReadableStream) : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      ...(raw ? { duplex: "half" } : {}),
    } as RequestInit);
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {}
      throw new Error(`worker ${method} ${path}: ${message}`);
    }
    return (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T;
  }

  status(slug: string): Promise<WorkerWorldStatus> {
    return this.call("GET", `/worlds/${slug}`, undefined, 8000);
  }
  list(): Promise<WorkerWorldStatus[]> {
    return this.call("GET", "/worlds", undefined, 15_000);
  }
  apply(spec: WorldSpec, rconPassword: string, extraFiles: WorldFile[] = []): Promise<WorkerWorldStatus> {
    return this.call("PUT", `/worlds/${spec.slug}`, { spec, rconPassword, extraFiles }, 300_000);
  }
  putFiles(slug: string, files: WorldFile[]): Promise<void> {
    return this.call("POST", `/worlds/${slug}/files`, { files });
  }
  start(slug: string): Promise<void> {
    return this.call("POST", `/worlds/${slug}/start`);
  }
  stop(slug: string): Promise<void> {
    return this.call("POST", `/worlds/${slug}/stop`, undefined, 90_000);
  }
  async rcon(slug: string, commands: string[]): Promise<string[]> {
    return (await this.call<{ outputs: string[] }>("POST", `/worlds/${slug}/rcon`, { commands }, 60_000)).outputs;
  }
  backup(slug: string, label: string): Promise<BackupInfo> {
    return this.call("POST", `/worlds/${slug}/backups`, { label }, 600_000);
  }
  listBackups(slug: string): Promise<BackupInfo[]> {
    return this.call("GET", `/worlds/${slug}/backups`);
  }
  restore(slug: string, id: string): Promise<{ safetyBackup: BackupInfo }> {
    return this.call("POST", `/worlds/${slug}/restore`, { id }, 900_000);
  }
  remove(slug: string, purge: boolean): Promise<void> {
    return this.call("DELETE", `/worlds/${slug}?purge=${purge}`, undefined, 90_000);
  }
  listMaps(): Promise<MapReport[]> {
    return this.call("GET", "/maps");
  }
  getMap(id: string): Promise<MapReport> {
    return this.call("GET", `/maps/${encodeURIComponent(id)}`);
  }
  importMap(url: string): Promise<MapReport> {
    return this.call("POST", "/maps/import", { url }, 900_000);
  }
  uploadMap(stream: AsyncIterable<Uint8Array>, filename: string): Promise<MapReport> {
    return this.call("POST", `/maps/upload?filename=${encodeURIComponent(filename)}`, undefined, 900_000, { stream, type: "application/zip" });
  }
  deleteMap(id: string): Promise<void> {
    return this.call("DELETE", `/maps/${encodeURIComponent(id)}`);
  }
  installMap(slug: string, id: string, root: string): Promise<{ files: number; bytes: number }> {
    return this.call("POST", `/worlds/${slug}/install-map`, { id, root }, 900_000);
  }
  render(slug: string, req: RenderRequest): Promise<RenderResponse> {
    return this.call("POST", `/worlds/${slug}/render`, req, 120_000);
  }
  logs(slug: string, tail = 200): Promise<string> {
    return this.call("GET", `/worlds/${slug}/logs?tail=${tail}`);
  }
}
