# apps/daemon/AGENTS.md

Follow the root `AGENTS.md` and `apps/AGENTS.md` first. This file records daemon-specific code organization and editing rules.

## Role

`apps/daemon` is the local Express + SQLite daemon and owns `/api/*` HTTP routes/SSE streams, the `od` CLI (`src/cli.ts`), project persistence, generated files, artifacts, media, skills, design systems, plugins, MCP, connector credentials, automation state, agent spawning, static serving, and the daemon sidecar entry under `sidecar/`.

The daemon is not a shared library for the web app. Do not import daemon private `src/` from `apps/web`; shared web/daemon contracts belong in `packages/contracts`.

## Source Layout

- `src/server.ts` is the composition root (services, middleware, route registration). Keep request/domain logic out unless the route is bootstrap-wide (`/api/health`, `/api/version`).
- `src/cli.ts` is the CLI composition root. Keep substantial command implementation in domain modules or focused `*-cli.ts` helpers. Do not edit generated `dist/` output.
- `src/routes/` holds domain route registrars. Legacy `src/*-routes.ts` files may remain until touched; move one to `src/routes/<domain>.ts` only when the move is small and the change is already about that domain.
- `src/http/` owns shared HTTP helpers, error/result adapters, origin checks, and mounting utilities. `src/services/` owns Express-free reusable services.
- `src/runtimes/` owns agent runtime definitions (`defs/`), spawning, parser integration, executable discovery, and env shaping. `src/prompts/` owns daemon-side prompt construction; mirrored BYOK/API wording lives in `packages/contracts/src/prompts/`.
- `src/plugins/`, `src/connectors/`, `src/registry/`, `src/research/`, `src/media-adapters/`, `src/live-artifacts/`, `src/storage/`, `src/critique/`, `src/media/`, `src/artifacts/` own their domains. Prefer adding code inside the existing domain folder before creating a new top-level folder.
- Vela invocations go through `src/integrations/vela-command.ts` (shared binary resolver + env). Do not add a second content-addressed drive implementation or direct hub HTTP client.
- `tests/` contains daemon tests, roughly parallel to `src/`.

## Top-Level `src/` Hygiene

`src/` still has 100+ top-level files; do not add more. New domain code belongs in a domain folder, new routes in `src/routes/`, new runtime/stream-parser code in `src/runtimes/` (definitions in `defs/`), new provider glue in the domain folder or `src/integrations/<provider>.ts`, new persistence in `src/storage/`, new prompts in `src/prompts/`. Avoid new general-purpose helpers; put the helper with its owner.

Still-true move targets (move only what helps the current change; never mix a broad move with behavior changes):

- `import-export-routes.ts`, `mcp-routes.ts` -> `src/routes/` (`project-routes.ts` already moved).
- `copilot-stream.ts`, `agents.ts`, `run-*`, `agent-*` -> `src/runtimes/` (or a future `src/runs/`).
- `inline-assets.ts`, `lint-artifact.ts` -> `src/artifacts/`.
- `memory*.ts`, `routines.ts`, prompt/handoff helpers -> keep with their domain.

## Route Structure

```ts
import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';

export interface RegisterExampleRoutesDeps extends RouteDeps<'http' | 'paths'> {
  example: ExampleService;
}

export function registerExampleRoutes(app: Express, ctx: RegisterExampleRoutesDeps): void {
  // app.get/post/patch/delete(...)
}
```

- One exported registrar per domain. Declare a narrow `Register*RoutesDeps` (only the `ServerContext` keys used + explicit domain service interfaces, no `any`); add it to `src/route-context-contract.ts` when covered by the server context assertion.
- Register from the matching semantic section in `server.ts`. Reuse `src/http/` helpers; do not invent another error envelope. Validate near the route boundary, push reusable behavior into services.
- Shared DTOs/error shapes go in `packages/contracts` (never daemon-only Node/SQLite/Express/fs types); never restate response shapes by hand. Daemon data paths derive from `RUNTIME_DATA_DIR` per the root data contract.

## CLI and Surface Parity

User-facing capabilities close the loop in one change: contract type + daemon route + web surface if applicable + `od` subcommand with `--json` (and `--prompt-file <path|->` for long prompts).

## Runtime and Agent Changes

- Parser changes belong beside the matching `src/runtimes/` stream helper with focused parser tests; runtime definition changes belong in `src/runtimes/defs/`.
- Replay a `mocks/` trace instead of burning provider budget (see root `AGENTS.md`).
- Preserve Claude stream-json bookkeeping in `src/runtimes/claude-stream.ts` + `server.ts`: never close stdin on a `tool_use` stop reason (mid-tool pause, not turn end).

## Tests

- Tests live under `apps/daemon/tests/`, never under `src/`. Cheapest layer first: pure helper test → route-level Vitest with `startServer` → broader integration only when necessary. Bug fixes get a red spec first.
- Native-module failures (`better-sqlite3`): rebuild for the active Node version before blaming the code.

## Commands

```bash
pnpm --filter @open-design/daemon typecheck
pnpm --filter @open-design/daemon test
pnpm --filter @open-design/daemon build
pnpm exec vitest run -c vitest.config.ts tests/<file>.test.ts   # from apps/daemon/
pnpm tools-dev run web --daemon-port <port> --web-port <port>   # runtime validation, not package aliases
```
