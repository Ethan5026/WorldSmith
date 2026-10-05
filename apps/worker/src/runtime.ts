// World containers on the local Docker engine. One container + one named volume per world,
// on the internal worlds network (no published ports: players arrive through the gatekeeper).

import Docker from "dockerode";
import {
  compileWorld,
  worldContainerName,
  worldVolumeName,
  worldDatapack,
  type WorldFile,
  type WorldSpec,
} from "@worldsmith/core";
import { RconClient, statusPing, descriptionText } from "@worldsmith/mcproto";
import { buildTar, resolveFile } from "./files.ts";

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

  constructor(opts: { network: string; cacheDir: string; socketPath?: string }) {
    this.docker = new Docker({ socketPath: opts.socketPath ?? "/var/run/docker.sock" });
    this.network = opts.network;
    this.cacheDir = opts.cacheDir;
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
      [...spec.files, ...worldDatapack(spec), ...extraFiles].map((f) => resolveFile(f, this.cacheDir)),
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
    if (files.length > 0) await container.putArchive(await buildTar(files), { path: "/data" });
  }

  /** Write files into an existing world (running or stopped), e.g. whitelist.json or builder output. */
  async putFiles(slug: string, files: WorldFile[]): Promise<void> {
    if (!(await this.inspect(slug))) throw new Error(`World ${slug} does not exist`);
    const resolved = await Promise.all(files.map((f) => resolveFile(f, this.cacheDir)));
    await this.container(slug).putArchive(await buildTar(resolved), { path: "/data" });
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
