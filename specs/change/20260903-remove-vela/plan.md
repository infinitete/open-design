# Remove Vela Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every active Vela/AMR capability and Vela CLI distribution path from Open Design on macOS, Windows, and Linux while keeping historical records readable.

**Architecture:** Retire persisted selections first, then remove the daemon runtime and media providers, then remove their web/contracts consumers, and finally remove packaged and release-time distribution. Historical run identifiers remain data, but no active registry, route, UI, prompt, build, or network path may create new Vela/AMR activity.

**Tech Stack:** TypeScript, Node.js 24, Express, SQLite/better-sqlite3, React 18, Electron, Vitest, pnpm 10.33.2, GitHub Actions, Bash, PowerShell.

**Spec:** `specs/change/20260903-remove-vela/spec.md`

## Global Constraints

- Remove Vela from macOS, Windows, Linux AppImage, Linux deb, Linux headless, containerized Linux, and release automation.
- Preserve local agent CLIs, BYOK providers, non-Vela media providers, projects, generated artifacts, and historical run/analytics rows.
- Never replace a retired Vela selection with another paid provider.
- Historical `agentId: "amr"` values may remain readable, but no new config, run, analytics event, retry, or resume may select AMR.
- Do not leave hidden flags, disabled routes, no-op adapters, or compatibility stubs that can reactivate Vela.
- Keep daemon data paths derived from the resolved `RUNTIME_DATA_DIR`.
- Use Node `~24` and pnpm `10.33.2`; run `pnpm install` after manifest or lockfile edits.
- Each task follows RED, minimal GREEN, focused verification, independent review, and one scoped commit.

## Spec Coverage Map

| Spec requirement | Implemented by |
| --- | --- |
| Retire stored agent and media selections | Task 1 |
| Remove AMR execution and historical retry actions | Task 2 |
| Remove Vela auth, billing, analytics, and network calls | Task 3 |
| Remove Vela image/video models without harming other media | Task 4 |
| Remove web surfaces and active shared contracts | Task 5 |
| Remove packaged and desktop configuration | Task 6 |
| Remove Vela from every platform and release lane | Task 7 |
| Prevent reintroduction and delete obsolete e2e coverage | Task 8 |
| Prove package gates and real artifact contents | Task 9 |

## Execution Setup

- [ ] Confirm the isolated branch and install the locked dependency graph:

```bash
git branch --show-current
node --version
corepack pnpm --version
pnpm install --frozen-lockfile
```

Expected: branch is `refactor/remove-vela`, Node is `v24.x`, pnpm is
`10.33.2`, and install completes without changing `pnpm-lock.yaml`.

---

### Task 1: Retire Vela selections without damaging user data

**Files:**
- Modify: `apps/daemon/src/app-config.ts`
- Modify: `apps/daemon/src/db.ts`
- Modify: `apps/daemon/tests/app-config.test.ts`
- Create: `apps/daemon/tests/retired-vela-project-metadata.test.ts`

**Interfaces:**
- Consumes: existing `AppConfigPrefs`, `normalizeRetiredAgentPrefs`, `openDatabase(dataDir)` and the `projects.metadata_json` column.
- Produces: `retireVelaProjectMetadata(db: Database.Database): number`, called once by `openDatabase`; normalized app config without active AMR keys.

- [ ] **Step 1: Write failing app-config retirement tests**

Add cases to `apps/daemon/tests/app-config.test.ts` that write this literal config and read it back:

```ts
{
  agentId: 'amr',
  agentModels: { amr: { model: 'vela/default' }, codex: { model: 'gpt-5' } },
  agentCliEnv: { amr: { VELA_BIN: '/tmp/vela' }, codex: { CODEX_HOME: '/tmp/codex' } },
  agentCliEnvIntent: { amr: { apiKeyOverride: true }, codex: { apiKeyOverride: true } },
}
```

Assert that `agentId`, `agentModels.amr`, `agentCliEnv.amr`, and
`agentCliEnvIntent.amr` are absent while the `codex` entries are unchanged.

- [ ] **Step 2: Run the app-config test and verify RED**

Run:

```bash
pnpm --filter @open-design/daemon exec vitest run tests/app-config.test.ts
```

Expected: FAIL because `RETIRED_AGENT_IDS` contains only `gemini` and AMR env
entries are still accepted.

- [ ] **Step 3: Write the failing project-metadata migration test**

In `apps/daemon/tests/retired-vela-project-metadata.test.ts`, create projects
whose literal metadata covers:

```ts
{ kind: 'image', imageModel: 'vela/image-pro', imageAspect: '16:9', keep: true }
{ kind: 'video', videoModel: 'vela/video-pro', videoLength: 5, keep: true }
{ kind: 'image', imageModel: 'gpt-image-2', keep: true }
```

Reopen the database twice. Assert that only the two `vela/*` fields disappear,
all other fields remain, the non-Vela model remains, and the second open makes
zero additional changes.

- [ ] **Step 4: Run the migration test and verify RED**

Run:

```bash
pnpm --filter @open-design/daemon exec vitest run tests/retired-vela-project-metadata.test.ts
```

Expected: FAIL because `retireVelaProjectMetadata` does not exist and startup
does not normalize project metadata.

- [ ] **Step 5: Implement minimal retirement normalization**

Extend the retired set and all four preference maps in
`apps/daemon/src/app-config.ts`:

```ts
const RETIRED_AGENT_IDS: ReadonlySet<string> = new Set(['gemini', 'amr']);
```

Keep `normalizeRetiredAgentPrefs` immutable: clone each map only when an `amr`
entry exists and delete the whole top-level map only when it becomes empty.

Add a synchronous transaction in `apps/daemon/src/db.ts`:

```ts
function parseProjectMetadataObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function retireVelaProjectMetadata(db: Database.Database): number {
  const rows = db.prepare('SELECT id, metadata_json AS metadataJson FROM projects WHERE metadata_json IS NOT NULL').all();
  const update = db.prepare('UPDATE projects SET metadata_json = ?, updated_at = updated_at WHERE id = ?');
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const metadata = parseProjectMetadataObject(row.metadataJson);
      if (!metadata) continue;
      const next = { ...metadata };
      if (typeof next.imageModel === 'string' && next.imageModel.startsWith('vela/')) delete next.imageModel;
      if (typeof next.videoModel === 'string' && next.videoModel.startsWith('vela/')) delete next.videoModel;
      if (JSON.stringify(next) === JSON.stringify(metadata)) continue;
      update.run(JSON.stringify(next), row.id);
      changed += 1;
    }
  })();
  return changed;
}
```

Use the repository's existing JSON parse/error conventions rather than throwing
on malformed historical metadata. Invoke the function after the `projects`
table and forward-compatible columns exist.

- [ ] **Step 6: Run focused daemon tests and verify GREEN**

Run:

```bash
pnpm --filter @open-design/daemon exec vitest run tests/app-config.test.ts tests/retired-vela-project-metadata.test.ts
pnpm --filter @open-design/daemon typecheck
```

Expected: both files pass; daemon typecheck exits 0.

- [ ] **Step 7: Commit the migration**

```bash
git add apps/daemon/src/app-config.ts apps/daemon/src/db.ts apps/daemon/tests/app-config.test.ts apps/daemon/tests/retired-vela-project-metadata.test.ts
git commit -m "refactor(daemon): retire Vela selections"
```

---

### Task 2: Remove the AMR agent runtime and run lifecycle

**Files:**
- Delete: `apps/daemon/src/runtimes/defs/amr.ts`
- Delete: `apps/daemon/src/runtimes/amr-model-cache.ts`
- Delete: `apps/daemon/src/runtimes/amr-model-probe.ts`
- Delete: `apps/daemon/src/runtimes/project-amr-trace-env.ts`
- Delete: `apps/daemon/src/runtimes/vela-child-evidence.ts`
- Delete: `apps/daemon/src/amr-stderr-filter.ts`
- Delete: `apps/daemon/src/storage/amr-terminal-report-outbox.ts`
- Modify: `apps/daemon/src/db.ts`
- Modify: `apps/daemon/src/runtimes/registry.ts`
- Modify: `apps/daemon/src/runtimes/detection.ts`
- Modify: `apps/daemon/src/runtimes/env.ts`
- Modify: `apps/daemon/src/runtimes/executables.ts`
- Modify: `apps/daemon/src/runtimes/metadata.ts`
- Modify: `apps/daemon/src/runtimes/models.ts`
- Modify: `apps/daemon/src/runtimes/auth.ts`
- Modify: `apps/daemon/src/runtimes/runs.ts`
- Modify: `apps/daemon/src/runtimes/chat-run-lifecycle.ts`
- Modify: `apps/daemon/src/runtimes/chat-run-records.ts`
- Modify: `apps/daemon/src/agent-session-resume.ts`
- Modify: `apps/daemon/src/agent-protocol/acp/constants.ts`
- Modify: `apps/daemon/src/agent-protocol/acp/session.ts`
- Modify: `apps/daemon/src/agent-protocol/acp/updates.ts`
- Modify: `apps/daemon/src/automations/workspace-scope.ts`
- Modify: `apps/daemon/src/brands/index.ts`
- Modify: `apps/daemon/src/cli.ts`
- Modify: `apps/daemon/src/design-systems/index.ts`
- Modify: `apps/daemon/src/mcp-workspace-context.ts`
- Modify: `apps/daemon/src/mcp.ts`
- Modify: `apps/daemon/src/server.ts`
- Modify: `apps/daemon/src/route-context-contract.ts`
- Modify: `apps/daemon/src/routes/project/comments.ts`
- Modify: `apps/daemon/src/routes/project/index.ts`
- Modify: `apps/daemon/src/routes/routine.ts`
- Modify: `apps/daemon/src/routes/runs.ts`
- Modify: `apps/daemon/src/native-session-recovery.ts`
- Modify: `apps/daemon/src/run-artifact-fs.ts`
- Modify: `apps/daemon/src/run-failure-classification.ts`
- Modify: `apps/daemon/src/run-diagnostics.ts`
- Modify: `apps/daemon/src/runtimes/chat-prompt-inputs.ts`
- Modify: `apps/daemon/src/runtimes/od-next-capability-gate.ts`
- Modify: `apps/daemon/src/runtimes/types.ts`
- Modify: `apps/daemon/src/strategies/od-next/automatic-continuation-service.ts`
- Modify: `apps/daemon/src/strategies/od-next/complex-production.ts`
- Modify: `apps/daemon/src/strategies/od-next/coordinator.ts`
- Modify: `apps/daemon/src/strategies/od-next/initial-prompt-bundle-service.ts`
- Modify: `apps/daemon/src/strategies/od-next/rollout.ts`
- Delete: `apps/daemon/tests/amr-session-resume.test.ts`
- Delete: `apps/daemon/tests/amr-stderr-filter.test.ts`
- Delete: `apps/daemon/tests/runtimes/amr-terminal-report-delivery.test.ts`
- Delete: `apps/daemon/tests/runtimes/amr-terminal-reports.test.ts`
- Delete: `apps/daemon/tests/runtimes/open-design-amr-trace-env.test.ts`
- Delete: `apps/daemon/tests/runtimes/vela-child-evidence.test.ts`
- Delete: `apps/daemon/tests/fixtures/od-next-runtime-capabilities/vela-opencode-0.0.1-local-opencode-1.18.18.sanitized-real-seed.json`
- Delete: `apps/daemon/tests/fixtures/od-next-runtime-capabilities/vela-opencode.contract.json`
- Delete: `apps/daemon/tests/fixtures/vela-opencode-child-evidence-wire-v1.golden.json`
- Modify: `apps/daemon/tests/runtimes/env-and-detection.test.ts`
- Modify: `apps/daemon/tests/runtimes/runtime-version-provenance.test.ts`
- Modify: `apps/daemon/tests/runtimes/resolve-model.test.ts`
- Modify: `apps/daemon/tests/user-facing-agent-label.test.ts`
- Modify: `apps/daemon/tests/{acp-handshake-failure-wiring,acp-handshake-failure,acp,api-failure-journal,chat-run-artifact-quiet-period,mcp-brief-app,mcp-create-artifact,mcp-get-project,mcp-runs,mcp-write-tools,project-cli,run-diagnostics,run-retry-runtime,server-bootstrap-regression,server-startup-smoke,system-prompt-template}.test.ts`
- Modify: `apps/daemon/tests/runtimes/{acp-stall-last-progress-age,agent-args,agent-runtime-env,chat-run-inactivity-timeout,launch,od-next-capability-gate,run-failure-telemetry-smoke,runs}.test.ts`
- Modify: `apps/daemon/tests/strategies/od-next/{complex-production,coordinator,rollout}.test.ts`

**Interfaces:**
- Consumes: the generic `RuntimeAgentDef` registry and existing unknown-agent validation.
- Produces: a shipped agent registry with no `amr`; generic history readers still accept string agent IDs.

- [ ] **Step 1: Write the failing runtime-registry test**

Add a literal assertion to `apps/daemon/tests/runtimes/env-and-detection.test.ts`:

```ts
assert.equal(SHIPPED_AGENT_DEFS.some((agent) => agent.id === 'amr'), false);
assert.equal(getAgentDef('amr'), undefined);
```

Keep existing assertions for Codex, Claude, OpenCode, and other shipped local
agents so the test catches accidental collateral removal.

- [ ] **Step 2: Run the registry test and verify RED**

```bash
pnpm --filter @open-design/daemon exec vitest run tests/runtimes/env-and-detection.test.ts
```

Expected: FAIL because `amrAgentDef` is still registered.

- [ ] **Step 3: Unregister AMR and remove active runtime branches**

Remove the `amrAgentDef` import and array entry from `runtimes/registry.ts`.
Remove branches whose predicate is `agentId === 'amr'`, Vela executable/profile
resolution, AMR model preflight/cache, AMR retry/resume eligibility, AMR stderr
filtering, terminal report delivery, and Vela child-evidence adaptation from the
listed runtime, ACP, server, route, diagnostics, and strategy files. Preserve
generic branches for local agents and BYOK.

Delete the dedicated source, fixtures, and tests only after their final import
is gone. Remove the AMR terminal-report migration import and invocation from
`db.ts`. Do not replace deleted code with `null as any`, empty callbacks, or
`if (false)` branches.

- [ ] **Step 4: Verify the daemon runtime is GREEN**

```bash
pnpm --filter @open-design/daemon exec vitest run \
  tests/runtimes/env-and-detection.test.ts \
  tests/runtimes/runtime-version-provenance.test.ts \
  tests/runtimes/resolve-model.test.ts \
  tests/agent-session-resume.test.ts \
  tests/native-session-recovery.test.ts \
  tests/run-failure-classification.test.ts \
  tests/user-facing-agent-label.test.ts
pnpm --filter @open-design/daemon typecheck
```

Expected: focused tests and typecheck pass with no AMR runtime registered.

- [ ] **Step 5: Commit the runtime removal**

```bash
git status --short
# Stage exactly the paths enumerated in Task 2's Files block.
git diff --cached --name-only
git commit -m "refactor(daemon): remove AMR runtime"
```

---

### Task 3: Remove Vela auth, account, analytics, and network integration

**Files:**
- Delete: `apps/daemon/src/integrations/vela.ts`
- Modify: `apps/daemon/src/connectionTest.ts`
- Modify: `apps/daemon/src/diagnostics-export.ts`
- Modify: `apps/daemon/src/installation.ts`
- Modify: `apps/daemon/src/integrations/aborted-error.ts`
- Modify: `apps/daemon/src/langfuse-bridge.ts`
- Modify: `apps/daemon/src/langfuse-trace.ts`
- Modify: `apps/daemon/src/services/run-analytics-lifecycle.ts`
- Modify: `apps/daemon/src/run-analytics-observability.ts`
- Modify: `apps/daemon/src/observability/runtime-child-observations.ts`
- Modify: `apps/daemon/src/observability/task-observation-otlp-exporter.ts`
- Modify: `apps/daemon/src/routes/telemetry.ts`
- Modify: `apps/daemon/src/server.ts`
- Delete: `apps/daemon/tests/integrations/vela.test.ts`
- Delete: `apps/daemon/tests/integrations/vela-terminal-command.test.ts`
- Delete: `apps/daemon/tests/amr-auth-analytics.test.ts`
- Delete: `apps/daemon/tests/mcp-vela-login.test.ts`
- Delete: `apps/daemon/tests/fixtures/fake-vela.mjs`
- Modify: `apps/daemon/tests/connection-test.test.ts`
- Modify: `apps/daemon/tests/diagnostics-export.test.ts`
- Modify: `apps/daemon/tests/langfuse-trace.test.ts`
- Modify: `apps/daemon/tests/run-analytics-observability.test.ts`
- Modify: `apps/daemon/tests/{aborted-error,cli-startup,langfuse-bridge,langfuse-bridge-nonblocking,run-runtime-type-analytics}.test.ts`
- Modify: `apps/daemon/tests/observability/{main-run-observation,task-observation-otlp-exporter,task-observation-rollout}.test.ts`

**Interfaces:**
- Consumes: generic agent connection tests, diagnostics, PostHog/Langfuse paths.
- Produces: no Vela process or network invocation; generic observability remains available.

- [ ] **Step 1: Write failing negative integration tests**

Update the surviving connection/diagnostics tests to assert their public JSON
does not contain `vela`, `amrLogin`, `amrAccount`, or `amrProfile`, while still
containing generic CLI availability and local diagnostics.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @open-design/daemon exec vitest run tests/connection-test.test.ts tests/diagnostics-export.test.ts tests/langfuse-trace.test.ts tests/run-analytics-observability.test.ts
```

Expected: FAIL because daemon payloads still read Vela login/account context.

- [ ] **Step 3: Remove integration callers and delete dedicated modules**

Remove all imports and calls to `readVelaLoginStatus`,
`readVelaControlApiContext`, `mirrorAmrEntryAnalytics`, and
`runVelaCommand`. Keep local PostHog/Langfuse event delivery that does not call
Vela. Delete Vela-specific tests rather than converting them to no-op tests.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --filter @open-design/daemon exec vitest run tests/connection-test.test.ts tests/diagnostics-export.test.ts tests/langfuse-trace.test.ts tests/run-analytics-observability.test.ts
pnpm --filter @open-design/daemon typecheck
git status --short
# Stage exactly the paths enumerated in Task 3's Files block.
git diff --cached --name-only
git commit -m "refactor(daemon): remove Vela services"
```

---

### Task 4: Remove Vela image and video providers

**Files:**
- Delete: `apps/daemon/src/media/vela.ts`
- Delete: `apps/daemon/src/media/amr-image-staging.ts`
- Delete: `apps/daemon/src/integrations/vela-command.ts`
- Modify: `apps/daemon/src/media/index.ts`
- Modify: `apps/daemon/src/media/models.ts`
- Modify: `apps/daemon/src/prompts/media-contract.ts`
- Modify: `apps/daemon/src/prompts/system.ts`
- Delete: `apps/daemon/tests/media/vela.test.ts`
- Delete: `apps/daemon/tests/media/vela-workspace-routes.test.ts`
- Modify: `apps/daemon/tests/media/models.test.ts`
- Modify: `apps/daemon/tests/prompts/system.test.ts`
- Modify: `apps/daemon/tests/prompts/system-prompt-matrix.test.ts`
- Modify: `packages/contracts/src/prompts/media-contract.ts`
- Modify: `packages/contracts/src/prompts/system.ts`

**Interfaces:**
- Consumes: generic media provider registry and project metadata migration from Task 1.
- Produces: media model catalogues and prompts with no `vela/*` provider; other providers unchanged.

- [ ] **Step 1: Write failing media-catalogue tests**

In `apps/daemon/tests/media/models.test.ts`, assert that the literal model list
contains no ID starting with `vela/`, then assert representative non-Vela image,
video, and audio models remain. In prompt tests, assert generated image/video
prompts do not instruct an agent to invoke or route through Vela.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @open-design/daemon exec vitest run tests/media/models.test.ts tests/prompts/system.test.ts tests/prompts/system-prompt-matrix.test.ts
```

Expected: FAIL because Vela models and prompt clauses are still present.

- [ ] **Step 3: Remove provider dispatch and prompts**

Delete the Vela adapter and remove its branches from `media/index.ts` and
`media/models.ts`. Remove only Vela-specific paragraphs from daemon and shared
prompt builders; preserve the generic `od media generate` contract and every
non-Vela provider.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --filter @open-design/daemon exec vitest run tests/media/models.test.ts tests/prompts/system.test.ts tests/prompts/system-prompt-matrix.test.ts
pnpm --filter @open-design/contracts typecheck
pnpm --filter @open-design/daemon typecheck
git status --short
# Stage exactly the paths enumerated in Task 4's Files block.
git diff --cached --name-only
git commit -m "refactor(media): remove Vela providers"
```

---

### Task 5: Remove AMR/Vela web surfaces and active contracts

**Files:**
- Delete: `apps/web/src/runtime/amr-artifact-upgrade.ts`
- Delete: `apps/web/src/runtime/amr-guidance.ts`
- Delete: `apps/web/src/runtime/amr-unlimited-models.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/AgentIcon.tsx`
- Modify: `apps/web/src/components/AssistantMessage.tsx`
- Modify: `apps/web/src/components/AvatarMenu.tsx`
- Modify: `apps/web/src/components/ChatPane.tsx`
- Modify: `apps/web/src/components/DeepSeekV4FlashCampaign.tsx`
- Modify: `apps/web/src/components/EntryNavRail.tsx`
- Modify: `apps/web/src/components/EntryShell.tsx`
- Modify: `apps/web/src/components/EntryView.tsx`
- Modify: `apps/web/src/components/FileWorkspace.tsx`
- Modify: `apps/web/src/components/HandoffButton.tsx`
- Modify: `apps/web/src/components/HomeView.tsx`
- Modify: `apps/web/src/components/InlineModelSwitcher.tsx`
- Modify: `apps/web/src/components/NewProjectPanel.tsx`
- Modify: `apps/web/src/components/ProjectView.tsx`
- Modify: `apps/web/src/components/RecentProjectsStrip.tsx`
- Modify: `apps/web/src/components/SettingsDialog.tsx`
- Modify: `apps/web/src/components/WorkbenchCampaignBadge.tsx`
- Modify: `apps/web/src/components/WorkspaceTabsBar.tsx`
- Modify: `apps/web/src/components/agentModelSelection.ts`
- Modify: `apps/web/src/components/agentOrdering.ts`
- Modify: `apps/web/src/components/modelOptions.tsx`
- Modify: `apps/web/src/media/models.ts`
- Modify: `apps/web/src/providers/daemon.ts`
- Modify: `apps/web/src/analytics/client.ts`
- Modify: `apps/web/src/analytics/provider.tsx`
- Modify: `apps/web/src/analytics/run-task.ts`
- Modify: `apps/web/src/lib/backoff.ts`
- Modify: `apps/web/src/message-center-client.ts`
- Modify: `apps/web/src/state/onboarding-profile.ts`
- Modify: `apps/web/src/state/projects.ts`
- Modify: `apps/web/src/utils/agentLabels.ts`
- Modify: `apps/web/src/i18n/types.ts`
- Modify: `apps/web/src/i18n/locales/{ar,de,en,es-ES,fa,fr,hu,id,it,ja,ko,pl,pt-BR,ru,th,tr,uk,zh-CN,zh-TW}.ts`
- Modify: `apps/web/src/styles/chat.css`
- Modify: `apps/web/src/styles/shell.css`
- Modify: `apps/web/src/styles/home/entry-layout.css`
- Modify: `apps/web/src/styles/viewer/routines.css`
- Modify: `apps/web/src/styles/workspace/artifacts.css`
- Delete: `apps/web/tests/components/App.onboarding-amr-e2e.test.tsx`
- Delete: `apps/web/tests/runtime/amr-artifact-upgrade.test.ts`
- Delete: `apps/web/tests/runtime/amr-guidance.test.ts`
- Delete: `apps/web/tests/runtime/amr-unlimited-models.plan-tier.test.ts`
- Delete: `apps/web/tests/runtime/amr-unlimited-models.test.ts`
- Delete: `apps/web/tests/styles/amr-account-control.test.ts`
- Delete: `apps/web/tests/styles/cloud-signin-tip-selectable-text.test.ts`
- Modify: `apps/web/tests/components/InlineModelSwitcher.compact-model-click.test.tsx`
- Modify: `apps/web/tests/components/NewProjectPanel.media.test.tsx`
- Modify: `apps/web/tests/components/AgentIcon.test.tsx`
- Modify: `apps/web/tests/utils/visibleAgents.test.ts`
- Modify: `apps/web/tests/media/model-provider.test.ts`
- Modify: `apps/web/tests/{analytics-configure-globals,analytics-session-replay,analytics/run-task-analytics,first-party-external-link,home-media-surfaces,message-center-client,providers/sse}.test.ts`
- Modify: `apps/web/tests/campaigns/{deepseek-v4-flash-modal,workbench-campaign-badge-signed-in-only}.test.tsx`
- Modify: `apps/web/tests/campaigns/deepseek-v4-flash-ui-contract.test.ts`
- Modify: `apps/web/tests/components/{App.onboarding-agent-autoselect,AssistantMessage,ChatPane.connect-repo,ChatPane.conversation-title,ChatPane.streaming,HandoffButton.fallback-reveal,MessageCenter,NewProjectPanel,ProjectView.reattach-restore,ProjectView.run-cleanup,ToolCard.disclosure}.test.tsx`
- Modify: `apps/web/tests/components/{agentModelSelection,modelProviderIcon}.test.ts`
- Modify: `apps/web/tests/components/NewProjectPanel.test.ts`
- Modify: `apps/web/tests/styles/onboarding-cli-chip-alignment.test.tsx`
- Modify: `apps/web/tests/styles/{avatar-menu-pinned-footer,onboarding-layout}.test.ts`
- Modify: `packages/contracts/src/api/chat.ts`
- Modify: `packages/contracts/src/api/registry.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/analytics/events/mappers.ts`
- Modify: `packages/contracts/src/analytics/events/mcp.ts`
- Modify: `packages/contracts/src/analytics/events/onboarding.ts`
- Modify: `packages/contracts/src/analytics/events/result-events.ts`
- Modify: `packages/contracts/src/analytics/events/shared-enums.ts`
- Modify: `packages/contracts/src/analytics/events/surface-view.ts`
- Modify: `packages/contracts/src/analytics/events/ui-click.ts`
- Modify: `packages/contracts/src/analytics/public-params.ts`
- Modify: `packages/contracts/tests/analytics-agent-provider.test.ts`
- Modify: `packages/contracts/tests/analytics-run-finished-contract.test.ts`

**Interfaces:**
- Consumes: daemon registry without AMR and media catalogues without Vela.
- Produces: UI and active shared contracts that expose only supported agents/providers; historical run IDs remain strings.

- [ ] **Step 1: Write failing web and contract tests**

Update `visibleAgents.test.ts`, `AgentIcon.test.tsx`,
`InlineModelSwitcher.compact-model-click.test.tsx`, and
`NewProjectPanel.media.test.tsx` to assert no selectable `amr` agent and no
`vela/*` media model while asserting Codex/local CLI, BYOK, and representative
non-Vela media options remain. Update analytics contract tests so new runtime
mapping never emits `amr_cloud` or provider `amr`.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @open-design/contracts exec vitest run tests/analytics-agent-provider.test.ts tests/analytics-run-finished-contract.test.ts
pnpm --filter @open-design/web exec vitest run tests/utils/visibleAgents.test.ts tests/components/AgentIcon.test.tsx tests/components/InlineModelSwitcher.compact-model-click.test.tsx tests/components/NewProjectPanel.media.test.tsx tests/media/model-provider.test.ts
```

Expected: FAIL on existing AMR agent and Vela media choices.

- [ ] **Step 3: Remove active UI, contract, copy, and style branches**

Remove AMR/Vela props, state, fetches, actions, analytics emission, recovery
cards, account UI, model entries, icons, translation keys, and CSS selectors.
Delete dedicated AMR runtime helpers and tests. Keep historical run rendering
generic: an old string ID may display as plain text, but no button may retry,
resume, authorize, recharge, upgrade, or select AMR.

Remove active AMR/Vela error and analytics unions only after all new-event
producers are gone. If a persisted run decoder requires a literal, isolate it
in the historical read type instead of leaving it in the writable request type.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --filter @open-design/contracts test
pnpm --filter @open-design/contracts typecheck
pnpm --filter @open-design/web exec vitest run tests/utils/visibleAgents.test.ts tests/components/AgentIcon.test.tsx tests/components/InlineModelSwitcher.compact-model-click.test.tsx tests/components/NewProjectPanel.media.test.tsx tests/media/model-provider.test.ts
pnpm --filter @open-design/web typecheck
git status --short
# Stage exactly the paths enumerated in Task 5's Files block.
git diff --cached --name-only
git commit -m "refactor(web): remove AMR and Vela surfaces"
```

---

### Task 6: Remove packaged and desktop Vela configuration

**Files:**
- Delete: `apps/packaged/src/workspace-team.ts`
- Modify: `apps/packaged/src/config.ts`
- Modify: `apps/packaged/src/headless.ts`
- Modify: `apps/packaged/src/sidecars.ts`
- Modify: `apps/packaged/tests/config.test.ts`
- Modify: `apps/packaged/tests/sidecars.test.ts`
- Delete: `apps/packaged/tests/workspace-team.test.ts`
- Modify: `apps/packaged/tests/source-origins.test.ts`
- Modify: `apps/packaged/tests/startup-telemetry.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/diagnostics-fetch.ts`
- Modify: `apps/desktop/src/main/diagnostics.ts`
- Modify: `apps/desktop/src/main/invite-deeplink-core.ts`
- Modify: `apps/desktop/src/main/invite-deeplink.ts`
- Delete: `apps/desktop/tests/main/amr-environment-profile-menu.test.ts`
- Modify: `apps/desktop/tests/main/diagnostics-export-delegates.test.ts`

**Interfaces:**
- Consumes: generic packaged config and sidecar launch environment.
- Produces: packaged config with no AMR profile/Vela URL fields and sidecars with no Vela env.

- [ ] **Step 1: Write failing packaged-config tests**

Assert `loadPackagedConfig` ignores/rejects legacy `amrProfile`, `velaWebUrl`,
and `velaWebUrls`, and assert daemon sidecar env contains none of
`OPEN_DESIGN_AMR_PROFILE`, `OD_VELA_WEB_URL`, or `OD_WORKSPACE_CONTEXT_SOURCE`.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @open-design/packaged exec vitest run tests/config.test.ts tests/sidecars.test.ts tests/source-origins.test.ts
```

Expected: FAIL because packaged config and sidecar launch still forward Vela.

- [ ] **Step 3: Remove packaged/desktop integration**

Delete Vela/AMR config fields, parsing, forwarding, workspace-team transport
activation, and the hidden desktop AMR environment profile menu. Preserve
generic daemon/web sidecar startup, updater, diagnostics, and `od://` routing.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --filter @open-design/packaged test
pnpm --filter @open-design/packaged typecheck
pnpm --filter @open-design/desktop test
pnpm --filter @open-design/desktop typecheck
git status --short
# Stage exactly the paths enumerated in Task 6's Files block.
git diff --cached --name-only
git commit -m "refactor(packaged): remove Vela configuration"
```

---

### Task 7: Remove Vela CLI from every platform and release lane

**Files:**
- Delete: `tools/pack/src/vela-cli.ts`
- Modify: `tools/pack/package.json`
- Modify: `tools/pack/src/config/index.ts`
- Modify: `tools/pack/src/index.ts`
- Modify: `tools/pack/src/mac/app.ts`
- Modify: `tools/pack/src/win/resources.ts`
- Modify: `tools/pack/src/linux.ts`
- Modify: `tools/pack/tests/resources/resources.test.ts`
- Modify: `tools/pack/tests/config/config.test.ts`
- Modify: `tools/pack/tests/mac.test.ts`
- Modify: `tools/pack/tests/win-resources.test.ts`
- Modify: `tools/pack/tests/linux.test.ts`
- Modify: `tools/pack/tests/release-workflows.test.ts`
- Modify: `tools/release/scripts/build-platform.sh`
- Modify: `tools/release/scripts/build-platform.ps1`
- Modify: `.github/workflows/release-stable.yml`
- Modify: `.github/workflows/release-beta.yml`
- Modify: `.github/workflows/release-prerelease.yml`
- Modify: `pnpm-lock.yaml`
- Modify: `tools/pack/README.md`
- Modify: `tools/pack/AGENTS.md`
- Modify: `apps/daemon/AGENTS.md`

**Interfaces:**
- Consumes: platform resource builders without a Vela requirement.
- Produces: no `--require-vela-cli`, `OPEN_DESIGN_VELA_CLI_BIN`, Vela package, copied binary, or release secret input on any platform.

- [ ] **Step 1: Write failing cross-platform packaging tests**

Update platform tests to inspect generated mac config/resources, Windows
resource plans, Linux AppImage/deb/headless config, container arguments, and
release command arrays. Assert all omit:

```ts
[
  '--require-vela-cli',
  'OPEN_DESIGN_VELA_CLI_BIN',
  '@powerformer/vela-cli',
  'open-design/bin/vela',
]
```

Keep positive assertions for the daemon CLI, DSH runtime, OpenCode where used
independently, and other bundled resources.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @open-design/tools-pack exec vitest run tests/config/config.test.ts tests/mac.test.ts tests/win-resources.test.ts tests/linux.test.ts tests/release-workflows.test.ts
```

Expected: FAIL because every platform still carries Vela inputs.

- [ ] **Step 3: Remove platform implementation and manifests**

Delete `vela-cli.ts`, its optional dependency, `requireVelaCli` config/CLI
option, mac/Windows/Linux copy calls, Linux container mount/env mapping, and
release-script/workflow flags and secrets. Remove stale ownership text from
AGENTS/README files. Do not remove generic OpenCode packaging used by supported
non-AMR agents.

- [ ] **Step 4: Regenerate dependencies**

```bash
pnpm install
pnpm why @powerformer/vela-cli
```

Expected: install exits 0; `pnpm why` prints no dependency path. Verify the
lockfile has no `@powerformer/vela-cli` or platform binary package entry:

```bash
if rg -n '@powerformer/vela-cli' pnpm-lock.yaml tools/pack/package.json; then exit 1; fi
```

- [ ] **Step 5: Verify platform/release tests and commit**

```bash
pnpm --filter @open-design/tools-pack test
pnpm --filter @open-design/tools-pack typecheck
pnpm --filter @open-design/tools-release typecheck
pnpm --dir e2e test tests/packaged-smoke-workflow.test.ts
git status --short
# Stage exactly the paths enumerated in Task 7's Files block.
git diff --cached --name-only
git commit -m "refactor(pack): remove Vela from all platforms"
```

---

### Task 8: Remove obsolete AMR end-to-end suites and enforce the retirement boundary

**Files:**
- Delete: `e2e/tests/amr/auth-error-convergence.test.ts`
- Delete: `e2e/tests/amr/insufficient-balance.test.ts`
- Delete: `e2e/tests/amr/turn.test.ts`
- Modify: `e2e/lib/vitest/suite.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/guard.ts`
- Create: `e2e/tests/scripts/retired-vela.test.ts`

**Interfaces:**
- Consumes: the completed removal from Tasks 1-7.
- Produces: a repository guard that prevents active Vela/AMR code and distribution inputs from returning.

- [ ] **Step 1: Write the failing guard test**

Add a test fixture in `e2e/tests/scripts/retired-vela.test.ts` that calls the
new exported guard helper with an in-memory path/content list. The test must
reject active source such as:

```ts
{ path: 'tools/pack/src/example.ts', content: 'runVelaCommand()' }
{ path: 'apps/web/src/example.tsx', content: "agentId === 'amr'" }
```

It must allow the exact historical compatibility files that still decode old
rows and the approved archived documents under `specs/change/`.

- [ ] **Step 2: Run the guard test and verify RED**

```bash
pnpm --dir e2e test tests/scripts/retired-vela.test.ts
```

Expected: FAIL because the guard helper does not exist.

- [ ] **Step 3: Remove obsolete e2e composition and implement the guard**

Delete AMR suites and their `createSmokeSuite(...).with.amr` composition. Remove
AMR jobs/filters from `ci.yml` without changing unrelated CI scope routing.

In `scripts/guard.ts`, add this explicit interface and exported helper, then run
it over active TypeScript, package manifests, release scripts, and workflow
files:

```ts
export type RetiredVelaSourceEntry = { path: string; content: string };
export type RetiredVelaViolation = { path: string; token: string };

const retiredVelaAllowedExactPaths = new Set([
  'CHANGELOG.md',
  'RELEASE-NOTES-0.10.0.md',
  'apps/landing-page/app/content/blog/open-design-0-13-0-stay-in-flow.md',
]);

export function findRetiredVelaViolations(
  entries: readonly RetiredVelaSourceEntry[],
): RetiredVelaViolation[] {
  return entries.flatMap(({ path, content }) => {
    if (path.startsWith('specs/change/') || retiredVelaAllowedExactPaths.has(path)) return [];
    const match = /\bvela\b|vela_|vela-|\bamr\b|amr_|amr-/i.exec(content);
    return match ? [{ path, token: match[0] }] : [];
  });
}
```

Do not allow entire active directories. Report every violating path and matched
token before failing.

- [ ] **Step 4: Run guard/e2e tests and commit**

```bash
pnpm --dir e2e test tests/scripts/retired-vela.test.ts tests/packaged-smoke-workflow.test.ts
pnpm guard
git status --short
# Stage exactly the paths enumerated in Task 8's Files block.
git diff --cached --name-only
git commit -m "test: prevent Vela integration regressions"
```

---

### Task 9: Final verification and real artifact inspection

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: all commits from Tasks 1-8.
- Produces: completion evidence for source, tests, and platform artifacts.

- [ ] **Step 1: Run source residue checks**

```bash
rg -n -i '\bvela\b|vela_|vela-|\bamr\b|amr_|amr-' \
  apps/daemon/src apps/web/src apps/packaged/src apps/desktop/src \
  tools/pack/src tools/release/scripts tools/pack/package.json \
  .github/workflows
```

Expected: no output except exact historical compatibility comments/files
allowed by the Task 8 guard. Review every output line rather than weakening the
pattern.

- [ ] **Step 2: Run all affected package gates**

```bash
pnpm --filter @open-design/contracts test
pnpm --filter @open-design/daemon test
pnpm --filter @open-design/web test
pnpm --filter @open-design/packaged test
pnpm --filter @open-design/tools-pack test
pnpm --filter @open-design/contracts build
pnpm --filter @open-design/daemon build
pnpm --filter @open-design/web build
pnpm --filter @open-design/desktop build
pnpm --filter @open-design/packaged build
pnpm --filter @open-design/tools-pack build
pnpm guard
pnpm typecheck
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Build and inspect a real macOS app**

Run on macOS arm64:

```bash
pnpm tools-pack mac build --to app
MAC_APP='.tmp/tools-pack/out/mac/namespaces/default/builder/mac-arm64/Open Design.app'
if find "$MAC_APP" -type f -iname '*vela*' -print | rg -q .; then exit 1; fi
if rg -n -i 'vela|amr' "$MAC_APP/Contents/Resources/open-design-config.json"; then exit 1; fi
```

Expected: build exits 0 and both inspections produce no matches.

- [ ] **Step 4: Build and inspect Linux artifacts**

Run on a Linux release-capable host:

```bash
pnpm tools-pack linux build --to appimage
find .tmp/tools-pack/out/linux/namespaces/default -type f -iname '*vela*' -print
```

Expected: build exits 0 and `find` prints nothing. Run the same resource
inspection after `pnpm tools-pack linux build --to deb` and for the headless
install root created by `pnpm tools-pack linux install --headless`.

- [ ] **Step 5: Validate Windows payload absence**

Run on Windows x64:

```powershell
pnpm tools-pack win build --to all
$matches = Get-ChildItem -Recurse .tmp\tools-pack\out\win\namespaces\default |
  Where-Object { $_.Name -match 'vela' }
if ($matches) { $matches | Format-Table FullName; exit 1 }
```

Expected: build exits 0 and no matching file is reported.

- [ ] **Step 6: Request final review and preserve integration boundaries**

Request an independent read-only review against
`specs/change/20260903-remove-vela/spec.md`. Fix every Critical or Important
finding, rerun the affected gates, and obtain a fresh PASS. Do not merge, push,
delete worktrees, or install artifacts without separate user authorization.
