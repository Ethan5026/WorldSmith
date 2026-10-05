# Phase 0 spikes

| Spike | Status | Evidence |
|---|---|---|
| A: worlds on the laptop | ✅ pass | Paper 26.2 b129 (stable): `Done (13.562s)!`, ~2.5 GiB, protocol 776. Paper 26.3 b152 (beta): `Done (17.511s)!`, ~2.5 GiB, protocol 777. Docker Desktop has 8 GiB (WSL default). Image `itzg/minecraft-server:java25` is 870 MB. |
| B: reachability via playit | ⏳ needs owner | Needs a playit.gg account and an agent secret. |
| C: Claude connector | 🟡 infra up, awaiting owner connect | `worldsmith` node in the owner's tailnet (`tail072963.ts.net`), HTTPS + Funnel enabled. Funnel `:443` → public listener: OAuth metadata 200, portal paths 404, `/mcp` without token 401. OAuth with owner approval (match code) has e2e tests (`apps/hub/test/connector-flow.test.ts`). Remaining: add the connector in claude.ai and call `world_status` from the phone. |
| D: portal on phone | 🟡 portal up on tailnet | `:8443` is tailnet-only (serve config: Funnel on 443 only). `/api/me` identifies "Ethan Gruening" from Tailscale identity headers; `/api/world` live (Paper 26.2, 2.7 ms). Remaining: phone joins the tailnet, Add to Home Screen, enable push, test notification. |
| E: gatekeeper | ✅ pass (real client) | `probe.ts` against live servers: status + pong OK; Login Start gets Encryption Request (0x01). Gatekeeper: allowed → piped; unknown → "Request sent"; wrong protocol → version help; garbage → dropped. **Real client (Ethan5026):** a 26.3 client got the version-help kick (protocol 777 vs 776); a 26.2 client was piped through, online-mode auth succeeded (UUID 01cc1dfd… matches Mojang), and joined the world. |

## How to rerun

```sh
docker compose -f spikes/spike-a-worlds/compose.yaml up -d paper-262        # 127.0.0.1:25601
node spikes/spike-e-gatekeeper/probe.ts 127.0.0.1 25601                     # direct to server
GK_ALLOW=YourName GK_OWNER=Ethan node spikes/spike-e-gatekeeper/gatekeeper.ts   # 127.0.0.1:25599
node spikes/spike-e-gatekeeper/probe.ts 127.0.0.1 25599 SomeFriend          # → "Request sent" kick
docker compose -f spikes/spike-a-worlds/compose.yaml down -v                # cleanup
```

## Design notes learned

- **Security (fixed):** with `TS_USERSPACE=true`, tailscaled forwards any inbound tailnet connection to the matching 127.0.0.1 port. A tailnet peer could hit `100.x:3000` directly, forge `Tailscale-User-Login`, and get owner access to the portal. Fixed by running the `ts` container with a kernel tun (`TS_USERSPACE=false`, `NET_ADMIN`, `/dev/net/tun`). `scripts/security-check.sh` now guards this and 11 other exposure checks.

- A container using `network_mode: service:ts` loses networking when `ts` restarts (502 from serve). Fixed with `depends_on: {ts: {restart: true}}`.
- Claude Code's WebFetch runs from this laptop, which is on the tailnet. It can't prove what the public internet sees; test Funnel exposure from a phone on cellular with Tailscale off.

- Keep world data in **named volumes** (WSL ext4), not Windows bind mounts. Bind mounts through Docker Desktop are slow for region-file I/O.
- The status `description` from vanilla/Paper is a plain string when MOTD is plain text. Parse it as string or component.
- Echoing the *world's* protocol in status makes a mismatched client show the version in red in the server list. The gatekeeper also kicks with launcher instructions, which is friendlier than vanilla's "Outdated client".
- itzg sets `-Xms = -Xmx`, so RSS is roughly heap + 0.5 GiB from the start. Budget memory per world from `MEMORY`, not from measured use.
