// Readable one-line descriptions of block entities (chests, signs, command blocks…), so Claude can
// check what it built without parsing NBT: "chest 'Starter Kit': diamond_sword, bread×16".

import { nbt, type NbtCompound, type NbtValue } from "./nbt.ts";

export interface Feature {
  /** Block name at the position, e.g. "chain_command_block" (more specific than the entity id). */
  block: string;
  x: number;
  y: number;
  z: number;
  detail?: string;
}

const short = (id: string) => id.replace(/^minecraft:/, "");

/** Plain text of a text component stored as NBT (26.x), or as a JSON string (older worlds). */
export function componentText(v: NbtValue | undefined, depth = 0): string {
  if (v === undefined || depth > 8) return "";
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
      try {
        return jsonText(JSON.parse(t), depth);
      } catch {
        return v;
      }
    }
    return v;
  }
  const list = nbt.list(v);
  if (list.length) return list.map((x) => componentText(x, depth + 1)).join("");
  const c = nbt.compound(v);
  if (!c) return "";
  const own = nbt.str(c.text) ?? nbt.str(c[""]) ?? nbt.str(c.translate) ?? "";
  return own + nbt.list(c.extra).map((x) => componentText(x, depth + 1)).join("");
}

function jsonText(j: unknown, depth: number): string {
  if (depth > 8) return "";
  if (typeof j === "string") return j;
  if (Array.isArray(j)) return j.map((x) => jsonText(x, depth + 1)).join("");
  if (j && typeof j === "object") {
    const o = j as { text?: unknown; translate?: unknown; extra?: unknown[] };
    const own = typeof o.text === "string" ? o.text : typeof o.translate === "string" ? o.translate : "";
    return own + (Array.isArray(o.extra) ? o.extra.map((x) => jsonText(x, depth + 1)).join("") : "");
  }
  return "";
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function signSide(side: NbtValue | undefined): string {
  const lines = nbt.list(nbt.compound(side)?.messages).map((m) => componentText(m).trim());
  return lines.filter(Boolean).join(" / ");
}

function items(list: NbtValue[]): string {
  const parts = list.flatMap((i) => {
    const c = nbt.compound(i);
    const id = nbt.str(c?.id);
    if (!c || !id) return [];
    const count = nbt.num(c.count) ?? nbt.num(c.Count) ?? 1;
    return [`${short(id)}${count > 1 ? `×${count}` : ""}`];
  });
  if (!parts.length) return "empty";
  return parts.length > 6 ? `${parts.slice(0, 6).join(", ")} +${parts.length - 6} more` : parts.join(", ");
}

/** Describe one block entity; blockAt gives the block name at an absolute position. */
export function describeBlockEntity(be: NbtCompound, blockAt: (x: number, y: number, z: number) => string): Feature | undefined {
  const x = nbt.num(be.x);
  const y = nbt.num(be.y);
  const z = nbt.num(be.z);
  if (x === undefined || y === undefined || z === undefined) return undefined;
  const block = short(blockAt(x, y, z));
  const parts: string[] = [];
  const name = componentText(be.CustomName).trim();
  if (name) parts.push(`'${clip(name, 40)}'`);

  if (be.front_text !== undefined || be.back_text !== undefined) {
    const front = signSide(be.front_text);
    const back = signSide(be.back_text);
    if (front) parts.push(`"${clip(front, 120)}"`);
    if (back) parts.push(`back: "${clip(back, 80)}"`);
  } else if (typeof be.Command === "string") {
    const auto = nbt.num(be.auto) === 1 ? "always active" : "needs redstone";
    parts.push(`${auto}: ${clip(be.Command, 160)}`);
  } else if (typeof be.LootTable === "string") {
    parts.push(`loot table ${short(be.LootTable)}`);
  } else if (be.Items !== undefined) {
    parts.push(items(nbt.list(be.Items)));
  } else if (be.item !== undefined) {
    parts.push(items([be.item])); // decorated pots, item frames on some versions, jukeboxes
  } else if (be.SpawnData !== undefined) {
    const entity = nbt.str(nbt.compound(nbt.compound(be.SpawnData)?.entity)?.id);
    if (entity) parts.push(`spawns ${short(entity)}`);
  }
  return { block, x, y, z, detail: parts.length ? parts.join(" ") : undefined };
}
