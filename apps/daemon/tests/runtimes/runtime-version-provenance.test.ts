import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  detectAgents,
  ensureDetectedRuntimeVersions,
  getDetectedRuntimeVersions,
} from '../../src/runtimes/detection.js';

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(name: string, version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'od-runtime-version-'));
  roots.push(root);
  const bin = join(root, name);
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(version)}\n`, 'utf8');
  chmodSync(bin, 0o755);
  process.env.PATH = `${root}:${originalPath ?? ''}`;
  return bin;
}

describe('runtime version provenance', () => {
  it('remembers the exact detected CLI version for later run telemetry', async () => {
    executable('claude', 'claude 9.8.7');

    const agents = await detectAgents();

    expect(agents.find((agent) => agent.id === 'claude')?.version).toBe('claude 9.8.7');
    expect(getDetectedRuntimeVersions('claude')).toEqual({
      invocable: true,
      agentCliVersion: 'claude 9.8.7',
    });
  });

  it('re-probes when the configured executable changes instead of reusing another binary scope', async () => {
    const first = executable('claude-first', 'claude 1.0.0');
    const second = executable('claude-second', 'claude 2.0.0');

    await expect(ensureDetectedRuntimeVersions('claude', { CLAUDE_BIN: first }))
      .resolves.toEqual({ invocable: true, agentCliVersion: 'claude 1.0.0' });
    await expect(ensureDetectedRuntimeVersions('claude', { CLAUDE_BIN: second }))
      .resolves.toEqual({ invocable: true, agentCliVersion: 'claude 2.0.0' });
  });

  it('retains invocability when version output is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'od-runtime-version-null-'));
    roots.push(root);
    const spawned = join(root, 'claude-spawned');
    writeFileSync(spawned, '#!/bin/sh\nexit 2\n', 'utf8');
    chmodSync(spawned, 0o755);

    await expect(ensureDetectedRuntimeVersions('claude', { CLAUDE_BIN: spawned }))
      .resolves.toEqual({ invocable: true });
  });
});
