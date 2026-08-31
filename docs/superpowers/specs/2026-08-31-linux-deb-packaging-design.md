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
- Help text: `linux: "build target: all|appimage|deb|dir (default: all)"`.

Target mapping in `tools/pack/src/linux.ts`:

| `--to` | electron-builder targets | Behavior change |
| --- | --- | --- |
| `appimage` | `["AppImage"]` | unchanged |
| `deb` | `["deb"]` | new |
| `dir` | `["dir"]` | unchanged |
| `all` | `["AppImage", "deb"]` | **changed**: previously `all` was equivalent to `appimage`; it now produces both artifacts in one electron-builder run |

The default `--to` remains `all`, so the default build now also emits a deb.
This is intentional; `deb.compression` is set to `"normal"` to keep the
single-threaded xz compression bounded (top-level `compression: "maximum"`
would otherwise add minutes for marginal size).

`tools/pack/src/index.ts`:

- `linux install` and `linux uninstall` gain a `--deb` flag selecting the deb
  smoke form. `--deb` and `--headless` are mutually exclusive; passing both is
  a config error.

## Build Pipeline

Changes concentrate in `writeLinuxBuilderConfig` in
`tools/pack/src/linux.ts`:

- Target array mapped from `--to` as above; `all` builds both targets in one
  electron-builder invocation, sharing the workspace build, tarballs,
  assembled app, and resources — nothing is built twice.
- `linux.packageName: "open-design"` (fixed dpkg package name; lowercase
  letters and hyphen, Debian policy conformant). `productName`,
  `executableName`, and `artifactName` stay as-is.
- `deb: { compression: "normal" }`.
- `maintainer`, `category`, and `synopsis` already exist in the linux config
  and satisfy deb's required `maintainer` field.
- Version: unchanged `electronBuilderVersionForAppVersion` output; semver
  prerelease segments (e.g. `0.10.0-beta.1`) are valid Debian version
  characters.
- Architecture: host arch only, matching AppImage behavior.

Artifact discovery and result:

- `findBuiltDeb()` scans the builder output root for a `.deb` file, mirroring
  `findBuiltAppImage()`.
- `LinuxPackResult` gains `debPath: string | null`.

Containerized builds: the inner docker command already forwards `--to`
verbatim, and the mounted `/home/builder/.cache/electron-builder` cache volume
is where electron-builder downloads the fpm bundle, so
`--containerized --to deb` works without docker-arg changes. First deb build
requires network access to fetch the fpm bundle (same model as the existing
electron download).

## Install/Uninstall Smoke

New module `tools/pack/src/linux/deb.ts` (new `linux/` owned directory —
root-level `src/*.ts` files are treated as unclassified by CI; the legacy
`linux.ts` stays where it is, all new code lives under `src/linux/`).

### Privilege resolution

- `process.getuid?.() === 0`: run commands directly, no prefix.
- Else if `sudo` exists: prefix `sudo -n`. `sudo -n` fails fast when a
  password would be required; the error message tells the operator to run as
  root or configure NOPASSWD sudo for the current user.
- Else: hard error ("deb install smoke requires root or NOPASSWD sudo").

### Install flow (`linux install --deb`)

1. Locate the built artifact via `findBuiltDeb()`; if missing, error with
   "run `tools-pack linux build --to deb` first".
2. Pick the package manager: `apt-get` if present, else `dpkg`.
   - Preferred: `DEBIAN_FRONTEND=noninteractive apt-get install -y <absolute .deb path>` — resolves declared dependencies (`libgtk-3-0`, `libnss3`, `libxtst6`, `xdg-utils`, …) from configured repositories.
   - Fallback: `dpkg -i <path>` — offline-capable; dependency failures
     surface dpkg's own error output.
3. Verify with `dpkg-query -W -f='${Status}|${Version}' open-design`;
   expected status `install ok installed` and a version matching the built
   package. A mismatch is a failed smoke with both values reported.
4. JSON result: package name, version, resolved `packageManager`, artifact
   path, and the installed-file list from `dpkg-query -L open-design`
   (key paths reported from the dpkg database; no hardcoded `/opt/...`
   guesses).

### Uninstall flow (`linux uninstall --deb`)

1. `DEBIAN_FRONTEND=noninteractive apt-get remove -y open-design`, falling
   back to `dpkg -r open-design`. No purge: user-data cleanup is not in
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
    quoting), dpkg-query status parsing, and the fixed package-name constant.
  - IO orchestrators: `installPackedLinuxDeb(config)` and
    `uninstallPackedLinuxDeb(config)`.
- `tools/pack/src/linux.ts` dispatches `--deb` install/uninstall to the new
  module and owns the builder-config/target changes.
- `tools/pack/src/config/index.ts` extends the output-type validation.
- Tests: new `tools/pack/tests/linux-deb.test.ts` covering the privilege
  matrix (root / sudo / neither), command composition, dpkg status parsing,
  the fixed package-name constant, `--deb`+`--headless` mutual exclusion, and
  `findBuiltDeb` selection. `--to` mapping assertions extend the existing
  config tests under `tools/pack/tests/config/`.
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
