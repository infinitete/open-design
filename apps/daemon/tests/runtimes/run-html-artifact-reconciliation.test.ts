import { expect, it, vi } from 'vitest';

import { reconcileRunHtmlArtifactManifests } from '../../src/runtimes/run-html-artifact-reconciliation.js';

it('awaits each touched HTML manifest repair and isolates per-file failures', async () => {
  const order: string[] = [];
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const reconcile = vi.fn(async (_name: string) => {
    const call = reconcile.mock.calls.length;
    order.push(`repair:${call}`);
    if (call === 1) await delayed;
    else throw new Error('one file failed');
  });
  let settled = false;
  const pending = reconcileRunHtmlArtifactManifests({
    files: [{ name: 'one.html' }, { name: 'two.htm' }, { name: 'note.md' }],
    runStartTimeMs: 100,
    stat: vi.fn(async () => ({ mtimeMs: 101 })),
    isRunTouchedProjectFile: (mtime, start) => mtime >= start,
    reconcile,
  }).then(() => { settled = true; order.push('settled'); });

  await new Promise<void>(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  release();
  await pending;
  expect(order).toEqual(['repair:1', 'repair:2', 'settled']);
  expect(reconcile).toHaveBeenCalledTimes(2);
});
