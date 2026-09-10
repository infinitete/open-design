import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
}));

import { PackagedPathAccessError } from "../src/errors.js";
import {
  claimPackagedSingleInstanceLock,
  createPackagedSecondInstanceHandoff,
  ensurePackagedNamespacePaths,
  findPackagedDeeplinkArg,
  stabilizePackagedWorkingDirectory,
  verifyPackagedDataRootWritable,
} from "../src/launch.js";
import { resolvePackagedNamespacePaths } from "../src/paths.js";

describe("stabilizePackagedWorkingDirectory", () => {
  it("switches to the namespace runtime root without reading the inherited cwd", () => {
    const runtimeRoot = join(tmpdir(), "od-packaged-runtime");
    const chdir = vi.fn();
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("uv_cwd");
    });

    try {
      stabilizePackagedWorkingDirectory({ runtimeRoot }, chdir);

      expect(chdir).toHaveBeenCalledWith(runtimeRoot);
      expect(cwd).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
    }
  });
});

describe("ensurePackagedNamespacePaths", () => {
  it("creates no update or generation directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "od-packaged-namespace-"));
    try {
      const config = {
        appVersion: "1.2.3",
        daemonCliEntry: null,
        daemonSidecarEntry: null,
        namespace: "release-beta-win",
        namespaceBaseRoot: join(root, "namespaces"),
        nodeCommand: null,
        resourceRoot: join(root, "resources", "open-design"),
        webOutputMode: "server" as const,
        webSidecarEntry: null,
        webStandaloneRoot: null,
      };
      const paths = resolvePackagedNamespacePaths(config, config.namespace);

      await ensurePackagedNamespacePaths(paths);

      // The packaged app installs and boots as a single artifact: no update
      // root, no version directories, no generation pointer files.
      expect(existsSync(join(paths.namespaceRoot, "updates"))).toBe(false);
      expect(existsSync(join(paths.namespaceRoot, "versions"))).toBe(false);
      expect(existsSync(join(paths.namespaceRoot, "runtime.json"))).toBe(false);
      expect(existsSync(join(paths.namespaceRoot, "state", "attempt.json"))).toBe(false);
      expect(existsSync(paths.runtimeRoot)).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("verifyPackagedDataRootWritable", () => {
  it("accepts a writable dataRoot", async () => {
    const root = mkdtempSync(join(tmpdir(), "od-packaged-launch-"));
    try {
      const dataRoot = join(root, "namespaces", "release-beta", "data");
      await expect(verifyPackagedDataRootWritable({ dataRoot })).resolves.toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("wraps low-level mkdir/access failures with a user-actionable error", async () => {
    const root = mkdtempSync(join(tmpdir(), "od-packaged-launch-"));
    try {
      const blocker = join(root, "namespaces", "release-beta");
      mkdirSync(blocker, { recursive: true });
      writeFileSync(join(blocker, "data"), "not a directory");

      let captured: unknown;
      try {
        await verifyPackagedDataRootWritable({ dataRoot: join(blocker, "data") });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(PackagedPathAccessError);
      expect((captured as Error).message).toContain("Open Design could not create or write to:");
      expect((captured as Error).message).toContain(join(blocker, "data"));
      expect((captured as Error).message).toContain("Current user:");
      expect((captured as Error).message).toContain("Try in Terminal:");
      expect((captured as Error).message).toContain("sudo chown -R");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("claimPackagedSingleInstanceLock", () => {
  it("registers a second-instance focus callback when the lock is acquired", () => {
    const listeners = new Map<string, (event: unknown, argv: string[]) => void>();
    const app = {
      on: vi.fn((event: string, listener: (event: unknown, argv: string[]) => void) => {
        listeners.set(event, listener);
        return app;
      }),
      quit: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
    };
    const focusExisting = vi.fn();

    expect(claimPackagedSingleInstanceLock(app, focusExisting)).toBe(true);
    listeners.get("second-instance")?.({}, ["Open Design.exe", "--from-protocol"]);

    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(app.on).toHaveBeenCalledWith("second-instance", expect.any(Function));
    expect(app.quit).not.toHaveBeenCalled();
    expect(focusExisting).toHaveBeenCalledExactlyOnceWith([
      "Open Design.exe",
      "--from-protocol",
    ]);
  });

  it("queues a deeplink from the lock fallback while desktop IPC is unavailable", () => {
    const listeners = new Map<string, (event: unknown, argv: string[]) => void>();
    const deeplinkUrl = "opendesign://workspace/invite/continue?nonce=cold-race";
    const handoff = createPackagedSecondInstanceHandoff();
    const app = {
      on: vi.fn((event: string, listener: (event: unknown, argv: string[]) => void) => {
        listeners.set(event, listener);
        return app;
      }),
      quit: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
    };
    const dispatchDeeplink = vi.fn();
    const show = vi.fn();

    expect(claimPackagedSingleInstanceLock(app, (argv) => {
      handoff.handle(findPackagedDeeplinkArg(argv));
    })).toBe(true);
    listeners.get("second-instance")?.({}, ["Open Design.exe", deeplinkUrl]);

    expect(show).not.toHaveBeenCalled();
    expect(dispatchDeeplink).not.toHaveBeenCalled();

    handoff.attach({ dispatchDeeplink, show });

    expect(show).toHaveBeenCalledTimes(1);
    expect(dispatchDeeplink).toHaveBeenCalledExactlyOnceWith(deeplinkUrl);
  });

  it("quits the duplicate process before packaged sidecars start when the lock is held", () => {
    const app = {
      on: vi.fn(),
      quit: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => false),
    };

    expect(claimPackagedSingleInstanceLock(app, vi.fn())).toBe(false);

    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.on).not.toHaveBeenCalled();
  });
});
