// Username → real account UUID via Mojang's public profile API (cached).

const cache = new Map<string, { value: { uuid: string; name: string } | null; until: number }>();

export function dashUuid(hex: string): string {
  const h = hex.replace(/-/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Returns null if no Java account has that name. Throws if Mojang can't be reached. */
export async function lookupJavaProfile(name: string): Promise<{ uuid: string; name: string } | null> {
  const key = name.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(5000),
  });
  let value: { uuid: string; name: string } | null = null;
  if (res.status === 200) {
    const body = (await res.json()) as { id: string; name: string };
    value = { uuid: dashUuid(body.id), name: body.name };
  } else if (res.status !== 204 && res.status !== 404) {
    throw new Error(`Mojang profile lookup failed (${res.status})`);
  }
  cache.set(key, { value, until: Date.now() + (value ? 60 : 5) * 60_000 });
  return value;
}

/** Floodgate's Java-side UUID for a Bedrock player: new UUID(0, xuid). */
export function floodgateUuid(xuid: bigint | string): string {
  const hex = BigInt(xuid).toString(16).padStart(16, "0");
  return `00000000-0000-0000-${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/**
 * Bedrock gamertag → Xbox XUID via GeyserMC's global API. Returns null if no such gamertag.
 * The API may not know players who have never joined any Geyser server (503); callers explain that.
 */
export async function lookupBedrockXuid(gamertag: string): Promise<string | null> {
  const res = await fetch(`https://api.geysermc.org/v2/xbox/xuid/${encodeURIComponent(gamertag)}`, { signal: AbortSignal.timeout(6000) });
  if (res.status === 200) {
    // Read the digits as text: XUIDs are 16-digit integers and must never pass through a float.
    const m = /"xuid"\s*:\s*"?(\d+)"?/.exec(await res.text());
    return m ? m[1]! : null;
  }
  if (res.status === 400 || res.status === 404 || res.status === 204) return null;
  throw new Error(`Couldn't look up that Xbox gamertag right now (GeyserMC API ${res.status}). Ask them to join once, then approve their request.`);
}
