// World containers on the local Docker engine. One container + one named volume per world,
// on the internal worlds network (no published ports: players arrive through the gatekeeper).

import Docker from "dockerode";
import {
  compileWorld,
  worldContainerName,
  worldVolumeName,
  worldDatapack,
  serverConfigFiles,
  crossplayFiles,
  type WorldFile,
  type WorldSpec,
} from "@worldsmith/core";
import { RconClient, statusPing, descriptionText } from "@worldsmith/mcproto";
import { buildTar, resolveFile, type ResolvedFile } from "./files.ts";
import { Backups, isBackupId, type BackupInfo } from "./backups.ts";
import { renderContainerArea, type RenderInput, type RenderOutput } from "./render.ts";
import { MapStore } from "./maps.ts";
import { TemplateLibrary, type TemplateMeta } from "./templates.ts";
import { SavedGames, type SavedGame } from "./games.ts";
import type { Vec3 } from "@worldsmith/mcworld";

const MANAGED_LABEL = "worldsmith.world";
const RCON_PORT = 25575;
const GAME_PORT = 25565;

export interface WorldStatus {
  slug: string;
  container: "missing" | "created" | "running" | "restarting" | "exited" | "paused" | "dead" | "removing";
  health?: "starting" | "healthy" | "unhealthy";
  startedAt?: string;
  mc?: { online: true; version: string; protocol: number; motd: string; players: { online: number; max: number } } | { online: false };
  /** Address the gatekeeper connects to (only meaningful while running). */
  backend: string;
}

export class WorldRuntime {
  docker: Docker;
  network: string;
  cacheDir: string;
  backups: Backups;
  floodgateKey: string | undefined;
  maps: MapStore;
  templates: TemplateLibrary;
  games: SavedGames;

  constructor(opts: { network: string; cacheDir: string; backupsDir: string; mapsDir?: string; floodgateKey?: string; socketPath?: string }) {
    this.maps = new MapStore(opts.mapsDir ?? `${opts.cacheDir}/maps`);
    this.templates = new TemplateLibrary(`${opts.cacheDir}/templates`);
    this.games = new SavedGames(`${opts.cacheDir}/games`);
    this.floodgateKey = opts.floodgateKey;
    this.docker = new Docker({ socketPath: opts.socketPath ?? "/var/run/docker.sock" });
    this.network = opts.network;
    this.cacheDir = opts.cacheDir;
    this.backups = new Backups(opts.backupsDir);
  }

  private container(slug: string) {
    return this.docker.getContainer(worldContainerName(slug));
  }

  private async inspect(slug: string) {
    try {
      return await this.container(slug).inspect();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return undefined;
      throw err;
    }
  }

  async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      const stream = await this.docker.pull(image);
      await new Promise((resolve, reject) => this.docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve(null))));
    }
  }

  /**
   * Create (or re-create) the world's container from its spec. The volume — the world itself —
   * is kept across re-creates. Refuses while the world is running.
   */
  async apply(spec: WorldSpec, rconPassword: string, extraFiles: WorldFile[] = []): Promise<void> {
    const compiled = compileWorld(spec, { rconPassword });
    const existing = await this.inspect(spec.slug);
    if (existing?.State.Running) throw new Error(`World ${spec.slug} is running; stop it before applying changes`);

    // Resolve every file before touching Docker, so a bad hash leaves the world untouched.
    const files = await Promise.all(
      [...spec.files, ...worldDatapack(spec), ...serverConfigFiles(spec), ...crossplayFiles(spec, this.floodgateKey), ...extraFiles].map((f) => resolveFile(f, this.cacheDir)),
    );
    await this.ensureImage(compiled.image);

    const volume = worldVolumeName(spec.slug);
    try {
      await this.docker.getVolume(volume).inspect();
    } catch {
      await this.docker.createVolume({ Name: volume, Labels: { [MANAGED_LABEL]: spec.slug } });
    }
    if (existing) await this.container(spec.slug).remove({ force: true });

    const container = await this.docker.createContainer({
      name: worldContainerName(spec.slug),
      Image: compiled.image,
      Env: Object.entries(compiled.env).map(([k, v]) => `${k}=${v}`),
      Labels: { [MANAGED_LABEL]: spec.slug, "worldsmith.recipe": spec.recipe ?? "" },
      HostConfig: {
        Mounts: [{ Type: "volume", Source: volume, Target: "/data" }],
        Memory: compiled.memoryLimitBytes,
        NetworkMode: this.network,
        RestartPolicy: { Name: "no" },
        // itzg starts as root to fix /data ownership, then drops to uid 1000.
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 1024,
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
    });
    const toWrite = await this.skipExisting(container, files);
    if (toWrite.length > 0) await container.putArchive(await buildTar(toWrite), { path: "/data" });
  }

  /** Write files into an existing world (running or stopped), e.g. whitelist.json or builder output. */
  async putFiles(slug: string, files: WorldFile[]): Promise<void> {
    if (!(await this.inspect(slug))) throw new Error(`World ${slug} does not exist`);
    const resolved = await Promise.all(files.map((f) => resolveFile(f, this.cacheDir)));
    const toWrite = await this.skipExisting(this.container(slug), resolved);
    if (toWrite.length > 0) await this.container(slug).putArchive(await buildTar(toWrite), { path: "/data" });
  }

  /** Drop "only if missing" files that the world already has. */
  private async skipExisting(container: Docker.Container, files: ResolvedFile[]): Promise<ResolvedFile[]> {
    const out: ResolvedFile[] = [];
    for (const f of files) {
      if (f.onlyIfMissing) {
        try {
          await container.infoArchive({ path: `/data/${f.path}` });
          continue; // exists: keep the world's version
        } catch (err) {
          if ((err as { statusCode?: number }).statusCode !== 404) throw err;
        }
      }
      out.push(f);
    }
    return out;
  }

  async start(slug: string): Promise<void> {
    const info = await this.inspect(slug);
    if (!info) throw new Error(`World ${slug} does not exist`);
    if (!info.State.Running) await this.container(slug).start();
  }

  async stop(slug: string): Promise<void> {
    const info = await this.inspect(slug);
    if (info?.State.Running) await this.container(slug).stop({ t: 60 }); // itzg saves the world on SIGTERM
  }

  async remove(slug: string, purgeVolume: boolean): Promise<void> {
    const info = await this.inspect(slug);
    if (info) await this.container(slug).remove({ force: true });
    if (purgeVolume) {
      try {
        await this.docker.getVolume(worldVolumeName(slug)).remove();
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      }
    }
  }

  async status(slug: string): Promise<WorldStatus> {
    const backend = `${worldContainerName(slug)}:${GAME_PORT}`;
    const info = await this.inspect(slug);
    if (!info) return { slug, container: "missing", backend };
    const status: WorldStatus = {
      slug,
      container: info.State.Status as WorldStatus["container"],
      health: info.State.Health?.Status as WorldStatus["health"],
      startedAt: info.State.Running ? info.State.StartedAt : undefined,
      backend,
    };
    if (info.State.Running) {
      try {
        const { status: s } = await statusPing(worldContainerName(slug), GAME_PORT, 2000);
        status.mc = {
          online: true,
          version: s.version.name,
          protocol: s.version.protocol,
          motd: descriptionText(s.description),
          players: { online: s.players.online, max: s.players.max },
        };
      } catch {
        status.mc = { online: false };
      }
    }
    return status;
  }

  async list(): Promise<WorldStatus[]> {
    const containers = await this.docker.listContainers({ all: true, filters: { label: [MANAGED_LABEL] } });
    return Promise.all(containers.map((c) => this.status(c.Labels[MANAGED_LABEL]!)));
  }

  async rcon(slug: string, commands: string[]): Promise<string[]> {
    const info = await this.inspect(slug);
    if (!info?.State.Running) throw new Error(`World ${slug} is not running`);
    const password = info.Config.Env.find((e) => e.startsWith("RCON_PASSWORD="))?.slice("RCON_PASSWORD=".length);
    if (!password) throw new Error(`World ${slug} has no RCON password`);
    const client = await RconClient.connect(worldContainerName(slug), RCON_PORT, password);
    try {
      const out: string[] = [];
      for (const c of commands) out.push(await client.command(c));
      return out;
    } finally {
      client.close();
    }
  }

  /** Back up a world. Running worlds pause autosave and flush to disk for a consistent copy. */
  async backup(slug: string, label: string): Promise<BackupInfo> {
    const info = await this.inspect(slug);
    if (!info) throw new Error(`World ${slug} does not exist`);
    const live = info.State.Running && (await this.status(slug)).mc?.online === true;
    if (live) await this.rcon(slug, ["save-off", "save-all flush"]);
    try {
      return await this.backups.create(this.container(slug), slug, label);
    } finally {
      if (live) await this.rcon(slug, ["save-on"]).catch(() => undefined);
    }
  }

  listBackups(slug: string): BackupInfo[] {
    return this.backups.list(slug);
  }

  /** Replace a stopped world's data with a backup (after taking a safety backup of the current state). */
  async restore(slug: string, id: string): Promise<BackupInfo> {
    if (!isBackupId(id)) throw new Error("Not a backup id");
    if (!this.backups.list(slug).some((b) => b.id === id)) throw new Error(`No backup ${id} for ${slug}`);
    const info = await this.inspect(slug);
    if (!info) throw new Error(`World ${slug} does not exist`);
    if (info.State.Running) throw new Error("Stop the world before restoring a backup");
    const safety = await this.backups.create(this.container(slug), slug, "before-restore");
    await this.wipeVolume(slug);
    await this.backups.unpack(this.container(slug), slug, id);
    return safety;
  }

  private async wipeVolume(slug: string): Promise<void> {
    const image = "alpine:3.20";
    await this.ensureImage(image);
    const helper = await this.docker.createContainer({
      Image: image,
      Cmd: ["sh", "-c", "find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +"],
      Labels: { "worldsmith.helper": "wipe" },
      HostConfig: { Mounts: [{ Type: "volume", Source: worldVolumeName(slug), Target: "/data" }], NetworkMode: "none" },
    });
    try {
      await helper.start();
      const result = (await helper.wait()) as { StatusCode: number };
      if (result.StatusCode !== 0) throw new Error(`Wiping ${slug} failed (exit ${result.StatusCode})`);
    } finally {
      await helper.remove({ force: true });
    }
  }

  /** Put an imported map into a world that has never started (so there's no world of its own yet). */
  async installMap(slug: string, id: string, root: string): Promise<{ files: number; bytes: number }> {
    const info = await this.inspect(slug);
    if (!info) throw new Error(`World ${slug} does not exist`);
    if (info.State.Running) throw new Error("Stop the world before installing a map");
    let hasWorld = true;
    try {
      await this.container(slug).infoArchive({ path: "/data/world/level.dat" });
    } catch {
      hasWorld = false;
    }
    if (hasWorld) throw new Error(`${slug} already has a world; maps go into new worlds only`);
    return this.maps.install(id, root, this.container(slug));
  }

  /** Save a box of a world into the template library (a running world saves to disk first). */
  async captureTemplate(
    slug: string,
    input: { name: string; from: Vec3; to: Vec3; dimension: string; description?: string; dataVersion: number },
  ): Promise<TemplateMeta> {
    const info = await this.inspect(slug);
    if (!info) throw new Error(`World ${slug} does not exist`);
    if (info.State.Running) await this.rcon(slug, ["save-all flush"]).catch(() => undefined);
    return this.templates.capture(this.container(slug), { world: slug, ...input });
  }

  /** Save a world as a reusable minigame (consistent copy: a running world pauses saving briefly). */
  async saveGame(slug: string, input: Omit<SavedGame, "createdAt" | "bytes" | "source">): Promise<SavedGame> {
    const info = await this.inspect(slug);
    if (!info) throw new Error(`World ${slug} does not exist`);
    const live = info.State.Running && (await this.status(slug)).mc?.online === true;
    if (live) await this.rcon(slug, ["save-off", "save-all flush"]);
    try {
      return await this.games.save(this.container(slug), { ...input, source: slug });
    } finally {
      if (live) await this.rcon(slug, ["save-on"]).catch(() => undefined);
    }
  }

  /** Fill a brand-new world (never started) with a saved minigame's data. */
  async installGame(slug: string, name: string): Promise<void> {
    const info = await this.inspect(slug);
    if (!info) throw new Error(`World ${slug} does not exist`);
    if (info.State.Running) throw new Error("Stop the world before installing a saved minigame");
    try {
      await this.container(slug).infoArchive({ path: "/data/world/level.dat" });
      throw new Error(`${slug} already has a world; saved minigames go into new worlds only`);
    } catch (err) {
      if ((err as Error).message.includes("already has a world")) throw err;
    }
    await this.games.install(this.container(slug), name);
  }

  /** Make library templates placeable in a world (worldsmith:<name>_<hash>). */
  async installTemplates(slug: string, names: string[]): Promise<{ name: string; id: string; size: Vec3 }[]> {
    const files = names.map((n) => this.templates.installFile(n));
    await this.putFiles(slug, files.map((f) => ({ kind: "inline" as const, encoding: "base64" as const, path: f.path, content: f.base64 })));
    return files.map((f) => ({ name: f.meta.name, id: f.meta.id, size: f.meta.size }));
  }

  /** Top-down map of an area. Running worlds save first so the picture includes recent changes. */
  async render(slug: string, input: RenderInput): Promise<RenderOutput & { flushed: boolean }> {
    const info = await this.inspect(slug);
    if (!info) throw new Error(`World ${slug} does not exist`);
    let flushed = false;
    if (info.State.Running) {
      flushed = await this.rcon(slug, ["save-all flush"]).then(
        () => true,
        () => false, // still starting up: render what's on disk
      );
    }
    return { ...(await renderContainerArea(this.container(slug), input)), flushed };
  }

  async logs(slug: string, tail: number): Promise<string> {
    const buf = (await this.container(slug).logs({ stdout: true, stderr: true, tail, timestamps: false })) as Buffer;
    // Docker multiplexes stdout/stderr with 8-byte frame headers when there's no TTY.
    const out: string[] = [];
    for (let i = 0; i + 8 <= buf.length; ) {
      const size = buf.readUInt32BE(i + 4);
      out.push(buf.subarray(i + 8, i + 8 + size).toString("utf8"));
      i += 8 + size;
    }
    return out.join("");
  }
}
