# GitHub automation guide

Several historical workflows predate the current topology — do not copy old patterns blindly. For new work use `ci.yml` + `comment|autofix|report|convergence.atom.yml` + `.github/scripts/handoff.py` unless a maintainer chooses otherwise.

## Required reading

- `.github/workflows/ci.yml`, `comment.atom.yml`, `autofix.atom.yml`, `report.atom.yml`
- `.github/scripts/handoff.py` (artifact names, layout, validation)
- `.github/config/runners.json|scopes.json|convergence.json` + `.github/scripts/runners.py|scopes.py|convergence.py`
- `convergence.atom.yml` + `.github/scripts/lib/r2.py` for reusable workload results
- `specs/current/ci.md` for scope rules, confidence tiers, planner invariants
- `e2e/tests/packaged-smoke-workflow.test.ts` for topology coverage
- `scripts/approve-fork-pr-workflows.ts` + its e2e test for fork-approval changes

Cross-workflow changes update the topology tests, not just YAML.

## Architecture

Business layer (decides): `ci.yml` is the low-privilege PR / merge-queue / manual gate — resolves runners, composes scope + convergence in the Linux `plan` job, runs validation, produces typed handoffs. Packaging checks are standalone, outside the merge gate (`nix.yml`, `docker-image.yml` — never re-attach to `Validate workspace`). Business workflows never do trusted writes when a capability workflow can.

Capability layer (executes): `comment.atom.yml` upserts pure-text bodies from `handoff-comment-*`; `autofix.atom.yml` applies `patch.diff` from `handoff-autofix-*` to same-repo branches; `report.atom.yml` materializes advanced comments (deps, R2, artifact processing) from `handoff-report-*` and upserts; `rerun.atom.yml` re-runs only infra-cancelled leaves (`rerun_infra_cancel.py` — never assertion failures or stale heads); `convergence.atom.yml` solely publishes immutable reusable results from `handoff-convergence-*`.

Rule: no new `foo.comment|autofix|report.atom.yml` — express the flow as a `ci.yml` producer plus the existing atoms.

## Directory conventions

- `workflows/` = entrypoints; `actions/` = composite setup steps; `scripts/` = workflow-owned glue (release-only helpers under `scripts/release/`; repo-level checks stay in root `scripts/` — do not move handoff glue there to look general).
- Workflow glue may be Python (stdlib, small, portable); project-owned scripts stay TypeScript. The planning control plane is Linux-only stdlib-only: a Windows job must never invoke it. Keep placement, relevance, convergence, and fine-grained commands inside each workload.

## Handoff contract

All names/paths come from `handoff.py` (`artifact-name`, `artifact-pattern`); never hand-roll prefixes, layouts, or metadata parsers — extend `handoff.py` first. Layout: `handoff/comment/<id>/{metadata.json,body.md}`, `handoff/autofix/<id>/{metadata.json,patch.diff}`, `handoff/report/<id>/metadata.json`, `handoff/convergence/<id>/{metadata.json,candidate.json}`. PR handoffs bind PR + head/base SHA + run id; convergence handoffs bind repo + policy + event + attempt + source SHAs + candidate.

## Capability rules

- `comment`: already-final `body.md` with a stable marker; validates PR/draft/head/base before upsert; file-backed `gh api --input` payload; no deps, R2, report scripts, or PR-code checkout.
- `autofix`: `patch.diff` + `allowed_paths` + `commit_message`; fork/closed/draft/stale cases skip (never fail); re-validates live PR state; changed files must exactly match `allowed_paths`; bot app token for pushes; no arbitrary commands or PR-head code execution.
- `report`: trusted writer for non-pure-text comments. PR artifacts are untrusted data — checkout trusted base code before running repo scripts; validate PR state before secret use and again before upsert; explicit per-type dispatch.
- Trusted `workflow_run` workflows download PR artifacts as data but never execute PR code.

## Fork PR approval

`fork-pr-workflow-approval.yml` + `approve-fork-pr-workflows.ts` may approve low-risk fork `pull_request` runs only — never trusted `workflow_run` capabilities. `ci.yml` is the only approved workflow path unless a maintainer expands the allowlist.

## Common iteration flow

1. Classify: validation → `ci.yml`; pure-text comment → `handoff/comment`; same-repo patch → `handoff/autofix`; generated comment → `handoff/report`; new naming/paths → `handoff.py`.
2. Scope routing: edit `.github/config/scopes.json`, run `python3 .github/scripts/scopes.py validate`.
3. Convergence: declare input closure + execution class + contract + explicit reuse opt-in in `convergence.json` (`"*"` until high-confidence evidence narrows it).
4. Topology coverage in `e2e/tests/packaged-smoke-workflow.test.ts` or the relevant script test.
5. `python3 .github/scripts/handoff.py self-check`, `actionlint -color`, focused e2e test, `git diff --check`, `pnpm guard`, `pnpm typecheck`.

Cross-workflow topology tests live in `e2e/tests/`; script behavior contracts in `e2e/tests/scripts/` (root `scripts/` is test-free per guard). No one-off `*.test.ts` per helper — prefer existing topology coverage and helper self-checks.
