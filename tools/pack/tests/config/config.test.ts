import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";

import cliSource from "@/index.ts?raw";
import { resolveToolPackConfig, WORKSPACE_ROOT } from "@/config/index.js";

// The retired platform CLI surface: no strict-bundling flag, no env override,
// no optional package pin, and no copied platform binary may come back on any
// platform. These tokens are asserted here (config + CLI + manifest) and per
// platform in the mac/win/linux/release-workflow suites.
const retiredVelaCliTokens = [
  "--require-vela-cli",
  "OPEN_DESIGN_VELA_CLI_BIN",
  "@powerformer/vela-cli",
  "open-design/bin/vela",
] as const;

describe("resolveToolPackConfig retired Vela packaging inputs", () => {
  it("resolves a config with no strict-bundling, AMR profile, or web-origin fields", () => {
    const config = resolveToolPackConfig("mac", { namespace: "retired-inputs-test" }) as Record<
      string,
      unknown
    >;
    expect("requireVelaCli" in config).toBe(false);
    expect("amrProfile" in config).toBe(false);
    expect("velaWebUrl" in config).toBe(false);
    expect("velaWebUrls" in config).toBe(false);
  });

  it("ignores retired build-time environment variables instead of validating them", () => {
    // Values the old resolvers rejected (unknown profile, non-URL origins) must
    // now be inert: the keys are no longer read, so a leftover CI secret or a
    // stale local export cannot fail or shape a build.
    const retiredEnv = {
      OD_VELA_WEB_URL: "not-a-url",
      OD_VELA_WEB_URL_PROD: "not-a-url",
      OD_VELA_WEB_URL_TEST: "not-a-url",
      OD_VELA_WEB_URL_FEATURE_TEST: "not-a-url",
      OPEN_DESIGN_AMR_PROFILE: "staging",
      OPEN_DESIGN_VELA_CLI_BIN: "/host/bin/vela",
    } as const;
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(retiredEnv)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const config = resolveToolPackConfig("mac", { namespace: "retired-inputs-test" }) as Record<
        string,
        unknown
      >;
      expect("amrProfile" in config).toBe(false);
      expect("velaWebUrl" in config).toBe(false);
      expect("velaWebUrls" in config).toBe(false);
      expect("requireVelaCli" in config).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("declares no retired Vela packaging token in the CLI surface or package manifest", async () => {
    for (const token of retiredVelaCliTokens) {
      expect(cliSource).not.toContain(token);
    }
    const manifest = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    for (const token of retiredVelaCliTokens) {
      expect(manifest).not.toContain(token);
    }
  });
});

describe("resolveToolPackConfig win build target", () => {
  it("accepts the portable zip target and rejects unsupported values", () => {
    expect(resolveToolPackConfig("win", { to: "zip" }).to).toBe("zip");
    expect(resolveToolPackConfig("win", { to: "all" }).to).toBe("all");
    expect(resolveToolPackConfig("win", { to: "nsis" }).to).toBe("nsis");
    expect(() => resolveToolPackConfig("win", { to: "dmg" })).toThrow(/unsupported win --to target: dmg/);
  });
});

describe("resolveToolPackConfig linux build target", () => {
  it("accepts the deb target alongside appimage/dir/all and rejects unsupported values", () => {
    expect(resolveToolPackConfig("linux", { to: "deb" }).to).toBe("deb");
    expect(resolveToolPackConfig("linux", { to: "appimage" }).to).toBe("appimage");
    expect(resolveToolPackConfig("linux", { to: "dir" }).to).toBe("dir");
    expect(resolveToolPackConfig("linux", { to: "all" }).to).toBe("all");
    expect(() => resolveToolPackConfig("linux", { to: "nsis" })).toThrow(/unsupported linux --to target: nsis/);
  });
});

describe("resolveToolPackConfig cache root", () => {
  it("keeps the default cache outside custom tools-pack roots", () => {
    const config = resolveToolPackConfig("win", {
      dir: "C:\\odqa-release-4ch",
      namespace: "cache-root-test",
    });

    expect(config.roots.toolPackRoot).toBe(resolve("C:\\odqa-release-4ch"));
    expect(config.roots.cacheRoot).toBe(resolve(join(WORKSPACE_ROOT, ".tmp", "tools-pack", "cache")));
  });

  it("uses an explicit cache-dir when supplied", () => {
    const config = resolveToolPackConfig("win", {
      cacheDir: "C:\\odqa-tools-pack-cache",
      dir: "C:\\odqa-release-4ch",
      namespace: "cache-root-test",
    });

    expect(config.roots.toolPackRoot).toBe(resolve("C:\\odqa-release-4ch"));
    expect(config.roots.cacheRoot).toBe(resolve("C:\\odqa-tools-pack-cache"));
  });
});

describe("resolveToolPackConfig namespace defaults", () => {
  it("keeps ordinary local builds on the default namespace", () => {
    expect(resolveToolPackConfig("mac").namespace).toBe("default");
    expect(resolveToolPackConfig("win", { appVersion: "0.8.0" }).namespace).toBe("default");
  });

  it("defaults prerelease mac builds to their release channel namespace", () => {
    expect(resolveToolPackConfig("mac", { appVersion: "0.8.0-beta.4" }).namespace).toBe("release-beta");
    expect(resolveToolPackConfig("mac", { appVersion: "0.8.0-preview.4" }).namespace).toBe("release-preview");
    expect(resolveToolPackConfig("mac", { appVersion: "0.8.0-prerelease.4" }).namespace).toBe("release-prerelease");
  });

  it("defaults prerelease non-mac builds to platform-specific release channel namespaces", () => {
    expect(resolveToolPackConfig("win", { appVersion: "0.8.0-beta.4" }).namespace).toBe("release-beta-win");
    expect(resolveToolPackConfig("linux", { appVersion: "0.8.0-preview.4" }).namespace).toBe("release-preview-linux");
    expect(resolveToolPackConfig("win", { appVersion: "0.8.0-prerelease.4" }).namespace).toBe("release-prerelease-win");
  });

  it("keeps an explicit namespace ahead of the prerelease channel default", () => {
    expect(resolveToolPackConfig("mac", { appVersion: "0.8.0-beta.4", namespace: "custom-beta" }).namespace).toBe(
      "custom-beta",
    );
  });
});

describe("resolveToolPackConfig retired telemetry analytics inputs", () => {
  it("resolves a config with no telemetry or PostHog fields", () => {
    const config = resolveToolPackConfig("mac", { namespace: "retired-telemetry-test" }) as Record<
      string,
      unknown
    >;
    expect("telemetryRelayUrl" in config).toBe(false);
    expect("posthogKey" in config).toBe(false);
    expect("posthogHost" in config).toBe(false);
    expect("posthogCliApiKey" in config).toBe(false);
    expect("posthogCliProjectId" in config).toBe(false);
    expect("posthogCliHost" in config).toBe(false);
  });

  it("ignores retired telemetry environment variables instead of validating them", () => {
    // Values the old resolvers rejected (non-URL relay hosts, whitespace keys)
    // must now be inert: the keys are no longer read, so a leftover CI secret
    // or a stale local export cannot fail or shape a build.
    const retiredEnv = {
      OPEN_DESIGN_TELEMETRY_RELAY_URL: "not-a-url",
      POSTHOG_KEY: "phc_test abc",
      POSTHOG_HOST: "not-a-url",
      POSTHOG_CLI_API_KEY: "phx_test def",
      POSTHOG_CLI_PROJECT_ID: "not-numeric",
      POSTHOG_CLI_HOST: "not-a-url",
    } as const;
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(retiredEnv)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const config = resolveToolPackConfig("mac", { namespace: "retired-telemetry-test" }) as Record<
        string,
        unknown
      >;
      expect("telemetryRelayUrl" in config).toBe(false);
      expect("posthogKey" in config).toBe(false);
      expect("posthogHost" in config).toBe(false);
      expect("posthogCliApiKey" in config).toBe(false);
      expect("posthogCliProjectId" in config).toBe(false);
      expect("posthogCliHost" in config).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
