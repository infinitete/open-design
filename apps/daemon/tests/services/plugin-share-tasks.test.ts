import { describe, expect, it, vi } from 'vitest';
import { createPluginShareTaskStore } from '../../src/services/plugin-share-tasks.js';

describe('plugin share task settlement', () => {
  it('exposes a private settled promise that resolves only after the CLI finishes', async () => {
    let finish!: (value: { ok: boolean; stdout: string }) => void;
    const execution = new Promise<{ ok: boolean; stdout: string }>(resolve => {
      finish = resolve;
    });
    const store = createPluginShareTaskStore({
      randomUUID: vi.fn(() => 'task-id') as never,
      execCommandViaLoginShell: vi.fn(async () => execution) as never,
      OD_NODE_BIN: 'node',
      OD_BIN: 'od',
    });

    const started = store.createAndStart(
      'project',
      { action: 'publish-github', path: 'plugins/example' },
      '/project/plugins/example',
    );
    expect(started.task.id).toBe('task-id');
    expect(started.task.status).toBe('running');
    let settled = false;
    void started.settled.then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);

    finish({ ok: true, stdout: JSON.stringify({ ok: true, repoUrl: 'https://example.test/repo' }) });
    await expect(started.settled).resolves.toBeUndefined();
    expect(started.task.status).toBe('done');
  });

  it('settles after recording an unexpected CLI failure on the task', async () => {
    const store = createPluginShareTaskStore({
      randomUUID: vi.fn(() => 'task-id') as never,
      execCommandViaLoginShell: vi.fn(async () => { throw new Error('spawn failed'); }) as never,
      OD_NODE_BIN: 'node',
      OD_BIN: 'od',
    });

    const started = store.createAndStart(
      'project',
      { action: 'publish-github', path: 'plugins/example' },
      '/project/plugins/example',
    );
    await expect(started.settled).resolves.toBeUndefined();
    expect(started.task.status).toBe('failed');
    expect(started.task.error).toEqual(expect.objectContaining({
      code: 'plugin-share-task-failed',
      message: 'spawn failed',
    }));
  });
});
