import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PACKAGED_CONFIG_PATH_ENV,
  PACKAGED_NAMESPACE_BASE_ROOT_ENV,
  resolvePackagedNamespaceBaseRoot,
} from '../src/config.js';

// readPackagedConfig lazily imports `electron` for app.getPath("userData").
// In vitest the real module resolves to the Electron binary path string, so
// mock it with the minimal app surface the config loader consumes.
const electronAppMock = vi.hoisted(() => ({
  app: {
    getAppPath: () => '/tmp/od-packaged-config-test/app',
    getPath: () => '/tmp/od-packaged-config-test/user-data',
  },
}));

vi.mock('electron', () => ({
  default: electronAppMock.app,
  app: electronAppMock.app,
}));

describe('resolvePackagedNamespaceBaseRoot', () => {
  it('lets a historical handoff preserve the already-resolved namespace base root', () => {
    const inheritedRoot = join('C:', 'tools-pack', 'runtime', 'namespaces');
    const bakedRoot = join('C:', 'Users', 'Nexu', 'AppData', 'Roaming', 'Open Design', 'namespaces');

    expect(resolvePackagedNamespaceBaseRoot(bakedRoot, join('C:', 'fallback'), {
      [PACKAGED_NAMESPACE_BASE_ROOT_ENV]: inheritedRoot,
    })).toBe(resolve(inheritedRoot));
  });

  it('falls back to the payload config and then Electron userData', () => {
    const bakedRoot = join('C:', 'packaged', 'namespaces');
    const userDataRoot = join('C:', 'user-data');

    expect(resolvePackagedNamespaceBaseRoot(bakedRoot, userDataRoot, {})).toBe(resolve(bakedRoot));
    expect(resolvePackagedNamespaceBaseRoot(undefined, userDataRoot, {})).toBe(
      join(userDataRoot, 'namespaces'),
    );
  });
});

describe('readPackagedConfig legacy Vela fields', () => {
  const tempDirs: string[] = [];
  const savedConfigPath = process.env[PACKAGED_CONFIG_PATH_ENV];
  const savedResourcesPath = process.resourcesPath;

  afterEach(() => {
    if (savedConfigPath == null) delete process.env[PACKAGED_CONFIG_PATH_ENV];
    else process.env[PACKAGED_CONFIG_PATH_ENV] = savedConfigPath;
    Object.defineProperty(process, 'resourcesPath', {
      value: savedResourcesPath,
      configurable: true,
    });
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('ignores the retired amrProfile/velaWebUrl/velaWebUrls keys instead of loading them', async () => {
    const { readPackagedConfig } = await import('../src/config.js');
    const root = mkdtempSync(join(tmpdir(), 'od-packaged-config-legacy-'));
    tempDirs.push(root);
    writeFileSync(
      join(root, 'open-design-config.json'),
      JSON.stringify({
        // Retired keys a pre-removal bundle may still carry. The loader's
        // convention for unknown keys is to ignore them, so these must not
        // surface on the resolved config nor break the load.
        amrProfile: 'test',
        velaWebUrl: 'https://vela.example.invalid',
        velaWebUrls: {
          'feature-test': 'https://feature-test.example.invalid',
          prod: 'https://prod.example.invalid',
          test: 'https://test.example.invalid',
        },
        namespace: 'release-legacy-check',
        resourceRoot: join(root, 'resources'),
      }),
      'utf8',
    );
    Object.defineProperty(process, 'resourcesPath', { value: root, configurable: true });
    process.env[PACKAGED_CONFIG_PATH_ENV] = join(root, 'open-design-config.json');

    const config = await readPackagedConfig();

    expect('amrProfile' in config).toBe(false);
    expect('velaWebUrl' in config).toBe(false);
    expect('velaWebUrls' in config).toBe(false);
    expect(config.namespace).toBe('release-legacy-check');
    expect(config.resourceRoot).toBe(resolve(join(root, 'resources')));
  });
});
