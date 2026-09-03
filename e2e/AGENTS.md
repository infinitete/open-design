# e2e/AGENTS.md

Follow the root `AGENTS.md` first. This package owns user-level end-to-end smoke tests and Playwright UI automation only.

Coverage posture and intentional gaps: `docs/testing/e2e-coverage/status.md`.

## Directory layout

- `specs/*.spec.ts`: small set of long-running core capability chains (dialog generation, Orbit, packaged runtime) for PR/release gating. Expand only when a core capability deserves always-on signal.
- `tests/*.test.ts`: broader hotspot checks spanning app/package/resource boundaries. `tests/scripts/` covers root operational scripts (root `scripts/` is test-free per `pnpm guard`); keep fixtures hermetic and runnable through e2e Vitest.
- `ui/*.test.ts`: flat Playwright files only. No subdirectories, TSX, Vitest, jsdom, or Testing Library under `ui/`.
- `resources/`: flat declarative TS resources. `scripts/playwright.ts`: artifact cleanup only, must not wrap `playwright test`.
- `lib/tools-dev/`: framework-neutral runtime lifecycle (namespaces, ports, `tools-dev --json`, start/stop). Must not import Vitest or Playwright.
- `lib/playwright/suite.ts`: worker-scoped tools-dev fixture + `baseURL` + failure attachments. `lib/vitest/suite.ts`: same for Vitest (`createSmokeSuite(...).with.*` composes `toolsDev`, `env`, `pathEntry` — never hand-roll save/restore or fixed ports in specs).
- `lib/timeouts.ts`: `T.short/medium/long/xlong` (CI-scaled). Use instead of hardcoded milliseconds.
- `lib/fake-agents.ts` (`createFakeAgentRuntimes` + `agentCliEnv`) and `lib/playwright/mock-factory.ts` (`applyStandardMocks`): the two approved agent-availability sources (below).

## Spec and test model

- `specs/` read as business workflows; `tests/` pin hotspots that fell out of a spec. Infrastructure checks may precede a spec, but most tests should be extracted after a spec proves the hotspot matters. Merge, split, or delete tests as capabilities evolve.
- Non-UI smoke stays pure inspect: daemon/web APIs, sidecar IPC, `inspect`, logs, reports, screenshots — no Playwright.
- External services use temporary server-level mocks. No real API keys, provider accounts, or UI-level route patching for core smoke.
- Every atomic suite runs in an isolated namespace. Success keeps curated reports only; failure preserves scratch, logs, mock requests, screenshots, and report pointers.

## UI test stability rules

The full pool shards every non-visual `ui` file across workers with one tools-dev runtime per worker, so two hazards hide from narrow runs: within-file interleaving and cross-file carry-over through worker-scoped daemon state. New and repaired UI tests must hold:

- **Order independence.** Each test does its own complete setup; any contiguous subset passes with the rest absent. No `describe.serial` (atomic per shard + skip-after-failure floors pool wall time).
- **Know your state axis.** Daemon/data root is shared across a worker's tests; localStorage seeds and `applyStandardMocks` interception are per-test. Match the file's existing model (real-daemon specs reset config and create real projects; entry-surface specs route-mock).
- **Hermetic agents.** Route-mocked specs intercept `/api/agents` JSON **and** `?stream=1` SSE with terminal `done` (an incomplete stream gets rejected and availability clears). Real-daemon specs use `createFakeAgentRuntimes` + `agentCliEnv`. A spec passing only where a real CLI is installed is broken.
- **Settle async surfaces.** Late fetches can remount UI and reset transient state; require observed state to survive a settle window instead of trusting the first observation.
- **Enabled is not ready.** Streamed preconditions (e.g. agent availability over `/api/agents` SSE) gate submits independently of control state — wait for the signal, not `toBeEnabled`.
- **Never force-click into gated containers.** `inert` swallows force-clicks silently and `isVisible()` is true inside collapsed reveals; use reveal-aware helpers and actionability as the readiness signal.
- **Browser witnesses only at cross-layer boundaries.** Extend an existing workflow that already owns the setup instead of repeating full setup to reassert a lower-layer invariant.
- **Retry-only green is a signal.** CI retries once on a fresh worker runtime; a first-attempt-only failure means carry-over, startup instability, or an async race — reproduce locally and fix the cause. Long waits must fail with a diagnosis (which gate never opened), not an opaque timeout.

## Naming and tools

- `specs/` = `*.spec.ts`; `tests/` = `*.test.ts`. Short basenames via directory hierarchy (`main.spec.ts`, `inspect.test.ts`).
- `ui/` imports runtime-bound `test`/`expect` from `@/playwright/suite` (`@playwright/test` for types/helpers only). E2E Vitest uses Node APIs only; web component tests belong in `apps/web/tests/`.
- Cross-app consistency may be asserted, but never import one app's private implementation as a helper — keep test helpers in `e2e/lib/` or promote reusable logic to a pure package. `@/*` aliases `lib/*` (e2e-local).
- Priority tags are test-name prefixes: `[P0]`, `[P1]`, `[P2]`.

## Commands

From this directory; validate single cases by file path. Do not add root e2e aliases or per-case scripts.

```bash
pnpm test specs/mac.spec.ts
pnpm test tests/tools-dev/inspect.test.ts
pnpm test specs
pnpm test tests
pnpm test:p0
pnpm test:p0p1
pnpm test:ui:p0
pnpm test:ui:p0p1
pnpm typecheck
pnpm exec tsx scripts/playwright.ts clean
pnpm exec playwright test -c playwright.config.ts --list
pnpm exec playwright test -c playwright.config.ts
```

Single-worker fallback is `--workers=1` (or `OD_PLAYWRIGHT_WORKERS=1`); never reintroduce a shared daemon/web runtime mode.
