import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { MessagesResponse, PortableSnapshot, ProjectGitAccepted } from '@open-design/contracts';
import { expect, test } from '@/playwright/suite';
import { createFakeAgentRuntimes } from '@/fake-agents';
import { createProjectGitE2eFixture, gitOperation, mutate, requestJson, seedGitHistory, state, waitOperation } from '@/project-git-fixture';
import { T } from '@/timeouts';

let fixture: Awaited<ReturnType<typeof createProjectGitE2eFixture>>;
const gitTraffic = new WeakMap<object, unknown[]>();
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
test.use({
  actionTimeout: T.long,
  toolsDevExternalDataDir: true,
  toolsDevEnvironment: {
    async setup(root) {
      fixture = await createProjectGitE2eFixture(join(root, 'scratch'));
      return fixture.env;
    },
  },
});

test.beforeEach(async ({ page, toolsDev }) => {
  test.setTimeout(T.xlong * 5);
  const traffic: unknown[] = []; gitTraffic.set(page, traffic);
  page.on('response', async response => {
    const path = new URL(response.url()).pathname;
    if (!path.includes('/git') && !path.includes('/project-git-operations/')) return;
    try { traffic.push({ path, status: response.status(), body: await response.json() }); } catch { /* Page teardown may cancel a read. */ }
  });
  const fake = await createFakeAgentRuntimes({ root: join(toolsDev.root, 'scratch', 'fake-agents'), runtimeIds: ['codex'] });
  const config = { mode: 'daemon', onboardingCompleted: true, agentId: 'codex',
    agentModels: { codex: { model: 'default', reasoning: 'default' } }, agentCliEnv: { codex: fake.codex.env }, skillId: null, designSystemId: null };
  const response = await page.request.put('/api/app-config', { data: config });
  expect(response.ok()).toBe(true);
  await page.addInitScript(value => {
    localStorage.setItem('open-design:config', JSON.stringify(value));
    localStorage.setItem('open-design:locale', 'zh-CN');
    localStorage.setItem('open-design:locale-source', 'manual');
  }, config);
});

test.afterEach(async ({ page }, testInfo) => {
  await testInfo.attach('public-git-http', { body: JSON.stringify(gitTraffic.get(page) ?? [], null, 2), contentType: 'application/json' });
});

test('[P1] project git history restores content and rejects an old editor save', async ({ page, toolsDev }, testInfo) => {
  const base = toolsDev.url.web();
  const seed = await seedGitHistory(base);
  const fileApi = `/api/projects/${seed.projectId}/files`;
  const messagesApi = `/api/projects/${seed.projectId}/conversations/${seed.conversationId}/messages`;
  const form = '<question-form id="historic" title="Archived brief">{"questions":[{"id":"tone","label":"Historical tone","type":"text","required":true}]}</question-form>';
  const historicalId = randomUUID();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await mutate(base, seed.projectId, fileApi, { name: 'history-reference.png', content: png, encoding: 'base64' });
  const initialMessages = await requestJson<MessagesResponse>(base, messagesApi);
  await mutate(base, seed.projectId, `${messagesApi}/${initialMessages.body.messages[0]!.id}`, {
    role: 'user', content: 'version-one message', createdAt: 1,
    commentAttachments: [{ id: 'historical-selection', order: 0, filePath: 'index.html', elementId: 'hero', selector: '#hero',
      label: 'Historical selected hero', comment: 'Historical contrast request', currentText: 'Original hero title',
      htmlHint: '<h1>Original hero title</h1>', selectionKind: 'element',
      imageAttachments: [{ path: 'history-reference.png', name: 'Selection reference' }] }],
  }, 'PUT');
  await mutate(base, seed.projectId, `${messagesApi}/${historicalId}`, { role: 'assistant', content: form, createdAt: 3,
    feedback: { rating: 'negative', customReason: 'Historical feedback only', createdAt: 3 },
    attachments: [{ path: 'history-reference.png', name: 'history-reference.png', kind: 'image' }],
    events: [{ kind: 'text', text: 'Historical display event' }] }, 'PUT');
  await gitOperation(base, seed.projectId, '/sync');
  seed.targetOid = (await state(base, seed.projectId)).localHead!;
  seed.targetContent = seed.targetContent.replaceAll('one', 'two');
  await mutate(base, seed.projectId, fileApi, { name: 'index.html', content: seed.targetContent.replaceAll('two', 'latest') });
  await mutate(base, seed.projectId, `${messagesApi}/${historicalId}`, { role: 'assistant', content: 'Latest non-historical answer', createdAt: 3 }, 'PUT');
  await gitOperation(base, seed.projectId, '/sync');
  seed.projectRevision = (await state(base, seed.projectId)).projectRevision;
  const targetMessages = await requestJson<PortableSnapshot>(base, `/api/projects/${seed.projectId}/git/commits/${seed.targetOid}/conversations`);
  await page.goto(`/projects/${seed.projectId}/conversations/${seed.conversationId}`);
  await expect(page.getByTestId('project-git-status')).toBeVisible({ timeout: T.long });
  await page.screenshot({ path: testInfo.outputPath('status-entry.png') });
  const entered = signal();
  const release = signal();
  await page.route(`**${fileApi}`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    entered.resolve(); await release.promise; await route.continue();
  });
  const delayedSave = page.evaluate(async ({ path, revision, content }) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ name: 'index.html', content, expectedProjectRevision: revision }) });
    return { status: response.status, body: await response.json() };
  }, { path: fileApi, revision: seed.projectRevision, content: '<!doctype html><html><head><title>Old draft</title></head><body>old queued draft</body></html>' });
  try {
    await Promise.race([entered.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Old editor POST did not reach route hold')), T.medium))]);
    await page.getByRole('button', { name: '历史', exact: true }).click();
    await page.getByTestId(`git-commit-${seed.targetOid}`).getByRole('button', { name: '恢复', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认恢复', exact: true })).toBeEnabled({ timeout: T.long });
    await page.screenshot({ path: testInfo.outputPath('history-restore-entry.png') });
    await page.getByRole('button', { name: '确认恢复', exact: true }).click();
    await expect.poll(async () => (await state(base, seed.projectId)).projectRevision, { timeout: T.xlong, message: 'Restore must advance the project epoch before releasing old save' }).toBeGreaterThan(seed.projectRevision);
    await expect.poll(async () => (await state(base, seed.projectId)).phase, { timeout: T.xlong, message: 'Restore must finish materialization before releasing old save' }).toBe('local_saved');
    release.resolve();
    const oldSave = await delayedSave;
    expect(oldSave.status).toBe(409);
    expect(oldSave.body.error.code).toBe('PROJECT_STATE_CHANGED');
    const current = await page.request.get(`/api/projects/${seed.projectId}/raw/index.html`);
    expect(await current.text()).toBe(seed.targetContent);
    const messages = await requestJson<MessagesResponse>(base, messagesApi);
    expect(messages.body.messages.map(message => message.content)).toEqual(['version-one message', 'version-two message', form]);
    const history = page.getByTestId('restored-historical-message').filter({ hasText: form });
    await expect(history).toBeVisible({ timeout: T.long });
    await expect(history.getByText('Historical feedback only', { exact: true })).toBeVisible();
    await expect(history.getByText('Historical display event', { exact: true })).toBeVisible();
    await expect(history.locator('form, button, input, textarea, select')).toHaveCount(0);
    await expect(history.locator('img')).toBeVisible();
    expect(await history.locator('img').evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    const selection = page.getByTestId('restored-historical-message').filter({ hasText: 'Historical selected hero' });
    await expect(selection.getByText('Historical contrast request', { exact: true })).toBeVisible();
    await expect(selection.getByText('Original hero title', { exact: true })).toBeVisible();
    await expect(selection.locator('form, button, input, textarea, select')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('restored-inert-history.png') });
    await testInfo.attach('restore-public-evidence', { body: JSON.stringify({ seed, targetMessages, messages, oldSave, state: await state(base, seed.projectId) }, null, 2), contentType: 'application/json' });
  } finally {
    release.resolve();
    await delayedSave.catch(() => undefined);
    await page.unroute(`**${fileApi}`);
  }
});

test('[P1] version settings bind preview and conflict resolution use real Git', async ({ page, toolsDev }, testInfo) => {
  const base = toolsDev.url.web();
  const seed = await seedGitHistory(base);
  // This is the sole binding case; the other case never touches this remote.
  await page.goto(`/projects/${seed.projectId}/conversations/${seed.conversationId}`);
  await expect(page.getByTestId('project-git-status')).toBeVisible({ timeout: T.long });
  await page.getByRole('button', { name: '版本设置', exact: true }).filter({ hasText: /^版本设置$/u }).click({ timeout: T.long });
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('仓库地址', { exact: true }).fill(fixture.remoteUrl, { timeout: T.long });
  await dialog.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(dialog.getByText('远端仓库为空。', { exact: true })).toBeVisible({ timeout: T.xlong });
  await page.screenshot({ path: testInfo.outputPath('binding-preview-entry.png') });
  await testInfo.attach('binding-confirm-hit-target', { body: JSON.stringify(await dialog.getByRole('button', { name: '确认', exact: true }).evaluate(button => {
    button.scrollIntoView({ block: 'center' });
    const box = button.getBoundingClientRect();
    const ancestors = []; let current: Element | null = button;
    while (current) { const css = getComputedStyle(current); ancestors.push({ tag: current.tagName, class: current.className,
      zIndex: css.zIndex, position: css.position, transform: css.transform, isolation: css.isolation, contain: css.contain }); current = current.parentElement; }
    return { box: box.toJSON(), hitClass: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.className, ancestors };
  }), null, 2), contentType: 'application/json' });
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect.poll(async () => (await state(base, seed.projectId)).binding.remoteConfigured, { timeout: T.xlong }).toBe(true);
  await expect(dialog.getByText('远端仓库为空。', { exact: true })).toHaveCount(0, { timeout: T.xlong });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await gitOperation(base, seed.projectId, '', { action: 'pause' }, 'PATCH');
  await gitOperation(base, seed.projectId, '/sync');
  await fixture.git(fixture.cloneB, 'pull', 'origin', 'main');
  const externalContent = seed.targetContent.replaceAll('one', 'remote-choice');
  await writeFile(join(fixture.cloneB, 'index.html'), externalContent);
  await fixture.git(fixture.cloneB, 'add', 'index.html');
  await fixture.git(fixture.cloneB, 'commit', '-m', 'External conflicting design');
  await fixture.git(fixture.cloneB, 'push', 'origin', 'main');
  const localContent = seed.targetContent.replaceAll('one', 'local-choice');
  await mutate(base, seed.projectId, `/api/projects/${seed.projectId}/files`, { name: 'index.html', content: localContent });
  const accepted = await mutate<ProjectGitAccepted>(base, seed.projectId, `/api/projects/${seed.projectId}/git/sync`, {});
  const operation = await waitOperation(base, accepted.operationId);
  expect(operation.phase, JSON.stringify(operation)).toBe('conflict');
  expect(await (await page.request.get(`/api/projects/${seed.projectId}/raw/index.html`)).text()).toBe(localContent);
  await expect(page.getByRole('button', { name: '冲突', exact: true })).toBeVisible({ timeout: T.long });
  await page.getByRole('button', { name: '冲突', exact: true }).click();
  const conflictDialog = page.getByRole('dialog');
  await expect(conflictDialog.getByRole('heading', { name: '共同祖先', exact: true })).toBeVisible({ timeout: T.long });
  await expect(conflictDialog.getByText(localContent, { exact: true })).toBeVisible();
  await expect(conflictDialog.getByText(externalContent, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('conflict-entry.png') });
  await conflictDialog.getByRole('combobox', { name: 'index.html', exact: true }).selectOption('remote');
  await conflictDialog.getByRole('button', { name: '提交解决方案', exact: true }).click();
  await expect(conflictDialog).toHaveCount(0, { timeout: T.xlong });
  await expect.poll(async () => (await state(base, seed.projectId)).phase, { timeout: T.xlong }).not.toBe('conflict');
  expect(await (await page.request.get(`/api/projects/${seed.projectId}/raw/index.html`)).text()).toBe(externalContent);
  await testInfo.attach('conflict-operation', { body: JSON.stringify(operation), contentType: 'application/json' });
});
