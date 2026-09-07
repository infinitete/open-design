// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGitState } from '@open-design/contracts';

import { useProjectGitAuthoritySet } from '../../src/providers/project-git';
import { captureProjectMutation } from '../../src/state/project-git';
import { RecentProjectsStrip } from '../../src/components/RecentProjectsStrip';
import { I18nProvider } from '../../src/i18n';

const legalState: ProjectGitState = {
  enabled: true,
  phase: 'synced',
  localHead: 'a'.repeat(40),
  observedRemoteHead: null,
  confirmedRemoteHead: null,
  projectRevision: 7,
  contentRevision: 9,
  bindingGeneration: 2,
  dirty: false,
  pendingPush: false,
  autoSync: true,
  operationId: null,
  error: null,
  binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' },
  dependencies: [],
};

class MockEventSource {
  static instances: MockEventSource[] = [];
  static active = 0;
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  private closed = false;
  readonly close = vi.fn(() => {
    if (this.closed) return;
    this.closed = true;
    MockEventSource.active -= 1;
  });

  constructor(readonly url: string | URL) {
    MockEventSource.instances.push(this);
    MockEventSource.active += 1;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === 'function'
      ? listener
      : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function RecentAuthorityHarness() {
  const authorities = useProjectGitAuthoritySet([]);
  const projects = ['target-project-1', 'target-project-2'].map((id, index) => ({
    id,
    name: `Project ${index + 1}`,
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt: 2,
    status: { value: 'not_started' as const },
  }));
  return (
    <I18nProvider initial="en">
      <RecentProjectsStrip
        projects={projects}
        heading="All projects"
        onOpen={() => undefined}
        onDelete={async () => true}
        canManageProjectCollection
        projectMutationReady={authorities.isReady}
      />
    </I18nProvider>
  );
}

function HomeAuthorityHarness({ visibleProjectIds }: { visibleProjectIds: string[] }) {
  const authorities = useProjectGitAuthoritySet([]);
  return (
    <output
      data-testid="authority"
      data-visible-projects={visibleProjectIds.length}
      data-target-ready={String(authorities.isReady('target-project'))}
    />
  );
}

function publishTargets(source: string, projectIds: string[]) {
  window.dispatchEvent(new CustomEvent('open-design:project-mutation-targets', {
    detail: { source, projectIds },
  }));
}

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  MockEventSource.instances = [];
  MockEventSource.active = 0;
});

describe('Home project Git authority set', () => {
  it('opens only the operation target and disposes it when the intent closes', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(legalState), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const visibleProjectIds = Array.from({ length: 100 }, (_, index) => `project-${index}`);
    render(<HomeAuthorityHarness visibleProjectIds={visibleProjectIds} />);

    expect(screen.getByTestId('authority')).toHaveAttribute('data-visible-projects', '100');
    expect(MockEventSource.instances).toHaveLength(0);

    act(() => publishTargets('one-menu', ['target-project']));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(String(MockEventSource.instances[0]?.url)).toContain('/target-project/events');
    expect(captureProjectMutation('target-project')?.expectedProjectRevision).toBe(7);

    act(() => publishTargets('one-menu', []));
    await waitFor(() => expect(MockEventSource.instances[0]?.close).toHaveBeenCalledOnce());
    expect(captureProjectMutation('target-project')).toBeUndefined();
  });

  it('locks on a higher revision and unlocks only after its exact-generation refresh', async () => {
    let resolveRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(legalState), { status: 200 }))
      .mockReturnValueOnce(refresh);
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('fetch', fetchMock);
    render(<HomeAuthorityHarness visibleProjectIds={[]} />);

    act(() => publishTargets('rename-dialog', ['target-project']));
    await waitFor(() => expect(screen.getByTestId('authority')).toHaveAttribute('data-target-ready', 'true'));
    const nextState = { ...legalState, projectRevision: 8, contentRevision: 10 };
    act(() => MockEventSource.instances[0]?.emit('project-git-state', {
      type: 'project-git-state',
      projectId: 'target-project',
      state: nextState,
    }));

    await waitFor(() => expect(screen.getByTestId('authority')).toHaveAttribute('data-target-ready', 'false'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captureProjectMutation('target-project')).toBeUndefined();

    resolveRefresh(new Response(JSON.stringify(nextState), { status: 200 }));
    await waitFor(() => expect(screen.getByTestId('authority')).toHaveAttribute('data-target-ready', 'true'));
    expect(captureProjectMutation('target-project')?.expectedProjectRevision).toBe(8);
  });

  it('releases every real authority-hub EventSource when Recent bulk delete is cancelled', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(legalState), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    render(<RecentAuthorityHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Multi-select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Project 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Project 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(MockEventSource.active).toBe(2));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(MockEventSource.active).toBe(0));
    expect(MockEventSource.instances.every((source) => source.close.mock.calls.length === 1)).toBe(true);
  });
});
