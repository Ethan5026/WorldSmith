// Small owner-editable settings (e.g. the public server address shown to invited friends).

import type { Db } from "./db.ts";

export const SETTING_KEYS = ["java_address", "bedrock_address"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export class Settings {
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  get(key: SettingKey): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  set(key: SettingKey, value: string | null): void {
    if (value === null || value === "") this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  all(): Partial<Record<SettingKey, string>> {
    return Object.fromEntries(SETTING_KEYS.map((k) => [k, this.get(k)]).filter(([, v]) => v !== undefined));
  }
}
