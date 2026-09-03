# `apps/daemon/src/critique/` (Critique Theater, daemon side)

Module map for the critique pipeline. User-facing name is **Design Jury**;
the directory keeps the internal **Critique Theater** name so the product
label can move without churning code paths.

## Layout

- `orchestrator.ts`: the state machine (spawns CLI session, feeds panelist prompts, decides continue/terminate on SHIP / round_end).
- `parser.ts` + `parsers/v1.ts`: streaming parser for the `<CRITIQUE_RUN>` / `<PANELIST>` / `<SHIP>` envelope; yields one `PanelEvent` at a time via async generator (never collects eagerly).
- `config.ts`: `CritiqueConfig` defaults + `OD_CRITIQUE_*` env parsing — the only place for thresholds, weights, timeouts.
- `errors.ts`: typed parser failures → `DegradedReason` tags on `critique.degraded`.
- `persistence.ts` (`critique_runs` / `critique_rounds`), `artifact-writer.ts` (SHIP body to disk; byte-budget + `O_NOFOLLOW` traversal guard), `artifact-handler.ts` (HTTP read path), `interrupt-handler.ts` (kill request), `transcript.ts` (replayable event transcripts).
- `adapter-degraded.ts`: in-memory degraded-adapter registry (24h TTL) consulted before routing a run.
- `conformance.ts` + `__fixtures__/v1/` + `__fixtures__/adapters/`: harness entry, canonical transcripts, synthetic adapter stubs (parser exercised end-to-end without a real model). `conformance-history.ts` / `scoreboard.ts` summarize evidence; `ratchet.ts` + `rollout.ts` resolve the rollout tier; `run-registry.ts` backs interrupt handling; `spawn-inputs.ts` builds isolated subprocess inputs.
- Adapter registry is `runtimes/registry.ts` — there is no `src/agents/registry.ts` despite what old plans say.

## Invariants

- Terminal phases (`shipped`, `degraded`, `interrupted`, `failed`) emit exactly once per run; the reducer treats them as sticky, duplicate SHIP trips `duplicate_ship`.
- Artifact bytes never travel on the wire — SHIP carries `artifactRef` only.
- Round bookkeeping is keyed by round number; a late event from round N must not corrupt round N+1.
- Designer weight is frozen at 0.0 until v1 ends (0 / 0.4 / 0.2 / 0.2 / 0.2). V1 weights are wire-shape, not a tuning knob — changing them breaks persisted `composite` numbers. V2 lands per-skill cast via `od.critique.cast` in `SKILL.md` frontmatter.

## When you change anything here

1. `packages/contracts/src/critique.ts` first: `PanelEvent`, `DegradedReason`, `FailedCause`, `ParserWarningKind` are the single source of truth. Enforce schema strictness in the parser; do not loosen it.
2. New failure shape → new v1 fixture under `__fixtures__/v1/` + conformance case.
3. Wire-shape change → bump `CRITIQUE_PROTOCOL_VERSION` (mismatch auto-marks adapters `degraded`).

## Related

- Spec: `specs/current/critique-theater.md` · Plan: `specs/current/critique-theater-plan.md` · User docs: `docs/critique-theater.md` · Web side: `apps/web/src/components/Theater/AGENTS.md`
