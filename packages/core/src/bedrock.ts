// Bedrock crossplay files for a world: Floodgate (lets Bedrock players in without a Java account)
// plus the AES key it shares with Geyser. The key is what stops anyone forging a Bedrock login.

import type { WorldFile, WorldSpec } from "./world.ts";

/** Pinned from download.geysermc.org (Floodgate 2.2.5 build 141, Spigot/Paper; supports 26.2). */
export const FLOODGATE_PAPER: WorldFile = {
  kind: "download",
  source: "geysermc",
  project: "floodgate",
  version: "2.2.5-b141",
  url: "https://download.geysermc.org/v2/projects/floodgate/versions/2.2.5/builds/141/downloads/spigot",
  sha256: "21570aff9ce17d6983928e8552777760e1ede5050026b04c686b0ae112e6fd7e",
  path: "plugins/floodgate-spigot.jar",
};

/** Floodgate's key.pem is the raw 16-byte AES key; Geyser must use the very same bytes. */
export function crossplayFiles(spec: WorldSpec, floodgateKeyB64: string | undefined): WorldFile[] {
  if (!spec.crossplay.bedrock) return [];
  if (spec.minecraft.type !== "PAPER") return []; // Fabric/NeoForge: Floodgate-Modded, added with modded worlds
  if (!floodgateKeyB64 || Buffer.from(floodgateKeyB64, "base64").length !== 16) {
    throw new Error("This world allows Bedrock players, but FLOODGATE_KEY_B64 (16 bytes, base64) isn't configured.");
  }
  return [
    FLOODGATE_PAPER,
    { kind: "inline", encoding: "base64", path: "plugins/floodgate/key.pem", content: floodgateKeyB64 },
  ];
}
