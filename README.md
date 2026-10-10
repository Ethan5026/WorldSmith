# WorldSmith

Describe a Minecraft world on your phone, approve Claude's plan, and friends can join a few minutes later.

- **Claude app** (custom connector): describe the world and refine the plan in chat.
- **Portal** (private PWA): approve builds, approve friends, choose the featured world.
- **Gatekeeper**: the one public address. It handles join requests, wake on join, and version help.
- **Worker**: one `itzg/minecraft-server` container per world, test-booted before going live.

Status: Phase 1 (server, friends, crossplay) and Phase 2 (Claude world builder) are done; Phase 3 (showcase content) is next. Start with [docs/HANDOFF.md](docs/HANDOFF.md).

## Layout

See the table in [docs/HANDOFF.md](docs/HANDOFF.md#4-architecture-as-built).

## Develop

Node 24 runs the TypeScript directly; `tsc` is only used for type checking.

```sh
pnpm install
pnpm test        # node:test
pnpm typecheck
```
