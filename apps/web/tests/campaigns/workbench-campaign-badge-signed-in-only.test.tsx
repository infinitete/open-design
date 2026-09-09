// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchCampaignBadge } from '../../src/components/WorkbenchCampaignBadge';
import { I18nProvider } from '../../src/i18n';

const badgeSource = readFileSync(
  resolve(process.cwd(), 'src/components/WorkbenchCampaignBadge.tsx'),
  'utf8',
);
const entryShellSource = readFileSync(
  resolve(process.cwd(), 'src/components/EntryShell.tsx'),
  'utf8',
);

function renderBadge(loggedIn: boolean | null | undefined) {
  render(
    <I18nProvider initial="zh-CN">
      <WorkbenchCampaignBadge
        audience="unpaid"
        page="home"
        loggedIn={loggedIn}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('workbench campaign badge is signed-in only', () => {
  it('renders nothing for a signed-out client', () => {
    renderBadge(false);
    expect(screen.queryByTestId('deepseek-campaign-pricing-badge')).toBeNull();
  });

  it('renders nothing while the Vela login state is still unresolved', () => {
    renderBadge(null);
    expect(screen.queryByTestId('deepseek-campaign-pricing-badge')).toBeNull();
    cleanup();
    renderBadge(undefined);
    expect(screen.queryByTestId('deepseek-campaign-pricing-badge')).toBeNull();
  });

  it('still renders for a signed-in client', () => {
    renderBadge(true);
    expect(screen.getByTestId('deepseek-campaign-pricing-badge')).toBeTruthy();
  });

  it('makes `loggedIn` a required prop so a new mount point cannot forget it', () => {
    // A future third mount point is caught by typecheck, not by review.
    expect(badgeSource).toMatch(/\n\s*loggedIn: boolean \| null \| undefined;/);
    expect(badgeSource).not.toMatch(/\n\s*loggedIn\?:/);
  });

  it('mounts the badge signed-out from the entry shell mount point', () => {
    // There is no cloud login surface anymore, so the shell mount point pins
    // the signed-out state explicitly.
    expect(entryShellSource).toMatch(
      /<WorkbenchCampaignBadge[\s\S]{0,400}?loggedIn=\{false\}/,
    );
  });
});
