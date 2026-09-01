# Linux Debian (.deb) Packaging Design

## Goal

Add a `.deb` packaging lane to the existing `tools-pack linux` surface so
Debian-family users (Debian, Ubuntu, Mint, and derivatives) can install Open
Design with their native package manager. The lane ships build output plus
install/uninstall smoke commands; it does not duplicate the AppImage runtime
lifecycle.

## Background

The Linux lane today produces AppImage only (`build --to all|appimage|dir`,
plus install/start/stop/logs/uninstall/cleanup lifecycle and a `--headless`
no-Electron mode). electron-builder 26.8.1 — already pinned by
`tools/pack` — natively supports a `deb` target: package identity is
configurable via `linux.packageName`, and the build uses a prebuilt fpm bundle
that electron-builder auto-downloads into `~/.cache/electron-builder/fpm` (the
same cache volume the containerized build already mounts).

## Decisions

Three decisions were confirmed with the maintainer during brainstorming:

1. **Scope: build + install/uninstall smoke only.** The deb lane gets
   `build` output and `install`/`uninstall` smoke commands. The
   start/stop/logs/inspect lifecycle remains AppImage-only (system-level deb
   installs make multi-instance runtime identity a separate problem that is
   deliberately out of scope here).
2. **Fixed single package name.** The dpkg package name is fixed
   (`open-design`), not namespace-scoped. Installing a second namespace's deb
   upgrades/replaces the first, and uninstall removes the package regardless
   of which artifact installed it. The artifact **file name** remains
   namespace-scoped (`Open Design-<ns>.deb` via the existing `artifactName`
   template) — file name and dpkg package name are independent.
3. **apt preferred + `sudo -n`.** Install/uninstall prefer
   `apt-get` (scripting-stable CLI, resolves dependencies for local `.deb`
   paths) and fall back to `dpkg`. Elevation uses `sudo -n`
   (non-interactive): a password prompt would hang automation, so
   authentication failure is a hard error with guidance.

## CLI Surface

`tools/pack/src/config/index.ts`:

- Add `"deb"` to the `ToolPackBuildOutput` union.
- Linux validation accepts `all | appimage | deb | dir`.

Target mapping in `tools/pack/src/linux.ts`:

| `--to` | electron-builder targets | Behavior change |
| --- | --- | --- |
| `appimage` | `["AppImage"]` | unchanged |
| `deb` | `["deb"]` | new |
| `dir` | `["dir"]` | unchanged |
| `all` | `["AppImage", "deb"]` | **changed**: previously `all` was equivalent to `appimage`; it now produces both artifacts in one electron-builder run |

The default `--to` remains `all`, so the default build now also emits a deb.
This is intentional: the spec wants deb compression bounded for build time
(deb's own default `xz` is single-threaded and would otherwise add minutes
for marginal size), pinning the `deb.compression` candidate `gz`; see Build
Pipeline for the enum details.

`tools/pack/src/index.ts`:

- Help text: `TO_HELP_BY_PLATFORM.linux` gains `deb|`, becoming
  `linux: "build target: all|appimage|deb|dir (default: all)"` (kept in sync
  with the config resolver, which throws on unlisted values).
- `linux install` and `linux uninstall` gain a `--deb` flag selecting the deb
  smoke form. `--deb` and `--headless` are mutually exclusive; passing both is
  a config error.
- Lifecycle-mode plumbing: `LinuxLifecycleMode`/`resolveLinuxLifecycleMode`
  in `tools/pack/src/linux.ts` gains a `"deb"` mode and is the enforcement
  point for two config errors: the `--deb`+`--headless` mutual exclusion, and
  `--deb` passed with non-smoke actions (`start`/`stop`/`logs`/`inspect`/
  `cleanup` — `cac` parses the flag for those commands too, so it must
  hard-error rather than silently fall through to the AppImage branch). The
  function already receives the action parameter and both options, making it
  the natural enforcement point. Call coverage today is partial:
  `resolveLinuxLifecycleMode` is invoked only for `install`/`start`/`stop`/
  `uninstall` in the `src/index.ts` dispatch and inside
  `cleanupPackedLinuxNamespace`, so the `logs` and `inspect` dispatch
  branches gain the check (or an inline `--deb` guard) for this feature;
  `LinuxLifecycleAction` widens to include `logs` and `inspect`, and the CLI
  options type gains `deb?: boolean`.
- Dispatch chain: `src/index.ts` resolves the lifecycle mode via
  `resolveLinuxLifecycleMode` and calls the deb module's install/uninstall
  orchestrators (`installPackedLinuxDeb`/`uninstallPackedLinuxDeb`) directly.

## Build Pipeline

Changes concentrate in `writeLinuxBuilderConfig` in
`tools/pack/src/linux.ts`:

- Target array mapped from `--to` as above; `all` builds both targets in one
  electron-builder invocation, sharing the workspace build, tarballs,
  assembled app, and resources — nothing is built twice.
- Deb-only builds skip AppImage-specific staging: the AppRun staging gate
  (currently `config.to !== "dir"`) and the builder-config `extraFiles`
  AppRun entry plus `appImage.executableArgs` apply only when the AppImage
  target is present (`appimage` or `all`), not for `deb` or `dir`.
- `deb.packageName: "open-design"` pins the fixed dpkg package name (lowercase
  letters and hyphen, Debian policy conformant) via the conditional `deb`
  builder block; electron-builder 26.8.1's `linux` block has no `packageName`
  property (verified by a real build). `productName`,
  `executableName`, and `artifactName` stay as-is.
- Deb compression bounded for build time: the slow path is deb's own default
  `xz` compression (single-threaded), which can otherwise add minutes for
  marginal size. At electron-builder 26.8.1 FpmTarget reads compression only
  from the linux/deb sections — the top-level `compression: "maximum"`
  setting never reaches the deb target. The `deb.compression` enum is
  `gz | bzip2 | xz | lzo`; `gzip` is invalid and hard-fails schema
  validation, and there is no preset or level surface — fpm receives a bare
  `--deb-compression <value>` — so the only build-time lever is choosing
  `gz` or `bzip2` over the `xz` default. The bounded-build-time candidate
  is `deb.compression: "gz"`; the exact option and value are verified
  against electron-builder 26.8.1 at implementation time.
- `maintainer`, `category`, and `synopsis` already exist in the linux config
  and satisfy deb's required `maintainer` field.
- Version: `electronBuilderVersionForAppVersion` output passes through
  unchanged, but electron-builder's deb target sanitizes it for dpkg —
  `getSanitizedVersion()` replaces `-` with `~` — so
  `--app-version 0.10.0-beta.1` produces deb Version `0.10.0~beta.1`. `~` is
  the Debian-correct prerelease ordering: it sorts before the base release
  (`0.10.0~beta.1 < 0.10.0`), so dpkg upgrade logic treats the prerelease as
  earlier than the eventual stable release.
- Architecture: host arch only, matching AppImage behavior.
- The deb lane ships its own space-safe after-install/after-remove scripts via `deb.afterInstall`/`deb.afterRemove`: electron-builder's default maintainer scripts register an update-alternatives name derived from the product name ("Open Design"), and Debian alternatives names must not contain "/" or spaces — the defaults error on install and fail removal. The lane scripts create a plain `/usr/bin/open-design` symlink (named after the dpkg package) and keep the default behaviors that matter: chrome-sandbox mode selection, mime and desktop database updates, and the AppArmor profile install.

Artifact discovery and result:

- `findBuiltDeb()` scans the builder output root for a `.deb` file, mirroring
  `findBuiltAppImage()`; unlike its module-private model, it is exported
  (like the target-mapping helper) so tests can reach it via the `@/*` alias.
- `LinuxPackResult` gains `debPath: string | null`.

Containerized builds: the inner docker command already forwards `--to`
verbatim, and the mounted `/home/builder/.cache/electron-builder` cache volume
is where electron-builder downloads the fpm bundle, so
`--containerized --to deb` works without docker-arg changes. First deb build
requires network access to fetch the fpm bundle (same model as the existing
electron download). The containerized branch of `packLinux` returns `debPath`
with the same discovery symmetry as the native branch (both resolve the
artifact through `findBuiltDeb()` after the builder run).

## Install/Uninstall Smoke

New module `tools/pack/src/linux/deb.ts` (new `linux/` owned directory —
root-level `src/*.ts` files are treated as unclassified by CI; the legacy
`linux.ts` stays where it is, all new code lives under `src/linux/`).
CI scope note, accepted as-is: `tools/pack/src/linux/` is not in the
`packaged-leaf` source unit in `.github/config/scopes.json` (unlike its
`mac/` and `win/` siblings), so `deb.ts` lands in the medium-confidence
`tools-pack-sources` unit instead of the certain tier its mac/win siblings
get. Adding the directory to `scopes.json` requires the
`specs/current/ci.md` methodology and is out of scope here.

### Privilege resolution

- `process.getuid?.() === 0`: run commands directly, no prefix.
- Else if `sudo` exists: prefix `sudo -n`. `sudo -n` fails fast when a
  password would be required; the error message tells the operator to run as
  root or configure NOPASSWD sudo for the current user.
- Else: hard error ("deb install smoke requires root or NOPASSWD sudo").

The prefix applies only to mutating commands (`apt-get install`/`remove`,
`dpkg -i`/`-r`); verification reads (`dpkg-query`, `dpkg-deb -f`) run
unprefixed. Environment variables ride through `env` after the prefix — the
composed install form is `sudo -n env DEBIAN_FRONTEND=noninteractive
apt-get install -y <path>` — because default sudoers `env_reset` strips
`DEBIAN_FRONTEND` and the `sudo VAR=val cmd` form requires SETENV
privileges in sudoers.

### Install flow (`linux install --deb`)

1. Locate the built artifact via `findBuiltDeb()`; if missing, error with
   "run `tools-pack linux build --to deb` first".
2. Pick the package manager: `apt-get` if present, else `dpkg`. Both are
   mutating commands, so each runs under the privilege prefix with
   `DEBIAN_FRONTEND=noninteractive` passed through `env` (see Privilege
   resolution for the composed form and rationale).
   - Preferred: `env DEBIAN_FRONTEND=noninteractive apt-get install -y <absolute .deb path>` — resolves declared dependencies (`libgtk-3-0`, `libnss3`, `libxtst6`, `xdg-utils`, …) from configured repositories.
   - Fallback: `dpkg -i <path>` — offline-capable; dependency failures
     surface dpkg's own error output.
3. Verify with `dpkg-query -W -f='${Status}|${Version}' open-design`;
   expected status `install ok installed` and a version matching the built
   package. The expected version comes solely from the built artifact via
   `dpkg-deb -f <path> Version`; a mismatch is a failed smoke with both
   values reported.
4. JSON result: package name, `version` (the sanitized dpkg Version, e.g.
   `0.10.0~beta.1` — not the raw app version), resolved `packageManager`,
   artifact path, and the installed-file list from
   `dpkg-query -L open-design` (key paths reported from the dpkg database;
   no hardcoded `/opt/...` guesses). The version-sanitize helper serves
   this JSON result reporting only; verification never applies it (step 3
   compares against the version read straight from the artifact).

### Uninstall flow (`linux uninstall --deb`)

1. Pick the package manager once by presence, mirroring install: `apt-get`
   (`env DEBIAN_FRONTEND=noninteractive apt-get remove -y open-design`,
   composed with the privilege prefix as in install) if present, else
   `dpkg -r open-design`. There is no failure-based retry with
   the other tool. No purge: user-data cleanup is not in
   scope, and dpkg `config-files` residue (`deinstall ok config-files`) is
   reported as-is rather than treated as failure.
2. Verify the package no longer reports `install ok installed`.
3. JSON result: package name, resolved `packageManager`, observed dpkg
   status.

### Host guard

If `dpkg` itself is missing, both flows fail fast with "deb smoke requires a
Debian-family host".

### Known limitation

The deb lane performs no process management. A running instance is not
stopped before upgrade or removal; the running process keeps the old binary
inode until it exits. Process lifecycle ownership stays with the AppImage
lane.

## Code Organization and Tests

- `tools/pack/src/linux/deb.ts` holds:
  - Pure, unit-testable helpers: privilege-prefix resolution, install/
    uninstall command composition (argv arrays — `execFile` semantics, so
    paths containing spaces such as `Open Design-<ns>.deb` need no shell
    quoting), dpkg-query status parsing, and version sanitization (`-` →
    `~`, mirroring electron-builder's `getSanitizedVersion()`; used for
    JSON result reporting only).
  - IO orchestrators: `installPackedLinuxDeb(config)` and
    `uninstallPackedLinuxDeb(config)`.
- `tools/pack/src/linux.ts` owns the builder-config/target changes, defines
  the fixed dpkg package-name constant next to `PRODUCT_NAME`, and exports
  the primitives the deb module consumes (the package-name constant,
  `resolveLinuxLifecycleMode`, the `--to` target mapping, `findBuiltDeb`);
  the install/uninstall dispatch chain lives in `src/index.ts` (see CLI
  Surface).
- Import direction between the two modules is one-way to prevent a
  `linux.ts` ↔ `linux/deb.ts` cycle: `deb.ts` depends on `linux.ts`
  primitives (including the package-name constant above), while the
  consumers of `deb.ts`'s orchestrators — the `src/index.ts` install/
  uninstall dispatch, the layer that already consumes `linux.ts`'s
  lifecycle orchestrators — sit above it. `linux.ts` must not import from
  `deb.ts`, and `deb.ts` must not import anything from `linux.ts` that
  would create a cycle.
- The `--to` → electron-builder targets mapping currently lives inside the
  unexported `writeLinuxBuilderConfig`; extract it into a small pure mapping
  helper (e.g. `linuxBuilderTargetsFor(to)`) exported from `linux.ts` so
  `tests/linux-deb.test.ts` can assert the mapping table directly. The
  existing `tests/config/config.test.ts` only covers validation
  (accepted/rejected values), not the mapping.
- `tools/pack/src/config/index.ts` extends the output-type validation;
  accepted/rejected `--to deb` validation tests belong in the existing
  `tests/config/config.test.ts` (the repo convention for
  `resolveToolPackConfig` target validation).
- Tests: new `tools/pack/tests/linux-deb.test.ts` covering the privilege
  matrix (root / sudo / neither), command composition, dpkg status parsing,
  the fixed package-name constant, `--deb`+`--headless` mutual exclusion,
  `findBuiltDeb` selection, version sanitization (`0.10.0-beta.1` →
  `0.10.0~beta.1`), and `--to` mapping assertions against the
  exported mapping helper described above.
- Tests import source through the test-only `@/*` alias per
  `tools/pack/AGENTS.md`.

## Documentation Updates

- `tools/pack/AGENTS.md`: add deb lines under "Owns" (deb build target;
  deb install/uninstall smoke) and a rule stating the fixed dpkg package
  name and that the deb lane owns no process lifecycle.
- `tools/AGENTS.md`: add `pnpm tools-pack linux build --to deb` to the
  common-commands list.

## Out of Scope

- start/stop/logs/inspect lifecycle for deb installs.
- Updater or release-feed integration for deb (Linux exposes no updater
  actions today).
- rpm, snap, flatpak, pacman, or other non-deb formats.
- arm64 cross-builds beyond host arch.
- Publishing deb artifacts through `tools/release` or CI workflow changes.
- Multi-instance (namespace) isolation of system-level installs.
