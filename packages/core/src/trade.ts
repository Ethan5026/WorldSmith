// Villager traders with custom offers (the `trader` build op, and the Lucky Bazaar in game kits).
// Offers are plain vanilla NBT, so Bedrock players trade through Geyser's normal trading screen.
//
// Verified on Paper 26.2: VillagerData is {profession,level,type}; an offer is
// {buy:{id,count},buyB?,sell:{id,count,components},maxUses,rewardExp,xp,priceMultiplier}; a wandering
// trader with DespawnDelay:0 never leaves; enchantments are a plain id→level map.

import { z } from "zod";
import { snbtString } from "./snbt.ts";

const Id = z.string().regex(/^(minecraft:)?[a-z0-9_]+$/);

export const TradeCost = z.object({ id: Id, count: z.number().int().min(1).max(64).default(1) });
export type TradeCost = z.infer<typeof TradeCost>;

export const TradeItem = z.object({
  id: Id,
  count: z.number().int().min(1).max(64).default(1),
  name: z.string().max(40).optional(),
  color: z.string().max(20).optional().describe("Name color, e.g. gold"),
  lore: z.array(z.string().max(60)).max(4).optional(),
  enchantments: z.record(z.string().regex(/^(minecraft:)?[a-z_]+$/), z.number().int().min(1).max(255)).optional(),
  potion: z.string().regex(/^(minecraft:)?[a-z_]+$/).optional().describe("For potions and tipped arrows, e.g. long_fire_resistance or strong_strength"),
  unbreakable: z.boolean().optional(),
  components: z.string().max(1000).optional().describe('Extra raw SNBT components (advanced), e.g. "minecraft:custom_data":{x:1b}'),
});
export type TradeItem = z.infer<typeof TradeItem>;

export const Trade = z.object({
  buy: TradeCost,
  buyB: TradeCost.optional(),
  sell: TradeItem,
  maxUses: z.number().int().min(1).max(99999).default(9999),
});
export type Trade = z.infer<typeof Trade>;

export const PROFESSIONS = [
  "armorer", "butcher", "cartographer", "cleric", "farmer", "fisherman", "fletcher",
  "leatherworker", "librarian", "mason", "shepherd", "toolsmith", "weaponsmith",
] as const;
export const Profession = z.enum([...PROFESSIONS, "wandering"]);
export type Profession = z.infer<typeof Profession>;

const ns = (id: string) => (id.includes(":") ? id : `minecraft:${id}`);

/** {text:"…",color:"…",italic:false}: item names and lore aren't italic unless asked. */
export function itemText(text: string, color?: string): string {
  return `{text:${snbtString(text)}${color ? `,color:${snbtString(color)}` : ""},italic:false}`;
}

export function itemComponents(item: TradeItem): string[] {
  const c: string[] = [];
  if (item.name) c.push(`"minecraft:custom_name":${itemText(item.name, item.color)}`);
  if (item.lore?.length) c.push(`"minecraft:lore":[${item.lore.map((l) => itemText(l, "gray")).join(",")}]`);
  if (item.enchantments && Object.keys(item.enchantments).length) {
    c.push(`"minecraft:enchantments":{${Object.entries(item.enchantments).map(([k, v]) => `${snbtString(ns(k))}:${v}`).join(",")}}`);
  }
  if (item.potion) c.push(`"minecraft:potion_contents":{potion:${snbtString(ns(item.potion))}}`);
  if (item.unbreakable) c.push(`"minecraft:unbreakable":{}`);
  if (item.components) c.push(item.components);
  return c;
}

export function itemSnbt(item: TradeItem): string {
  const c = itemComponents(item);
  return `{id:${snbtString(ns(item.id))},count:${item.count}${c.length ? `,components:{${c.join(",")}}` : ""}}`;
}

const costSnbt = (c: TradeCost) => `{id:${snbtString(ns(c.id))},count:${c.count}}`;

/** One offer. Prices never drift: no demand, no price multiplier, no villager XP. */
export function offerSnbt(t: Trade): string {
  return `{buy:${costSnbt(t.buy)},${t.buyB ? `buyB:${costSnbt(t.buyB)},` : ""}sell:${itemSnbt(t.sell)},maxUses:${t.maxUses},rewardExp:0b,xp:0,priceMultiplier:0f,demand:0}`;
}

/** Yaw that makes an entity look toward a horizontal direction. */
export const YAW = { south: 0, west: 90, north: 180, east: -90 } as const;

export interface TraderSpec {
  profession: Profession;
  name: string;
  color?: string;
  facing: keyof typeof YAW;
  tags?: string[];
  trades: Trade[];
}

/** Entity type and NBT for a trader that stays put, can't be hurt, never despawns and never restocks badly. */
export function traderEntity(t: TraderSpec): { entity: string; nbt: string; offers: string[] } {
  const offers = t.trades.map(offerSnbt);
  const common = [
    `Tags:[${(t.tags ?? []).map(snbtString).join(",")}]`,
    "NoAI:1b",
    "Invulnerable:1b",
    "PersistenceRequired:1b",
    "Silent:1b",
    `Rotation:[${YAW[t.facing]}f,0f]`,
    `CustomName:{text:${snbtString(t.name)},color:${snbtString(t.color ?? "gold")},bold:1b}`,
    "CustomNameVisible:1b",
    `Offers:{Recipes:[${offers.join(",")}]}`,
  ];
  if (t.profession === "wandering") return { entity: "minecraft:wandering_trader", nbt: `{${[...common, "DespawnDelay:0"].join(",")}}`, offers };
  return {
    entity: "minecraft:villager",
    nbt: `{${[...common, `VillagerData:{profession:${snbtString(ns(t.profession))},level:5,type:"minecraft:plains"}`, "Xp:0"].join(",")}}`,
    offers,
  };
}
