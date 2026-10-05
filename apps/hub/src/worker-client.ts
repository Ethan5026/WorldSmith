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

export class WorkerClient {
  base: URL;
  token: string;

  constructor(base: URL, token: string) {
    this.base = base;
    this.token = token;
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(new URL(path, this.base), {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
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
  logs(slug: string, tail = 200): Promise<string> {
    return this.call("GET", `/worlds/${slug}/logs?tail=${tail}`);
  }
}
