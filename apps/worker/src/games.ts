// Saved minigames: a world snapshot (map, builds, game datapacks, plugin settings and data) plus the
// spec it ran with, kept on the worker so it can be copied into fresh worlds any number of times.
// Player data, access lists and server jars are left out: every copy starts clean, and jars come back
// hash-checked from the spec's pinned downloads.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Docker from "dockerode";
import type { WorldSpec } from "@worldsmith/core";
import { archiveData, unpackArchive } from "./backups.ts";

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Left out of a saved game (paths inside the archive start with "data/"). */
const SKIP = [
  /^data\/world\/(players|playerdata|stats|advancements)(\/|$)/,
  /^data\/(ops|whitelist|banned-players|banned-ips|usercache)\.json$/,
];

export interface SavedGame {
  name: string;
  title: string;
  description?: string;
  /** The world it was saved from, and when. */
  source: string;
  createdAt: string;
  bytes: number;
  /** Spec to copy (slug/name are replaced for each copy). */
  spec: WorldSpec;
}

export class SavedGames {
  dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private path(name: string, file: "game.tar.gz" | "meta.json" | ""): string {
    if (!NAME_RE.test(name)) throw new Error("Saved game names use lowercase letters, digits and dashes (2-41).");
    return path.join(this.dir, name, file);
  }

  list(): SavedGame[] {
    return readdirSync(this.dir)
      .filter((n) => NAME_RE.test(n) && existsSync(path.join(this.dir, n, "meta.json")))
      .map((n) => JSON.parse(readFileSync(path.join(this.dir, n, "meta.json"), "utf8")) as SavedGame)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(name: string): SavedGame {
    const meta = this.path(name, "meta.json");
    if (!existsSync(meta)) throw new Error(`No saved minigame called "${name}".`);
    return JSON.parse(readFileSync(meta, "utf8")) as SavedGame;
  }

  /** Snapshot a world. The caller pauses saving on a running world (like a backup). */
  async save(container: Docker.Container, input: { name: string; title: string; description?: string; source: string; spec: WorldSpec }): Promise<SavedGame> {
    mkdirSync(this.path(input.name, ""), { recursive: true });
    const file = this.path(input.name, "game.tar.gz");
    await archiveData(container, `${file}.new`, SKIP);
    renameSync(`${file}.new`, file);
    const meta: SavedGame = { ...input, createdAt: new Date().toISOString(), bytes: statSync(file).size };
    writeFileSync(this.path(input.name, "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  }

  /** Copy a saved game's data into a new world's container (created, never started). */
  async install(container: Docker.Container, name: string): Promise<void> {
    this.get(name);
    await unpackArchive(container, this.path(name, "game.tar.gz"));
  }

  remove(name: string): void {
    this.get(name);
    rmSync(this.path(name, ""), { recursive: true, force: true });
  }
}
