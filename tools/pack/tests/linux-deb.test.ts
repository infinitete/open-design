import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "@/config/index.js";
import { DEB_PACKAGE_NAME, findBuiltDeb, linuxBuilderTargetsFor, resolveLinuxPaths } from "@/linux.js";
import {
  composeDebInstallCommand,
  composeDebUninstallCommand,
  isDebInstalled,
  parseDpkgQueryStatus,
  pickDebPackageManager,
  resolveDebPrivilege,
  sanitizeDebVersion,
} from "@/linux/deb.js";

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
