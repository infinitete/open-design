# `apps/web/src/components/Theater/` (Critique Theater, web side)

Module map for the Design Jury visual surface. The directory keeps the
internal **Theater** name; the user-facing label comes from one i18n key
(`critiqueTheater.userFacingName`) so renames need no code churn.

## Layout

- `state/reducer.ts`: pure state machine over contract-level `PanelEvent` + host-synthesized `{ type: '__reset__' }`. No `useState` for run state in components.
- `state/sse.ts`: SSE channel manager + `sseToPanelEvent` with per-variant validation — malformed frames never reach the reducer.
- `hooks/useCritiqueStream.ts`: subscribes to the project SSE stream; tears down on `enabled=false` / `projectId` change with `__reset__` (no cross-project bleed). `hooks/useCritiqueReplay.ts`: drives the same reducer from recorded `.ndjson(.gz)` (split parse + pace effects so pause/resume keeps the cursor). `hooks/useCritiqueTheaterEnabled.ts`: Settings toggle synced via localStorage + cross-tab `storage` + same-tab CustomEvent.
- `CritiqueTheaterMount.tsx`: drop-in mount; owns the kill handshake (`POST /api/projects/:id/critique/:runId/interrupt`) and the live-stage → collapsed-badge swap.
- `TheaterStage.tsx` (five `PanelistLane`s + `ScoreTicker` + `RoundDivider` + `InterruptButton`), `PanelistLane.tsx`, `ScoreTicker.tsx`, `RoundDivider.tsx`, `InterruptButton.tsx` (click + Esc, Esc scoped away from text inputs), `TheaterDegraded.tsx` (`useId()` heading — no multi-chip collisions), `TheaterCollapsed.tsx` (interrupted branch uses `interruptedSummary`, not `shippedSummary`), `TheaterTranscript.tsx` (read-only replay).
- `index.ts`: public barrel (mount, surfaces, hooks, setter, reducer-derived types). Everything else stays internal.

## Invariants

- **Role-keyed tinting via `data-role`.** CSS picks hues via `color-mix` over semantic tokens — no hex literals in this directory.
- **All strings through i18n.** Every visible string is `t(...)` under `critiqueTheater.*`; the locale test enforces all 19 locales carry the same keyset.
- **Terminal phases are sticky.** Only a new-run `run_started` or host `__reset__` leaves them; informational `parser_warning`s are still accepted.
- **Interrupt is double-action.** Optimistic local `interrupted` + the kill POST; failed fetch is swallowed (dev warning) so the UI still collapses.
- **Designer weight frozen at 0.0** (mirror of the daemon invariant): `ScoreTicker` / `TheaterCollapsed` render wire `composite` as-is, never recompute it. No `weights` props until the contracts package carries the v2 cast type.

## When you change anything here

1. Wire shape → update `packages/contracts/src/critique.ts` first (reducer keys off `PanelEvent`, SSE off `CRITIQUE_SSE_EVENT_NAMES`).
2. New string → key in `apps/web/src/i18n/types.ts` + all 19 files under `apps/web/src/i18n/locales/` (no English fallback inheritance).
3. `pnpm --filter @open-design/web exec vitest run tests/components/Theater` before pushing (100+ cases: reducer, SSE, lifecycle, renders).
4. CSS changes under `.theater-*` in `apps/web/src/styles/viewer/theater.css` → visual regression via `test:ui:extended` with `--update-snapshots`.

## Related

- Spec: `specs/current/critique-theater.md` · Plan: `specs/current/critique-theater-plan.md` · User docs: `docs/critique-theater.md` · Daemon side: `apps/daemon/src/critique/AGENTS.md`
