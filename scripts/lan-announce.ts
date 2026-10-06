// Java "LAN worlds" announcer for Wi-Fi play. Runs on the PC itself, not in Docker: Docker
// Desktop's network can't send multicast onto your Wi-Fi. Every 1.5 s it tells Java players on the
// home network about each world with Wi-Fi play on, the same way "Open to LAN" does, so the world
// shows up in their Multiplayer list without typing an address.
//
// It only asks the gatekeeper on this PC which Wi-Fi ports are in use (a server-list ping, like
// any Minecraft client). No secrets, changes nothing.
//
//   node scripts/lan-announce.ts            (scripts/install-lan-announcer.ps1 starts it at sign-in)

import dgram from "node:dgram";
import os from "node:os";
import { descriptionText, statusPing } from "../packages/mcproto/src/index.ts";

const PORTS = Array.from({ length: 10 }, (_, i) => 25570 + i);
const GROUP = "224.0.2.60"; // Minecraft's LAN discovery group and port
const GROUP_PORT = 4445;
const ANNOUNCE_MS = 1500;
const SCAN_MS = 10_000;

let worlds: { port: number; motd: string }[] = [];

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

/** Which Wi-Fi ports lead to a world right now (unused ports hang up, so they don't answer). */
async function scan(): Promise<void> {
  const found = await Promise.all(
    PORTS.map(async (port) => {
      try {
        const { status } = await statusPing("127.0.0.1", port, 1500);
        const first = descriptionText(status.description).split("\n")[0] ?? "";
        const name = first.replace(/^WorldSmith\s*·\s*/, "").replace(/\s*\(Wi-Fi\)\s*$/, "").trim();
        return { port, motd: name || "WorldSmith" };
      } catch {
        return undefined;
      }
    }),
  );
  const next = found.filter((w): w is { port: number; motd: string } => w !== undefined);
  if (JSON.stringify(next) !== JSON.stringify(worlds)) log("worlds", { worlds: next });
  worlds = next;
}

/** Home-network IPv4 addresses (skips Tailscale, WSL/Docker adapters, link-local). */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|Docker|Tailscale|Loopback|VirtualBox|VMware|NordLynx|VPN|WireGuard|OpenVPN|TAP-/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^169\.254\./.test(a.address) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue;
      out.push(a.address);
    }
  }
  return out;
}

const sockets = new Map<string, dgram.Socket>();

function socketFor(address: string): dgram.Socket {
  let s = sockets.get(address);
  if (s) return s;
  s = dgram.createSocket({ type: "udp4", reuseAddr: true });
  s.on("error", (err) => {
    log("socket_error", { address, error: err.message });
    s!.close();
    sockets.delete(address);
  });
  s.bind(0, address, () => {
    s!.setMulticastInterface(address);
    s!.setMulticastTTL(1); // stay on the home network
  });
  sockets.set(address, s);
  return s;
}

function announce(): void {
  const addresses = lanAddresses();
  for (const [address, s] of sockets) {
    if (!addresses.includes(address)) {
      s.close();
      sockets.delete(address);
    }
  }
  if (!worlds.length) return;
  for (const address of addresses) {
    const s = socketFor(address);
    for (const w of worlds) s.send(`[MOTD]${w.motd}[/MOTD][AD]${w.port}[/AD]`, GROUP_PORT, GROUP);
  }
}

log("started", { addresses: lanAddresses() });
await scan();
setInterval(() => void scan(), SCAN_MS);
setInterval(announce, ANNOUNCE_MS);
