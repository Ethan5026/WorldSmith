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
