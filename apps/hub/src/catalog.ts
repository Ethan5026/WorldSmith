// Modrinth catalog: search, and resolve plan content to exact, hash-pinned files for one world.
// Every download is pinned to a sha512 Modrinth publishes; the worker checks it before install.

import type { ContentCrossplay, PlanContent, ServerType, WorldFile } from "@worldsmith/core";

const API = "https://api.modrinth.com/v2";
const UA = "WorldSmith/0.2 (personal Minecraft server; github.com/Ethan5026/WorldSmith)";

export type Fetcher = (url: string) => Promise<unknown>;

export const modrinthFetch: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Modrinth answered ${res.status} for ${url.replace(API, "")}`);
  return res.json();
};

interface MrProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  project_type: "mod" | "plugin" | "datapack" | "resourcepack" | "modpack" | "shader";
  client_side: "required" | "optional" | "unsupported" | "unknown";
  server_side: "required" | "optional" | "unsupported" | "unknown";
  license?: { id: string };
  icon_url?: string | null;
  downloads?: number;
  loaders?: string[];
}
interface MrVersion {
  id: string;
  project_id: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  loaders: string[];
  game_versions: string[];
  files: { url: string; filename: string; primary: boolean; size: number; hashes: { sha512?: string } }[];
  dependencies: { project_id: string | null; version_id: string | null; dependency_type: "required" | "optional" | "incompatible" | "embedded" }[];
}

/** Which Modrinth loaders work on a server type, and where their files go. */
export function loadersFor(type: ServerType): { loaders: string[]; dir: string } {
  if (type === "PAPER") return { loaders: ["paper", "spigot", "bukkit", "purpur"], dir: "plugins" };
  if (type === "FABRIC") return { loaders: ["fabric"], dir: "mods" };
  if (type === "NEOFORGE") return { loaders: ["neoforge"], dir: "mods" };
  return { loaders: [], dir: "" };
}

export interface ResolvedContent {
  project: { id: string; slug: string; title: string; type: string; license?: string; iconUrl?: string; url: string; clientSide: string; serverSide: string };
  version: { id: string; number: string; type: string };
  file: WorldFile;
  label: "No install needed" | "Friends install pack";
  why: string;
  /** Pulled in as a dependency of another item. */
  requiredBy?: string;
  crossplay: ContentCrossplay;
}

export interface Resolution {
  minecraft: string;
  serverType: ServerType;
  items: ResolvedContent[];
  /** Problems the planner must fix before the plan can be proposed. */
  issues: string[];
}

export class Catalog {
  get: Fetcher;
  constructor(get: Fetcher = modrinthFetch) {
    this.get = get;
  }

  async search(query: string, kind: "plugin" | "datapack" | "mod", minecraft: string, limit = 10) {
    const facets = JSON.stringify([[`project_type:${kind}`], [`versions:${minecraft}`]]);
    const r = (await this.get(`${API}/search?query=${encodeURIComponent(query)}&limit=${limit}&facets=${encodeURIComponent(facets)}`)) as {
      hits: { slug: string; title: string; description: string; downloads: number; categories: string[]; client_side: string; server_side: string; license: string; date_modified: string }[];
    };
    return r.hits.map((h) => ({
      project: h.slug,
      title: h.title,
      description: h.description,
      downloads: h.downloads,
      loaders: h.categories.filter((c) => ["paper", "spigot", "bukkit", "purpur", "folia", "fabric", "neoforge", "forge", "quilt", "datapack"].includes(c)),
      installForFriends: h.client_side === "required" ? "Friends install pack (client mod needed)" : "No install needed",
      license: h.license,
      updated: h.date_modified.slice(0, 10),
      url: `https://modrinth.com/${kind}/${h.slug}`,
    }));
  }

  /** Resolve plan content (plus required dependencies) for one Minecraft version and server type. */
  async resolve(content: PlanContent[], minecraft: string, serverType: ServerType): Promise<Resolution> {
    const items: ResolvedContent[] = [];
    const issues: string[] = [];
    const seen = new Set<string>();
    const { loaders, dir } = loadersFor(serverType);

    const one = async (ref: string, why: string, crossplay: PlanContent["crossplay"], pinned: string | undefined, requiredBy?: string, depth = 0): Promise<void> => {
      const project = (await this.get(`${API}/project/${encodeURIComponent(ref)}`)) as MrProject | undefined;
      if (!project) return void issues.push(`"${ref}" isn't a Modrinth project (check the slug with search_catalog).`);
      if (seen.has(project.id)) return;
      seen.add(project.id);
      // Modrinth's API reports most datapacks as project_type "mod" with a "datapack" loader. Use the datapack
      // build whenever this server type can't load the project as a mod or plugin.
      const canLoad = (project.loaders ?? []).some((l) => loaders.includes(l));
      const isDatapack = project.project_type === "datapack" || (!canLoad && (project.loaders ?? []).includes("datapack"));
      if (!isDatapack && !["mod", "plugin"].includes(project.project_type)) {
        return void issues.push(`${project.title} is a ${project.project_type}; only plugins, mods and datapacks can go into a world.`);
      }
      const want = isDatapack ? ["datapack"] : loaders;
      if (!want.length) return void issues.push(`${project.title}: ${serverType} servers can't load ${project.project_type}s.`);
      const versions = (await this.get(
        `${API}/project/${project.id}/version?loaders=${encodeURIComponent(JSON.stringify(want))}&game_versions=${encodeURIComponent(JSON.stringify([minecraft]))}`,
      )) as MrVersion[] | undefined;
      const candidates = (versions ?? []).filter((v) => !pinned || v.id === pinned);
      const version = candidates.find((v) => v.version_type === "release") ?? candidates[0];
      if (!version) {
        const kind = isDatapack ? "datapack" : serverType === "PAPER" ? "Paper" : serverType;
        return void issues.push(`${project.title} has no ${pinned ? `version ${pinned} ` : ""}build for Minecraft ${minecraft} (${kind}). Pick another project or a different base.`);
      }
      const file = version.files.find((f) => f.primary) ?? version.files[0];
      if (!file?.hashes.sha512) return void issues.push(`${project.title} ${version.version_number} has no file with a sha512 hash; WorldSmith only installs hash-checked files.`);
      if (!/^[A-Za-z0-9._+ -]{1,120}$/.test(file.filename) || file.filename.startsWith(".")) return void issues.push(`${project.title}: unusual file name "${file.filename}".`);
      const clientNeeded = !isDatapack && project.client_side === "required";
      if (!isDatapack && project.server_side === "unsupported") return void issues.push(`${project.title} is client-only; it does nothing on a server.`);
      items.push({
        project: {
          id: project.id,
          slug: project.slug,
          title: project.title,
          type: project.project_type,
          license: project.license?.id,
          iconUrl: project.icon_url ?? undefined,
          url: `https://modrinth.com/${project.project_type}/${project.slug}`,
          clientSide: project.client_side,
          serverSide: project.server_side,
        },
        version: { id: version.id, number: version.version_number, type: version.version_type },
        file: {
          kind: "download",
          source: "modrinth",
          project: project.slug,
          version: version.version_number,
          url: file.url,
          sha512: file.hashes.sha512,
          path: isDatapack ? `world/datapacks/${file.filename}` : `${dir}/${file.filename}`,
        },
        label: clientNeeded ? "Friends install pack" : "No install needed",
        why,
        requiredBy,
        crossplay: {
          id: project.slug,
          name: project.title,
          ...(crossplay ??
            (clientNeeded
              ? { textures: "none" as const, behavior: "cannot_join" as const }
              : isDatapack
                ? { textures: "native" as const, behavior: "identical" as const }
                : // Server plugins mostly work through Geyser, but menus and custom items can look or act differently.
                  { textures: "native" as const, behavior: "approximate" as const })),
          differences: crossplay?.note
            ? [{ source: project.slug, area: "behavior", feature: project.title, java: "As designed.", bedrock: crossplay.note, severity: "minor" }]
            : [],
        },
      });
      if (depth >= 3) return;
      for (const d of version.dependencies) {
        if (d.dependency_type === "incompatible" && d.project_id && items.some((i) => i.project.id === d.project_id)) {
          issues.push(`${project.title} is incompatible with ${items.find((i) => i.project.id === d.project_id)!.project.title}.`);
        }
        if (d.dependency_type === "required" && d.project_id) await one(d.project_id, `Needed by ${project.title}`, undefined, undefined, project.title, depth + 1);
      }
    };

    for (const c of content) await one(c.project, c.why, c.crossplay, c.version);
    return { minecraft, serverType, items, issues };
  }
}
