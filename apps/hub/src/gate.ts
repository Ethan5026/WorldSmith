// Join decisions for the gatekeeper. The gatekeeper (internet-facing, no secrets, no database)
// asks over a Unix socket; everything that matters is decided here.

import express from "express";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { z } from "zod";
import { isValidUsername, type TextComponent } from "@worldsmith/mcproto";
import { audit, type Db } from "./db.ts";
import type { AccessService } from "./access.ts";
import type { WorldService } from "./worlds.ts";
import type { Push } from "./push.ts";

export type LoginDecision = { action: "pipe"; backend: string } | { action: "kick"; reason: TextComponent };

export interface StatusAnswer {
  versionName: string;
  protocol: number;
  motd: TextComponent;
  players: { online: number; max: number };
}

const PLAYING_NOTIFY_EVERY_MS = 30 * 60 * 1000;
const lines = (...parts: TextComponent[]): TextComponent => ({ text: "", extra: parts });

export class GateService {
  db: Db;
  access: AccessService;
  worlds: WorldService;
  push: Push;
  ownerName: string;
  private lastPlayingNotice = new Map<string, number>();

  constructor(db: Db, access: AccessService, worlds: WorldService, push: Push, ownerName: string) {
    this.db = db;
    this.access = access;
    this.worlds = worlds;
    this.push = push;
    this.ownerName = ownerName;
  }

  async status(clientProtocol: number): Promise<StatusAnswer> {
    const slug = this.worlds.featuredSlug();
    if (!slug) {
      return {
        versionName: "WorldSmith",
        protocol: clientProtocol,
        motd: lines({ text: "WorldSmith ", color: "gold", bold: true }, { text: "· no world is open right now", color: "gray" }),
        players: { online: 0, max: 0 },
      };
    }
    const w = await this.worlds.view(slug);
    const stateLine: Record<string, TextComponent> = {
      online: { text: w.players.online > 0 ? `Online · ${w.players.online} playing` : "Online · join to play", color: "green" },
      waking: { text: "Waking up… join again in a moment", color: "yellow" },
      asleep: { text: "Asleep · join to wake it up", color: "aqua" },
      missing: { text: "Being set up", color: "gray" },
      error: { text: "Having trouble starting", color: "red" },
    };
    return {
      versionName: w.version,
      protocol: w.protocol,
      motd: lines({ text: "WorldSmith ", color: "gold", bold: true }, { text: `· ${w.name}\n`, color: "white" }, stateLine[w.state]!),
      players: w.players,
    };
  }

  async login(input: { protocol: number; username: string; claimedUuid?: string; host: string }): Promise<LoginDecision> {
    const slug = this.worlds.featuredSlug();
    const kick = (reason: TextComponent): LoginDecision => ({ action: "kick", reason });
    if (!slug) return kick({ text: `No world is open right now. Ask ${this.ownerName} to open one.`, color: "yellow" });
    if (!isValidUsername(input.username)) return kick({ text: "That isn't a valid Minecraft username.", color: "red" });

    const w = await this.worlds.view(slug);
    if (input.protocol !== w.protocol) {
      audit(this.db, "gate_wrong_version", { name: input.username, protocol: input.protocol, want: w.protocol });
      return kick(
        lines(
          { text: `${w.name} runs Minecraft ${w.version}\n\n`, color: "gold", bold: true },
          { text: "In the Minecraft Launcher: Installations → New installation →\n", color: "white" },
          { text: `pick version ${w.version}, then join again.`, color: "white" },
        ),
      );
    }

    const player = this.access.findApproved(input.username, input.claimedUuid);
    if (!player) {
      if (this.access.isDenied(input.username)) return kick({ text: "You don't have access to this server.", color: "red" });
      const { request, notify } = this.access.recordAttempt(input.username, input.claimedUuid, slug);
      if (notify) {
        void this.push.notify({
          title: `${input.username} wants to join`,
          body: `They tried to join ${w.name}. Tap to approve or decline.`,
          url: "/#requests",
          tag: `join-${request.id}`,
        });
      }
      return kick(
        lines(
          { text: "Request sent! ", color: "green", bold: true },
          { text: `${this.ownerName} has been asked to let you in.\n\n`, color: "white" },
          { text: "Try joining again once they approve.", color: "gray" },
        ),
      );
    }

    if (!this.access.canJoin(player, slug)) {
      // A friend, but this world has a guest list they're not on: ask the owner for this world.
      const { request, notify } = this.access.recordAttempt(player.name, input.claimedUuid, slug);
      if (notify) {
        void this.push.notify({
          title: `${player.name} wants to join ${w.name}`,
          body: `${w.name} is invite-only and they're not on its list. Tap to let them in.`,
          url: "/#requests",
          tag: `join-${request.id}`,
        });
      }
      return kick(
        lines(
          { text: `You're not on the list for ${w.name} yet.\n\n`, color: "yellow", bold: true },
          { text: `${this.ownerName} has been asked to add you.`, color: "white" },
        ),
      );
    }

    if (player.role !== "owner" && this.access.worldAccess(slug).onlyWithMe) {
      const ownerName = this.access.owner()?.name;
      const online = w.state === "online" ? await this.worlds.onlinePlayers(slug).catch(() => [] as string[]) : [];
      if (!ownerName || !online.some((n) => n.toLowerCase() === ownerName.toLowerCase())) {
        return kick(
          lines(
            { text: `${w.name} is only open when ${this.ownerName} is playing.\n\n`, color: "yellow", bold: true },
            { text: "Try again when they're on.", color: "white" },
          ),
        );
      }
    }

    if (w.state === "online") {
      this.notifyPlaying(player.name, player.role, w.name, slug);
      audit(this.db, "gate_pipe", { name: player.name, slug });
      return { action: "pipe", backend: w.backend };
    }
    if (w.state === "missing") return kick({ text: `${w.name} isn't set up yet.`, color: "yellow" });
    if (w.state === "error") return kick({ text: `${w.name} is having trouble starting. ${this.ownerName} has been told.`, color: "red" });
    if (w.state === "asleep") {
      await this.worlds.start(slug, `woken by ${player.name}`);
      this.notifyPlaying(player.name, player.role, w.name, slug, "woke up");
    }
    return kick(
      lines(
        { text: `Waking up ${w.name}…\n\n`, color: "yellow", bold: true },
        { text: "It takes about a minute. Join again shortly.", color: "white" },
      ),
    );
  }

  /** The owner chose quiet "X is playing Y" notifications when friends play without them. */
  private notifyPlaying(name: string, role: string, worldName: string, slug: string, verb = "is playing"): void {
    if (role === "owner") return;
    const key = `${name}:${slug}`;
    const last = this.lastPlayingNotice.get(key) ?? 0;
    if (Date.now() - last < PLAYING_NOTIFY_EVERY_MS) return;
    this.lastPlayingNotice.set(key, Date.now());
    void this.push.notify({ title: "WorldSmith", body: `${name} ${verb} ${worldName}`, url: "/", tag: `playing-${key}` });
  }
}

const LoginInput = z.object({
  protocol: z.number().int(),
  username: z.string().max(64),
  claimedUuid: z.string().max(40).optional(),
  host: z.string().max(300),
});

/** Gatekeeper ↔ hub API on a Unix socket in a shared volume (never on a network). */
export function listenGate(gate: GateService, socketPath: string): void {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));
  app.post("/gate/status", async (req, res) => {
    try {
      res.json(await gate.status(Number(req.body?.protocol ?? 0)));
    } catch (err) {
      console.error("gate status failed", err);
      res.status(500).json({ error: "status unavailable" });
    }
  });
  app.post("/gate/login", async (req, res) => {
    try {
      res.json(await gate.login(LoginInput.parse(req.body)));
    } catch (err) {
      console.error("gate login failed", err);
      res.json({ action: "kick", reason: { text: "The server is having trouble. Try again in a minute.", color: "red" } });
    }
  });
  if (existsSync(socketPath)) unlinkSync(socketPath);
  app.listen(socketPath, () => {
    chmodSync(socketPath, 0o660);
    console.log(`gate socket listening on ${socketPath}`);
  });
}
