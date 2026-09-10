---
id: 20260910-remove-auto-update
name: Remove Auto-Update and Versioned Distribution
status: proposed
created: '2026-09-10'
---

## Overview

### Problem Statement

Open Design carries two independent self-update stacks plus a versioned
launcher/payload distribution model that exists *only* so an installed app can
replace itself in place:

1. **Packaged desktop auto-updater (macOS/Windows).** `apps/desktop` polls
   `https://releases.open-design.ai/<channel>/latest/metadata.json`, verifies a
   checksummed artifact, stages it under the namespace update root, activates a
   new generation, and restarts into it. Roughly 4,100 lines of source across
   `apps/desktop/src/main/updater*` plus ~4,250 lines of tests, a renderer UI
   (`UpdaterPopup` / `UpdateDialog` / Settings → About), a nine-method IPC
   surface, and a host bridge contract.
2. **Standalone shell updater.** `packages/standalone` owns signed-metadata
   verification, content-addressed materialization and the
   `StandaloneUpdater`/`VersionedLauncher`/`FossilBootloader` chain consumed by
   `shells/terminal` (`update` / `apply-update` subcommands).
3. **Versioned launcher / payload distribution.** `packages/launcher-proto` and
   `apps/packaged`'s launcher runtime write `runtime.json`/`attempt.json`/
   `install.json` on every cold start and delegate to a per-version payload
   desktop staged under `<root>/launcher/channels/<channel>/.../versions/<v>/`.
   `tools/pack` builds that payload for both platform lanes and the NSIS
   installer syncs the generation pointer.

Every one of these exists to serve in-place updates. The product has moved to a
single-player local application distributed as a downloadable installer, so the
update loop, the release feed that drives it, the generation machinery it needs,
and the UI that surfaces it are all cost without benefit: network calls on a
timer, checksum/staging/rollback state machines, extra process hops at startup,
a large test surface, and a release pipeline that publishes metadata nothing
would consume.

### Goals

- Remove the packaged desktop auto-updater end to end: scheduler, feed client,
  download/verify/stage/activate chain, release lifecycle/cleanup, deferred
  launcher helpers, IPC surface, renderer UI, and macOS app-menu item.
- Remove the standalone shell updater and the versioned launcher chain from
  `packages/standalone`, and the `update`/`apply-update` lifecycle from
  `shells/terminal`.
- Remove the versioned launcher/payload distribution model: the installed
  application **is** the application. `apps/packaged` boots the desktop directly
  instead of selecting and delegating to a payload generation.
- Remove release-side update publication: `latest/metadata.json`,
  `control.launcher.version.{min,url}`, the launcher version floor policy, and
  the CI update-fixture build/run path.
- Remove the post-update "what's new" surface (it only has meaning immediately
  after an update).
- Leave no disabled routes, no-op adapters, hidden flags, or compatibility
  stubs that could reactivate any of the above.

### Non-Goals

- **Not** removing release artifact building or storage publishing. Installers
  are still built, signed, uploaded, and downloaded manually.
- **Not** removing release channels, release namespaces, or app identity.
  `beta`/`prerelease`/`preview`/`stable`, namespace-scoped install/data/log
  paths, the `od://` protocol, and channel-specific product names stay.
- **Not** removing `packages/release` channel/version primitives — packaging and
  namespace derivation still depend on them.
- **Not** touching historical records. `CHANGELOG.md`, landing-page blog posts,
  and past `specs/change/*` entries stay readable; they are history, not active
  behavior.
- **Not** touching the Docker `deploy/scripts/update.sh` documented in
  `docs/install-guide.md` — that is image redeployment, a different mechanism.
- **Not** removing `apps/closure`, `shells/terminal` as a carrier, or
  `packages/standalone`'s verification/materialization primitives.

### Success Criteria

- No source file under `apps/`, `packages/`, `tools/`, `shells/` or `e2e/`
  references `OD_UPDATE_*`, `od:update:`, `launcher-proto`, `StandaloneUpdater`,
  `VersionedLauncher`, `runtime.json`, `attempt.json`, or the update UI.
- A freshly built and installed macOS/Windows artifact starts with no
  `versions/`, `runtime.json`, or `attempt.json` anywhere under its root, and no
  outbound request to a release metadata host.
- Settings → About shows version/channel/runtime facts and no update controls.
- `pnpm guard`, `pnpm typecheck`, and every touched package's tests pass.
- CI has no update-fixture job, no `RELEASE_LAUNCHER_VERSION_MIN_*` variable, and
  no `windows-launcher-payload` scope workload.

## Design

### Decisions

| # | Decision | Source |
| --- | --- | --- |
| D1 | Remove **both** update stacks, not just the packaged desktop one. | Confirmed |
| D2 | Remove release-side update metadata publication as part of this change. | Confirmed |
| D3 | Remove the versioned launcher/payload distribution model; the installed app boots its own desktop. | Confirmed |
| D4 | Remove the post-update "what's new" surface with the update lifecycle. | Confirmed |
| D5 | Extend the D3 principle to `shells/terminal`: drop the multi-generation launcher, keep a single installed generation with install/start/status/stop/inspect. | Derived from D3 |

**D5 is the one derived call.** It keeps `packages/standalone`'s
`protocol.ts` (signing, digests, metadata verification) and `store.ts`
(materialization, generation records) but deletes `update.ts` and `launcher.ts`.
`shells/terminal` keeps `install`, `start`, `status`, `stop`, `inspect` and
loses `update` / `apply-update`. If you would rather remove only the terminal
`update`/`apply-update` subcommands and keep `VersionedLauncher` /
`FossilBootloader` as the terminal launch path, say so at confirmation — it is a
one-task change to the plan, not a re-plan.

### Removal Boundary

**Removed**

| Surface | Owner |
| --- | --- |
| `updater.ts`, `updater/{config,feed,store,payload,release-lifecycle,deferred-launch,scheduler,support}.ts` | `apps/desktop` |
| `update-menu.ts`, `update-preflight.ts`, installer-observation hooks | `apps/desktop` |
| `od:update:*` IPC handlers, status/dialog events, teardown table entries | `apps/desktop` |
| `updater` namespace on the preload host bridge | `apps/desktop` |
| `UpdaterPopup`, `UpdateDialog`, Settings → About update rows, silent-update preference, `lib/updater.ts` | `apps/web` |
| `UpdaterStatus*` / `UpdaterMode` / `UpdaterAction*` / menu-label / open-dialog types and actions | `packages/host` |
| `update.ts` (`StandaloneUpdater`), `launcher.ts` (`VersionedLauncher`, `FossilBootloader`) | `packages/standalone` |
| `update` / `apply-update` subcommands, `applyTerminalUpdate` | `shells/terminal` |
| `packages/launcher-proto` (whole package) | `packages` |
| `launcher-runtime.ts`, `payload-desktop-launch.ts`, `launcher-after-quit.ts`, `obsolete-installed-outer.ts`, payload delegation in `index.ts` | `apps/packaged` |
| `payload-desktop-handoff.ts` and its sidecar wiring | `apps/daemon` |
| `whats-new` service, routes, `od whats-new`, web popup | `apps/daemon`, `apps/web` |
| `src/launcher/`, `src/updates/`, `mac/payload.ts`, `win/payload.ts`, NSIS runtime sync, launcher-proto build wiring | `tools/pack` |
| `updater` fixture service | `tools/serve` |
| `launcher-version-floor.ts`, `control.launcher.version` block, floor checks in `verify-metadata.ts` | `tools/release` |
| Update fixture builds, `*_update_metadata_url` inputs, floor repo vars, update smoke assertions | `.github` |
| All updater e2e specs/tests and the `full` smoke profile's update segment | `e2e` |
| `docs/testing/updater-lifecycle.md`, `docs/whats-new.md`, `tools/pack/AGENTS.md` updater section | `docs` |

**Kept**

| Surface | Why |
| --- | --- |
| Release channels, release namespaces, channel-specific product identity | Install, data scoping, and update-free distribution still need them |
| Namespace-scoped data/log/runtime paths; no ports in paths | Root `AGENTS.md` contract, unchanged |
| `packages/release` channel/version primitives | Packaging namespace derivation, `apps/desktop` config |
| `packages/standalone` `protocol.ts` + `store.ts` | Install-time verification and materialization |
| `apps/packaged` sidecar boot, `od://` routing, identity gate, logging, headless | Product runtime |
| `tools/pack` artifact build/install/start/stop/logs/uninstall/cleanup/list/reset and release artifact preparation | Distribution |
| `tools/serve` `release-storage` and `collab-cloud` fixtures | Unrelated |

### Launch Path After Removal

Today a packaged cold start is: outer executable → `resolvePackagedLauncherRuntime`
(reads/writes `install.json`, `runtime.json`, `attempt.json`) → select a version
directory → `launchPackagedPayloadDesktop` spawns that version's desktop
executable → desktop boots sidecars.

After removal it is: installed executable → `runDesktopMain` → desktop boots
sidecars. `apps/packaged/src/index.ts` keeps namespace resolution, the argv
stamp, single-instance lock, splash, sidecar boot, `od://` registration, and the
`runDesktopMain` call; it loses the launcher-runtime resolution, payload
delegation, obsolete-outer retirement, and the `update:` block passed to
`runDesktopMain`. `apps/packaged/src/paths.ts` loses `updateRoot`.

The `apps/packaged` `headless` lane and `windows-lifecycle.ts` keep working:
they never depended on the generation model, only on paths.

### Installer and Packaging Shape

- mac and Windows lanes build and install a single application artifact. The
  `payload` build target and the launcher payload manifest/archive are gone, as
  is `tools/pack/src/launcher/` (layout, payload layout, generation-0 runtime
  descriptor) and `tools/pack/src/updates/` (cache lifecycle snapshot).
- The NSIS `SyncLauncherRuntime` PowerShell helper that rewrote `runtime.json`
  and deleted `attempt.json` at install time is removed.
- `tools/pack/src/mac/builder.ts` and `win/builder.ts` keep their `publish:
  [{provider: "generic", ...}]` stubs and `--publish never`; that flag already
  prevents electron-builder from publishing its own feed and is not the in-app
  feed. Leave it unless a lane's tests require otherwise.
- Windows uninstall-version synchronization and registry identity observation
  stay — they are install identity, not updates.

### Existing Installs

An already-installed older build keeps working; it simply never updates. The
daemon's `payload-desktop-handoff.ts` bridge exists to migrate a historical
outer onto a newer payload — with updates gone there is nothing to migrate to,
so it is removed and those installs stay on their installed version until
reinstalled manually. This is accepted and documented, not worked around.

No data migration is required: update state lived under the namespace update
root (`releases/`, `staging/`, `downloads/`, `.back/`, `attempt.json`,
`cleanup.json`), which becomes orphaned rather than read. The spec does remove
the code that could clean it, so the plan includes an explicit note that
leftover directories are inert.

### Error and Compatibility Behavior

- No update capability may be signalled as "unavailable", "disabled", or
  "unsupported" — the concept is gone. `unavailableUpdaterStatus()` and any
  `supported`/`enabled` capability flags are deleted rather than stubbed to
  `false`.
- `packages/host`'s `isOpenDesignHostBridge` must stop requiring the updater
  namespace; the remaining bridge surface stays structurally checked.
- `OdUpdate*`-style contract types in `packages/contracts` and
  `packages/sidecar-proto` are removed, not deprecated.

### Test Strategy

- **Deleted outright (update-only):** `apps/desktop/tests/main/updater.test.ts`,
  `updater/`, `update-menu.test.ts`, `update-preflight.test.ts`,
  `updater-host-boundary.test.ts`, `updater/config.test.ts`; the web updater
  component/lib/preference tests; `e2e/tests/packaged-launcher-update-loop.test.ts`,
  `e2e/tests/updater-fixture.test.ts`, `e2e/tests/packaged/update-scenario.test.ts`,
  `e2e/ui/updater-popup-stacking.test.ts`,
  `e2e/ui/settings-about-update-actions-gap.test.ts`,
  `e2e/lib/vitest/tools-serve-updater-fixture.ts`,
  `e2e/lib/vitest/packaged-update-scenario.ts`, `tools/serve` fixture tests,
  `tools/release` floor tests, `tools/pack` launcher/updates tests, and
  `packages/launcher-proto` tests with the package.
- **Surgically edited (mixed ownership):** `e2e/specs/mac.spec.ts` and
  `e2e/specs/win.spec.ts` lose their update fixtures and recovery segments but
  keep install/start/inspect/stop/uninstall coverage; `e2e/ui/entry-chrome-flows.test.ts`
  loses its two Settings-About update tests; `e2e/lib/vitest/packaged-smoke-profile.ts`
  and its test lose the `full`-implies-updater contract;
  `e2e/tests/packaged-smoke-workflow.test.ts` loses the update-fixture topology
  assertions; `apps/desktop/tests/main/preload-host-boundary.test.ts` and
  `about-panel-and-base-url.test.ts` lose their updater assertions.
- **New coverage:** a regression test asserting the removed surfaces stay gone
  (no `od:update:*` handler, no `updater` preload namespace, no `runtime.json` /
  `attempt.json` written on a packaged cold start). Following the repo's
  bug-fix rule, the cheapest layer that sees the symptom is the app Vitest layer
  for the IPC/preload assertions.

### Delivery

- One concern per commit, in dependency order: renderer surfaces → host
  contract → desktop runtime → packages → packaged/launcher → tools → CI → e2e
  → docs.
- No `Co-authored-by` trailers.
- Non-trivial feature removal: this spec is the issue-first artifact required by
  the root `AGENTS.md`.
