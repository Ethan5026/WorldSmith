# WorldSmith

Describe a Minecraft world on your phone, approve Claude's plan, and friends can join a few minutes later.

- **Claude app** (custom connector): describe the world and refine the plan in chat.
- **Portal** (private PWA): approve builds, approve friends, choose the featured world.
- **Gatekeeper**: the one public address. It handles join requests, wake on join, and version help.
- **Worker**: one `itzg/minecraft-server` container per world, test-booted before going live.

Status: Phase 0 (risk spikes). See [docs/spikes.md](docs/spikes.md) and [docs/feasibility.md](docs/feasibility.md).

## Layout

```
packages/mcproto/   Minecraft handshake/status/login codec (tested against live 26.2/26.3 servers)
spikes/             Phase 0 experiments (spike-a-worlds, spike-e-gatekeeper)
docs/               feasibility research, spike log
```

## Develop

Node 24 runs the TypeScript directly; `tsc` is only used for type checking.

```sh
pnpm install
pnpm test        # node:test
pnpm typecheck
```
