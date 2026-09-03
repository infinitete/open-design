# tools/pack

Follow the root `AGENTS.md` and `tools/AGENTS.md` first. This tool owns the repo-external packaged build/start/stop/logs command surface.

Read `tools/pack/CACHE.md` before changing any build-cache node key, adding a cache node, or changing what a cached node reads or writes (determinant rules, materialization-time parameters, signing boundary, confidence grading).

## Owns

- Local packaging orchestration: mac / Windows NSIS / Linux AppImage build/install/start/stop/logs/uninstall/cleanup/list/reset, plus beta release artifact preparation.
- Linux extras: `--headless` install/start/stop (no Electron), `--containerized` builds (distro-agnostic glibc), `--to deb` lane (fixed dpkg name `open-design`, namespace-scoped artifact names; no lifecycle — start/stop/logs/inspect stay AppImage-only, deb install/uninstall never stops running instances).
- Windows registry observation/cleanup via `reg.exe`, scoped to namespace install/uninstaller paths; lifecycle logs carry NSIS automation markers/timings plus app runtime logs.
- Sidecar/process/path primitives consumed from `@open-design/sidecar-proto`, `@open-design/sidecar`, `@open-design/platform`.

## Does not own

Product business logic, sidecar protocol definitions, a second process identity model, or product update runtime integration (updater surface lives in `apps/desktop`, handoff in `apps/packaged` — do not duplicate that logic here).

## Rules

- Keep cross-platform responsibilities in named dirs (`cache/`, `config/`, `launcher/`, `resources/`, `updates/`, `versioning/`); platform behavior below `mac/`/`win/`. Mirror in `tests/`. A new root-level `src/*.ts` is unclassified by CI and pays the conservative Windows payload fallback until placed in an owned unit.
- Tests import source through the test-only `@/*` alias (`?raw` suffix for source-text inspection); no depth-dependent `../src/` imports or file URLs.
- Do not hand-build `--od-stamp-*` args; use `createProcessStampArgs` with `OPEN_DESIGN_SIDECAR_CONTRACT`.
- No port numbers in data/log/runtime/cache path decisions — namespace decides, ports are transient transports. Namespace-named `.app` installs do not change path conventions either.
- Public artifacts use channel-specific identity: `Open Design` / `Open Design Beta` / `Open Design Prerelease` / `Open Design Preview`. Namespace-scoped install paths are a developer multi-instance convention only.
- `--dir` = output/runtime/install validation root, never the cache root (default workspace cache is the hot path; `--cache-dir` is a cold-cache/isolation escape hatch only). Use `--portable` for public/release artifacts so local build-machine roots never bake into packaged config.
- Electron-builder resources belong under `tools/pack/resources/`; never point pack logic at Downloads, web public assets, docs assets, or other app-owned paths.
- Windows NSIS smoke uses short namespaces (`rg`, `smoke`, `nsis-a`): deep Next.js standalone trees under long namespaces exceed the 260-char path limit (`regression-merge-nsis` hit 264 chars and silently missed an installed file while `rg` passed). Long namespaces only when intentionally testing path length.
- The deb lane ships its own space-safe after-install/after-remove scripts (rendered in `src/linux.ts`, wired via `deb.afterInstall`/`deb.afterRemove`): electron-builder's default templates register an update-alternatives name containing the product name's space, which Debian rejects. The same scripts also rename the installed hicolor icon from the space-containing `<productName>.png` to the space-free dpkg package name (`deb.desktop.entry.Icon` points at that name via `debDesktopEntry`), because gtk-update-icon-cache cannot cache icon names containing spaces and fails with "The generated cache was invalid".

## Packaged auto-update architecture and harness

Read this section before changing auto-update behavior — bugs hide between otherwise-green package tests. Full lifecycle→test map: `docs/testing/updater-lifecycle.md`.

### Architecture map

- `apps/desktop/src/main/updater.ts`: updater state, metadata parsing, artifact selection, checksum verification, download store, progress events, installer opening (tested in `apps/desktop/tests/main/updater.test.ts`).
- `apps/desktop/src/main/runtime.ts`: updater IPC (`od:update:status|check|download|install|quit`, `od:update:status-changed`). Installer launch stays separate from shutdown — quit is an explicit post-installer action.
- `apps/desktop/src/main/index.ts`: scheduler + packaged macOS app-menu item (mirrors state, opens renderer dialog; no second updater, no native result dialog; Win/Linux menus expose no update actions).
- `apps/web`: `src/lib/updater.ts` normalizes snapshots; `UpdaterPopup.tsx` is the ready-update surface; `UpdateDialog.tsx` owns the macOS menu check flow. All copy/menu labels go through `apps/web/src/i18n`.
- `packages/launcher-proto`: launcher pointer/attempt/handoff-journal shapes. `runtime.json` + `attempt.json` is the only payload-version state machine.
- `apps/packaged/src/index.ts`: delegates to the selected payload desktop, passing `appVersion` + namespace-scoped `updateRoot` only when the outer itself must run.
- `apps/daemon/src/sidecar/payload-desktop-handoff.ts`: compatibility bridge for historical outers only (rearms previous pointer, persists desktop-binding journal; journal is not a second version selector). `install.json` keeps identifying the physical outer — activation/handoff must not rewrite it.
- `tools/serve` owns deterministic updater fixtures only — no product updater logic.

### Release metadata shape

Runtime reads `https://releases.open-design.ai/<channel>/latest/metadata.json` (`OD_UPDATE_METADATA_URL` overrides). Package-launcher context prefers `platforms.<platform>.artifacts.payload`, installer as recovery fallback. Artifacts need a checksum (prefer `sha256Url`) — bytes verify before any install action. `OD_UPDATE_CURRENT_VERSION` overrides the version for tests (prefer building with `--app-version` for user-flow validation).

- Launcher floor `control.launcher.version.{min, url}` compares against the **physical outer version** (from the outer bundle's `open-design-config.json`; `OD_UPDATE_INSTALLED_VERSION` for tests), never the payload version. Floor trip (or unreadable outer) selects the installer, offering same-version reinstall when nothing is newer (`reinstall: {reason, installedVersion, minVersion, url}`). Policy is one repo-vars pair per channel (`RELEASE_LAUNCHER_VERSION_MIN_<CHANNEL>` + `..._URL_<CHANNEL>`), resolved in `tools/release/src/storage/launcher-version-floor.ts` (non-stable falls back to STABLE as a unit); `publish-metadata` hard-fails if `min` exceeds the release version.
- `od:update:clear-cache` (+ sidecar `clear-cache`, Settings → About row with two-stage confirm) resets one-shot update state and purges `releases/`, `staging/`, `downloads/`, `.back/`, stale `attempt.json`, and non-`confirmed` journals. Never touches `active`/`lastSuccessful`, retained entries, `install.json`, or `confirmed` journals; spawned installer helpers are not cancelled.
- Release notes: `docs/CHANGELOG/v<version>/<locale>.md` (stable additionally requires `en` + `zh-CN`). Post-update "what's new" is NOT in metadata — one hand-curated R2 document (`OD_WHATS_NEW_URL` overrides), shown once per `id`.

### Channel identity rules

Identity must be stable across install, update, shortcuts, registry, and app data. Beta validation must use the real beta namespace `release-beta-win` (`Open Design` key `Open Design-release-beta-win`); beta-like ad hoc namespaces (e.g. `beta-local-flow`) create a different registry key and are not equivalent evidence. Same for prerelease (`release-prerelease-win`) and preview (`release-preview-win`). For feed-driven local validation, build with the matching release namespace + older `--app-version` (e.g. `--namespace release-beta-win --app-version 0.10.0-beta.1`).

### Deterministic fixture harness

For IPC/popup/progress/checksum/dry-run-install assertions (not full user-view validation):

```bash
pnpm tools-serve start updater --json --channel beta --version 99.0.0-beta.1 --platform win
```

```bash
OD_UPDATE_ENABLED=1
OD_UPDATE_METADATA_URL=<fixture metadataUrl>
OD_UPDATE_CURRENT_VERSION=99.0.0-beta.0
OD_UPDATE_OPEN_DRY_RUN=1
OD_UPDATE_AUTO_CHECK=1
```

### High-confidence user-flow acceptance

For release-feed selection, channel identity, registry/install behavior, installer opening, or visible updater UI changes — exercise the real beta feed, no mocks: confirm latest metadata via the public feed, build a non-portable beta package with the real namespace + lower version, install, and check the payload path end-to-end (download → sha256 → stage under the channel `launcher/` tree → popup with i18n copy and honest progress → relaunch of the exact versioned payload executable → `active`/`lastSuccessful` set, `attempt.json` gone, journal absent or `confirmed`). Installer fallback must overwrite the same `Open Design-release-beta-win` key, not create a second one. The registry query is the source of truth (Windows Settings > Apps caches):

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'Open Design*' } |
  Select-Object PSChildName,DisplayName,DisplayVersion,InstallLocation
```

Cleanup: stop first, then `tools-pack win stop/uninstall/cleanup --dir <root> --namespace release-beta-win --json` with the `--remove-*` flags; never add `--cache-dir` to routine validation.

### Validation matrix for updater changes

```bash
pnpm --filter @open-design/desktop test -- tests/main/updater.test.ts tests/main/updater-host-boundary.test.ts tests/main/preload-host-boundary.test.ts
pnpm --filter @open-design/web test -- tests/components/UpdaterPopup.test.tsx tests/lib/updater.test.ts
pnpm --filter @open-design/tools-serve test
pnpm --filter @open-design/tools-pack test -- tests/win-identity.test.ts tests/win-app.test.ts tests/win-builder.test.ts
pnpm --filter @open-design/desktop typecheck
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/tools-pack typecheck
pnpm --filter @open-design/tools-serve typecheck
git diff --check
pnpm guard
pnpm typecheck
```

Launcher payload/handoff changes additionally need the platform full spec: exact desktop executable identity, a real PPTX response, full stop + installed-outer cold start, and the same checks again after restart.
