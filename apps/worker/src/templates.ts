// Template library: builds copied out of worlds (save_template), kept on the worker and usable in any
// world. Installing one writes it into the world as worldsmith:<name>_<hash> (Minecraft caches a
// template once loaded, so a re-saved template must get a new id).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Docker from "dockerode";
import { buildStructure, captureStructure, regionDirs, STRUCTURE_DIR, STRUCTURE_NAMESPACE, structureHash, structureInfo, type StructureInfo, type Vec3 } from "@worldsmith/mcworld";
import { readContainerFile } from "./render.ts";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export interface TemplateMeta extends StructureInfo {
  name: string;
  description?: string;
  hash: string;
  /** In-world id once installed: worldsmith:<name>_<hash>. */
  id: string;
  source?: { world: string; dimension: string; from: Vec3; to: Vec3 };
  createdAt: string;
  missingChunks?: number;
}

export class TemplateLibrary {
  dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string, ext: "nbt" | "json"): string {
    if (!NAME_RE.test(name)) throw new Error("Template names use lowercase letters, digits, - and _ (up to 41).");
    return path.join(this.dir, `${name}.${ext}`);
  }

  list(): TemplateMeta[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as TemplateMeta)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): { meta: TemplateMeta; data: Buffer } {
    const json = this.file(name, "json");
    if (!existsSync(json)) throw new Error(`No template called "${name}".`);
    return { meta: JSON.parse(readFileSync(json, "utf8")) as TemplateMeta, data: readFileSync(this.file(name, "nbt")) };
  }

  save(name: string, data: Buffer, extra: Pick<TemplateMeta, "description" | "source" | "missingChunks">): TemplateMeta {
    const hash = structureHash(data);
    const meta: TemplateMeta = { name, hash, id: `${STRUCTURE_NAMESPACE}:${name}_${hash}`, createdAt: new Date().toISOString(), ...structureInfo(data), ...extra };
    const nbtFile = this.file(name, "nbt");
    writeFileSync(`${nbtFile}.tmp`, data);
    renameSync(`${nbtFile}.tmp`, nbtFile);
    writeFileSync(this.file(name, "json"), JSON.stringify(meta, null, 2));
    return meta;
  }

  /** Copy a box out of a world (its saved files) into the library. */
  async capture(
    container: Docker.Container,
    input: { world: string; name: string; from: Vec3; to: Vec3; dimension: string; description?: string; dataVersion: number },
  ): Promise<TemplateMeta> {
    let regionDir: string | undefined;
    for (const dir of regionDirs(input.dimension)) {
      try {
        await container.infoArchive({ path: `/data/${dir}` });
        regionDir = dir;
        break;
      } catch {
        // try the next layout
      }
    }
    if (!regionDir) throw new Error(`No saved terrain for ${input.dimension} yet.`);
    const cap = await captureStructure((rx, rz) => readContainerFile(container, `/data/${regionDir}/r.${rx}.${rz}.mca`), input.from, input.to);
    if (cap.blocks.length === 0) throw new Error("Nothing to save there: those chunks haven't been generated.");
    const data = buildStructure(cap.size, cap.blocks, input.dataVersion);
    return this.save(input.name, data, {
      description: input.description,
      source: { world: input.world, dimension: input.dimension, from: input.from, to: input.to },
      missingChunks: cap.missingChunks || undefined,
    });
  }

  /** The world file that makes a template placeable as its id. */
  installFile(name: string): { meta: TemplateMeta; path: string; base64: string } {
    const { meta, data } = this.get(name);
    return { meta, path: `${STRUCTURE_DIR}/${name}_${meta.hash}.nbt`, base64: data.toString("base64") };
  }
}
