import { describe, expect, it } from "vitest";

import {
  resolveAboutPanelVersion,
  resolveFirstAvailableBaseUrl,
} from "../../src/main/index.js";

// Unit pins for the two generic main-process helpers that survived the
// removal of the hidden AMR environment profile menu. They back real
// behavior: `resolveFirstAvailableBaseUrl` is the ordered fallback behind
// daemon URL discovery (deeplink hand-off, diagnostics export, updater
// app-config reads), and `resolveAboutPanelVersion` feeds the native
// About panel's version line.
describe("resolveFirstAvailableBaseUrl", () => {
  it("falls through a busy discovery source to the direct daemon URL", async () => {
    await expect(resolveFirstAvailableBaseUrl([
      async () => null,
      async () => "http://127.0.0.1:17456",
      async () => "http://127.0.0.1:17573",
    ])).resolves.toBe("http://127.0.0.1:17456");
  });

  it("continues after a discovery source throws", async () => {
    await expect(resolveFirstAvailableBaseUrl([
      async () => { throw new Error("sidecar busy"); },
      async () => "http://127.0.0.1:17456",
    ])).resolves.toBe("http://127.0.0.1:17456");
  });

  it("rejects when every discovery source comes up empty", async () => {
    await expect(resolveFirstAvailableBaseUrl([
      async () => null,
      async () => "   ",
    ])).rejects.toThrow("daemon URL is unavailable");
  });
});

describe("resolveAboutPanelVersion", () => {
  it("uses the active packaged runtime version for the native About panel", () => {
    expect(resolveAboutPanelVersion({ update: { currentVersion: "0.10.0-beta.24" } })).toBe("0.10.0-beta.24");
    expect(resolveAboutPanelVersion({ update: { currentVersion: " 0.10.0-beta.24 " } })).toBe("0.10.0-beta.24");
    expect(resolveAboutPanelVersion({ update: { currentVersion: "" } })).toBeNull();
    expect(resolveAboutPanelVersion({})).toBeNull();
  });
});
