// Web Push to the owner's installed portal (iOS 16.4+ home-screen PWA, Android, desktop).

import webpush, { type PushSubscription } from "web-push";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db.ts";

export interface PushMessage {
  title: string;
  body: string;
  /** Portal path to open when the notification is tapped. */
  url?: string;
  tag?: string;
}

export class Push {
  db: Db;
  publicKey: string;

  constructor(db: Db, dataDir: string, contactUrl: string) {
    this.db = db;
    const file = path.join(dataDir, "vapid.json");
    if (!existsSync(file)) {
      writeFileSync(file, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
    }
    const keys = JSON.parse(readFileSync(file, "utf8")) as { publicKey: string; privateKey: string };
    // The VAPID subject is the contact push services see; use the portal URL, not a personal email.
    webpush.setVapidDetails(contactUrl, keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
  }

  subscribe(sub: PushSubscription): void {
    this.db
      .prepare("INSERT OR REPLACE INTO push_subscriptions (endpoint, subscription, created_at) VALUES (?, ?, ?)")
      .run(sub.endpoint, JSON.stringify(sub), Date.now());
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n;
  }

  /** Best effort: never throws. Drops subscriptions the push service says are gone. */
  async notify(msg: PushMessage): Promise<number> {
    const rows = this.db.prepare("SELECT endpoint, subscription FROM push_subscriptions").all() as {
      endpoint: string;
      subscription: string;
    }[];
    let delivered = 0;
    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(JSON.parse(row.subscription) as PushSubscription, JSON.stringify(msg), {
            TTL: 600,
            urgency: "high",
          });
          delivered++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(row.endpoint);
          } else {
            console.error("push failed", status, (err as Error).message);
          }
        }
      }),
    );
    return delivered;
  }
}
