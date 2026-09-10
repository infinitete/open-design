# Remove Auto-Update and Versioned Distribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove both self-update stacks and the versioned launcher/payload distribution model from Open Design, leaving a packaged application that installs, boots, and runs without any generation, feed, or update state.

**Architecture:** Retire the renderer surfaces first, then the host bridge contract they depend on, then the desktop updater runtime, then the two distribution packages, then the tooling that builds and publishes updates, then CI and e2e, and finally docs plus a dead-config sweep.

**Tech Stack:** TypeScript, Node 24, Electron, React 18, Next.js 16, Express, Vitest, Playwright, pnpm 10.33.2, GitHub Actions, NSIS, PowerShell.

**Spec:** `specs/change/20260910-remove-auto-update/spec.md`

## Global Constraints

- Remove update behavior from macOS, Windows, Linux AppImage, Linux deb, Linux headless, containerized Linux, the terminal shell, and release automation.
- Preserve local agent CLIs, BYOK providers, projects, generated artifacts, release channels, release namespaces, and channel-specific product identity.
- No disabled routes, no-op adapters, `enabled: false` capability flags, or compatibility stubs that could reactivate an update path.
- No code, env var, IPC channel, or UI control may signal "update unavailable" or "updates unsupported" — the concept is deleted, not stubbed.
- Namespace-scoped data/log/runtime paths stay port-free and unchanged.
- Historical records stay readable and unedited: `CHANGELOG.md`, `apps/landing-page` blog posts, and past `specs/change/*` entries.
- Do not touch `deploy/scripts/update.sh` / `docs/install-guide.md` (Docker redeployment, different mechanism).
- Use Node `~24` and pnpm `10.33.2`; run `pnpm install` after manifest, workspace, or lockfile edits.
- Do not edit, revert, or stage the in-flight working-tree changes in `tools/pack/src/linux.ts` and `tools/pack/tests/linux.test.ts` (unrelated proxy-env fix, currently unstaged).
- Each task follows focused verification and one scoped commit, with no `Co-authored-by` trailer.

## Spec Coverage Map

| Spec requirement | Implemented by |
| --- | --- |
| Remove packaged desktop auto-updater UI and preference | Task 1 |
| Remove the post-update "what's new" surface | Task 2 |
| Remove the host bridge updater contract | Task 3 |
| Remove the desktop updater runtime, IPC, menu | Task 4 |
| Remove the standalone shell updater and versioned launcher | Task 5 |
| Remove the versioned launcher/payload distribution model | Tasks 6, 7, 8, 11 |
| Remove release-side update publication | Tasks 9, 10, 12 |
| Re-scope CI and e2e coverage | Tasks 12, 13 |
| Retire stored preference, remove docs, prove gates | Task 14 |

## Execution Setup

- [ ] Confirm the branch, toolchain, and clean install:

```bash
git branch --show-current
node --version
corepack pnpm --version
pnpm install --frozen-lockfile
```

Expected: Node `v24.x`, pnpm `10.33.2`, install completes without changing
`pnpm-lock.yaml`, and `git status` shows only the two pre-existing `tools/pack`
modifications.

- [ ] Capture the removal baseline (used as the exit condition in Task 14):

```bash
rg -il 'OD_UPDATE_|od:update:|launcher-proto|StandaloneUpdater|VersionedLauncher|UpdaterPopup|WhatsNewPopup|runtime\.json|attempt\.json' \
  --glob '!node_modules' --glob '!dist' --glob '!.next' --glob '!CHANGELOG.md' \
  apps packages tools shells e2e docs scripts .github | sort > /tmp/removal-baseline.txt
wc -l /tmp/removal-baseline.txt
```

---

### Task 1: Remove the renderer update surface and the silent-update preference

**Files:**
- Delete: `apps/web/src/lib/updater.ts`
- Delete: `apps/web/src/components/UpdaterPopup.tsx`, `apps/web/src/components/UpdaterPopup.module.css`
- Delete: `apps/web/src/components/UpdateDialog.tsx`, `apps/web/src/components/UpdateDialog.module.css`
- Delete: `apps/web/src/state/silent-update-preference.ts`
- Delete: `apps/web/tests/update-surface-real-data.test.ts`, `apps/web/tests/lib/updater.test.ts`
- Delete: `apps/web/tests/components/UpdateDialog.test.tsx`, `apps/web/tests/components/UpdaterPopup.test.tsx`, `apps/web/tests/components/UpdaterPopup.rocket-indicator.test.tsx`, `apps/web/tests/components/silent-updates-currentTarget.race.test.tsx`, `apps/web/tests/state/silent-update-preference.test.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/EntryShell.tsx`, `apps/web/src/components/EntryNavRail.tsx`, `apps/web/src/components/SettingsDialog.tsx`
- Modify: `apps/web/src/styles/entrance.css`, `apps/web/src/styles/home/entry-layout.css`, `apps/web/src/styles/workspace/mention-home.css`, `apps/web/src/styles/workspace/artifacts.css`
- Modify: `apps/web/src/i18n/types.ts` and all 19 files in `apps/web/src/i18n/locales/`
- Modify: `apps/daemon/src/app-config.ts`, `packages/contracts/src/api/app-config.ts`

**Interfaces:**
- Consumes: `getHostUpdaterStatus` and the eight sibling host actions (removed in Task 3).
- Produces: a web shell with no update mount point, plus an `AppConfigPrefs` without `allowSilentUpdates`.

- [ ] **Step 1: Delete the update modules and their tests**

```bash
git rm -q apps/web/src/lib/updater.ts \
  apps/web/src/components/UpdaterPopup.tsx apps/web/src/components/UpdaterPopup.module.css \
  apps/web/src/components/UpdateDialog.tsx apps/web/src/components/UpdateDialog.module.css \
  apps/web/src/state/silent-update-preference.ts \
  apps/web/tests/update-surface-real-data.test.ts apps/web/tests/lib/updater.test.ts \
  apps/web/tests/components/UpdateDialog.test.tsx apps/web/tests/components/UpdaterPopup.test.tsx \
  apps/web/tests/components/UpdaterPopup.rocket-indicator.test.tsx \
  apps/web/tests/components/silent-updates-currentTarget.race.test.tsx \
  apps/web/tests/state/silent-update-preference.test.ts
```

- [ ] **Step 2: Unwire `App.tsx`**

Remove the `UpdateDialog` import and its mount (the sibling of the workspace
shell, around the end of the non-onboarding return), the `UpdaterPopup` import
(note: it is imported but never rendered — drop it outright), the
`createSilentUpdatePreferenceWriter` import, `silentUpdatePreferenceWriterRef`,
`handleSilentUpdatePreferenceChange`, and every `onSilentUpdatePreferenceChange`
prop pass. Remove the now-orphaned comment that gated silent-update default
seeding on a successful config fetch.

- [ ] **Step 3: Unwire `EntryShell.tsx` and `EntryNavRail.tsx`**

In `EntryShell.tsx`, delete the `updaterSlot` construction and pass-through, the
`onSilentUpdatePreferenceChange` prop from the type, the destructure, and the
call site. In `EntryNavRail.tsx`, delete the `updaterSlot` prop from both
component layers, the three pass-down sites, the render site, and the doc
comments describing the slot contract and tooltip reservation. Leave
`entry-nav-rail__account-updater` CSS removal to Step 5.

- [ ] **Step 4: Unwire `SettingsDialog.tsx`**

Delete the `../lib/updater` import block, the `AboutUpdatePrimaryAction` /
`AboutUpdateTone` / `AboutUpdateControl` types and `deriveAboutUpdateControl`,
the `aboutUpdaterModel` / `aboutUpdateActionBusy` / `aboutUpdateQuitFailed` /
`aboutUpdaterToast` / `clearUpdaterCacheStage` / `clearUpdaterCacheBusy` state,
the two subscribe/read effects, `aboutUpdaterToastText`,
`applyAboutUpdaterResult`, `handleAboutUpdateAction`, and
`handleClearUpdaterCache`.

In the About JSX keep the version / channel / runtime / platform / arch rows and
the export-diagnostics and reset-onboarding rows; delete the
`settings-about-update-status` row, the `settings-about-update-actions` row with
its check/download/install/quit button and release link, the silent-update
toggle row, and the two-stage clear-update-cache row.

Keep `settings.updateViewReleases`-style release-notes links out entirely —
manual downloading is a README concern, not a Settings control.

- [ ] **Step 5: Remove the updater-only CSS**

Delete the `/* Updater popup */` block in `styles/entrance.css`, the
`.entry-updater-menu` rule and the `:has(.updater-popup)` z-index rule in
`styles/home/entry-layout.css`, the whole `.entry-nav-rail__account-updater`
block including its `:empty` rule, the entire `.updater-popup*` family plus RTL
overrides in `styles/workspace/mention-home.css`, and the
`.settings-about-update-actions` rule in `styles/workspace/artifacts.css`.

- [ ] **Step 6: Remove the i18n keys**

From `apps/web/src/i18n/types.ts` delete the contiguous blocks for the 20
`settings.update*` keys, all 42 `updater.*` keys under the `// Desktop updater`
banner (including the reinstall cluster and its comment), the
`settings.clearUpdaterCache*` keys, and the `settings.allowSilentUpdates*` keys.

Then remove the same keys from every locale file. All 19 locales carry the
identical set, but `zh-CN` and `zh-TW` use double-quoted keys — match
quote-agnostically or you will silently leave 144 entries behind:

```bash
rg -c '["'\''](updater\.|settings\.update|settings\.clearUpdaterCache|settings\.allowSilentUpdates)' \
  apps/web/src/i18n/locales/*.ts | sort
```

Expected after the edit: no matches. Verify with a key-diff against
`types.ts` so no locale retains a key the type no longer declares.

- [ ] **Step 7: Retire the stored `allowSilentUpdates` preference**

In `packages/contracts/src/api/app-config.ts` and
`apps/daemon/src/app-config.ts`, remove the `allowSilentUpdates` field from the
interface, from `ALLOWED_KEYS`, and its validator branch. Follow the existing
retirement convention in `app-config.ts` (see `RETIRED_AGENT_IDS` and the
clone-on-write helpers) so an already-stored `allowSilentUpdates` is dropped on
read rather than resurrected — do not leave the key accepted-but-ignored.

Add coverage in `apps/daemon/tests/app-config.test.ts`: write a literal config
containing `allowSilentUpdates: true` alongside unrelated keys, read it back,
and assert the key is gone while every unrelated key survives.

- [ ] **Step 8: Verify**

```bash
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web test
pnpm i18n:check
pnpm --filter @open-design/daemon exec vitest run tests/app-config.test.ts
pnpm --filter @open-design/daemon typecheck
```

Expected: all pass. `rg -n 'lib/updater|UpdaterPopup|UpdateDialog|silentUpdate' apps/web/src` returns nothing.
`pnpm i18n:check` is the gate that catches a locale left with keys the type no longer declares — across 19 files × 72 keys it will catch a partial removal that typecheck cannot.

- [ ] **Step 9: Commit**

```bash
git add -A apps/web apps/daemon/src/app-config.ts apps/daemon/tests/app-config.test.ts packages/contracts/src/api/app-config.ts
git commit -m "refactor(web): remove the auto-update surface"
```

---

### Task 2: Remove the post-update "what's new" surface

**Files:**
- Delete: `apps/web/src/components/WhatsNewPopup.tsx`, `apps/web/src/components/WhatsNewPopup.module.css`
- Delete: `apps/web/src/lib/whats-new.ts`, `apps/web/tests/lib/whats-new.test.ts`, `apps/web/tests/components/WhatsNewPopup.test.tsx`
- Delete: `apps/daemon/src/services/whats-new.ts`, `apps/daemon/src/routes/whats-new.ts`, `apps/daemon/tests/whats-new.test.ts`
- Delete: `docs/whats-new.md`
- Modify: `apps/web/src/components/EntryShell.tsx`, `apps/web/src/providers/registry.ts` (or wherever `fetchWhatsNew` lives)
- Modify: `apps/daemon/src/server.ts`, `apps/daemon/src/cli.ts`
- Modify: `packages/contracts/src/api/*` (what's-new DTOs), `apps/web/src/i18n/types.ts` + 19 locales

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: no `/api/whats-new` route, no `od whats-new` subcommand, no `WhatsNewPopup`.

- [ ] **Step 1: Confirm the full consumer graph before deleting**

```bash
rg -n "whats-new|whatsNew|WHATS_NEW|WhatsNew" \
  apps packages docs --glob '!node_modules' --glob '!dist' --glob '!.next'
```

Every hit must be accounted for as removed or as a historical doc you are
deliberately leaving (none expected).

- [ ] **Step 2: Delete the web surface**

```bash
git rm -q apps/web/src/components/WhatsNewPopup.tsx apps/web/src/components/WhatsNewPopup.module.css \
  apps/web/src/lib/whats-new.ts apps/web/tests/lib/whats-new.test.ts \
  apps/web/tests/components/WhatsNewPopup.test.tsx
```

Remove the `WhatsNewPopup` mount from `EntryShell.tsx` and its import, plus the
`whatsNew.*` keys from `types.ts` and all 19 locales (2 keys each). If
`apps/web/src/hooks/useAppVersion.ts` is consumed only by the popup, delete it
too; if it has other consumers, leave it.

- [ ] **Step 3: Delete the daemon surface**

```bash
git rm -q apps/daemon/src/services/whats-new.ts apps/daemon/src/routes/whats-new.ts \
  apps/daemon/tests/whats-new.test.ts docs/whats-new.md
```

Unwire `createWhatsNewService()` from the service registry and
`registerWhatsNewRoutes(...)` from the route registration in
`apps/daemon/src/server.ts`, remove the `'whats-new'` entry from
`SUBCOMMAND_MAP` and the `runWhatsNew` handler in `apps/daemon/src/cli.ts`, and
delete the what's-new DTOs from `packages/contracts`.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @open-design/daemon build
pnpm --filter @open-design/daemon test
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web test
```

Expected: all pass, and `rg -n "whats-new|whatsNew" apps packages` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web apps/daemon packages/contracts docs/whats-new.md
git commit -m "refactor(app): remove the post-update what's-new surface"
```

---

### Task 3: Remove the host bridge updater contract

**Files:**
- Modify: `packages/host/src/protocol.ts`, `packages/host/src/actions.ts`, `packages/host/src/detection.ts`, `packages/host/src/normalize.ts`, `packages/host/src/index.ts`, `packages/host/src/testing.ts`
- Modify: `packages/host/tests/index.test.ts`

**Interfaces:**
- Consumes: Task 1 must be complete — `apps/web` is the only consumer of the updater actions.
- Produces: an `OpenDesignHostBridge` whose `updater` namespace no longer exists, with `isOpenDesignHostBridge` structurally validating only the remaining capabilities.

- [ ] **Step 1: Delete the updater types and actions**

From `protocol.ts` remove `OpenDesignHostUpdaterStatusSnapshot`,
`OpenDesignHostUpdaterState`, `OpenDesignHostUpdaterMode`,
`OpenDesignHostUpdaterAction`, `OpenDesignHostUpdaterStatusAction`,
`OpenDesignHostUpdaterResult`, `OpenDesignHostUpdaterMenuLabels`,
`OpenDesignHostUpdaterOpenDialogRequest`, `OpenDesignHostUpdaterOpenDialogListener`,
the `updater` member of `OpenDesignHostBridge`, and the
`__od__` scope's updater entries.

From `actions.ts` remove `OPEN_DESIGN_HOST_UPDATER_ACTIONS` and every wrapper
built on it: `getHostUpdaterStatus`, `checkHostUpdater`,
`clearHostUpdaterCache`, `downloadHostUpdater`, `installHostUpdater`,
`quitHostAfterUpdaterInstallerOpen`, `subscribeHostUpdater`,
`subscribeHostUpdaterOpenDialog`, `setHostUpdaterMenuLabels`. Update the module
doc comment, which currently advertises "the full updater action surface".

From `detection.ts` remove the nine updater methods from the
`isOpenDesignHostBridge` structural check and any updater fields from
`candidateFromScope` / `normalize.ts` / `testing.ts`.

- [ ] **Step 2: Update the host tests**

Rewrite the updater portions of `packages/host/tests/index.test.ts` so the
bridge fixture carries no updater namespace and the structural guard is asserted
against the remaining capabilities. Add a negative assertion that a bridge
*carrying* an `updater` key is still accepted (unknown keys must not be
load-bearing) — this guards against a future reintroduction silently passing.

- [ ] **Step 3: Verify**

```bash
pnpm --filter @open-design/host typecheck
pnpm --filter @open-design/host test
```

Expected: both pass; `rg -n -i updater packages/host/` returns nothing.

- [ ] **Step 4: Commit**

```bash
git add packages/host
git commit -m "refactor(host): drop the updater host bridge contract"
```

---

### Task 4: Remove the desktop updater runtime

**Files:**
- Delete: `apps/desktop/src/main/updater.ts`
- Delete: `apps/desktop/src/main/updater/` (config, feed, store, payload, release-lifecycle, deferred-launch, scheduler, support)
- Delete: `apps/desktop/src/main/update-menu.ts`, `apps/desktop/src/main/update-preflight.ts`
- Delete: `apps/desktop/tests/main/updater.test.ts`, `apps/desktop/tests/main/updater/`, `apps/desktop/tests/main/update-menu.test.ts`, `apps/desktop/tests/main/update-preflight.test.ts`, `apps/desktop/tests/main/updater-host-boundary.test.ts`
- Modify: `apps/desktop/src/main/runtime.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/preload.cts`, `apps/desktop/src/main/installer-observations.ts` (or delete if update-only)
- Modify: `apps/desktop/tests/main/preload-host-boundary.test.ts`, `apps/desktop/tests/main/about-panel-and-base-url.test.ts`
- Modify: `packages/sidecar-proto/src/*` (`DESKTOP_UPDATE_*`, update status/action enums)
- Modify: `apps/desktop/package.json` (drop the `@open-design/launcher-proto` dependency)

**Interfaces:**
- Consumes: Task 3 (the renderer no longer calls any `od:update:*` channel).
- Produces: a desktop main process with no updater object, no scheduler, no `od:update:*` handlers, and no macOS app-menu update item.

- [ ] **Step 1: Delete the updater modules**

```bash
git rm -rq apps/desktop/src/main/updater.ts apps/desktop/src/main/updater \
  apps/desktop/src/main/update-menu.ts apps/desktop/src/main/update-preflight.ts \
  apps/desktop/tests/main/updater.test.ts apps/desktop/tests/main/updater \
  apps/desktop/tests/main/update-menu.test.ts apps/desktop/tests/main/update-preflight.test.ts \
  apps/desktop/tests/main/updater-host-boundary.test.ts
```

Delete `installer-observations.ts` too unless a non-updater caller imports it —
verify with `rg -n "installer-observations" apps/`.

- [ ] **Step 2: Strip `runtime.ts`**

Remove the `UPDATER_IPC_CHANNELS` table and its teardown loop, every
`ipcMain.handle("od:update:*")` registration, `sendUpdaterStatus` and the
status subscription, `guardedUpdaterStatus`, `unavailableUpdaterStatus`,
`checkOptionsFromHost`, `requireMainWindowSender` (if updater-only), the
`od:update:status-changed` / `od:update:open-dialog` events, `openUpdateDialog`
and its deferred flush, and the updater members of the runtime options type.

Do **not** replace `unavailableUpdaterStatus()` with a stub returning an
"unsupported" snapshot — delete the call sites.

- [ ] **Step 3: Strip `index.ts` and `preload.cts`**

In `index.ts` remove the `update-menu` and `updater` imports, the
`DesktopMainOptions.update` input, `resolveAboutPanelVersion` /
`configureAboutPanel` (replace the about-panel version with the app's own
version from `app.getVersion()`), the update submenu item and its
rebuild-on-status subscription in `installDesktopMenu`, the updater
construction, `snapshotUpdateForStatus`, the sidecar `UPDATE` message route, the
menu controller wiring, and the scheduler creation, start, and shutdown stop.
Keep `requestQuit` if the runtime uses it for non-update shutdown; otherwise
remove it with the updater.

In `preload.cts` remove `UPDATER_STATUS_EVENT`,
`UPDATER_OPEN_DIALOG_EVENT`, `invokeUpdater`, and the whole `updater` bridge
object. Keep `OPEN_DESIGN_HOST_GLOBAL` exposure.

- [ ] **Step 4: Remove the sidecar-proto update contract**

Delete `DESKTOP_UPDATE_*` types and the update status/action enums from
`packages/sidecar-proto`. Confirm with:

```bash
rg -n -i 'update' packages/sidecar-proto/src
```

Every remaining hit must be unrelated (e.g. "updatedAt"); if a hit is an
update-lifecycle shape, remove it.

- [ ] **Step 5: Update the boundary tests**

In `preload-host-boundary.test.ts` delete the assertions that the preload
contains `updater`, `od:update:quit`, `od:update:status-changed`,
`od:update:open-dialog`, and `od:update:set-menu-labels`, and add a negative
assertion that `od:update:` does not appear in the preload source. In
`about-panel-and-base-url.test.ts` replace the "version is sourced from
`update.currentVersion`" assertion with the app-version source.

- [ ] **Step 6: Verify**

```bash
pnpm --filter @open-design/desktop typecheck
pnpm --filter @open-design/desktop test
pnpm --filter @open-design/sidecar-proto test
```

Expected: all pass; `rg -n 'od:update:|update-menu|updater' apps/desktop/src` returns nothing.

- [ ] **Step 7: Commit**

```bash
git add -A apps/desktop packages/sidecar-proto
git commit -m "refactor(desktop): remove the packaged auto-updater runtime"
```

---

### Task 5: Remove the standalone updater and versioned launcher

**Files:**
- Delete: `packages/standalone/src/update.ts`, `packages/standalone/src/launcher.ts`
- Modify: `packages/standalone/src/index.ts`, `packages/standalone/tests/*`
- Modify: `shells/terminal/src/cli.ts`, `shells/terminal/src/index.ts`, `shells/terminal/tests/terminal.test.ts`
- Modify: `apps/closure` only if its imports break (it should not — it consumes `sha256Hex` and `StandaloneComponent` from `protocol.ts`)

**Interfaces:**
- Consumes: nothing from Tasks 1–4.
- Produces: `packages/standalone` exporting `protocol.ts` and `store.ts` only; `shells/terminal` with `install`/`start`/`status`/`stop`/`inspect` and no `update`/`apply-update`.

This task implements **D5**. If D5 is narrowed at confirmation, stop after the
`update.ts` deletion and the `update`/`apply-update` subcommand removal, and keep
`launcher.ts` as the terminal launch path.

- [ ] **Step 1: Delete the updater and versioned launcher**

```bash
git rm -q packages/standalone/src/update.ts packages/standalone/src/launcher.ts
```

Update `packages/standalone/src/index.ts` to export only `./protocol.js` and
`./store.js`.

- [ ] **Step 2: Re-point the terminal `start` path**

`FossilBootloader` currently loads the versioned launcher, which selects the
active generation and rolls back to `lastSuccessful` on failure. With one
installed generation there is nothing to select or roll back to, so `start`
boots the installed generation directly through `StandaloneStore` and the
lifecycle port.

Keep `LifecyclePort`, `LifecycleStatus`, and the `GenerationRecord` type in
`store.ts` — they are the lifecycle contract, not update machinery. Delete only
`VersionedLauncher` and `FossilBootloader`.

- [ ] **Step 3: Strip the terminal CLI**

In `shells/terminal/src/cli.ts` remove the `update` and `apply-update` branches,
the `StandaloneUpdater` / `VersionedLauncher` / `FossilBootloader` /
`supportsInstalledShell` imports, and the corresponding usage lines. In
`shells/terminal/src/index.ts` remove `applyTerminalUpdate` and
`InstalledShellIdentity`-only helpers.

Keep `installedChannel(root)`, `install`, `start`, `status`, `stop`, `inspect`,
and `TERMINAL_SHELL_IDENTITY`.

- [ ] **Step 4: Update the terminal tests**

Remove the updater cases from `shells/terminal/tests/terminal.test.ts` and keep
the install/materialize/lifecycle coverage. Assert that a single installed
generation starts without a `lastSuccessful` pointer and that a second install
replaces rather than coexists.

- [ ] **Step 5: Verify**

```bash
pnpm --filter @open-design/standalone build
pnpm --filter @open-design/standalone test
pnpm --filter @open-design/terminal typecheck || pnpm --filter @open-design/terminal build
pnpm --filter @open-design/closure typecheck
```

Expected: all pass; `rg -n 'StandaloneUpdater|VersionedLauncher|FossilBootloader' packages shells apps` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add -A packages/standalone shells/terminal apps/closure
git commit -m "refactor(standalone): remove the shell updater and versioned launcher"
```

---

### Task 6: Boot the packaged desktop directly

**Files:**
- Delete: `apps/packaged/src/launcher-runtime.ts`, `apps/packaged/src/payload-desktop-launch.ts`, `apps/packaged/src/launcher-after-quit.ts`, `apps/packaged/src/obsolete-installed-outer.ts`
- Delete: `apps/packaged/tests/launcher-runtime.test.ts`, `apps/packaged/tests/payload-desktop-launch.test.ts`, `apps/packaged/tests/launcher-after-quit.test.ts`, `apps/packaged/tests/obsolete-installed-outer.test.ts`
- Modify: `apps/packaged/src/index.ts`, `apps/packaged/src/paths.ts`, `apps/packaged/src/sidecars.ts`, `apps/packaged/src/launch.ts`, `apps/packaged/src/headless.ts`
- Modify: `apps/packaged/tests/{paths,launch,sidecars,identity,logging}.test.ts`
- Modify: `apps/packaged/package.json` (drop the `@open-design/launcher-proto` dependency)

**Interfaces:**
- Consumes: nothing from Tasks 1–5, but must land before Task 11 deletes `packages/launcher-proto`.
- Produces: `main()` that goes straight from namespace/argv resolution to `runDesktopMain`, with no launcher-runtime resolution and no `update:` option block.

- [ ] **Step 1: Delete the launcher modules**

```bash
git rm -q apps/packaged/src/launcher-runtime.ts apps/packaged/src/payload-desktop-launch.ts \
  apps/packaged/src/launcher-after-quit.ts apps/packaged/src/obsolete-installed-outer.ts \
  apps/packaged/tests/launcher-runtime.test.ts apps/packaged/tests/payload-desktop-launch.test.ts \
  apps/packaged/tests/launcher-after-quit.test.ts apps/packaged/tests/obsolete-installed-outer.test.ts
```

- [ ] **Step 2: Rewrite the startup path in `index.ts`**

Remove the `parseLauncherAfterQuitArgs` / `parseLauncherHandoffResumeArgs` /
`parseLauncherDelegatedArgs` argv parses, the after-quit wait and
exit-for-existing-desktop branches, `resolvePackagedLauncherRuntime(...)`,
`launchPackagedPayloadDesktop(...)`, `confirmPackagedLauncherRuntime(...)`,
obsolete-outer retirement, and the `applyPackagedUpdaterEnv(...)` call.

The entry becomes: parse the argv stamp → resolve the namespace → resolve
namespace paths → ensure paths and logging → single-instance lock → splash →
boot sidecars with the sidecar env stamp → register `od://` → `runDesktopMain`
with `windowTitle`, preload, and discovered URLs.

Drop `downloadRoot`, `installerObservationRoot`, `launcherLaunchPath`,
`launcherRoot`, `launcherPayloadExtractorPath`, and `launcherRuntimePath` from
the `update:` block passed to `runDesktopMain`, and remove the block itself.

- [ ] **Step 3: Remove update paths from `paths.ts` and `sidecars.ts`**

In `paths.ts` drop `updateRoot` from the namespace path shape and its
derivation (`join(namespaceRoot, "updates")`). In `sidecars.ts` drop the
17-key `OD_UPDATE_*` forward allow-list. In `launch.ts` drop the
`mkdir` of the update root. In `headless.ts` drop the `OD_UPDATE_METADATA_URL`
read.

- [ ] **Step 4: Update the packaged tests**

Remove update-root and launcher expectations from `paths.test.ts`,
`launch.test.ts`, `sidecars.test.ts`, `identity.test.ts`, and `logging.test.ts`.
Keep install identity, `od://` routing, and namespace-scoping coverage.

Add a regression test asserting a packaged cold start writes no `runtime.json`,
no `attempt.json`, and creates no `versions/` directory under the namespace
root.

- [ ] **Step 5: Verify**

```bash
pnpm --filter @open-design/packaged typecheck
pnpm --filter @open-design/packaged test
```

Expected: all pass; `rg -n 'launcher|updateRoot|runtime\.json|attempt\.json' apps/packaged/src` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add -A apps/packaged
git commit -m "refactor(packaged): boot the desktop directly"
```

---

### Task 7: Remove the daemon legacy payload handoff bridge

**Files:**
- Delete: `apps/daemon/src/sidecar/payload-desktop-handoff.ts`, `apps/daemon/tests/sidecar/payload-desktop-handoff.test.ts`
- Modify: `apps/daemon/src/sidecar/index.ts`
- Modify: `apps/daemon/package.json` (drop the `@open-design/launcher-proto` dependency)

**Interfaces:**
- Consumes: Task 6.
- Produces: a daemon sidecar entry that starts the daemon without preparing or executing a payload handoff.

- [ ] **Step 1: Delete the bridge and unwire the sidecar entry**

```bash
git rm -q apps/daemon/src/sidecar/payload-desktop-handoff.ts \
  apps/daemon/tests/sidecar/payload-desktop-handoff.test.ts
```

Remove the `prepareLegacyPayloadDesktopHandoff` call (before
`startDaemonSidecar`) and the fire-and-forget
`executeLegacyPayloadDesktopHandoff` call (after server start) from
`apps/daemon/src/sidecar/index.ts`.

- [ ] **Step 2: Verify**

```bash
pnpm --filter @open-design/daemon typecheck
pnpm --filter @open-design/daemon test
```

Expected: both pass; `rg -n 'payload-desktop-handoff|handoff' apps/daemon/src` returns nothing.

- [ ] **Step 3: Commit**

```bash
git add -A apps/daemon
git commit -m "refactor(daemon): drop the legacy payload handoff bridge"
```

---

### Task 8: Remove the packaging payload lanes and launcher machinery

**Files:**
- Delete: `tools/pack/src/launcher/`, `tools/pack/src/updates/`
- Delete: `tools/pack/src/mac/payload.ts`, `tools/pack/src/win/payload.ts`
- Delete: `tools/pack/tests/launcher/`, `tools/pack/tests/updates/`
- Modify: `tools/pack/src/win/custom-installer.ts`, `tools/pack/src/mac/builder.ts`, `tools/pack/src/win/builder.ts`, `tools/pack/src/win/lifecycle.ts`
- Modify: `tools/pack/src/workspace-build.ts`, `tools/pack/src/linux.ts`, `tools/pack/src/mac/workspace.ts`, `tools/pack/src/mac/constants.ts`, `tools/pack/src/mac/prebundle.ts`, `tools/pack/src/win/constants.ts`, `tools/pack/src/win/app.ts`, `tools/pack/src/win/prebundle.ts`
- Modify: `tools/pack/src/config/index.ts`
- Modify: `tools/pack/tests/{workspace-build,release-workflows,win-builder,win-identity}.test.ts`
- Modify: `tools/pack/package.json` (drop the `@open-design/launcher-proto` dependency)

**Interfaces:**
- Consumes: Task 6 (nothing in the packaged runtime reads these outputs any more).
- Produces: mac/Windows lanes that build and install a single application artifact.

- [ ] **Step 1: Delete the payload and launcher units**

```bash
git rm -rq tools/pack/src/launcher tools/pack/src/updates \
  tools/pack/src/mac/payload.ts tools/pack/src/win/payload.ts \
  tools/pack/tests/launcher tools/pack/tests/updates
```

- [ ] **Step 2: Remove the Windows launcher runtime sync**

In `win/custom-installer.ts` delete `createLauncherRuntimeSyncScript`, the
PowerShell `SyncLauncherRuntime` body that rewrites `runtime.json`, deletes
`attempt.json`, and rewrites `cleanup.json`, and the installer call site that
invokes it. Keep uninstall-version synchronization and registry observation —
they are install identity.

In `win/lifecycle.ts` drop the update-cache lifecycle summary call and its
report field; that reader lived in the deleted `src/updates/`.

- [ ] **Step 3: Remove the payload build targets**

In `mac/builder.ts` and `win/builder.ts` remove the payload archive/manifest
build steps and the `payload` target from the `--to` handling. Keep the
`publish: [{ provider: "generic", ... }]` stub and `--publish never` unless a
lane test requires otherwise — that flag suppresses electron-builder's own feed
and is not the in-app feed.

- [ ] **Step 4: Remove launcher-proto build wiring**

Remove the `packages/launcher-proto` entries and
`pnpm --filter @open-design/launcher-proto build` invocations from
`workspace-build.ts`, `linux.ts`, `mac/workspace.ts`, `mac/constants.ts`,
`mac/prebundle.ts`, `win/constants.ts`, `win/app.ts`, and `win/prebundle.ts`.

- [ ] **Step 5: Remove the update metadata URL from pack config**

In `tools/pack/src/config/index.ts` delete `updateMetadataUrl`,
`resolveToolPackUpdateMetadataUrl`, and its validator. If
`tools-pack ... build` accepts an `--update-metadata-url` flag, remove the flag
and its help text too.

- [ ] **Step 6: Update the pack tests**

Remove payload and launcher cases from `workspace-build.test.ts`,
`release-workflows.test.ts`, `win-builder.test.ts`, and `win-identity.test.ts`.
Keep the NSIS transaction-log, registry-identity, install/uninstall, and
namespace-scoping coverage.

- [ ] **Step 7: Verify**

```bash
pnpm --filter @open-design/tools-pack typecheck
pnpm --filter @open-design/tools-pack test
```

Expected: all pass; `rg -n 'launcher|payload|updateMetadataUrl' tools/pack/src` returns nothing outside unrelated words.

- [ ] **Step 8: Commit**

```bash
git add -A tools/pack
git commit -m "refactor(tools-pack): drop payload lanes and launcher machinery"
```

---

### Task 9: Remove the tools-serve updater fixture

**Files:**
- Delete: `tools/serve/src/updater-fixture.ts`, `tools/serve/tests/updater-fixture.test.ts`
- Modify: `tools/serve/src/index.ts`, `tools/serve/AGENTS.md`, `tools/serve/dist/` (rebuilt)

**Interfaces:**
- Consumes: Task 12 removes the CI callers; either order works, but this task must not land before the e2e helper deletion in Task 13 if the helper would then fail typecheck.
- Produces: `tools-serve` exposing only `release-storage` and `collab-cloud`.

- [ ] **Step 1: Delete the fixture**

```bash
git rm -q tools/serve/src/updater-fixture.ts tools/serve/tests/updater-fixture.test.ts
```

Remove the `updater` branch from `start(service, options)` and the updater-only
option declarations (`--artifact-path`, `--channel`,
`--control-launcher-version-min`, `--control-launcher-version-url`,
`--include-payload`, `--payload-path`, `--platform`, `--version`). Keep the
shared `--host`/`--port`/`--json` plumbing and the other two services.

- [ ] **Step 2: Update the serve docs and rebuild**

Remove the updater fixture rows from `tools/serve/AGENTS.md`.

```bash
pnpm --filter @open-design/tools-serve build
pnpm --filter @open-design/tools-serve typecheck
pnpm --filter @open-design/tools-serve test
```

Expected: all pass; `pnpm tools-serve start updater` exits with an unknown-command error.

- [ ] **Step 3: Commit**

```bash
git add -A tools/serve
git commit -m "refactor(tools-serve): remove the updater fixture service"
```

---

### Task 10: Remove release-side update metadata publication

**Files:**
- Delete: `tools/release/src/storage/launcher-version-floor.ts`, `tools/release/tests/launcher-version-floor.test.ts`
- Modify: `tools/release/src/storage/publish-metadata.ts`, `tools/release/src/storage/verify-metadata.ts`
- Modify: `tools/serve/tests/release-metadata-publish.test.ts`
- Modify: `.github/scripts/release/publish-beta-metadata.ps1`

**Interfaces:**
- Consumes: Task 9 (the storage fixture tests share a package).
- Produces: a publisher that uploads artifacts and platform manifests but writes no `latest/metadata.json` and no `control.launcher.version` block.

- [ ] **Step 1: Delete the floor policy**

```bash
git rm -q tools/release/src/storage/launcher-version-floor.ts \
  tools/release/tests/launcher-version-floor.test.ts
```

- [ ] **Step 2: Strip `publish-metadata.ts`**

Remove the floor import and resolution, the satisfiability assertion, the
`controlBlock` function, and the `uploadLatestMetadataWithCas` call that writes
`<channel>/latest/metadata.json`. Keep immutable version copies and
`publishLatestPlatformObjects` — those are how a manual download resolves an
artifact.

Remove `latestMetadataUrl` / `versionMetadataUrl` from the command's outputs and
their consumers in the release workflows and report.

- [ ] **Step 3: Strip `verify-metadata.ts`**

Remove the launcher-floor mirror checks so verification matches what is
published.

- [ ] **Step 4: Strip the legacy PowerShell publisher**

In `.github/scripts/release/publish-beta-metadata.ps1` remove the
`metadata.json` write and the `latestMetadataUrl` / `versionMetadataUrl`
outputs. If the script becomes a no-op, delete it and its callers instead of
leaving an empty script.

- [ ] **Step 5: Update the storage tests**

In `tools/serve/tests/release-metadata-publish.test.ts` remove the
`control?.launcher?.version?.min/url` assertions and any `latest/metadata.json`
object assertions; keep platform manifest and artifact publish coverage.

- [ ] **Step 6: Verify**

```bash
pnpm --filter @open-design/tools-release typecheck
pnpm --filter @open-design/tools-release test
pnpm --filter @open-design/tools-serve test
```

Expected: all pass; `rg -n 'launcher|metadata.json' tools/release/src` returns only unrelated hits.

- [ ] **Step 7: Commit**

```bash
git add -A tools/release tools/serve/tests .github/scripts/release
git commit -m "refactor(tools-release): stop publishing updater metadata"
```

---

### Task 11: Delete the launcher protocol package

**Files:**
- Delete: `packages/launcher-proto/` (whole directory)
- Modify: `flake.nix`, `scripts/guard.ts`, `scripts/postinstall.mjs`, `packages/AGENTS.md`

**Interfaces:**
- Consumes: Tasks 4, 6, 7, and 8 must all be complete — they are the last importers.
- Produces: a workspace with no launcher protocol package.

- [ ] **Step 1: Confirm no importers remain**

```bash
rg -n '@open-design/launcher-proto' --glob '!node_modules' --glob '!dist' .
```

Expected: only `packages/launcher-proto/**`, `pnpm-lock.yaml`, and the four
files you are about to edit.

- [ ] **Step 2: Delete the package and its wiring**

```bash
git rm -rq packages/launcher-proto
```

Remove its entry from `flake.nix`, from the `scripts/guard.ts` package list, from
`scripts/postinstall.mjs`, and from the package responsibility list in
`packages/AGENTS.md`.

- [ ] **Step 3: Reinstall and verify**

```bash
pnpm install
pnpm guard
pnpm typecheck
```

Expected: the lockfile drops the package, `guard` passes, and typecheck is clean.

- [ ] **Step 4: Commit**

```bash
git add -A packages/launcher-proto flake.nix scripts packages/AGENTS.md pnpm-lock.yaml
git commit -m "refactor(packages): delete the launcher protocol package"
```

---

### Task 12: Remove CI update fixtures, floor variables, and scope routing

**Files:**
- Modify: `.github/workflows/release-beta.yml`, `release-stable.yml`, `release-prerelease.yml`, `notify-release-feishu.yml`, `ci.yml`
- Modify: `.github/config/scopes.json`, `.github/config/convergence.json`
- Modify: `specs/current/ci.md`

Read `.github/AGENTS.md` and `specs/current/ci.md` before editing — the root
`AGENTS.md` requires both before changing CI scope routing, and
`.github/AGENTS.md` requires cross-workflow changes to update the topology tests
(handled in Task 13).

- [ ] **Step 1: Remove the update-fixture workflow surface**

In each of `release-beta.yml`, `release-stable.yml`, and
`release-prerelease.yml`:

- Remove the `*_update_metadata_url` and `*_update_target_version` inputs and
  their outputs.
- Remove the "Build <platform> update fixture" steps and the
  `OD_PACKAGED_E2E_*_UPDATE_FIXTURE` / `OD_PACKAGED_E2E_*_UPDATE_*` env entries.
- Remove the `RELEASE_LAUNCHER_VERSION_MIN_*` and `..._MIN_URL_*` env
  passthrough beside `publish-metadata`.
- Remove the `publish-metadata` step's metadata-URL outputs from any job output
  map.

If `mac_arm64_smoke_mode` / `win_x64_smoke_mode` existed only to select the
update fixture, collapse them; if they still select meaningful smoke depth, keep
them and update their descriptions. Fix the `||`-chain empty-string bug comment
in `notify-release-feishu.yml` only if the chain itself is removed.

- [ ] **Step 2: Remove the packaged update smoke from `ci.yml`**

Remove the focused fallback step running
`e2e test tests/packaged-launcher-update-loop.test.ts` and the
`tools-pack ... tests/launcher/windows/payload.test.ts` step. Leave the broad
`e2e_vitest` run; Task 13 removes the deleted files from its scope.

- [ ] **Step 3: Remove the scope workload**

In `.github/config/scopes.json` remove the `windows-launcher-payload` workload
set and the `certain-windows-launcher-payload` rule, and remove
`tools/pack/src/launcher/` and `tools/pack/src/updates/` from the packaged-leaf
source unit.

In `.github/config/convergence.json` remove the `packages/launcher-proto/` entry
and the `windows-launcher-payload` workload plus its suite mapping.

- [ ] **Step 4: Update the CI spec**

Update `specs/current/ci.md` to drop the packaged-launcher-update-loop fallback,
the `certain-windows-launcher-payload` rule, its source closure, and the
"Windows launcher-payload tests" workload row.

- [ ] **Step 5: Verify**

```bash
python3 -c "import json,sys; [json.load(open(p)) for p in ['.github/config/scopes.json','.github/config/convergence.json']]; print('json ok')"
pnpm --filter @open-design/e2e test tests/scripts/scopes.test.ts
rg -n 'LAUNCHER_VERSION_MIN|update_metadata_url|launcher-payload|launcher-proto' .github specs/current/ci.md
```

Expected: JSON parses, the scopes test passes, and the final grep returns nothing.

- [ ] **Step 6: Commit**

```bash
git add -A .github specs/current/ci.md
git commit -m "ci: drop updater fixtures and launcher scope routing"
```

---

### Task 13: Retire the updater e2e suites and re-scope platform specs

**Files:**
- Delete: `e2e/tests/packaged-launcher-update-loop.test.ts`, `e2e/tests/updater-fixture.test.ts`, `e2e/tests/packaged/update-scenario.test.ts`, `e2e/ui/updater-popup-stacking.test.ts`, `e2e/ui/settings-about-update-actions-gap.test.ts`, `e2e/lib/vitest/tools-serve-updater-fixture.ts`, `e2e/lib/vitest/packaged-update-scenario.ts`
- Modify: `e2e/specs/mac.spec.ts`, `e2e/specs/win.spec.ts`, `e2e/ui/entry-chrome-flows.test.ts`, `e2e/lib/vitest/packaged-smoke-profile.ts`, `e2e/tests/packaged/smoke-profile.test.ts`, `e2e/tests/packaged-smoke-workflow.test.ts`, `e2e/lib/vitest/packaged-app-shell.ts`, `e2e/tests/packaged/app-shell.test.ts`

Read `e2e/AGENTS.md` first — it governs layout, the neutral `lib/tools-dev/`
boundary, and the `@/playwright/suite` import rule.

- [ ] **Step 1: Delete the update-only suites**

```bash
git rm -q e2e/tests/packaged-launcher-update-loop.test.ts e2e/tests/updater-fixture.test.ts \
  e2e/tests/packaged/update-scenario.test.ts e2e/ui/updater-popup-stacking.test.ts \
  e2e/ui/settings-about-update-actions-gap.test.ts \
  e2e/lib/vitest/tools-serve-updater-fixture.ts e2e/lib/vitest/packaged-update-scenario.ts
```

- [ ] **Step 2: Surgically edit the platform specs**

In `e2e/specs/mac.spec.ts` and `e2e/specs/win.spec.ts` remove the update env
plumbing, the updater popup/click expressions, the `UpdaterRecoverySummary`
types, the update acceptance and recovery segment inside the main
install/start/inspect/stop/uninstall test, and the `silentUpdateTest` and
`rollbackTest` cases. Keep install, start, inspect, stop, uninstall, and every
non-update shell test intact.

These specs currently pass with update segments interleaved — re-read each
remaining test after the cut so no assertion depends on state the removed
segment produced.

- [ ] **Step 3: Edit the mixed UI and workflow tests**

In `e2e/ui/entry-chrome-flows.test.ts` remove the two Settings-About update
tests ("reads desktop updater status and runs a manual update check" and
"surfaces prerelease updater check failures with retry affordance"); keep
`test:ui:critical` membership intact.

In `e2e/tests/packaged-smoke-workflow.test.ts` remove the update-fixture
topology assertions: the launcher-update-loop fallback reference, the
`OD_PACKAGED_E2E_*_UPDATE_FIXTURE` expectations and
`expectWindowsUpdaterSmokeContract`, the update-fixture step name in the
prerelease-advisory test, and the beta metadata publish / launcher payload
artifact assertions.

- [ ] **Step 4: Collapse the smoke profile**

In `e2e/lib/vitest/packaged-smoke-profile.ts` and its test, remove the
"`full` additionally drives the updater" definition. Keep core/full/skip
resolution, but re-define `full` in terms of whatever it now selects (or drop
the level if nothing distinguishes it), and update the doc comment that frames
the resolution around the updater path.

In `e2e/lib/vitest/packaged-app-shell.ts` and `e2e/tests/packaged/app-shell.test.ts`
remove the `entry-nav-updater` fixture node, the comment referencing
`clickUpdaterRailExpression`, and any assertions built on them.

- [ ] **Step 5: Verify**

```bash
pnpm --filter @open-design/e2e test tests/packaged/smoke-profile.test.ts
pnpm --filter @open-design/e2e test tests/packaged-smoke-workflow.test.ts
pnpm --filter @open-design/e2e test tests/packaged/app-shell.test.ts
rg -n -i 'updat' e2e/lib e2e/tests e2e/ui e2e/specs
```

Expected: the three suites pass and the final grep returns only unrelated
matches (`updatedAt`, React state updaters). Report the surviving hits in the
commit message if any remain.

- [ ] **Step 6: Commit**

```bash
git add -A e2e
git commit -m "test(e2e): retire updater coverage and re-scope packaged specs"
```

---

### Task 14: Remove updater docs, sweep dead config, prove the gates

**Files:**
- Delete: `docs/testing/updater-lifecycle.md`
- Modify: `tools/pack/AGENTS.md`, `tools/pack/README.md`, `tools/pack/CACHE.md`
- Modify: `docs/architecture.md`, `docs/testing/e2e-coverage/status.md`
- Modify: `AGENTS.md`, `tools/AGENTS.md`
- Modify: `packages/release/src/index.ts` only if a channel/version helper was update-only (expected: unchanged)

**Interfaces:**
- Consumes: every prior task.
- Produces: a repository whose docs describe only the shipped behavior.

- [ ] **Step 1: Delete the lifecycle map**

```bash
git rm -q docs/testing/updater-lifecycle.md
```

Remove the `../updater-lifecycle.md` pointer from
`docs/testing/e2e-coverage/status.md` and the updater gap/PR references on the
same page. Leave the rest of `status.md` intact.

- [ ] **Step 2: Rewrite the pack docs**

In `tools/pack/AGENTS.md` delete the entire
`## Packaged auto-update architecture and harness` section (architecture map,
release metadata shape, channel identity, fixture harness, high-confidence
user-flow acceptance, validation matrix). Keep the channel-identity rules that
govern install/uninstall/shortcuts/registry/app-data identity — move them under
a renamed section if they currently live inside the deleted one.

In `tools/pack/README.md` delete the update paragraph and the Linux
"no auto-update feed" note, replacing the latter with a plain statement that
packaged builds install a single artifact and do not self-update.

In `tools/pack/CACHE.md` remove the `win.launcher-payload-base` /
`win.launcher-payload` cache nodes, the `updateMetadataUrl`
materialization-time parameter, the payload key rules, and the corresponding
low-confidence points.

- [ ] **Step 3: Update the root and tools guides**

In `AGENTS.md` remove the `tools/pack/AGENTS.md` updater-section pointer, the
`tools/pack/CACHE.md` updater requirement, and `pnpm tools-serve start updater`
from the common commands. In `tools/AGENTS.md` remove the
`tools-serve start updater` ownership line, the packaged-updater acceptance
harness mention, and the fixture command.

In `docs/architecture.md` remove "update" from the
`tools/pack/AGENTS.md` pointer sentence.

- [ ] **Step 4: Sweep for survivors**

```bash
rg -n 'OD_UPDATE_|od:update:|launcher-proto|StandaloneUpdater|VersionedLauncher|UpdaterPopup|WhatsNewPopup|runtime\.json|attempt\.json|updateMetadataUrl|LAUNCHER_VERSION_MIN' \
  --glob '!node_modules' --glob '!dist' --glob '!.next' --glob '!CHANGELOG.md' \
  --glob '!specs/change/20260910-remove-auto-update/**' \
  apps packages tools shells e2e docs scripts .github
```

Compare against `/tmp/removal-baseline.txt` from Execution Setup. Every surviving
hit must be justified in the commit message; expected survivors are historical
blog/content assets under `plugins/_official/` and `design-templates/`, which are
shipped example content, not product code.

- [ ] **Step 5: Run the full gates**

```bash
pnpm install
pnpm guard
pnpm typecheck
pnpm i18n:check
pnpm i18n:coverage
pnpm --filter @open-design/daemon test
pnpm --filter @open-design/web test
pnpm --filter @open-design/desktop test
pnpm --filter @open-design/packaged test
pnpm --filter @open-design/host test
pnpm --filter @open-design/tools-pack test
pnpm --filter @open-design/tools-serve test
pnpm --filter @open-design/tools-release test
pnpm --filter @open-design/standalone test
pnpm --filter @open-design/daemon build
```

Expected: every command exits 0. Record the transcript for the PR.

- [ ] **Step 6: Prove a packaged cold start is update-free**

Build and install one lane end to end (macOS or Windows, whichever host is
available), then confirm the installed root contains no `versions/`,
`runtime.json`, or `attempt.json`, and that a cold start makes no request to a
release metadata host. Capture the evidence for the PR body, which the root
`AGENTS.md` requires for non-trivial changes.

- [ ] **Step 7: Commit**

```bash
git add -A docs AGENTS.md tools/AGENTS.md tools/pack/AGENTS.md tools/pack/README.md tools/pack/CACHE.md
git commit -m "docs: describe the update-free distribution"
```

---

## Known Deliberate Gaps

- **Existing installed outers are not migrated.** A user on an older build stays
  on that build until they reinstall manually. The bridge that used to migrate
  them is removed with this change; this is inherent to removing updates and is
  documented in the spec's "Existing Installs" section.
- **Orphaned update state is inert, not reclaimed.** A root that previously ran
  an updater keeps `releases/`, `staging/`, `downloads/`, `.back/`, and stale
  `attempt.json`/`cleanup.json` until manually removed. The code that could
  clean it is removed here, so this is accepted rather than handled.
- **`tools/pack` `publish` stubs stay.** `publish: [{ provider: "generic", url:
  "https://updates.invalid/open-design" }]` plus `--publish never` exist to
  suppress electron-builder's own feed. They are not the in-app feed and are left
  alone unless a lane test requires their removal.
- **Windows/Linux lanes are host-gated.** macOS and Windows artifact acceptance
  cannot run on a Linux host; Step 6 of Task 14 covers whichever lane the host
  supports, and the remainder is validated in CI.
