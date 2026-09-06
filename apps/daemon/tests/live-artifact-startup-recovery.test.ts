import { expect, it, vi } from 'vitest';

import { recoverLiveArtifactsAtStartup } from '../src/live-artifacts/startup-recovery.js';

it('waits for project-Git recovery, read-probes exact persisted roots, and mutates only candidate projects at the startup epoch', async () => {
  const events: string[] = [];
  let ready!: () => void;
  const recoveryReady = new Promise<void>(resolve => { ready = resolve; });
  const withProjectRead = vi.fn(async (projectId: string, work: () => Promise<unknown>) => {
    events.push(`read:${projectId}`);
    return work();
  });
  const withProjectMutation = vi.fn(async (input: { projectId: string }, work: () => Promise<unknown>) => {
    events.push(`mutation:${input.projectId}`);
    return work();
  });
  const probe = vi.fn(async (location: { projectId: string; projectMetadata?: unknown }) => {
    events.push(`probe:${location.projectId}:${JSON.stringify(location.projectMetadata)}`);
    return location.projectId === 'candidate' ? [{ projectId: location.projectId, artifactId: 'artifact' }] : [];
  });
  const recover = vi.fn(async (location: { projectId: string; projectMetadata?: unknown }) => {
    events.push(`recover:${location.projectId}:${JSON.stringify(location.projectMetadata)}`);
    return [];
  });

  const pending = recoverLiveArtifactsAtStartup({
    projectsRoot: '/managed-projects',
    projects: [
      { id: 'plain', expectedProjectRevision: undefined },
      { id: 'candidate', projectMetadata: { baseDir: '/external/project' }, expectedProjectRevision: 7 },
    ],
    recoveryReady,
    coordination: { withProjectRead, withProjectMutation } as never,
    probe,
    recover,
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(events).toEqual([]);

  ready();
  await pending;

  expect(withProjectMutation).toHaveBeenCalledTimes(1);
  expect(withProjectMutation).toHaveBeenCalledWith({
    projectId: 'candidate',
    expectedProjectRevision: 7,
    source: 'live-artifact.startup-recovery',
  }, expect.any(Function));
  expect(probe).toHaveBeenCalledTimes(3);
  expect(recover).toHaveBeenCalledWith({
    projectsRoot: '/managed-projects',
    projectId: 'candidate',
    projectMetadata: { baseDir: '/external/project' },
  });
  expect(events).toEqual([
    'read:plain',
    'probe:plain:undefined',
    'read:candidate',
    'probe:candidate:{"baseDir":"/external/project"}',
    'mutation:candidate',
    'probe:candidate:{"baseDir":"/external/project"}',
    'recover:candidate:{"baseDir":"/external/project"}',
  ]);
});

it('isolates project recovery failures and never opens a mutation when the read probe has no lock', async () => {
  const onError = vi.fn();
  const withProjectMutation = vi.fn(async (_input: unknown, work: () => Promise<unknown>) => work());

  await recoverLiveArtifactsAtStartup({
    projectsRoot: '/projects',
    projects: [{ id: 'broken' }, { id: 'empty' }],
    recoveryReady: Promise.resolve(),
    coordination: {
      withProjectRead: async (projectId: string, work: () => Promise<unknown>) => {
        if (projectId === 'broken') throw new Error('managed recovery unavailable');
        return work();
      },
      withProjectMutation,
    } as never,
    probe: async () => [],
    recover: vi.fn(),
    onError,
  });

  expect(onError).toHaveBeenCalledWith('broken', expect.objectContaining({ message: 'managed recovery unavailable' }));
  expect(withProjectMutation).not.toHaveBeenCalled();
});
