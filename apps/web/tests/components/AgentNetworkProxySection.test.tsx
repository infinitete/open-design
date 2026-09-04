// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { testAgentMock } = vi.hoisted(() => ({
  testAgentMock: vi.fn(),
}));

vi.mock('../../src/providers/connection-test', () => ({
  testAgent: testAgentMock,
  testApiProvider: vi.fn(),
}));

import {
  AgentNetworkProxySection,
  draftFromPolicy,
  testPolicyFromDraft,
  updateMapFromDraft,
  type AgentNetworkDraft,
  type AgentNetworkProxySectionProps,
} from '../../src/components/AgentNetworkProxySection';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { AgentInfo } from '../../src/types';
import type { AgentNetworkPrefs } from '@open-design/contracts';

function renderSection(props: {
  agentId?: string;
  savedPrefs?: AgentNetworkPrefs;
  onSave?: AgentNetworkProxySectionProps['onSave'];
  onDraftChange?: AgentNetworkProxySectionProps['onDraftChange'];
} = {}) {
  const onSave = props.onSave
    ?? vi.fn<AgentNetworkProxySectionProps['onSave']>().mockResolvedValue({});
  const onDraftChange = props.onDraftChange
    ?? vi.fn<AgentNetworkProxySectionProps['onDraftChange']>();
  const view = render(
    <I18nProvider initial="en">
      <AgentNetworkProxySection
        agentId={props.agentId ?? 'codex'}
        savedPrefs={props.savedPrefs ?? {}}
        onSave={onSave}
        onDraftChange={onDraftChange}
      />
    </I18nProvider>,
  );
  return { ...view, onSave, onDraftChange };
}

describe('AgentNetworkProxySection', () => {
  beforeEach(() => {
    testAgentMock.mockReset();
  });

  afterEach(cleanup);

  it('keeps drafts per CLI and persists the complete map only on explicit save', async () => {
    const accepted = {
      claude: { mode: 'direct' as const },
      codex: {
        mode: 'custom' as const,
        proxyUrl: 'http://codex.proxy:8080',
        username: 'codex-user',
        passwordConfigured: true,
      },
    };
    const onSave = vi.fn().mockResolvedValue(accepted);
    const onDraftChange = vi.fn();
    const { rerender } = renderSection({
      savedPrefs: { claude: { mode: 'direct' } },
      onSave,
      onDraftChange,
    });

    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Proxy URL'), {
      target: { value: 'http://codex.proxy:8080' },
    });
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'codex-user' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'proxy-password' },
    });
    expect(onSave).not.toHaveBeenCalled();

    rerender(
      <I18nProvider initial="en">
        <AgentNetworkProxySection
          agentId="claude"
          savedPrefs={{ claude: { mode: 'direct' } }}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole('radio', { name: 'Direct' })).toBeChecked();

    rerender(
      <I18nProvider initial="en">
        <AgentNetworkProxySection
          agentId="codex"
          savedPrefs={{ claude: { mode: 'direct' } }}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      </I18nProvider>,
    );
    expect(screen.getByLabelText('Proxy URL')).toHaveValue('http://codex.proxy:8080');
    expect(screen.getByLabelText('Password')).toHaveValue('proxy-password');

    fireEvent.click(screen.getByRole('button', { name: 'Save proxy settings' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      claude: { mode: 'direct' },
      codex: {
        mode: 'custom',
        proxyUrl: 'http://codex.proxy:8080',
        username: 'codex-user',
        password: 'proxy-password',
      },
    });
    await waitFor(() => expect(screen.getByText('Proxy settings saved.')).toBeTruthy());
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByText('Password configured')).toBeTruthy();
  });

  it('keeps the rejected draft and displays the daemon error', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Proxy host is unavailable'));
    renderSection({ onSave });

    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Proxy URL'), {
      target: { value: 'socks5://proxy.internal:1080' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save proxy settings' }));

    expect(await screen.findByText('Proxy host is unavailable')).toBeTruthy();
    expect(screen.getByLabelText('Proxy URL')).toHaveValue('socks5://proxy.internal:1080');
    expect(screen.getByRole('button', { name: 'Save proxy settings' })).toBeEnabled();
  });

  it('maps inherit, direct, and saved-password keep/replace/clear semantics', () => {
    const savedPrefs: AgentNetworkPrefs = {
      claude: {
        mode: 'custom',
        proxyUrl: 'https://saved.proxy:8443',
        noProxy: 'localhost',
        username: 'saved-user',
        passwordConfigured: true,
      },
      codex: { mode: 'direct' },
    };
    const keep = draftFromPolicy(savedPrefs.claude);
    expect(keep).toEqual({
      mode: 'custom',
      proxyUrl: 'https://saved.proxy:8443',
      noProxy: 'localhost',
      username: 'saved-user',
      password: '',
      passwordAction: 'keep',
    });
    expect(testPolicyFromDraft(keep, savedPrefs.claude)).toEqual({
      mode: 'custom',
      proxyUrl: 'https://saved.proxy:8443',
      noProxy: 'localhost',
      username: 'saved-user',
      useStoredPassword: true,
    });

    expect(updateMapFromDraft(savedPrefs, 'codex', {
      ...draftFromPolicy(savedPrefs.codex),
      mode: 'inherit',
    })).toEqual({ claude: savedPrefs.claude });
    expect(updateMapFromDraft(savedPrefs, 'codex', {
      ...draftFromPolicy(savedPrefs.codex),
      mode: 'direct',
    })).toEqual(savedPrefs);

    const replace: AgentNetworkDraft = {
      ...keep,
      password: 'replacement',
      passwordAction: 'replace',
    };
    expect(updateMapFromDraft(savedPrefs, 'claude', replace).claude).toEqual({
      mode: 'custom',
      proxyUrl: 'https://saved.proxy:8443',
      noProxy: 'localhost',
      username: 'saved-user',
      password: 'replacement',
    });
    expect(testPolicyFromDraft(replace, savedPrefs.claude)).toEqual({
      mode: 'custom',
      proxyUrl: 'https://saved.proxy:8443',
      noProxy: 'localhost',
      username: 'saved-user',
      password: 'replacement',
    });

    const clear: AgentNetworkDraft = {
      ...keep,
      passwordAction: 'clear',
    };
    expect(updateMapFromDraft(savedPrefs, 'claude', clear).claude).toEqual({
      mode: 'custom',
      proxyUrl: 'https://saved.proxy:8443',
      noProxy: 'localhost',
      username: 'saved-user',
      clearPassword: true,
    });
    expect(testPolicyFromDraft(clear, savedPrefs.claude)).toEqual({
      mode: 'custom',
      proxyUrl: 'https://saved.proxy:8443',
      noProxy: 'localhost',
      username: 'saved-user',
      clearPassword: true,
    });
  });

  it('blocks invalid custom proxy input before save', async () => {
    const onSave = vi.fn();
    renderSection({ onSave });

    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Proxy URL'), {
      target: { value: 'https://user:pass@proxy.test/path' },
    });

    expect(screen.getByText('Use a host-only http://, https://, or socks5:// URL without credentials.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save proxy settings' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('sends the selected unsaved draft to connection test without entering autosave', async () => {
    const onPersist = vi.fn();
    const onPersistAgentNetwork = vi.fn().mockResolvedValue({
      codex: {
        mode: 'custom' as const,
        proxyUrl: 'http://draft.proxy:8080',
        passwordConfigured: false,
      },
    });
    const agents: AgentInfo[] = [{
      id: 'codex',
      name: 'Codex',
      bin: 'codex',
      available: true,
    }];
    testAgentMock.mockResolvedValue({
      ok: true,
      kind: 'success',
      latencyMs: 10,
      agentName: 'Codex',
      sample: 'ok',
    });

    render(
      <I18nProvider initial="en">
        <SettingsDialog
          presentation="page"
          initial={{
            ...DEFAULT_CONFIG,
            mode: 'daemon',
            agentId: 'codex',
            agentNetwork: {},
          }}
          agents={agents}
          daemonLive
          appVersionInfo={null}
          initialSection="execution"
          onPersist={onPersist}
          onPersistComposioKey={vi.fn()}
          onPersistAgentNetwork={onPersistAgentNetwork}
          onClose={vi.fn()}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Proxy URL'), {
      target: { value: 'http://draft.proxy:8080' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));

    await waitFor(() => expect(testAgentMock).toHaveBeenCalledTimes(1));
    expect(testAgentMock.mock.calls[0]?.[0]).toMatchObject({
      agentId: 'codex',
      agentNetwork: {
        mode: 'custom',
        proxyUrl: 'http://draft.proxy:8080',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save proxy settings' }));
    await waitFor(() => expect(onPersistAgentNetwork).toHaveBeenCalledTimes(1));
    expect(onPersistAgentNetwork).toHaveBeenCalledWith({
      codex: {
        mode: 'custom',
        proxyUrl: 'http://draft.proxy:8080',
      },
    });
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    expect(onPersist).not.toHaveBeenCalled();
  });

  it('reports failure instead of claiming a save when Settings lacks persistence wiring', async () => {
    const onPersist = vi.fn();
    const agents: AgentInfo[] = [{
      id: 'custom-cli',
      name: 'Custom CLI',
      bin: 'custom-cli',
      available: true,
    }];

    render(
      <I18nProvider initial="en">
        <SettingsDialog
          presentation="page"
          initial={{
            ...DEFAULT_CONFIG,
            mode: 'daemon',
            agentId: 'custom-cli',
            agentNetwork: {},
          }}
          agents={agents}
          daemonLive
          appVersionInfo={null}
          initialSection="execution"
          onPersist={onPersist}
          onPersistComposioKey={vi.fn()}
          onClose={vi.fn()}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText('Network proxy')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Direct' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save proxy settings' }));

    expect(await screen.findByText('Could not save proxy settings.')).toBeTruthy();
    expect(screen.queryByText('Proxy settings saved.')).toBeNull();
    expect(onPersist).not.toHaveBeenCalled();
  });
});
