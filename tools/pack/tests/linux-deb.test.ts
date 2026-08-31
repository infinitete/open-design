import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "@/config/index.js";
import { DEB_PACKAGE_NAME, findBuiltDeb, linuxBuilderTargetsFor, resolveLinuxPaths } from "@/linux.js";

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
