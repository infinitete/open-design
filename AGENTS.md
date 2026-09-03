# AGENTS.md

Read this first. After entering `apps/`, `packages/`, `tools/`, `e2e/`, or `.github/`, read that layer's `AGENTS.md` and follow it. Do not copy module details back here.

Key docs: `README.md`, `QUICKSTART.md`, `CONTRIBUTING.md`, `docs/architecture.md`, `docs/skills-protocol.md`, `docs/agent-adapters.md`, `docs/code-review-guidelines.md`, `specs/current/ci.md` (required before changing CI scope routing).

## Stack

pnpm monorepo (`apps/*`, `packages/*`, `shells/*`, `tools/*`, `e2e`). No `opencode.json` / `.opencode` config.

- `apps/web`: Next.js 16 App Router + React 18. `apps/daemon`: Express + SQLite daemon and `od` bin (`apps/daemon/src/cli.ts`, `src/server.ts`); owns `/api/*`, agent spawning, skills, design systems, artifacts. `apps/desktop`: Electron shell, discovers web URL via sidecar IPC only. `apps/packaged`: thin packaged entry (`od://` glue). `apps/landing-page`: standalone static Astro site, must not import product runtime.
- `packages/contracts`: pure-TS web/daemon DTOs. `packages/sidecar-proto`: business protocol; `packages/sidecar`: generic runtime; `packages/platform`: generic OS process primitives. `packages/standalone`: shell-neutral distribution contract. `shells/terminal`: official Node carrier, consumes standalone contracts only.
- Content dirs: `skills/` (functional skills), `design-templates/` (rendering catalog), `design-systems/` (brand `DESIGN.md` packages), `craft/`, `plugins/`, `mocks/` (replay mock CLIs, see `mocks/README.md`). Do not restore `apps/nextjs` or `packages/shared`.

## Environment

- Node `~24`, `pnpm@10.33.2` via Corepack (`package.json#engines`, `packageManager`). Windows native is best-effort; `corepack enable` fails with EPERM there (use `npm i -g pnpm@10.33.2`), and `better-sqlite3` compiles from source (~2 min, needs VS Build Tools 2022+).
- TypeScript-first for all project-owned entrypoints/modules/scripts/tests. New `.js`/`.mjs`/`.cjs` needs a generated/vendor/compat reason and must pass `pnpm guard`.
- Run `pnpm install` after manifest, workspace-layout, bin/link, or command-entry changes.

## Lifecycle (only entrypoint)

- `pnpm tools-dev` is the only local lifecycle entry. Never add/restore root `dev`, `dev:all`, `daemon`, `preview`, `start`, `build`, or `test` aliases; build/test stay package-scoped, e2e stays in `e2e/`.
- Ports via flags only: `--daemon-port` / `--web-port`. Env is `OD_PORT` (web proxy target) + `OD_WEB_PORT` (listener); never `NEXT_PORT`.
- `pnpm tools-dev run web` = foreground daemon+web (dev/e2e server flow). `pnpm tools-dev` = background daemon+web+desktop.

## Verify before handing off

- Minimum: `pnpm guard` + `pnpm typecheck` + package-scoped tests/builds for what changed (e.g. `pnpm --filter @open-design/daemon test`).
- `pnpm guard` enforces what agents get wrong: `tests/` sibling to `src/` (no `*.test.ts(x)` under `src/`, `scripts/` test-free), exact dep specs (`workspace:*` or `x.y.z`), web import isolation, e2e layout, TS-only residual JS, tools top-level allowlist, token/style policy.
- Parser/stream changes (`apps/daemon/src/runtimes/*-stream.ts`, `json-event-stream.ts`, etc.): replay a `mocks/` trace via PATH overlay instead of burning provider budget: `export PATH="$PWD/mocks/bin:$PATH" OD_MOCKS_TRACE=<id> OD_MOCKS_NO_DELAY=1`.
- Lockfile changes affecting packaging need `pnpm nix:update-hash`; `nix.yml` and `docker-image.yml` are standalone, not part of `ci.yml` merge gate.

## Boundaries (`pnpm guard` blocks most of these)

- `apps/web` must not import `apps/daemon/src/**`, `packages/sidecar`, `packages/sidecar-proto`, or `packages/platform`. Web/daemon integration goes through HTTP `/api/*` + `packages/contracts`.
- Keep `packages/contracts` pure TS: no Next.js/Express/Node fs-process/browser/SQLite/daemon/sidecar imports. New shared DTOs, SSE unions, error/task shapes go here first.
- App business logic must not import sidecar packages or branch on `mode`/`namespace`/`ipc`/`source`. Keep sidecar awareness in `apps/<app>/sidecar` or the desktop wrapper.
- Stamps have exactly five fields: `app`, `mode`, `namespace`, `ipc`, `source`. Orchestration (`tools-dev`, `tools-pack`, launchers) must call `sidecar-proto`/`sidecar`/`platform` primitives; never hand-build `--od-stamp-*` args or process-scan regexes.
- Packaged data/log/runtime/cache paths are namespace-scoped and must never embed ports. POSIX IPC: `/tmp/open-design/ipc/<namespace>/<app>.sock`. Default runtime files: `<root>/.tmp/<source>/<namespace>/...`, git-ignored.
- Cross-app/cross-runtime consistency checks belong in `e2e/tests/`, never by importing another app's private `src/`.

## Daemon data directory contract (only source of truth)

`apps/daemon/src/server.ts` resolves `OD_DATA_DIR` once into `RUNTIME_DATA_DIR`. All daemon-owned data (SQLite, artifacts, config, memory, MCP tokens, automation/plugin/connector state, generated files, agent homes, sandbox logs) derives from it. Exceptions: imported-folder projects use `metadata.baseDir`; `OD_MEDIA_CONFIG_DIR` overrides `media-config.json` only; `OD_LEGACY_DATA_DIR` is a migration source only; `CODEX_HOME`-style tool homes are integration inputs, not data roots. `tools-dev --namespace` alone does not isolate data — pass `OD_DATA_DIR` explicitly. Never invent new data-path conventions or restate concrete paths elsewhere; if the rule is missing, block and ask a maintainer. Do not reuse legacy fallbacks (`defaultRegistryRoots()`, cwd-relative defaults, `openDatabase()` without the resolved root).

## New capability closure (UI + CLI in one PR)

Every user-facing capability ships web UI **and** `od` CLI together calling the same `/api/*` endpoint: contract type in `packages/contracts/src/api/` + daemon route (`*-routes.ts` or `src/routes/`) + `apps/web/src/` surface + `od <cap>` subcommand in `apps/daemon/src/cli.ts` via `SUBCOMMAND_MAP`, with `--json` and `--prompt-file <path|->`. Staging one surface now and the other later is a regression.

## e2e / Playwright

- Read `e2e/AGENTS.md` before touching `e2e/`. Layout: `specs/*.spec.ts` (core chains) · `tests/*.test.ts` (hotspots; `tests/scripts/` for root-script contracts) · `ui/*.test.ts` flat Playwright only · `lib/tools-dev/` neutral lifecycle (no Vitest/Playwright imports) + `lib/playwright/suite.ts` / `lib/vitest/suite.ts` composition.
- UI tests import `test`/`expect` from `@/playwright/suite` (type-only `@playwright/test` imports OK). One isolated tools-dev daemon/web/data root per worker; never add shared-runtime mode; `--workers=1` when constrained. Never hand-spawn `tools-dev` in a case; use the suite harness. Order independence is the contract: no `describe.serial`, each test does its own setup.
- Bug fixes: lead with a red spec at the cheapest layer that sees the symptom (e2e Vitest at daemon HTTP boundary → app Vitest → Playwright UI), keep the spec in scope, link `Fixes #N`.

## GitHub / releases (pointers, not copies)

- Read `.github/AGENTS.md` before touching workflows/scripts/actions. `ci.yml` decides; `comment`/`autofix`/`report` atoms execute via `handoff.py` contracts. Never add `foo.comment.atom.yml`-style follow-ons without using the existing atoms.
- Read `specs/current/ci.md` before changing planner confidence/routing/omission in `.github/config/scopes.json` + `scopes.py`.
- Read `tools/pack/AGENTS.md` updater section + `tools/pack/CACHE.md` before touching updater code, installer identity, updater UI, or cache keys. Channel identities stay distinct (`Open Design` / `Beta` / `Prerelease` / `Preview`); stable gates on prerelease only.

## Commits / PRs

- No `Co-authored-by` or co-author trailers.
- One concern per PR. Title imperative + scope (`add dating-web skill`, `fix daemon SSE backpressure`). Fill every section of `.github/pull_request_template.md`; UI changes need entry-point screenshots; bug fixes need the red spec + red-on-main/green-on-branch note. Non-trivial features need an issue first. Review bar: `docs/code-review-guidelines.md` (this file wins on conflict).

## Common commands

```bash
corepack enable && pnpm install
pnpm tools-dev run web --daemon-port <port> --web-port <port>
pnpm tools-dev status --json && pnpm tools-dev logs --json && pnpm tools-dev check
pnpm guard && pnpm typecheck
pnpm --filter @open-design/daemon test && pnpm --filter @open-design/web test
pnpm --filter @open-design/daemon build   # rebuilds od CLI (dist/cli.js) for OD_BIN media checks
pnpm tools-serve start updater            # deterministic updater fixture service
```
