// Map renders straight from a world's region files, read out of its container (running or
// stopped). Running worlds flush to disk first so recent builds show up.

import type Docker from "dockerode";
import { extract } from "tar-stream";
import { regionDirs, renderTopDown, type Feature, type Marker } from "@worldsmith/mcworld";

const MAX_REGION_BYTES = 64 * 1024 * 1024;

export interface RenderInput {
  dimension: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  scale?: number;
  maxY?: number;
  grid?: boolean;
  markers?: Marker[];
}

export interface RenderOutput {
  pngBase64: string;
  width: number;
  height: number;
  scale: number;
  gridStep: number;
  regionDir: string;
  stats: { minY: number; maxY: number; missingChunks: number; topBlocks: [string, number][]; seeThrough: [string, number][] };
  features: Feature[];
}

/** One file out of a container, or undefined if it doesn't exist. */
export async function readContainerFile(container: Docker.Container, file: string, maxBytes = MAX_REGION_BYTES): Promise<Buffer | undefined> {
  let stream: NodeJS.ReadableStream;
  try {
    stream = (await container.getArchive({ path: file })) as NodeJS.ReadableStream;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return undefined;
    throw err;
  }
  return new Promise((resolve, reject) => {
    const ex = extract();
    let found: Buffer | undefined;
    ex.on("entry", (header, entry, next) => {
      if (header.type !== "file" || found || (header.size ?? 0) > maxBytes) {
        entry.on("end", next);
        entry.resume();
        return;
      }
      const parts: Buffer[] = [];
      entry.on("data", (d) => void parts.push(d as Buffer));
      entry.on("end", () => {
        found = Buffer.concat(parts);
        next();
      });
    });
    ex.on("finish", () => resolve(found));
    ex.on("error", reject);
    stream.pipe(ex);
  });
}

async function exists(container: Docker.Container, p: string): Promise<boolean> {
  try {
    await container.infoArchive({ path: p });
    return true;
  } catch {
    return false;
  }
}

export async function renderContainerArea(container: Docker.Container, input: RenderInput): Promise<RenderOutput> {
  let regionDir: string | undefined;
  for (const dir of regionDirs(input.dimension)) {
    if (await exists(container, `/data/${dir}`)) {
      regionDir = dir;
      break;
    }
  }
  if (!regionDir) throw new Error(`No region files for ${input.dimension} yet (has anyone visited it?)`);
  const result = await renderTopDown({
    ...input,
    loadRegion: (rx, rz) => readContainerFile(container, `/data/${regionDir}/r.${rx}.${rz}.mca`),
  });
  return {
    pngBase64: result.png.toString("base64"),
    width: result.width,
    height: result.height,
    scale: result.scale,
    gridStep: result.gridStep,
    regionDir,
    stats: result.stats,
    features: result.features,
  };
}
