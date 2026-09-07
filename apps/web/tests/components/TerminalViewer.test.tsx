// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalViewer } from '../../src/components/workspace/TerminalViewer';
import { I18nProvider } from '../../src/i18n';
import { createTerminal, terminalStreamUrl } from '../../src/state/projects';
import {
  createProjectGitStateStore,
  registerProjectMutationStore,
  unregisterProjectMutationStore,
} from '../../src/state/project-git';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { theme?: unknown } = {};

    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('../../src/state/projects', () => ({
  createTerminal: vi.fn(),
  killTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  sendTerminalStdin: vi.fn(),
  terminalStreamUrl: vi.fn(
    (projectId: string, terminalId: string) =>
      `/api/projects/${projectId}/terminals/${terminalId}/stream`,
  ),
}));

class StubEventSource {
  static CLOSED = 2;

  readyState = 0;

  constructor(readonly url: string) {}

  addEventListener(_type: string, _listener: EventListener) {}

  close() {
    this.readyState = StubEventSource.CLOSED;
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('EventSource', StubEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('TerminalViewer', () => {
  it('shows localized loading copy while the initial terminal connection is pending', () => {
    render(
      <I18nProvider initial="zh-CN">
        <TerminalViewer terminalId="term-1" projectId="project-1" onClose={vi.fn()} />
      </I18nProvider>,
    );

    const loading = screen.getByTestId('terminal-loading');
    expect(loading.textContent).toContain('正在启动项目终端…');
    expect(loading.textContent).toContain('正在连接项目目录，通常只需几秒。');
  });

  it('leaves connecting and shows restart/close actions when revision changes during restart', async () => {
    class EndedEventSource extends StubEventSource {
      override addEventListener(type: string, listener: EventListener) {
        if (type === 'exit') {
          queueMicrotask(() => listener(new MessageEvent(type, {
            data: JSON.stringify({ exitCode: 0, signal: null }),
          })));
        }
      }
    }
    vi.stubGlobal('EventSource', EndedEventSource);
    vi.mocked(createTerminal).mockRejectedValue(Object.assign(
      new Error('Project history changed'),
      { code: 'PROJECT_STATE_CHANGED' },
    ));

    render(
      <I18nProvider initial="en">
        <TerminalViewer terminalId="term-old" projectId="project-1" onClose={vi.fn()} />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-restart')).toBeTruthy());
    fireEvent.click(screen.getByTestId('terminal-restart'));
    await waitFor(() => {
      expect(screen.queryByTestId('terminal-loading')).toBeNull();
      expect(screen.getByTestId('terminal-restart')).toBeTruthy();
      expect(screen.getByTestId('terminal-close')).toBeTruthy();
    });
  });

  it('does not bind a deferred successful restart after its project revision changes', async () => {
    class EndedEventSource extends StubEventSource {
      override addEventListener(type: string, listener: EventListener) {
        if (type === 'exit') {
          queueMicrotask(() => listener(new MessageEvent(type, {
            data: JSON.stringify({ exitCode: 0, signal: null }),
          })));
        }
      }
    }
    const state = {
      enabled: true,
      phase: 'synced' as const,
      localHead: 'a'.repeat(40),
      observedRemoteHead: null,
      confirmedRemoteHead: null,
      projectRevision: 1,
      contentRevision: 1,
      bindingGeneration: 1,
      dirty: false,
      pendingPush: false,
      autoSync: true,
      operationId: null,
      error: null,
      binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' },
      dependencies: [],
    };
    const store = createProjectGitStateStore(state);
    registerProjectMutationStore('project-deferred-terminal', store);
    let resolveCreate!: (value: Awaited<ReturnType<typeof createTerminal>>) => void;
    vi.mocked(createTerminal).mockReturnValue(new Promise<Awaited<ReturnType<typeof createTerminal>>>((resolve) => {
      resolveCreate = resolve;
    }));
    vi.stubGlobal('EventSource', EndedEventSource);
    try {
      render(
        <I18nProvider initial="en">
          <TerminalViewer
            terminalId="term-old"
            projectId="project-deferred-terminal"
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );

      await waitFor(() => expect(screen.getByTestId('terminal-restart')).toBeTruthy());
      fireEvent.click(screen.getByTestId('terminal-restart'));
      await waitFor(() => expect(createTerminal).toHaveBeenCalledWith(
        'project-deferred-terminal',
        undefined,
        expect.objectContaining({ expectedProjectRevision: 1 }),
      ));
      store.accept({ ...state, projectRevision: 2, contentRevision: 2 }, 'event');
      resolveCreate({
        id: 'term-stale-success', projectId: 'project-deferred-terminal', cwd: '/project',
        shell: '/bin/sh', cols: 80, rows: 24, status: 'running', createdAt: 1, updatedAt: 1,
        exitCode: null, signal: null,
      });

      await waitFor(() => expect(screen.getByTestId('terminal-restart')).toBeTruthy());
      expect(vi.mocked(terminalStreamUrl).mock.calls).not.toContainEqual([
        'project-deferred-terminal',
        'term-stale-success',
      ]);
    } finally {
      unregisterProjectMutationStore('project-deferred-terminal', store);
      store.dispose();
    }
  });
});
