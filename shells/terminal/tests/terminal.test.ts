import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StandaloneStore, canonicalJson, sha256Hex, signStandaloneChannelHead, signStandaloneMetadata, supportsInstalledShell, type StandaloneMetadata } from "@open-design/standalone";
import { FileFixtureLifecyclePort, OFFICIAL_NODE_VERSION, assertOfficialNodeVersion } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

describe("Terminal shell skeleton", () => {
  it("pins the exact official Node carrier", () => {
    expect(OFFICIAL_NODE_VERSION).toBe("24.18.0");
    expect(() => assertOfficialNodeVersion("24.18.0")).not.toThrow();
    expect(() => assertOfficialNodeVersion("24.18.1")).toThrow("requires official Node 24.18.0");
  });

  it("persists the Web/daemon-independent lifecycle fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-fixture-")); roots.push(root);
    const port = new FileFixtureLifecyclePort(root, "betahyx-local");
    const generation = { schemaVersion: 1 as const, id: "generation-1", channel: "betahyx", releaseVersion: "0.1.0-betahyx.1", standaloneVersion: "0.1.0", sourceCommit: "a".repeat(40), components: {} };
    await expect(port.start(generation)).resolves.toEqual({ state: "running", generationId: "generation-1" });
    await expect(new FileFixtureLifecyclePort(root, "betahyx-local").status()).resolves.toEqual({ state: "running", generationId: "generation-1" });
    await expect(port.stop()).resolves.toEqual({ state: "stopped", generationId: "generation-1" });
  });

  it("boots the committed generation and records it as the successful one", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-boot-")); roots.push(root);
    const artifact = Buffer.from("closure-update");
    const keys = generateKeyPairSync("ed25519");
    const metadata: StandaloneMetadata = {
      schemaVersion: 1,
      channel: "betahyx",
      releaseVersion: "0.1.0-betahyx.1",
      standaloneVersion: "0.1.0",
      sourceCommit: "a".repeat(40),
      publishedAt: "2026-08-24T00:00:00.000Z",
      components: [{ name: "closure-fixture", mode: "required", artifact: { entrypoint: "fixture.mjs", sha256: sha256Hex(artifact), size: artifact.byteLength, url: "https://fixtures.invalid/closure.mjs" } }],
      shellCompatibility: [{ shell: "terminal", target: "darwin-arm64", shellVersion: "0.1.0", runtime: { name: "node", version: OFFICIAL_NODE_VERSION } }],
    };
    const envelope = signStandaloneMetadata(metadata, "test-key", keys.privateKey);
    const store = new StandaloneStore(root, "terminal-betahyx");
    const lifecycle = new FileFixtureLifecyclePort(root, "terminal-betahyx");

    const generation = await store.prepare(envelope, new Map([["test-key", keys.publicKey]]), async () => artifact);
    await store.commit(generation.id);

    // Exactly what `start` does: activate the prepared attempt, boot it, and
    // record it. There is no second generation, so nothing can roll back.
    await store.activatePrepared();
    const active = await store.activeGeneration();
    expect(active.id).toBe(generation.id);
    await lifecycle.start(active);
    await store.markSuccessful(active.id);

    expect(await lifecycle.status()).toEqual({ state: "running", generationId: generation.id });
    expect(await store.readState()).toEqual({
      schemaVersion: 1,
      active: generation.id,
      attempt: null,
      lastSuccessful: generation.id,
    });
  });

  it("rejects a foreign Node carrier before parsing commands or opening a store", () => {
    const result = spawnSync(process.execPath, [
      "--import", "tsx",
      "--eval", "Object.defineProperty(process.versions, 'node', { value: '24.18.1' }); await import('./src/cli.ts');",
    ], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Terminal carrier requires official Node 24.18.0; got 24.18.1");
    expect(result.stderr).not.toContain("missing --root");
  });

  it("uses the signed channel namespace across default install and start", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-cli-defaults-")); roots.push(root);
    const artifact = Buffer.from("export default 'closure';\n");
    const keys = generateKeyPairSync("ed25519");
    const artifactPath = join(root, "closure.mjs");
    const metadataPath = join(root, "metadata.json");
    const publicKeyPath = join(root, "public.pem");
    const signed = signStandaloneMetadata({
      schemaVersion: 1,
      channel: "betahyx",
      releaseVersion: "0.1.0-betahyx.1",
      standaloneVersion: "0.1.0",
      sourceCommit: "a".repeat(40),
      publishedAt: "2026-08-24T00:00:00.000Z",
      components: [{ name: "closure-fixture", mode: "required", artifact: { entrypoint: "fixture.mjs", sha256: sha256Hex(artifact), size: artifact.byteLength, url: new URL(`file://${artifactPath}`).href } }],
      shellCompatibility: [{ shell: "terminal", target: "darwin-arm64", shellVersion: "0.1.0", runtime: { name: "node", version: OFFICIAL_NODE_VERSION } }],
    }, "test-key", keys.privateKey);
    await writeFile(artifactPath, artifact);
    const metadataBytes = Buffer.from(canonicalJson(signed));
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    await writeFile(metadataPath, metadataBytes);
    await writeFile(publicKeyPath, publicKey);
    const runCli = (args: string[]) => spawnSync(process.execPath, [
      "--import", "tsx",
      "--eval", `Object.defineProperty(process.versions, 'node', { value: '${OFFICIAL_NODE_VERSION}' }); process.argv = [process.execPath, 'cli', ...${JSON.stringify(args)}]; await import('./src/cli.ts');`,
    ], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });

    const install = runCli(["install", "--root", root, "--metadata", metadataPath, "--public-key", publicKeyPath, "--target", "darwin-arm64"]);
    expect(install.status, install.stderr).toBe(0);
    expect(JSON.parse(install.stdout)).toMatchObject({ generation: { channel: "betahyx" } });
    const start = runCli(["start", "--root", root]);
    expect(start.status, start.stderr).toBe(0);
    expect(JSON.parse(start.stdout)).toMatchObject({ state: "running" });
    expect(await new StandaloneStore(root, "terminal-betahyx").readState()).toMatchObject({ active: expect.any(String), lastSuccessful: expect.any(String) });
    expect(await new StandaloneStore(root, "terminal-local").readState()).toMatchObject({ active: null });
  });

  it("rejects a release whose shell distribution does not match the carrier", () => {
    const keys = generateKeyPairSync("ed25519");
    const artifact = Buffer.from("closure");
    const envelope = signStandaloneMetadata({
      schemaVersion: 1,
      channel: "betahyx",
      releaseVersion: "0.1.0-betahyx.2",
      standaloneVersion: "0.1.0",
      sourceCommit: "a".repeat(40),
      publishedAt: "2026-08-24T00:00:00.000Z",
      components: [{ name: "closure-fixture", mode: "required", artifact: { entrypoint: "fixture.mjs", sha256: sha256Hex(artifact), size: artifact.byteLength, url: "https://fixtures.invalid/closure.mjs" } }],
      shellCompatibility: [{ shell: "terminal", target: "win32-x64", shellVersion: "0.1.0", runtime: { name: "node", version: OFFICIAL_NODE_VERSION } }],
    }, "test-key", keys.privateKey);

    expect(supportsInstalledShell(envelope, {
      shell: "terminal",
      target: "darwin-arm64",
      shellVersion: "0.1.0",
      runtime: { name: "node", version: OFFICIAL_NODE_VERSION },
    })).toBe(false);
    expect(supportsInstalledShell(envelope, {
      shell: "terminal",
      target: "win32-x64",
      shellVersion: "0.1.0",
      runtime: { name: "node", version: OFFICIAL_NODE_VERSION },
    })).toBe(true);
  });
});
