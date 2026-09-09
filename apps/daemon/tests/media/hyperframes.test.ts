import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateMedia } from '../../src/media/index.js';

describe('hyperframes-html media renderer preflight', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  const originalAllowStubs = process.env.OD_MEDIA_ALLOW_STUBS;
  const originalHyperFramesBin = process.env.OD_HYPERFRAMES_BIN;
  const originalNodeBin = process.env.OD_NODE_BIN;
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-hyperframes-media-'));
    projectRoot = path.join(root, 'project-root');
    projectsRoot = path.join(projectRoot, '.od', 'projects');
    await mkdir(path.join(projectsRoot, 'project-1'), { recursive: true });
    process.env.OD_MEDIA_ALLOW_STUBS = '1';
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (originalAllowStubs == null) {
      delete process.env.OD_MEDIA_ALLOW_STUBS;
    } else {
      process.env.OD_MEDIA_ALLOW_STUBS = originalAllowStubs;
    }
    if (originalHyperFramesBin == null) {
      delete process.env.OD_HYPERFRAMES_BIN;
    } else {
      process.env.OD_HYPERFRAMES_BIN = originalHyperFramesBin;
    }
    if (originalNodeBin == null) {
      delete process.env.OD_NODE_BIN;
    } else {
      process.env.OD_NODE_BIN = originalNodeBin;
    }
    if (originalPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('rejects incomplete composition dirs instead of falling back to a stub', async () => {
    const compRel = '.hyperframes-cache/incomplete';
    const compDir = path.join(projectsRoot, 'project-1', compRel);
    await mkdir(compDir, { recursive: true });
    await writeFile(path.join(compDir, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8');

    await expect(generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'video',
      model: 'hyperframes-html',
      output: 'test.mp4',
      compositionDir: compRel,
    })).rejects.toThrow(/compositionDir is missing hyperframes\.json/);
  });

  it('requires meta.json before spawning the local renderer', async () => {
    const compRel = '.hyperframes-cache/no-meta';
    const compDir = path.join(projectsRoot, 'project-1', compRel);
    await mkdir(compDir, { recursive: true });
    await writeFile(path.join(compDir, 'hyperframes.json'), '{}', 'utf8');
    await writeFile(path.join(compDir, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8');

    await expect(generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'video',
      model: 'hyperframes-html',
      output: 'test.mp4',
      compositionDir: compRel,
    })).rejects.toThrow(/compositionDir is missing meta\.json/);
  });

  it.each([undefined, '0', 'false', '1'])('forces vendor telemetry off for parent opt-out %s', async (parentOptOut) => {
    vi.stubEnv('HYPERFRAMES_NO_TELEMETRY', parentOptOut);
    vi.stubEnv('DO_NOT_TRACK', '0');
    const compRel = '.hyperframes-cache/managed-runtime';
    const compDir = path.join(projectsRoot, 'project-1', compRel);
    const fakeCli = path.join(root, 'fake-hyperframes.mjs');
    await mkdir(compDir, { recursive: true });
    await writeFile(path.join(compDir, 'hyperframes.json'), '{}', 'utf8');
    await writeFile(path.join(compDir, 'meta.json'), '{}', 'utf8');
    await writeFile(path.join(compDir, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8');
    await writeFile(
      fakeCli,
      [
        "import { writeFile } from 'node:fs/promises';",
        "const outputIndex = process.argv.indexOf('--output');",
        "if (process.argv[2] !== 'render' || outputIndex < 0) process.exit(64);",
        "await writeFile(new URL('./spawn-capture.json', import.meta.url), JSON.stringify({ env: process.env, args: process.argv.slice(2) }));",
        "await writeFile(process.argv[outputIndex + 1], 'managed-hyperframes-render');",
        "process.stderr.write('Capturing frame 1/1\\n');",
      ].join('\n'),
      'utf8',
    );
    process.env.OD_HYPERFRAMES_BIN = fakeCli;
    process.env.OD_NODE_BIN = process.execPath;
    process.env.PATH = path.join(root, 'empty-path');

    const onProgress = vi.fn();
    const result = await generateMedia({
      onProgress,
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'video',
      model: 'hyperframes-html',
      output: 'managed.mp4',
      compositionDir: compRel,
    });

    const capture = JSON.parse(await readFile(path.join(root, 'spawn-capture.json'), 'utf8'));
    expect(capture.env.HYPERFRAMES_NO_TELEMETRY).toBe('1');
    expect(capture.env.DO_NOT_TRACK).toBe('0');
    expect(capture.env.OD_HYPERFRAMES_BIN).toBe(fakeCli);
    expect(capture.env.OD_NODE_BIN).toBe(process.execPath);
    expect(capture.env.PATH).toBe(path.join(root, 'empty-path'));
    expect(process.env.HYPERFRAMES_NO_TELEMETRY).toBe(parentOptOut);
    expect(capture.args).toEqual([
      'render', compDir, '--output', expect.stringMatching(/render\.mp4$/), '--workers', '1',
    ]);
    expect(onProgress).toHaveBeenCalledWith('Capturing frame 1/1');
    expect(result.name).toBe('managed.mp4');
    expect(result.providerNote).toContain('hyperframes/local-html');
    await expect(readFile(path.join(projectsRoot, 'project-1', 'managed.mp4'), 'utf8'))
      .resolves.toBe('managed-hyperframes-render');
  });
});
