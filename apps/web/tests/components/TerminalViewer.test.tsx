// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalViewer } from '../../src/components/workspace/TerminalViewer';
import { I18nProvider } from '../../src/i18n';
import { createTerminal, killTerminal, terminalStreamUrl } from '../../src/state/projects';

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
});

