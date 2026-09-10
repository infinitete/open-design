# tools/pack

Follow the root `AGENTS.md` and `tools/AGENTS.md` first. This tool owns the repo-external packaged build/start/stop/logs command surface.

Read `tools/pack/CACHE.md` before changing any build-cache node key, adding a cache node, or changing what a cached node reads or writes (determinant rules, materialization-time parameters, signing boundary, confidence grading).

## Owns

- Local packaging orchestration: mac / Windows NSIS / Linux AppImage build/install/start/stop/logs/uninstall/cleanup/list/reset, plus beta release artifact preparation.
- Linux extras: `--headless` install/start/stop (no Electron), `--containerized` builds (distro-agnostic glibc), `--to deb` lane (fixed dpkg name `open-design`, namespace-scoped artifact names; no lifecycle — start/stop/logs/inspect stay AppImage-only, deb install/uninstall never stops running instances).
- Windows registry observation/cleanup via `reg.exe`, scoped to namespace install/uninstaller paths; lifecycle logs carry NSIS automation markers/timings plus app runtime logs.
- Sidecar/process/path primitives consumed from `@open-design/sidecar-proto`, `@open-design/sidecar`, `@open-design/platform`.

## Does not own

Product business logic, sidecar protocol definitions, a second process identity model, or product runtime integration (the desktop surface lives in `apps/desktop`, the packaged entry in `apps/packaged` — do not duplicate that logic here).

## Rules

- Keep cross-platform responsibilities in named dirs (`cache/`, `config/`, `resources/`, `versioning/`); platform behavior below `mac/`/`win/`. Mirror in `tests/`.
- Tests import source through the test-only `@/*` alias (`?raw` suffix for source-text inspection); no depth-dependent `../src/` imports or file URLs.
- Do not hand-build `--od-stamp-*` args; use `createProcessStampArgs` with `OPEN_DESIGN_SIDECAR_CONTRACT`.
- No port numbers in data/log/runtime/cache path decisions — namespace decides, ports are transient transports. Namespace-named `.app` installs do not change path conventions either.
- Public artifacts use channel-specific identity: `Open Design` / `Open Design Beta` / `Open Design Prerelease` / `Open Design Preview`. Namespace-scoped install paths are a developer multi-instance convention only.
- `--dir` = output/runtime/install validation root, never the cache root (default workspace cache is the hot path; `--cache-dir` is a cold-cache/isolation escape hatch only). Use `--portable` for public/release artifacts so local build-machine roots never bake into packaged config.
- Electron-builder resources belong under `tools/pack/resources/`; never point pack logic at Downloads, web public assets, docs assets, or other app-owned paths.
- Windows NSIS smoke uses short namespaces (`rg`, `smoke`, `nsis-a`): deep Next.js standalone trees under long namespaces exceed the 260-char path limit (`regression-merge-nsis` hit 264 chars and silently missed an installed file while `rg` passed). Long namespaces only when intentionally testing path length.
- The deb lane ships its own space-safe after-install/after-remove scripts (rendered in `src/linux.ts`, wired via `deb.afterInstall`/`deb.afterRemove`): electron-builder's default templates register an update-alternatives name containing the product name's space, which Debian rejects. The same scripts also rename the installed hicolor icon from the space-containing `<productName>.png` to the space-free dpkg package name (`deb.desktop.entry.Icon` points at that name via `debDesktopEntry`), because gtk-update-icon-cache cannot cache icon names containing spaces and fails with "The generated cache was invalid".

## Channel identity rules

Identity must be stable across install, shortcuts, registry, and app data. Beta
validation must use the real beta namespace `release-beta-win` (`Open Design` key
`Open Design-release-beta-win`); beta-like ad hoc namespaces (e.g.
`beta-local-flow`) create a different registry key and are not equivalent
evidence. Same for prerelease (`release-prerelease-win`) and preview
(`release-preview-win`). Build with the matching release namespace and the real
`--app-version` (e.g. `--namespace release-beta-win --app-version 0.10.0-beta.1`).

The registry query is the source of truth (Windows Settings > Apps caches):

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'Open Design*' } |
  Select-Object PSChildName,DisplayName,DisplayVersion,InstallLocation
```

Cleanup: stop first, then `tools-pack win stop/uninstall/cleanup --dir <root> --namespace release-beta-win --json` with the `--remove-*` flags; never add `--cache-dir` to routine validation.
