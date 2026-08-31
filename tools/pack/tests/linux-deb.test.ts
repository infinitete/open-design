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
