import type { Locator, Page } from '@playwright/test';

import { expect, test } from '@/playwright/suite';
import { openSettingsDialog } from '@/playwright/amr';
import { expectStableCount } from '@/playwright/assertions';
import {
  routeAgents,
  routeUnavailableVelaStatus,
  suppressWhatsNew,
} from '@/playwright/mock-factory';
import { T } from '@/timeouts';

const STORAGE_KEY = 'open-design:config';

type AgentFixture = {
  id: string;
  name: string;
  bin: string;
  available: boolean;
  version?: string | null;
  models?: Array<{ id: string; label: string }>;
};

type ProxySettingsHarness = {
  appConfigWrites: Record<string, unknown>[];
  connectionBodies: Record<string, unknown>[];
  proxyUrl: Locator;
  password: Locator;
  saveProxy: Locator;
  testConnection: Locator;
  selectAgent: (agentId: string) => Promise<void>;
  selectMode: (label: 'Follow system' | 'Direct' | 'Custom') => Promise<void>;
  mode: (label: 'Follow system' | 'Direct' | 'Custom') => Locator;
  readBrowserConfig: () => Promise<Record<string, unknown>>;
  reloadSettings: () => Promise<void>;
};

const CODEX_AGENT: AgentFixture = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.134.0',
  models: [{ id: 'default', label: 'Default (CLI config)' }],
};

const CLAUDE_AGENT: AgentFixture = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '2.1.31',
  models: [{ id: 'default', label: 'Default (CLI config)' }],
};

function publicAgentNetwork(
  update: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(update).map(([agentId, value]) => {
    const policy = value as Record<string, unknown>;
    if (policy.mode === 'direct') return [agentId, { mode: 'direct' }];

    const previousPolicy = previous[agentId] as Record<string, unknown> | undefined;
    const passwordConfigured = policy.clearPassword === true
      ? false
      : typeof policy.password === 'string'
        ? policy.password.length > 0
        : previousPolicy?.passwordConfigured === true;
    return [agentId, {
      mode: 'custom',
      proxyUrl: policy.proxyUrl,
      ...(typeof policy.noProxy === 'string' ? { noProxy: policy.noProxy } : {}),
      ...(typeof policy.username === 'string' ? { username: policy.username } : {}),
      passwordConfigured,
    }];
  }));
}

async function openProxySettingsHarness(
  page: Page,
  input: { agents: AgentFixture[]; agentNetwork: Record<string, unknown> },
): Promise<ProxySettingsHarness> {
  const appConfigWrites: Record<string, unknown>[] = [];
  const connectionBodies: Record<string, unknown>[] = [];
  let appConfigReads = 0;
  let appConfigPuts = 0;
  let lastReadAgentNetwork = '{}';
  let appConfig: Record<string, unknown> = {
    mode: 'daemon',
    apiKey: '',
    apiProtocol: 'openai',
    apiVersion: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    apiProviderBaseUrl: 'https://api.openai.com/v1',
    agentId: input.agents[0]?.id ?? null,
    skillId: null,
    designSystemId: null,
    onboardingCompleted: true,
    privacyDecisionAt: 1,
    telemetry: { metrics: false, content: false, artifactManifest: false },
    mediaProviders: {},
    agentModels: {},
    agentCliEnv: {},
    agentNetwork: input.agentNetwork,
  };

  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) == null) {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
      window.localStorage.setItem('open-design:locale', 'en');
    },
    { key: STORAGE_KEY, value: appConfig },
  );
  await routeUnavailableVelaStatus(page);
  await suppressWhatsNew(page);
  await page.route('**/api/health', async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/connectors/composio/config', async (route) => {
    await route.fulfill({ json: { configured: false, apiKeyTail: '' } });
  });
  await page.route('**/api/media/config', async (route) => {
    await route.fulfill({ json: { providers: {} } });
  });
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() === 'GET') {
      appConfigReads += 1;
      lastReadAgentNetwork = JSON.stringify(appConfig.agentNetwork ?? {});
      await route.fulfill({ json: { config: appConfig } });
      return;
    }
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }

    const update = route.request().postDataJSON() as Record<string, unknown>;
    appConfigPuts += 1;
    if (update.agentNetwork && typeof update.agentNetwork === 'object') {
      appConfigWrites.push(update);
    }
    const currentNetwork = appConfig.agentNetwork as Record<string, unknown>;
    appConfig = {
      ...appConfig,
      ...update,
      ...(update.agentNetwork && typeof update.agentNetwork === 'object'
        ? {
            agentNetwork: publicAgentNetwork(
              update.agentNetwork as Record<string, unknown>,
              currentNetwork,
            ),
          }
        : {}),
    };
    await route.fulfill({ json: { config: appConfig } });
  });
  await routeAgents(page, input.agents);
  await page.route('**/api/test/connection', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    connectionBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 1,
        agentName: 'Fixture CLI',
        sample: 'ready',
      },
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const dialog = await openSettingsDialog(page);
  await dialog.getByTestId('settings-nav-execution').click();
  await dialog.getByRole('tab', { name: /Local CLI/i }).click();

  const mode = (label: 'Follow system' | 'Direct' | 'Custom') =>
    page.getByRole('radio', { name: label, exact: true });
  const selectAgent = async (agentId: string) => {
    const agentCard = page.getByTestId(`settings-agent-card-${agentId}`);
    await page.getByTestId(`settings-agent-select-${agentId}`).click();
    await expect(agentCard).toHaveClass(/active/);
  };
  const selectMode = async (label: 'Follow system' | 'Direct' | 'Custom') => {
    await mode(label).click();
    await expect(mode(label)).toBeChecked();
  };
  const saveProxy = page.getByRole('button', { name: 'Save proxy settings', exact: true });

  return {
    appConfigWrites,
    connectionBodies,
    proxyUrl: page.getByLabel('Proxy URL', { exact: true }),
    password: page.getByLabel('Password', { exact: true }),
    saveProxy,
    testConnection: page.locator('.agent-card.active').getByRole('button', {
      name: 'Test',
      exact: true,
    }),
    selectAgent,
    selectMode,
    mode,
    readBrowserConfig: () => page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) as Record<string, unknown> : {};
    }, STORAGE_KEY),
    reloadSettings: async () => {
      await expect(page.getByText('Proxy settings saved.', { exact: true })).toBeVisible();
      const readsBeforeReload = appConfigReads;
      const putsBeforeReload = appConfigPuts;
      const expectedNetwork = JSON.stringify(appConfig.agentNetwork ?? {});
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => appConfigReads).toBeGreaterThan(readsBeforeReload);
      await expect.poll(() => lastReadAgentNetwork).toBe(expectedNetwork);
      await expect.poll(() => appConfigPuts).toBeGreaterThan(putsBeforeReload);
      const reloadedDialog = await openSettingsDialog(page);
      await reloadedDialog.getByTestId('settings-nav-execution').click();
      await reloadedDialog.getByRole('tab', { name: /Local CLI/i }).click();
    },
  };
}

test('[P1] keeps independent explicit-save proxy drafts for two local CLIs', async ({ page }) => {
  const harness = await openProxySettingsHarness(page, {
    agents: [CODEX_AGENT, CLAUDE_AGENT],
    agentNetwork: {},
  });

  await harness.selectAgent('codex');
  await harness.selectMode('Custom');
  await harness.proxyUrl.fill('http://codex.proxy.test:8080');
  await page.getByLabel('Username', { exact: true }).fill('codex-user');
  await harness.password.fill('codex-password');
  await harness.testConnection.click();
  expect(harness.connectionBodies.at(-1)).toMatchObject({
    mode: 'agent',
    agentId: 'codex',
    agentNetwork: {
      mode: 'custom',
      proxyUrl: 'http://codex.proxy.test:8080',
      password: 'codex-password',
    },
  });
  expect(harness.appConfigWrites).toHaveLength(0);

  await harness.saveProxy.click();
  await expect.poll(() => harness.appConfigWrites.length).toBe(1);
  expect(JSON.stringify(await harness.readBrowserConfig())).not.toContain('codex-password');

  await harness.selectAgent('claude');
  await harness.selectMode('Direct');
  await harness.saveProxy.click();
  await expect.poll(() => harness.appConfigWrites.length).toBe(2);
  expect(harness.appConfigWrites.at(-1)).toMatchObject({
    agentNetwork: {
      codex: {
        mode: 'custom',
        proxyUrl: 'http://codex.proxy.test:8080',
      },
      claude: { mode: 'direct' },
    },
  });
  const networkWritesBeforeReload = harness.appConfigWrites.length;
  await harness.reloadSettings();
  await harness.selectAgent('codex');
  await expect(harness.proxyUrl).toHaveValue('http://codex.proxy.test:8080');
  await harness.selectAgent('claude');
  await expect(harness.mode('Direct')).toBeChecked();
  await expectStableCount(
    () => harness.appConfigWrites.length,
    networkWritesBeforeReload,
    {
      timeout: T.short,
      message: 'reload must restore proxy policies without writing agentNetwork again',
    },
  );
});
