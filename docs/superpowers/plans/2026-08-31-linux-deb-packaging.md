# Linux deb Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `.deb` packaging lane to `tools-pack linux` — a `deb` build target (plus dual-target `--to all`) and `install`/`uninstall` smoke commands driven by apt-get/dpkg with `sudo -n` elevation.

**Architecture:** The deb target rides the existing electron-builder pipeline in `tools/pack/src/linux.ts` (one builder invocation emits AppImage and/or deb from the same assembled app). Deb-specific smoke logic lives in a new owned module `tools/pack/src/linux/deb.ts` whose pure helpers (privilege resolution, argv composition, dpkg status parsing, version sanitization) are fully unit-tested, with thin IO orchestrators that accept an injectable environment + command runner so tests never execute real system commands. CLI dispatch goes `src/index.ts` → `resolveLinuxLifecycleMode` (mode `"deb"`) → deb orchestrators.

**Tech Stack:** TypeScript (Node ~24, pnpm@10.33.2), electron-builder 26.8.1 (`deb` target via auto-downloaded fpm bundle), vitest with the `@/` → `src` alias.

**Spec:** `docs/superpowers/specs/2026-08-31-linux-deb-packaging-design.md`

## Global Constraints

- Runtime: Node `~24`, pnpm `10.33.2` via Corepack. Never Node 22.
- dpkg package name is fixed: `open-design` (Debian policy: lowercase + hyphen). Artifact **file name** stays namespace-scoped via the existing `artifactName` template `Open Design-<ns>.${ext}`.
- `--to` → electron-builder targets mapping: `all` → `["AppImage", "deb"]`, `appimage` → `["AppImage"]`, `deb` → `["deb"]`, `dir` → `["dir"]`. Nothing built twice for `all`.
- Deb compression candidate is `gz` (enum `gz|bzip2|xz|lzo`, default `xz`, at electron-builder 26.8.1). Verify against the installed `scheme.json` before wiring; if `gz` is absent from the installed enum, omit the `deb.compression` option entirely (do not guess another value).
- electron-builder's deb target maps `-` → `~` in the package version (`0.10.0-beta.1` → `0.10.0~beta.1`). Install verification compares against `dpkg-deb -f <path> Version` (the artifact's own Version field); the `-`→`~` sanitize helper is for JSON reporting only.
- Privilege: `getuid() === 0` runs directly; otherwise `sudo -n` (hard error when sudo is missing or would prompt). Env vars ride through `env` after the prefix (`sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y <path>`); the prefix applies only to mutating commands (`apt-get install`/`remove`, `dpkg -i`/`-r`), never to verification reads (`dpkg-query`, `dpkg-deb -f`).
- Package-manager selection is presence-based and picked once: `apt-get` if present, else `dpkg`; no failure-based retry with the other tool. Missing `dpkg` → "deb smoke requires a Debian-family host".
- All new source lives under `tools/pack/src/linux/` (root-level `src/*.ts` files are treated as unclassified by CI). `tools/pack/src/linux.ts` stays where it is. Import direction is one-way: `deb.ts` may import linux.ts primitives; `linux.ts` must NOT import from `deb.ts`.
- Tests live in `tools/pack/tests/`, import source via the test-only `@/*` alias, run with `pnpm --filter @open-design/tools-pack test` (vitest). Unit tests must not execute real system commands — command execution and environment detection are injected.
- No root `pnpm test`/`pnpm build` aliases. Use `pnpm --filter @open-design/tools-pack ...`.
- Git commits must not include `Co-authored-by` trailers or any co-author metadata.
- Out of scope (do not implement): deb start/stop/logs lifecycle, updater/release integration, rpm/snap/flatpak, arm64 cross-builds, `tools/release` deb publishing, `scopes.json` changes.

---

### Task 1: Accept `deb` as a linux `--to` build target

**Files:**
- Modify: `tools/pack/src/config/index.ts:37` (union), `tools/pack/src/config/index.ts:179` (validation), `ToolPackCliOptions` (~line 43)
- Modify: `tools/pack/src/index.ts:83` (`TO_HELP_BY_PLATFORM.linux`)
- Test: `tools/pack/tests/config/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ToolPackBuildOutput` includes `"deb"`; `resolveToolPackConfig("linux", { to: "deb" })` resolves; `ToolPackCliOptions.deb?: boolean` exists for Task 6.

- [ ] **Step 1: Write the failing test**

Append to `tools/pack/tests/config/config.test.ts`, after the existing `resolveToolPackConfig win build target` describe block:

```ts
describe("resolveToolPackConfig linux build target", () => {
  it("accepts the deb target alongside appimage/dir/all and rejects unsupported values", () => {
    expect(resolveToolPackConfig("linux", { to: "deb" }).to).toBe("deb");
    expect(resolveToolPackConfig("linux", { to: "appimage" }).to).toBe("appimage");
    expect(resolveToolPackConfig("linux", { to: "dir" }).to).toBe("dir");
    expect(resolveToolPackConfig("linux", { to: "all" }).to).toBe("all");
    expect(() => resolveToolPackConfig("linux", { to: "nsis" })).toThrow(/unsupported linux --to target: nsis/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @open-design/tools-pack test -- tests/config/config.test.ts`
Expected: FAIL — `resolveToolPackConfig("linux", { to: "deb" })` throws `unsupported linux --to target: deb`.

- [ ] **Step 3: Implement**

In `tools/pack/src/config/index.ts`:

1. Line 37 union — add `"deb"`:

```ts
export type ToolPackBuildOutput = "all" | "app" | "appimage" | "deb" | "dir" | "dmg" | "nsis" | "zip";
```

2. Line 179 validation — accept `deb`:

```ts
  if (platform === "linux" && (value === "all" || value === "appimage" || value === "deb" || value === "dir")) return value;
```

3. `ToolPackCliOptions` (line ~43) — insert `deb?: boolean;` alphabetically between `containerized?: boolean;` and `dir?: string;`:

```ts
  containerized?: boolean;
  deb?: boolean;
  dir?: string;
```

In `tools/pack/src/index.ts` line 83, keep the help string in sync with the resolver:

```ts
  linux: "build target: all|appimage|deb|dir (default: all)",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @open-design/tools-pack test -- tests/config/config.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add tools/pack/src/config/index.ts tools/pack/src/index.ts tools/pack/tests/config/config.test.ts
git commit -m "feat(pack): accept deb as a linux --to build target"
```

---

### Task 2: Map `--to` onto electron-builder targets (packageName, deb compression, AppRun gates)

**Files:**
- Modify: `tools/pack/src/linux.ts` — new exported constant + mapping helper; `writeLinuxBuilderConfig`; `packLinux` AppRun staging gate; config import line
- Test: `tools/pack/tests/linux-deb.test.ts` (create)

**Interfaces:**
- Consumes: `ToolPackBuildOutput` with `"deb"` (Task 1).
- Produces:
  - `export const DEB_PACKAGE_NAME = "open-design";`
  - `export function linuxBuilderTargetsFor(to: ToolPackBuildOutput): string[]` — returns the electron-builder target array; throws on values the linux resolver rejects (defense in depth).
  - Builder config: `linux.packageName: "open-design"`, `deb: { compression: "gz" }` (only when the deb target is present), AppRun staging / `extraFiles` / `appImage.executableArgs` only when the AppImage target is present.

- [ ] **Step 1: Write the failing test**

Create `tools/pack/tests/linux-deb.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { DEB_PACKAGE_NAME, linuxBuilderTargetsFor } from "@/linux.js";

describe("linuxBuilderTargetsFor", () => {
  it("maps --to values onto electron-builder targets", () => {
    expect(linuxBuilderTargetsFor("all")).toEqual(["AppImage", "deb"]);
    expect(linuxBuilderTargetsFor("appimage")).toEqual(["AppImage"]);
    expect(linuxBuilderTargetsFor("deb")).toEqual(["deb"]);
    expect(linuxBuilderTargetsFor("dir")).toEqual(["dir"]);
  });

  it("rejects values the linux resolver never accepts", () => {
    expect(() => linuxBuilderTargetsFor("nsis")).toThrow(/unsupported linux --to target: nsis/);
  });
});

describe("DEB_PACKAGE_NAME", () => {
  it("is the fixed Debian-policy-conformant dpkg package name", () => {
    expect(DEB_PACKAGE_NAME).toBe("open-design");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @open-design/tools-pack test -- tests/linux-deb.test.ts`
Expected: FAIL — `linuxBuilderTargetsFor` is not exported from `@/linux.js`.

- [ ] **Step 3: Implement the helper and constant**

In `tools/pack/src/linux.ts`:

1. Extend the config import (line ~29) with the output type:

```ts
import type { ToolPackBuildOutput, ToolPackConfig } from "./config/index.js";
```

2. Next to the existing `PRODUCT_NAME` constant (line ~38):

```ts
export const PRODUCT_NAME = "Open Design";
export const DEB_PACKAGE_NAME = "open-design";
```

3. Add the mapping helper after `sanitizeNamespace` (line ~72):

```ts
export function linuxBuilderTargetsFor(to: ToolPackBuildOutput): string[] {
  if (to === "dir") return ["dir"];
  if (to === "deb") return ["deb"];
  if (to === "appimage") return ["AppImage"];
  if (to === "all") return ["AppImage", "deb"];
  throw new Error(`unsupported linux --to target: ${to}`);
}
```

- [ ] **Step 4: Verify the deb compression enum against the installed electron-builder**

Run (after `pnpm install` has materialized dependencies):

```bash
rg -n '"compression"' tools/pack/node_modules/app-builder-lib/scheme.json
```

Locate the deb (`LinuxDebOptions`) `compression` enum. Expected at 26.8.1: `["gz","bzip2","lzo","xz"]` with default `xz`. If `gz` is present, proceed with `deb.compression: "gz"` in Step 5. If the enum differs and lacks `gz`, omit the `deb.compression` option in Step 5 entirely (fall back to the `xz` default) — do not substitute an unverified value.

- [ ] **Step 5: Wire the mapping into writeLinuxBuilderConfig and packLinux**

In `tools/pack/src/linux.ts`, `writeLinuxBuilderConfig` (line ~621):

1. Replace the target selection and use it everywhere:

```ts
async function writeLinuxBuilderConfig(config: ToolPackConfig, paths: LinuxPaths): Promise<void> {
  const targets = linuxBuilderTargetsFor(config.to);
```

(The old line `const target = config.to === "dir" ? ["dir"] : ["AppImage"];` is deleted.)

2. In the `linux` block, rename `target` → `targets` and add the fixed package name:

```ts
    linux: {
      target: targets,
      icon: linuxResources.icon,
      category: "Development",
      synopsis: "Open Design",
      maintainer: "Open Design Contributors",
      packageName: DEB_PACKAGE_NAME,
    },
```

3. Add the deb compression option right after the `linux` block (only when the deb target is present; see Step 4 for the verified value):

```ts
    ...(targets.includes("deb") ? { deb: { compression: "gz" } } : {}),
```

4. Gate the AppImage-specific `extraFiles` on the AppImage target (replacing the `config.to === "dir"` condition):

```ts
    ...(targets.includes("AppImage")
      ? {
          extraFiles: [
            {
              from: paths.appImageAppRunPath,
              to: "AppRun",
            },
          ],
        }
      : {}),
```

5. Gate the `appImage` executable-args block the same way:

```ts
    ...(targets.includes("AppImage")
      ? {
          appImage: {
            executableArgs: [...LINUX_APPIMAGE_EXECUTABLE_ARGS],
          },
        }
      : {}),
```

6. In `packLinux` (line ~750), replace the AppRun staging gate:

```ts
  const targets = linuxBuilderTargetsFor(config.to);
  if (targets.includes("AppImage")) {
    await writeLinuxAppImageAppRun(paths);
  }
```

(The old `if (config.to !== "dir") { await writeLinuxAppImageAppRun(paths); }` is deleted. Behavior for `all`/`appimage`/`dir` is unchanged; `deb` now also skips AppImage-specific staging.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @open-design/tools-pack test -- tests/linux-deb.test.ts tests/linux.test.ts`
Expected: PASS — new mapping tests pass and existing linux tests (including `buildDockerArgs`) are unaffected.

- [ ] **Step 7: Commit**

```bash
git add tools/pack/src/linux.ts tools/pack/tests/linux-deb.test.ts
git commit -m "feat(pack): map linux --to onto electron-builder deb target"
```

---

### Task 3: Surface the built deb path (`findBuiltDeb`, `LinuxPackResult.debPath`)

**Files:**
- Modify: `tools/pack/src/linux.ts` — `findBuiltDeb` (new, exported), `LinuxPackResult`, both `packLinux` return branches, export `resolveLinuxPaths`
- Test: `tools/pack/tests/linux-deb.test.ts`

**Interfaces:**
- Consumes: `LinuxPaths` shape (`paths.appBuilderOutputRoot`) already in linux.ts.
- Produces:
  - `export async function findBuiltDeb(paths: LinuxPaths): Promise<string | null>;`
  - `LinuxPackResult` gains `debPath: string | null;` (set in both the containerized and native branches of `packLinux`).
  - `export function resolveLinuxPaths(config: ToolPackConfig): LinuxPaths;` (previously module-private; exported for Task 5's install orchestrator).

- [ ] **Step 1: Write the failing test**

Append to `tools/pack/tests/linux-deb.test.ts` (new imports at the top of the file, with the existing ones):

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findBuiltDeb, resolveLinuxPaths } from "@/linux.js";
import type { ToolPackConfig } from "@/config/index.js";
```

Test bodies (new describe block):

```ts
function makeDebTestConfig(appBuilderRoot: string): ToolPackConfig {
  return {
    containerized: false,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace: "default",
    platform: "linux",
    portable: false,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    requireVelaCli: false,
    roots: {
      output: {
        appBuilderRoot,
        namespaceRoot: join(appBuilderRoot, ".."),
        platformRoot: join(appBuilderRoot, "../.."),
        root: join(appBuilderRoot, "../../.."),
      },
      runtime: {
        namespaceBaseRoot: "/work/.tmp/tools-pack/runtime/linux/namespaces",
        namespaceRoot: "/work/.tmp/tools-pack/runtime/linux/namespaces/default",
      },
      cacheRoot: "/work/.tmp/tools-pack/cache",
      toolPackRoot: "/work/.tmp/tools-pack",
    },
    silent: true,
    signed: false,
    to: "deb",
    webOutputMode: "server",
    workspaceRoot: "/work",
  };
}

describe("findBuiltDeb", () => {
  it("returns the .deb from the builder output root", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "odtp-deb-"));
    await writeFile(join(outputRoot, "Open Design-ns.deb"), "deb-bytes");
    await writeFile(join(outputRoot, "Open Design-ns.AppImage"), "appimage-bytes");
    const debPath = await findBuiltDeb(resolveLinuxPaths(makeDebTestConfig(outputRoot)));
    expect(debPath).toBe(join(outputRoot, "Open Design-ns.deb"));
  });

  it("returns null when no .deb was built", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "odtp-deb-"));
    await writeFile(join(outputRoot, "Open Design-ns.AppImage"), "appimage-bytes");
    expect(await findBuiltDeb(resolveLinuxPaths(makeDebTestConfig(outputRoot)))).toBeNull();
  });

  it("returns null when the builder output root does not exist", async () => {
    const missing = join(tmpdir(), `odtp-deb-missing-${Date.now()}`);
    expect(await findBuiltDeb(resolveLinuxPaths(makeDebTestConfig(missing)))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @open-design/tools-pack test -- tests/linux-deb.test.ts`
Expected: FAIL — `findBuiltDeb` is not exported from `@/linux.js`.

- [ ] **Step 3: Implement**

In `tools/pack/src/linux.ts`:

1. Export `resolveLinuxPaths` (change `function resolveLinuxPaths(` → `export function resolveLinuxPaths(`).

2. Add `findBuiltDeb` next to `findBuiltAppImage` (line ~711):

```ts
export async function findBuiltDeb(paths: LinuxPaths): Promise<string | null> {
  if (!(await pathExists(paths.appBuilderOutputRoot))) return null;
  const entries = await readdir(paths.appBuilderOutputRoot);
  const deb = entries.find((entry) => entry.endsWith(".deb"));
  return deb ? join(paths.appBuilderOutputRoot, deb) : null;
}
```

3. Extend the result type (line ~720):

```ts
export type LinuxPackResult = {
  appImagePath: string | null;
  debPath: string | null;
  outputRoot: string;
  resourceRoot: string;
  runtimeNamespaceRoot: string;
  to: ToolPackConfig["to"];
  containerized: boolean;
};
```

4. Set `debPath` in both `packLinux` branches.

Containerized branch (line ~732):

```ts
    const paths = resolveLinuxPaths(config);
    const appImagePath = config.to === "dir" ? null : await findBuiltAppImage(paths);
    const debPath = await findBuiltDeb(paths);
    return {
      appImagePath,
      debPath,
      outputRoot: paths.appBuilderOutputRoot,
      resourceRoot: paths.resourceRoot,
      runtimeNamespaceRoot: config.roots.runtime.namespaceRoot,
      to: config.to,
      containerized: true,
    };
```

Native branch (end of `packLinux`, line ~756):

```ts
  const appImagePath = config.to === "dir" ? null : await findBuiltAppImage(paths);
  const debPath = await findBuiltDeb(paths);
  return {
    appImagePath,
    debPath,
    outputRoot: paths.appBuilderOutputRoot,
    resourceRoot: paths.resourceRoot,
    runtimeNamespaceRoot: config.roots.runtime.namespaceRoot,
    to: config.to,
    containerized: false,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @open-design/tools-pack test -- tests/linux-deb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/pack/src/linux.ts tools/pack/tests/linux-deb.test.ts
git commit -m "feat(pack): surface built deb path in linux pack results"
```

---

### Task 4: Deb smoke pure helpers (privilege, argv composition, status parsing, version sanitize)

**Files:**
- Create: `tools/pack/src/linux/deb.ts`
- Modify: `tools/pack/src/linux.ts` — export `commandExists`
- Test: `tools/pack/tests/linux-deb.test.ts`

**Interfaces:**
- Consumes: `DEB_PACKAGE_NAME` from linux.ts (Task 2).
- Produces (all exported from `tools/pack/src/linux/deb.ts`):
  - `export type DebPrivilege = "direct" | "sudo";`
  - `export type DebPackageManager = "apt-get" | "dpkg";`
  - `export function resolveDebPrivilege(input: { isRoot: boolean; hasSudo: boolean }): DebPrivilege`
  - `export function pickDebPackageManager(input: { hasAptGet: boolean; hasDpkg: boolean }): DebPackageManager`
  - `export function composeDebInstallCommand(input: { packageManager: DebPackageManager; privilege: DebPrivilege; artifactPath: string }): { command: string; args: string[] }`
  - `export function composeDebUninstallCommand(input: { packageManager: DebPackageManager; privilege: DebPrivilege }): { command: string; args: string[] }`
  - `export type DpkgQueryStatus = { status: string; version: string };`
  - `export function parseDpkgQueryStatus(stdout: string): DpkgQueryStatus | null`
  - `export function isDebInstalled(status: DpkgQueryStatus): boolean`
  - `export function sanitizeDebVersion(version: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `tools/pack/tests/linux-deb.test.ts` (import at top with the others):

```ts
import {
  composeDebInstallCommand,
  composeDebUninstallCommand,
  isDebInstalled,
  parseDpkgQueryStatus,
  pickDebPackageManager,
  resolveDebPrivilege,
  sanitizeDebVersion,
} from "@/linux/deb.js";
```

Test bodies:

```ts
describe("resolveDebPrivilege", () => {
  it("runs directly as root", () => {
    expect(resolveDebPrivilege({ isRoot: true, hasSudo: false })).toBe("direct");
  });

  it("uses non-interactive sudo otherwise", () => {
    expect(resolveDebPrivilege({ isRoot: false, hasSudo: true })).toBe("sudo");
  });

  it("hard-fails without root or sudo", () => {
    expect(() => resolveDebPrivilege({ isRoot: false, hasSudo: false })).toThrow(
      /deb install smoke requires root or NOPASSWD sudo/,
    );
  });
});

describe("pickDebPackageManager", () => {
  it("prefers apt-get when present", () => {
    expect(pickDebPackageManager({ hasAptGet: true, hasDpkg: true })).toBe("apt-get");
  });

  it("falls back to dpkg when apt-get is absent", () => {
    expect(pickDebPackageManager({ hasAptGet: false, hasDpkg: true })).toBe("dpkg");
  });

  it("fails fast off the Debian family", () => {
    expect(() => pickDebPackageManager({ hasAptGet: false, hasDpkg: false })).toThrow(
      /deb smoke requires a Debian-family host/,
    );
  });
});

describe("composeDebInstallCommand", () => {
  it("composes the sudo env form for apt-get", () => {
    expect(
      composeDebInstallCommand({
        packageManager: "apt-get",
        privilege: "sudo",
        artifactPath: "/out/Open Design-ns.deb",
      }),
    ).toEqual({
      command: "sudo",
      args: ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "/out/Open Design-ns.deb"],
    });
  });

  it("composes the direct env form for apt-get as root", () => {
    expect(
      composeDebInstallCommand({
        packageManager: "apt-get",
        privilege: "direct",
        artifactPath: "/out/Open Design-ns.deb",
      }),
    ).toEqual({
      command: "env",
      args: ["DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "/out/Open Design-ns.deb"],
    });
  });

  it("keeps the dpkg fallback with the noninteractive env wrapper", () => {
    expect(
      composeDebInstallCommand({
        packageManager: "dpkg",
        privilege: "sudo",
        artifactPath: "/out/Open Design-ns.deb",
      }),
    ).toEqual({
      command: "sudo",
      args: ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "dpkg", "-i", "/out/Open Design-ns.deb"],
    });
  });
});

describe("composeDebUninstallCommand", () => {
  it("removes via apt-get under the privilege prefix", () => {
    expect(composeDebUninstallCommand({ packageManager: "apt-get", privilege: "sudo" })).toEqual({
      command: "sudo",
      args: ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "remove", "-y", "open-design"],
    });
  });

  it("removes via dpkg without the env wrapper", () => {
    expect(composeDebUninstallCommand({ packageManager: "dpkg", privilege: "direct" })).toEqual({
      command: "dpkg",
      args: ["-r", "open-design"],
    });
  });
});

describe("parseDpkgQueryStatus", () => {
  it("parses the Status|Version line", () => {
    expect(parseDpkgQueryStatus("install ok installed|0.10.0~beta.1\n")).toEqual({
      status: "install ok installed",
      version: "0.10.0~beta.1",
    });
  });

  it("parses config-files residue", () => {
    expect(parseDpkgQueryStatus("deinstall ok config-files|0.9.0\n")).toEqual({
      status: "deinstall ok config-files",
      version: "0.9.0",
    });
  });

  it("returns null for malformed output", () => {
    expect(parseDpkgQueryStatus("")).toBeNull();
    expect(parseDpkgQueryStatus("no separator here\n")).toBeNull();
  });
});

describe("isDebInstalled", () => {
  it("accepts only the fully installed status", () => {
    expect(isDebInstalled({ status: "install ok installed", version: "1.0.0" })).toBe(true);
    expect(isDebInstalled({ status: "deinstall ok config-files", version: "1.0.0" })).toBe(false);
  });
});

describe("sanitizeDebVersion", () => {
  it("mirrors electron-builder's deb `-` to `~` mapping", () => {
    expect(sanitizeDebVersion("0.10.0-beta.1")).toBe("0.10.0~beta.1");
    expect(sanitizeDebVersion("0.10.0")).toBe("0.10.0");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @open-design/tools-pack test -- tests/linux-deb.test.ts`
Expected: FAIL — `@/linux/deb.js` does not exist.

- [ ] **Step 3: Implement the helpers and export commandExists**

1. In `tools/pack/src/linux.ts`, export the private helper (change `async function commandExists(` → `export async function commandExists(`).

2. Create `tools/pack/src/linux/deb.ts`:

```ts
import { DEB_PACKAGE_NAME } from "../linux.js";

export type DebPrivilege = "direct" | "sudo";
export type DebPackageManager = "apt-get" | "dpkg";

export function resolveDebPrivilege(input: { isRoot: boolean; hasSudo: boolean }): DebPrivilege {
  if (input.isRoot) return "direct";
  if (input.hasSudo) return "sudo";
  throw new Error("deb install smoke requires root or NOPASSWD sudo");
}

// Presence-based, picked once per flow: apt-get resolves dependencies for
// local .deb paths; dpkg is the offline fallback. Missing dpkg means the host
// cannot run deb smoke at all.
export function pickDebPackageManager(input: { hasAptGet: boolean; hasDpkg: boolean }): DebPackageManager {
  if (!input.hasDpkg) {
    throw new Error("deb smoke requires a Debian-family host");
  }
  return input.hasAptGet ? "apt-get" : "dpkg";
}

function composePrivileged(privilege: DebPrivilege, postPrefix: string[]): { command: string; args: string[] } {
  if (privilege === "sudo") {
    return { command: "sudo", args: ["-n", ...postPrefix] };
  }
  const [command, ...args] = postPrefix;
  if (command == null) throw new Error("empty deb command argv");
  return { command, args };
}

export function composeDebInstallCommand(input: {
  packageManager: DebPackageManager;
  privilege: DebPrivilege;
  artifactPath: string;
}): { command: string; args: string[] } {
  return composePrivileged(input.privilege, [
    "env",
    "DEBIAN_FRONTEND=noninteractive",
    input.packageManager === "apt-get" ? "apt-get" : "dpkg",
    "install",
    "-y",
    input.artifactPath,
  ]);
}

export function composeDebUninstallCommand(input: {
  packageManager: DebPackageManager;
  privilege: DebPrivilege;
}): { command: string; args: string[] } {
  if (input.packageManager === "apt-get") {
    return composePrivileged(input.privilege, [
      "env",
      "DEBIAN_FRONTEND=noninteractive",
      "apt-get",
      "remove",
      "-y",
      DEB_PACKAGE_NAME,
    ]);
  }
  return composePrivileged(input.privilege, ["dpkg", "-r", DEB_PACKAGE_NAME]);
}

export type DpkgQueryStatus = { status: string; version: string };

export function parseDpkgQueryStatus(stdout: string): DpkgQueryStatus | null {
  const line = stdout.trim().split("\n")[0] ?? "";
  const separator = line.indexOf("|");
  if (separator < 0) return null;
  const status = line.slice(0, separator).trim();
  const version = line.slice(separator + 1).trim();
  if (status.length === 0 || version.length === 0) return null;
  return { status, version };
}

export function isDebInstalled(status: DpkgQueryStatus): boolean {
  return status.status === "install ok installed";
}

// electron-builder's deb target maps `-` to `~` (getSanitizedVersion) so
// prerelease versions sort before the base release in dpkg ordering. Used for
// JSON result reporting only; install verification always reads the Version
// straight from the built artifact.
export function sanitizeDebVersion(version: string): string {
  return version.replace(/-/g, "~");
}
```

Note: `composePrivileged` is module-private — the spec's one-way import rule holds (`deb.ts` imports from `linux.ts`, never the reverse).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @open-design/tools-pack test -- tests/linux-deb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/pack/src/linux/deb.ts tools/pack/src/linux.ts tools/pack/tests/linux-deb.test.ts
git commit -m "feat(pack): add deb smoke pure helpers"
```

---

### Task 5: Deb install/uninstall IO orchestrators

**Files:**
- Modify: `tools/pack/src/linux/deb.ts` — orchestrators, result types, injectable IO
- Test: `tools/pack/tests/linux-deb.test.ts`

**Interfaces:**
- Consumes: `findBuiltDeb`, `resolveLinuxPaths`, `commandExists` from `../linux.js`; all Task 4 helpers.
- Produces (exported from `tools/pack/src/linux/deb.ts`):
  - `export type DebCommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;`
  - `export type DebEnvironment = { isRoot: boolean; hasSudo: boolean; hasAptGet: boolean; hasDpkg: boolean; };`
  - `export type DebOrchestratorOptions = { environment?: DebEnvironment; run?: DebCommandRunner; };`
  - `export type LinuxDebInstallResult = { artifactPath: string; packageManager: DebPackageManager; package: string; version: string; installedFiles: string[]; };`
  - `export async function installPackedLinuxDeb(config: ToolPackConfig, options?: DebOrchestratorOptions): Promise<LinuxDebInstallResult>;`
  - `export type LinuxDebUninstallResult = { package: string; packageManager: DebPackageManager; status: string; };`
  - `export async function uninstallPackedLinuxDeb(options?: DebOrchestratorOptions): Promise<LinuxDebUninstallResult>;`

Design note: environment detection (`process.getuid`, `commandExists`) and command execution (`execFileAsync`) are resolved once into a `DebEnvironment`/`DebCommandRunner` and injected. Unit tests pass both explicitly, so tests never execute real system commands and are host-independent. CLI callers use the defaults.

- [ ] **Step 1: Write the failing tests**

Update the top-of-file import of `@/linux/deb.js` in `tools/pack/tests/linux-deb.test.ts` to include the orchestrators:

```ts
import {
  composeDebInstallCommand,
  composeDebUninstallCommand,
  installPackedLinuxDeb,
  isDebInstalled,
  parseDpkgQueryStatus,
  pickDebPackageManager,
  resolveDebPrivilege,
  sanitizeDebVersion,
  uninstallPackedLinuxDeb,
} from "@/linux/deb.js";
```

Add `vi` to the existing vitest import:

```ts
import { describe, expect, it, vi } from "vitest";
```

Test bodies (the `DEB_ENV`, `makeDebTestConfig`, `mkdtemp`, `tmpdir`, `join`, `writeFile` bindings come from Task 3's additions):

```ts
const DEB_ENV = { isRoot: false, hasSudo: true, hasAptGet: true, hasDpkg: true };

describe("installPackedLinuxDeb", () => {
  it("fails fast when no .deb was built", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "odtp-deb-"));
    await expect(installPackedLinuxDeb(makeDebTestConfig(outputRoot), { environment: DEB_ENV })).rejects.toThrow(
      /no .deb found in builder output; run `tools-pack linux build --to deb` first/,
    );
  });

  it("installs under the privilege prefix and verifies status and version straight from the artifact", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "odtp-deb-"));
    const artifactPath = join(outputRoot, "Open Design-ns.deb");
    await writeFile(artifactPath, "deb-bytes");
    const config = makeDebTestConfig(outputRoot);

    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "dpkg-deb") return { stdout: "0.10.0~beta.1\n" };
      if (command === "dpkg-query" && args.includes("-f=${Status}|${Version}")) {
        return { stdout: "install ok installed|0.10.0~beta.1\n" };
      }
      if (command === "dpkg-query" && args.includes("-L")) {
        return { stdout: "/opt/OpenDesign\n/usr/bin/open-design\n" };
      }
      return { stdout: "" };
    });

    const result = await installPackedLinuxDeb(config, { environment: DEB_ENV, run });
    expect(result).toEqual({
      artifactPath,
      packageManager: "apt-get",
      package: "open-design",
      version: "0.10.0~beta.1",
      installedFiles: ["/opt/OpenDesign", "/usr/bin/open-design"],
    });
    expect(run).toHaveBeenCalledWith("sudo", [
      "-n",
      "env",
      "DEBIAN_FRONTEND=noninteractive",
      "apt-get",
      "install",
      "-y",
      artifactPath,
    ]);
  });

  it("fails the smoke when dpkg reports a different version than the artifact", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "odtp-deb-"));
    const artifactPath = join(outputRoot, "Open Design-ns.deb");
    await writeFile(artifactPath, "deb-bytes");
    const config = makeDebTestConfig(outputRoot);

    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "dpkg-deb") return { stdout: "0.10.0~beta.1\n" };
      if (command === "dpkg-query" && args.includes("-f=${Status}|${Version}")) {
        return { stdout: "install ok installed|0.9.0\n" };
      }
      return { stdout: "" };
    });

    await expect(installPackedLinuxDeb(config, { environment: DEB_ENV, run })).rejects.toThrow(
      /deb install verification failed/,
    );
  });
});

describe("uninstallPackedLinuxDeb", () => {
  it("reports config-files residue without failing", async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "dpkg-query" && args.includes("-f=${Status}|${Version}")) {
        return { stdout: "deinstall ok config-files|0.10.0~beta.1\n" };
      }
      return { stdout: "" };
    });
    const result = await uninstallPackedLinuxDeb({ environment: DEB_ENV, run });
    expect(result).toEqual({
      package: "open-design",
      packageManager: "apt-get",
      status: "deinstall ok config-files",
    });
  });

  it("fails when the package is still installed", async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "dpkg-query" && args.includes("-f=${Status}|${Version}")) {
        return { stdout: "install ok installed|0.10.0~beta.1\n" };
      }
      return { stdout: "" };
    });
    await expect(uninstallPackedLinuxDeb({ environment: DEB_ENV, run })).rejects.toThrow(/still installed/);
  });

  it("reports not-installed when dpkg-query exits non-zero for an unknown package", async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "dpkg-query" && args.includes("-f=${Status}|${Version}")) {
        throw new Error("dpkg-query: no packages found matching open-design");
      }
      return { stdout: "" };
    });
    const result = await uninstallPackedLinuxDeb({ environment: DEB_ENV, run });
    expect(result.status).toBe("not-installed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @open-design/tools-pack test -- tests/linux-deb.test.ts`
Expected: FAIL — `installPackedLinuxDeb`/`uninstallPackedLinuxDeb` are not exported from `@/linux/deb.js`.

- [ ] **Step 3: Implement the orchestrators**

1. The Task 4 helpers already live in `tools/pack/src/linux/deb.ts`; do **not** split the file — add the orchestrator code below them in the same file. Replace the import block at the top of `tools/pack/src/linux/deb.ts` (the single `import { DEB_PACKAGE_NAME } from "../linux.js";` line from Task 4) with:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ToolPackConfig } from "../config/index.js";
import { commandExists, DEB_PACKAGE_NAME, findBuiltDeb, resolveLinuxPaths } from "../linux.js";
```

2. Append the orchestrator code to `tools/pack/src/linux/deb.ts`:

```ts
const execFileAsync = promisify(execFile);

export type DebCommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;

export type DebEnvironment = {
  isRoot: boolean;
  hasSudo: boolean;
  hasAptGet: boolean;
  hasDpkg: boolean;
};

export type DebOrchestratorOptions = {
  environment?: DebEnvironment;
  run?: DebCommandRunner;
};

async function detectDebEnvironment(): Promise<DebEnvironment> {
  return {
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
    hasSudo: await commandExists("sudo"),
    hasAptGet: await commandExists("apt-get"),
    hasDpkg: await commandExists("dpkg"),
  };
}

export type LinuxDebInstallResult = {
  artifactPath: string;
  packageManager: DebPackageManager;
  package: string;
  version: string;
  installedFiles: string[];
};

export async function installPackedLinuxDeb(
  config: ToolPackConfig,
  options: DebOrchestratorOptions = {},
): Promise<LinuxDebInstallResult> {
  const { environment = await detectDebEnvironment(), run = execFileAsync } = options;
  const privilege = resolveDebPrivilege({ isRoot: environment.isRoot, hasSudo: environment.hasSudo });
  const packageManager = pickDebPackageManager({
    hasAptGet: environment.hasAptGet,
    hasDpkg: environment.hasDpkg,
  });

  const artifactPath = await findBuiltDeb(resolveLinuxPaths(config));
  if (artifactPath == null) {
    throw new Error("no .deb found in builder output; run `tools-pack linux build --to deb` first");
  }

  const { command, args } = composeDebInstallCommand({ packageManager, privilege, artifactPath });
  await run(command, args);

  const artifactVersion = (await run("dpkg-deb", ["-f", artifactPath, "Version"])).stdout.trim();
  const query = parseDpkgQueryStatus(
    (await run("dpkg-query", ["-W", "-f=${Status}|${Version}", DEB_PACKAGE_NAME])).stdout,
  );
  if (query == null || !isDebInstalled(query) || query.version !== artifactVersion) {
    const observed = query == null ? "no dpkg-query output" : `${query.status} at ${query.version}`;
    throw new Error(
      `deb install verification failed: expected install ok installed at ${artifactVersion}, got ${observed}`,
    );
  }

  const installedFiles = (await run("dpkg-query", ["-L", DEB_PACKAGE_NAME])).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    artifactPath,
    packageManager,
    package: DEB_PACKAGE_NAME,
    version: sanitizeDebVersion(artifactVersion),
    installedFiles,
  };
}

export type LinuxDebUninstallResult = {
  package: string;
  packageManager: DebPackageManager;
  status: string;
};

export async function uninstallPackedLinuxDeb(options: DebOrchestratorOptions = {}): Promise<LinuxDebUninstallResult> {
  const { environment = await detectDebEnvironment(), run = execFileAsync } = options;
  const privilege = resolveDebPrivilege({ isRoot: environment.isRoot, hasSudo: environment.hasSudo });
  const packageManager = pickDebPackageManager({
    hasAptGet: environment.hasAptGet,
    hasDpkg: environment.hasDpkg,
  });

  const { command, args } = composeDebUninstallCommand({ packageManager, privilege });
  await run(command, args);

  // dpkg-query exits non-zero once the package is fully unknown (purged);
  // `deinstall ok config-files` residue exits zero and is reported as-is.
  let status = "unknown";
  try {
    const query = parseDpkgQueryStatus(
      (await run("dpkg-query", ["-W", "-f=${Status}|${Version}", DEB_PACKAGE_NAME])).stdout,
    );
    if (query != null) status = query.status;
  } catch {
    status = "not-installed";
  }
  if (status === "install ok installed") {
    throw new Error(`deb uninstall verification failed: ${DEB_PACKAGE_NAME} is still installed`);
  }

  return { package: DEB_PACKAGE_NAME, packageManager, status };
}
```

Notes:
- `sanitizeDebVersion(artifactVersion)` is belt-and-braces: the Version read via `dpkg-deb -f` is already the electron-builder-sanitized value, so the mapping is a no-op there; the helper keeps the reporting contract explicit and unit-tested.
- Verification reads (`dpkg-deb -f`, `dpkg-query`) run unprefixed; only the mutating `run(command, args)` call carries the privilege prefix.
- `uninstallPackedLinuxDeb` takes no `config`: it needs no paths — only privilege and package-manager resolution plus the dpkg database.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @open-design/tools-pack test -- tests/linux-deb.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @open-design/tools-pack typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tools/pack/src/linux/deb.ts tools/pack/tests/linux-deb.test.ts
git commit -m "feat(pack): add deb install/uninstall smoke orchestrators"
```

---

### Task 6: Lifecycle-mode plumbing and CLI `--deb` wiring

**Files:**
- Modify: `tools/pack/src/linux.ts` — `LinuxLifecycleAction`/`LinuxLifecycleMode`/`resolveLinuxLifecycleMode`
- Modify: `tools/pack/src/index.ts` — `--deb` option, dispatch, logs/inspect guards
- Test: `tools/pack/tests/linux-deb.test.ts`

**Interfaces:**
- Consumes: `installPackedLinuxDeb`/`uninstallPackedLinuxDeb` (Task 5); `ToolPackCliOptions.deb` (Task 1).
- Produces:
  - `export type LinuxLifecycleAction = "cleanup" | "install" | "logs" | "inspect" | "start" | "stop" | "uninstall";`
  - `export type LinuxLifecycleMode = "appimage" | "deb" | "headless";`
  - `export function resolveLinuxLifecycleMode(options: { deb?: boolean; headless?: boolean }, action: LinuxLifecycleAction): LinuxLifecycleMode` — throws on `--deb`+`--headless`, and on `--deb` with any action other than `install`/`uninstall`.

- [ ] **Step 1: Write the failing tests**

Note: `tools/pack/tests/linux.test.ts` already covers the non-deb matrix (lines ~849-863) — those keep passing unchanged. Append the deb matrix to `tools/pack/tests/linux-deb.test.ts` (import at top with the others):

```ts
import { resolveLinuxLifecycleMode } from "@/linux.js";
```

```ts
describe("resolveLinuxLifecycleMode deb plumbing", () => {
  it("selects the deb mode for install/uninstall", () => {
    expect(resolveLinuxLifecycleMode({ deb: true }, "install")).toBe("deb");
    expect(resolveLinuxLifecycleMode({ deb: true }, "uninstall")).toBe("deb");
  });

  it("rejects --deb combined with --headless", () => {
    expect(() => resolveLinuxLifecycleMode({ deb: true, headless: true }, "install")).toThrow(/mutually exclusive/);
  });

  it("rejects --deb on non-smoke actions", () => {
    expect(() => resolveLinuxLifecycleMode({ deb: true }, "start")).toThrow(/does not support --deb/);
    expect(() => resolveLinuxLifecycleMode({ deb: true }, "stop")).toThrow(/does not support --deb/);
    expect(() => resolveLinuxLifecycleMode({ deb: true }, "logs")).toThrow(/does not support --deb/);
    expect(() => resolveLinuxLifecycleMode({ deb: true }, "inspect")).toThrow(/does not support --deb/);
    expect(() => resolveLinuxLifecycleMode({ deb: true }, "cleanup")).toThrow(/does not support --deb/);
  });

  it("preserves appimage/headless selection without --deb", () => {
    expect(resolveLinuxLifecycleMode({}, "install")).toBe("appimage");
    expect(resolveLinuxLifecycleMode({ headless: true }, "start")).toBe("headless");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @open-design/tools-pack test -- tests/linux-deb.test.ts`
Expected: FAIL — `deb` option is not recognized (returns `"appimage"` instead of `"deb"`, no throws).

- [ ] **Step 3: Implement resolveLinuxLifecycleMode**

Replace the existing implementation in `tools/pack/src/linux.ts` (line ~74):

```ts
export type LinuxLifecycleAction = "cleanup" | "install" | "logs" | "inspect" | "start" | "stop" | "uninstall";
export type LinuxLifecycleMode = "appimage" | "deb" | "headless";

export function resolveLinuxLifecycleMode(
  options: { deb?: boolean; headless?: boolean },
  action: LinuxLifecycleAction,
): LinuxLifecycleMode {
  if (options.deb === true) {
    if (options.headless === true) {
      throw new Error("--deb and --headless are mutually exclusive");
    }
    if (action !== "install" && action !== "uninstall") {
      throw new Error(`linux ${action} does not support --deb; deb smoke supports install/uninstall only`);
    }
    return "deb";
  }
  return options.headless === true ? "headless" : "appimage";
}
```

(The previously unused `_action` parameter is now `action` and load-bearing.)

- [ ] **Step 4: Wire the CLI**

In `tools/pack/src/index.ts`:

1. Extend the linux import block with the deb orchestrators:

```ts
import {
  cleanupPackedLinuxNamespace,
  installPackedLinuxApp,
  installPackedLinuxDeb,
  installPackedLinuxHeadless,
  inspectPackedLinuxApp,
  packLinux,
  readPackedLinuxLogs,
  resolveLinuxLifecycleMode,
  startPackedLinuxApp,
  startPackedLinuxHeadless,
  stopPackedLinuxApp,
  stopPackedLinuxHeadless,
  uninstallPackedLinuxApp,
  uninstallPackedLinuxDeb,
  uninstallPackedLinuxHeadless,
} from "./linux.js";
```

2. Add the `--deb` option to the linux command chain (after `--headless`):

```ts
addBuildOptions(addSharedOptions(cli.command("linux <action>", "Linux packaging commands: build|install|start|stop|logs|uninstall|cleanup|inspect")), "linux")
  .option("--containerized", "build inside electronuserland/builder Docker for wider glibc compatibility")
  .option("--headless", "install/start/stop/uninstall/cleanup the headless entry; inspect returns status only")
  .option("--deb", "install/uninstall the built .deb artifact (install/uninstall only)")
```

3. Rewrite the install/uninstall/logs/inspect cases in the linux action handler:

```ts
      case "install": {
        const mode = resolveLinuxLifecycleMode(options, "install");
        printJson(
          await (mode === "deb"
            ? installPackedLinuxDeb(config)
            : mode === "headless"
              ? installPackedLinuxHeadless(config)
              : installPackedLinuxApp(config)),
        );
        return;
      }
```

```ts
      case "uninstall": {
        const mode = resolveLinuxLifecycleMode(options, "uninstall");
        printJson(
          await (mode === "deb"
            ? uninstallPackedLinuxDeb()
            : mode === "headless"
              ? uninstallPackedLinuxHeadless(config)
              : uninstallPackedLinuxApp(config)),
        );
        return;
      }
```

```ts
      case "logs":
        resolveLinuxLifecycleMode(options, "logs");
        printLogs(await readPackedLinuxLogs(config), options);
        return;
```

```ts
      case "inspect":
        resolveLinuxLifecycleMode(options, "inspect");
        printJson(await inspectPackedLinuxApp(config, {
          expr: options.expr,
          headless: options.headless === true,
          path: options.path,
        }));
        return;
```

(The `resolveLinuxLifecycleMode(options, "logs" | "inspect")` calls are the enforcement point: they throw for `--deb` on those actions and are no-ops otherwise. `start`/`stop`/`cleanup` already dispatch through the resolver or `cleanupPackedLinuxNamespace`, so `--deb` there throws via the same code path.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @open-design/tools-pack test -- tests/linux-deb.test.ts tests/linux.test.ts`
Expected: PASS — deb matrix passes; existing linux tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add tools/pack/src/linux.ts tools/pack/src/index.ts tools/pack/tests/linux-deb.test.ts
git commit -m "feat(pack): wire --deb lifecycle mode into tools-pack linux CLI"
```

---

### Task 7: AGENTS.md ownership docs and full verification

**Files:**
- Modify: `tools/pack/AGENTS.md` — "Owns" list + Rules
- Modify: `tools/AGENTS.md` — common commands

**Interfaces:**
- Consumes: the completed feature.
- Produces: agent-facing documentation matching the shipped surface.

- [ ] **Step 1: Update tools/pack/AGENTS.md**

In the "Owns" list, after the Linux containerized-builds line, add:

```markdown
- Linux deb build target (`--to deb`, dual-target `--to all`) and deb install/uninstall smoke via apt-get/dpkg with `sudo -n` elevation.
```

In "Rules", add:

```markdown
- The deb lane uses the fixed dpkg package name `open-design` (artifact file names stay namespace-scoped) and owns no process lifecycle: start/stop/logs/inspect remain AppImage-only, and deb install/uninstall never stops running instances.
```

- [ ] **Step 2: Update tools/AGENTS.md**

In the "Common tools commands" code block, after `pnpm tools-pack linux build --containerized`, add:

```bash
pnpm tools-pack linux build --to deb
```

- [ ] **Step 3: Run the full package test suite**

Run: `pnpm --filter @open-design/tools-pack test`
Expected: PASS — no regressions across all suites.

- [ ] **Step 4: Run typecheck and repo guards**

```bash
pnpm --filter @open-design/tools-pack typecheck
pnpm guard
pnpm typecheck
```

Expected: all clean.

- [ ] **Step 5: Manual smoke on a Debian-family host (Ubuntu/Debian), if available**

```bash
pnpm tools-pack linux build --to deb --namespace deb-smoke
sudo -n env DEBIAN_FRONTEND=noninteractive true
pnpm tools-pack linux install --deb --namespace deb-smoke --json
pnpm tools-pack linux uninstall --deb --namespace deb-smoke --json
pnpm tools-pack linux cleanup --namespace deb-smoke --json
```

Expected: install JSON reports `package: "open-design"`, `install ok installed` status match, `version` equal to the built artifact's `dpkg-deb -f ... Version`; uninstall JSON reports the package no longer `install ok installed` (`deinstall ok config-files` residue is acceptable and reported as-is). On a prerelease build (`--app-version 0.10.0-beta.1`), `version` must read `0.10.0~beta.1`. If no Debian-family host is available, record the build artifact check only (`dpkg-deb -f <out>/.../Open Design-*.deb Package Version` on any host with dpkg-deb, or inside the `--containerized` run) and note the install/uninstall smoke as pending on a maintainer machine.

- [ ] **Step 6: Commit**

```bash
git add tools/pack/AGENTS.md tools/AGENTS.md
git commit -m "docs(pack): record linux deb lane ownership and command"
```
