# WorldSmith: working rules

Read **docs/HANDOFF.md** first: it covers the current state, what's next, how to deploy, and traps already found. Read **docs/builder-notes.md** before building anything in-game.

**Owner rules:**
- **In-world changes are instant.** Claude may change anything inside a world without asking.
- **Portal-only actions:** letting new people in, deleting worlds, and approving new worlds need the owner's portal tap. Keep them blocked in MCP.
- **Bedrock plans** must list the Java/Bedrock differences and ask for texture and behavior priorities before approval.
- **Secrets:** never print or paste anything from `deploy/.env`.
- **Tailscale:** only the owner's tailnet (`tail072963.ts.net`).
- **Maps:** never bypass bot protection on map sites.

**Engineering:**
- **Code style:** Node 24 runs TypeScript directly, so use erasable syntax only and `.ts` imports. Code is pnpm workspaces, zod v4 and `node:test`.
- **Before committing:**
  - `pnpm typecheck && pnpm test` (with `set -o pipefail`); commit only on `ℹ fail 0`.
  - Commit as you go and push to `phase-1`.
- **Deploying:** `docker compose -f deploy/compose.yaml -f deploy/compose.dev.yaml --profile hub --profile worker up -d --build <services>`. When the gatekeeper changes, always include `gatekeeper playit geyser`.
- **The live box is the Ubuntu mini PC** (`gru-server`, `192.168.40.46`, user `gruman`, repo `~/repos/WorldSmith`). The old Windows laptop is a stopped rollback copy: never start the stack there.
  - Run the hub's internals with `docker compose -f deploy/compose.yaml exec -T hub node --input-type=module - < script` (the container's rootfs is read-only, so pipe scripts in).
  - Wi-Fi play announcer: `systemctl --user status worldsmith-lan-announce`.
- **Communication:** the owner works from their phone. Explain results in plain language and say what they should try.
