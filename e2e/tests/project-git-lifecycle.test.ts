import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MessagesResponse, ProjectGitAccepted, ProjectGitConflictsResponse, ProjectGitFileResponse, ProjectGitState, PortableSnapshot } from '@open-design/contracts';
import { createSmokeSuite } from '@/vitest/suite';
import { T } from '@/timeouts';
import { createProjectGitE2eFixture, gitOperation, mutate, requestJson, runOd, seedGitHistory, state, waitOperation } from '@/project-git-fixture';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFakeAgentRuntimes } from '@/fake-agents';

it('[P1] ordinary opens and native admission fetch the second clone before the next scheduled check', async () => {
  const suite = await createSmokeSuite('project-git-before-use', { dataDir: await mkdtemp(join(tmpdir(), 'od-git-before-use-')) });
  const fixture = await createProjectGitE2eFixture(suite.scratchDir);
  const agents = await createFakeAgentRuntimes({ root: join(suite.scratchDir, 'agents'), runtimeIds: ['codex'] });
  try {
    await suite.with.toolsDev(async ({ webUrl }) => {
      const seed = await seedGitHistory(webUrl);
      const preview = await gitOperation(webUrl, seed.projectId, '/binding-preview', { url: fixture.remoteUrl, branch: 'main' });
      await gitOperation(webUrl, seed.projectId, '/bind', { previewId: preview.result!.preview!.id });
      const check = () => requestJson<ProjectGitState>(webUrl, `/api/projects/${seed.projectId}/git/check`, { method: 'POST', body: '{}' });
      const initial = await check(); expect(initial.status).toBe(200);
      await fixture.git(fixture.cloneB, 'pull', '--ff-only', 'origin', 'main');
      const evidence = [];
      for (const lane of ['http-open', 'cli-open', 'native-admission']) {
        const before = await state(webUrl, seed.projectId);
        const started = Date.now();
        const content = `<html><body>${lane} from clone B</body></html>`;
        await writeFile(join(fixture.cloneB, 'index.html'), content);
        await fixture.git(fixture.cloneB, 'add', 'index.html'); await fixture.git(fixture.cloneB, 'commit', '-m', lane);
        await fixture.git(fixture.cloneB, 'push', 'origin', 'main');
        const remote = await fixture.git(fixture.cloneB, 'rev-parse', 'HEAD');
        expect((await state(webUrl, seed.projectId)).localHead).toBe(before.localHead);
        let response: unknown;
        if (lane === 'http-open') {
          const result = await check(); expect(result.status).toBe(200); response = result;
        } else if (lane === 'cli-open') {
          const result = await runOd(webUrl, ['git', 'check', '--project', seed.projectId, '--json']);
          expect(result.code, result.stderr).toBe(0); response = JSON.parse(result.stdout);
        } else {
          const result = await requestJson(webUrl, '/api/runs', { method: 'POST', body: JSON.stringify({
            projectId: seed.projectId, conversationId: seed.conversationId, prompt: 'Read the current design', agentId: 'codex',
            expectedProjectRevision: before.projectRevision,
          }) });
          expect(result.status, JSON.stringify(result)).toBe(409);
          expect(result.body).toMatchObject({ error: { code: 'PROJECT_STATE_CHANGED' } }); response = result;
        }
        const after = await state(webUrl, seed.projectId);
        expect(after.localHead).toBe(remote); expect(after.projectRevision).toBeGreaterThan(before.projectRevision);
        expect(await (await fetch(`${webUrl}/api/projects/${seed.projectId}/raw/index.html`)).text()).toBe(content);
        expect(Date.now() - started).toBeLessThan(48_000);
        evidence.push({ lane, before, remote, after, response, elapsed: Date.now() - started });
      }
      await suite.report.json('before-use-two-clone.json', evidence);
    }, { env: { ...fixture.env, ...agents.codex.env } });
  } finally { await fixture.close(); }
}, T.xlong * 4);

it('[P1] fixture launchers preserve real Git arguments and reject unknown SSH commands', async () => {
  const suite = await createSmokeSuite('project-git-transport');
  const fixture = await createProjectGitE2eFixture(suite.scratchDir);
  const execute = promisify(execFile);
  const env = { ...process.env, ...fixture.env };
  const launcher = join(fixture.sshBinDir, 'git');
  let success = false;
  try {
    const identity = await execute(launcher, ['config', '--global', '--includes', '--null', '--list'], { env, timeout: T.short });
    expect(identity.stdout).toContain('user.name\nProject Git E2E\0');
    const forwarded = ['-C', fixture.cloneA, '-c', 'fixture.value=literal value', 'config', '--get', 'fixture.value'];
    expect((await execute(launcher, forwarded, { env, timeout: T.short })).stdout)
      .toBe((await execute(fixture.realGit, forwarded, { env, timeout: T.short })).stdout);
    const unsupported = ['--definitely-unsupported-project-git-option'];
    const realError = await execute(fixture.realGit, unsupported, { env, timeout: T.short }).catch(error => error);
    const wrapperError = await execute(launcher, unsupported, { env, timeout: T.short }).catch(error => error);
    expect(wrapperError.code).toBe(realError.code);
    expect(wrapperError.stderr).toBe(realError.stderr);
    for (const argv of [
      ['git@elsewhere.invalid', "git-upload-pack '/unknown'"],
      ['git@project-git.invalid', "git-upload-pack '/unknown'"],
      ['git@project-git.invalid', "git-upload-pack '/unknown'; touch sentinel"],
      ['-o', 'ProxyCommand=touch sentinel', 'git@project-git.invalid', "git-upload-pack '/unknown'"],
    ]) {
      await expect(execute(join(fixture.sshBinDir, 'ssh'), argv, { env, timeout: T.short })).rejects.toMatchObject({ code: 2 });
    }
    await suite.report.json('transport-boundary.json', { realGit: fixture.realGit, identityIsFixture: true, forwarded, unsupportedRejectedUnchanged: true });
    success = true;
  } finally { await fixture.close(); await suite.finalize({ success }); }
}, T.long);

it('[P1] HTTPS authentication and offline failures never claim a remote save', async () => {
  const suite = await createSmokeSuite('project-git-https', { dataDir: await mkdtemp(join(tmpdir(), 'od-git-https-')) });
  const fixture = await createProjectGitE2eFixture(suite.scratchDir);
  const server = await fixture.authServer(); let closed = false;
  try {
    const execute = promisify(execFile);
    const env = { ...process.env, ...fixture.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const unregistered = server.url.replace('/repo', '/unregistered');
    await expect(execute(join(fixture.sshBinDir, 'git'), ['ls-remote', unregistered], { env, timeout: T.long }))
      .rejects.toMatchObject({ code: 128, stderr: expect.stringContaining('certificate signer not trusted') });
    await suite.with.toolsDev(async ({ webUrl }) => {
      const seed = await seedGitHistory(webUrl);
      const before = await state(webUrl, seed.projectId);
      const accepted = await mutate<ProjectGitAccepted>(webUrl, seed.projectId, `/api/projects/${seed.projectId}/git/binding-preview`, { url: server.url, branch: 'main' });
      const auth = await waitOperation(webUrl, accepted.operationId);
      expect(auth.status).toBe('failed'); expect(auth.error?.code).toBe('GIT_AUTH_REQUIRED');
      expect(server.requests.length).toBeGreaterThan(0);
      expect((await state(webUrl, seed.projectId)).confirmedRemoteHead).toBeNull();
      await server.close(); closed = true;
      const offlineAccepted = await mutate<ProjectGitAccepted>(webUrl, seed.projectId, `/api/projects/${seed.projectId}/git/binding-preview`, { url: server.url, branch: 'main' });
      const offline = await waitOperation(webUrl, offlineAccepted.operationId);
      expect(offline.status).toBe('failed');
      const after = await state(webUrl, seed.projectId);
      expect(after.phase).not.toBe('synced'); expect(after.localHead).toBe(before.localHead); expect(after.confirmedRemoteHead).toBeNull();
      await suite.report.json('https-auth-offline.json', { realGit: fixture.realGit, ca: server.ca, url: server.url, requests: server.requests, auth, offline, before, after, unregisteredCaNotInjected: true });
    }, { env: fixture.env });
  } finally { if (!closed) await server.close(); await fixture.close(); }
}, T.xlong * 4);

it('[P1] two daemons cannot both enable one imported Git working tree', async () => {
  const a = await createSmokeSuite('project-git-owner-a', { dataDir: await mkdtemp(join(tmpdir(), 'od-git-owner-a-')) });
  const b = await createSmokeSuite('project-git-owner-b', { dataDir: await mkdtemp(join(tmpdir(), 'od-git-owner-b-')) });
  const fixture = await createProjectGitE2eFixture(a.scratchDir);
  await writeFile(join(fixture.cloneA, 'index.html'), '<!doctype html><html><head><title>Owned</title></head><body>Owned project</body></html>');
  await fixture.git(fixture.cloneA, 'add', 'index.html'); await fixture.git(fixture.cloneA, 'commit', '-m', 'Plain editor project');
  try {
    await a.with.toolsDev(async ({ webUrl: urlA }) => {
      await b.with.toolsDev(async ({ webUrl: urlB }) => {
        const importedA = await requestJson<{ project: { id: string } }>(urlA, '/api/import/folder', { method: 'POST', body: JSON.stringify({ baseDir: fixture.cloneA, name: 'First owner' }) });
        expect(importedA.status, JSON.stringify(importedA)).toBe(200);
        const projectA = importedA.body.project.id;
        const initialA = await state(urlA, projectA);
        expect(initialA.enabled).toBe(true);
        const importedB = await requestJson<{ project: { id: string } }>(urlB, '/api/import/folder', { method: 'POST', body: JSON.stringify({ baseDir: fixture.cloneA, name: 'Second owner' }) });
        expect(importedB.status, JSON.stringify(importedB)).toBe(400);
        expect(importedB.body).toMatchObject({ error: { code: 'BAD_REQUEST', message: 'The project state changed. Refresh and retry.' } });
        expect((await state(urlA, projectA)).enabled).toBe(true);
        await mutate(urlA, projectA, `/api/projects/${projectA}/files`, { name: 'index.html', content: '<!doctype html><html><head><title>Owner still writable</title></head><body>First owner</body></html>' });
        await gitOperation(urlA, projectA, '/sync');
        await a.report.json('one-writable-owner.json', { projectA, initialA, denied: importedB, head: await fixture.git(fixture.cloneA, 'rev-parse', 'HEAD') });
      }, { env: fixture.env });
    }, { env: fixture.env });
  } finally { await fixture.close(); }
}, T.xlong * 5);

it('[P1] message conflicts stay structured and remote rewrites retain local and protected history', async () => {
  const suite = await createSmokeSuite('project-git-conflict-rewrite', { dataDir: await mkdtemp(join(tmpdir(), 'od-git-conflict-')) });
  const fixture = await createProjectGitE2eFixture(suite.scratchDir);
  try {
    await suite.with.toolsDev(async ({ webUrl }) => {
      const seed = await seedGitHistory(webUrl);
      const preview = await gitOperation(webUrl, seed.projectId, '/binding-preview', { url: fixture.remoteUrl, branch: 'main' });
      await gitOperation(webUrl, seed.projectId, '/bind', { previewId: preview.result!.preview!.id });
      await gitOperation(webUrl, seed.projectId, '', { action: 'pause' }, 'PATCH');
      await gitOperation(webUrl, seed.projectId, '/sync');
      const shared = (await state(webUrl, seed.projectId)).localHead!;
      await fixture.git(fixture.cloneA, 'pull', 'origin', 'main');
      const paths = (await fixture.git(fixture.cloneA, 'ls-tree', '-r', '--name-only', 'HEAD', '.open-design/conversations')).split('\n').filter(path => path.includes('/messages/'));
      let changedPath = '';
      for (const path of paths) {
        const record = JSON.parse(await readFile(join(fixture.cloneA, path), 'utf8')) as { content: string };
        if (record.content !== 'version-one message') continue;
        changedPath = path; record.content = 'Remote edited message';
        await writeFile(join(fixture.cloneA, path), JSON.stringify(record));
      }
      expect(changedPath).not.toBe('');
      await fixture.git(fixture.cloneA, 'add', changedPath); await fixture.git(fixture.cloneA, 'commit', '-m', 'Remote message edit');
      await fixture.git(fixture.cloneA, 'push', 'origin', 'main');
      const messagesApi = `/api/projects/${seed.projectId}/conversations/${seed.conversationId}/messages`;
      const before = await requestJson<MessagesResponse>(webUrl, messagesApi);
      const firstMessage = before.body.messages.find(message => message.content === 'version-one message')!;
      await mutate(webUrl, seed.projectId, `${messagesApi}/${firstMessage.id}`, { role: 'user', content: 'Local edited message', createdAt: 1 }, 'PUT');
      const accepted = await mutate<ProjectGitAccepted>(webUrl, seed.projectId, `/api/projects/${seed.projectId}/git/sync`, {});
      const conflict = await waitOperation(webUrl, accepted.operationId);
      expect(conflict.phase, JSON.stringify(conflict)).toBe('conflict');
      const conflicts = await requestJson<ProjectGitConflictsResponse>(webUrl, `/api/projects/${seed.projectId}/git/conflicts`);
      expect(conflicts.body.conflicts.some(item => item.kind === 'message')).toBe(true);
      const during = await requestJson<MessagesResponse>(webUrl, messagesApi);
      expect(during.body.messages.find(message => message.id === firstMessage.id)?.content).toBe('Local edited message');
      expect(JSON.stringify(during.body)).not.toMatch(/<<<<<<<|=======|>>>>>>>/u);
      const resolution = join(suite.scratchDir, 'message-resolution.json');
      await writeFile(resolution, JSON.stringify({ expectedProjectRevision: conflict.basis.projectRevision,
        basis: conflict.basis, resolutions: conflicts.body.conflicts.map(item => ({ conflictId: item.id, kind: 'select', selectedSide: 'remote' })) }));
      const resolved = await runOd(webUrl, ['git', 'resolve', '--project', seed.projectId, '--operation', conflict.id, '--prompt-file', resolution, '--json']);
      expect(resolved.code, resolved.stderr).toBe(0);
      await gitOperation(webUrl, seed.projectId, '/sync');
      const settled = await state(webUrl, seed.projectId);
      const actualMessages = await requestJson<MessagesResponse>(webUrl, messagesApi);
      expect(actualMessages.body.messages.some(message => message.content === 'Remote edited message')).toBe(true);
      const repositories: string[] = [];
      for (const head of await readdir(suite.dataDir, { recursive: true })) {
        if (head.endsWith('/.git/HEAD')) repositories.push(join(suite.dataDir, dirname(dirname(head))));
      }
      const root = repositories.find(path => path.includes(seed.projectId));
      expect(root, JSON.stringify(repositories)).toBeTruthy();
      const protectedBefore = await fixture.git(root!, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/open-design/bindings/', 'refs/open-design/protection/');
      expect(protectedBefore).not.toBe('');
      // Controlled remote administrator rewinds only the disposable bare fixture.
      await fixture.git(fixture.bare, 'update-ref', 'refs/heads/main', shared, settled.confirmedRemoteHead!);
      const rewrittenAccepted = await mutate<ProjectGitAccepted>(webUrl, seed.projectId, `/api/projects/${seed.projectId}/git/sync`, {});
      const rewritten = await waitOperation(webUrl, rewrittenAccepted.operationId);
      expect(rewritten.status).not.toBe('succeeded');
      expect(rewritten.phase).toBe('conflict');
      expect(rewritten.error?.details).toMatchObject({ reason: 'remote_rewritten' });
      expect((await state(webUrl, seed.projectId)).localHead).toBe(settled.localHead);
      expect(await fixture.git(fixture.bare, 'rev-parse', 'main')).toBe(shared);
      const protectedRefs = await fixture.git(root!, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/open-design/bindings/', 'refs/open-design/protection/');
      expect(protectedRefs).toBe(protectedBefore);
      expect(await fixture.git(root!, 'rev-parse', 'HEAD')).toBe(settled.localHead);
      await fixture.git(root!, 'merge-base', '--is-ancestor', shared, settled.localHead!);
      await suite.report.json('message-conflict-rewrite.json', { shared, changedPath, conflict, conflicts, during: during.body, resolved, settled, rewritten, protectedBefore, protectedRefs, final: await state(webUrl, seed.projectId) });
    }, { env: fixture.env });
  } finally { await fixture.close(); }
}, T.xlong * 6);

it('[P1] local checkpoints expose the same real HEAD through HTTP and the built CLI', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'od-git-e2e-data-'));
  const suite = await createSmokeSuite('project-git-lifecycle', { dataDir });
  const fixture = await createProjectGitE2eFixture(suite.scratchDir);
  try {
    await suite.with.toolsDev(async ({ webUrl }) => {
      const seed = await seedGitHistory(webUrl);
      const response = await requestJson<ProjectGitState>(webUrl, `/api/projects/${seed.projectId}/git`);
      expect(response.status).toBe(200);
      expect(response.body.phase).toBe('local_saved');
      const cli = await runOd(webUrl, ['git', 'status', '--project', seed.projectId, '--json']);
      expect(cli.code, cli.stderr).toBe(0);
      expect(JSON.parse(cli.stdout).localHead).toBe(response.body.localHead);
      await suite.report.json('local-checkpoint.json', { seed, state: response.body, cli });
    }, { env: fixture.env });
  } finally { await fixture.close(); }
}, T.xlong * 5);

it('[P1] a killed daemon restarts without duplicating an acknowledged push and checkpoints without a page', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'od-git-restart-'));
  const fixtureSuite = await createSmokeSuite('project-git-restart-transport');
  const fixture = await createProjectGitE2eFixture(fixtureSuite.scratchDir);
  const first = await createSmokeSuite('project-git-before-crash', { dataDir });
  const second = await createSmokeSuite('project-git-after-crash', { dataDir });
  let projectId = ''; let acknowledged = ''; let commits = ''; let firstPid = 0;
  let success = false;
  try {
    await first.with.toolsDev(async ({ webUrl, status }) => {
      const seed = await seedGitHistory(webUrl); projectId = seed.projectId;
      const preview = await gitOperation(webUrl, projectId, '/binding-preview', { url: fixture.remoteUrl, branch: 'main' });
      await gitOperation(webUrl, projectId, '/bind', { previewId: preview.result!.preview!.id });
      await gitOperation(webUrl, projectId, '/sync');
      const before = await state(webUrl, projectId);
      await mutate(webUrl, projectId, `/api/projects/${projectId}/files`, { name: 'index.html', content: seed.targetContent.replaceAll('one', 'automatic') });
      await expect.poll(async () => (await state(webUrl, projectId)).localHead, { timeout: T.xlong, interval: T.short / 10 }).not.toBe(before.localHead);
      await expect.poll(async () => {
        const current = await state(webUrl, projectId);
        return current.localHead === current.confirmedRemoteHead && current.phase === 'synced';
      }, { timeout: T.xlong * 2, interval: T.short / 10 }).toBe(true);
      acknowledged = (await state(webUrl, projectId)).confirmedRemoteHead!;
      expect(await fixture.git(fixture.bare, 'rev-parse', 'main')).toBe(acknowledged);
      commits = await fixture.git(fixture.bare, 'rev-list', '--count', 'main');
      const pid = status.apps?.daemon?.pid;
      if (!pid) throw new Error('Harness did not expose the running daemon PID');
      firstPid = pid;
      await first.report.json('before-kill.json', { projectId, firstPid, acknowledged, commits, automaticRemoteWithoutPage: true, state: await state(webUrl, projectId) });
      process.kill(firstPid, 'SIGKILL');
    }, { env: fixture.env });
    await second.with.toolsDev(async ({ webUrl, status }) => {
      const restartedPid = status.apps?.daemon?.pid;
      expect(restartedPid).toBeTypeOf('number'); expect(restartedPid).not.toBe(firstPid);
      const recovered = await state(webUrl, projectId);
      expect(recovered.localHead).toBe(acknowledged);
      expect(recovered.confirmedRemoteHead).toBe(acknowledged);
      await gitOperation(webUrl, projectId, '/sync');
      expect(await fixture.git(fixture.bare, 'rev-list', '--count', 'main')).toBe(commits);
      expect(await fixture.git(fixture.bare, 'rev-parse', 'main')).toBe(acknowledged);
      await second.report.json('restart-no-duplicate.json', { firstPid, restartedPid, recovered, acknowledged, commits, final: await state(webUrl, projectId) });
    }, { env: fixture.env });
    success = true;
  } finally { await fixture.close(); await fixtureSuite.finalize({ success }); }
}, T.xlong * 5);

it('[P1] two daemons bind, open, push and restore files, settings, chat and image bytes without rewriting history', async () => {
  const suiteA = await createSmokeSuite('project-git-clone-a', { dataDir: await mkdtemp(join(tmpdir(), 'od-git-a-')) });
  const suiteB = await createSmokeSuite('project-git-clone-b', { dataDir: await mkdtemp(join(tmpdir(), 'od-git-b-')) });
  const fixture = await createProjectGitE2eFixture(suiteA.scratchDir);
  try {
    await suiteA.with.toolsDev(async ({ webUrl: a }) => {
      await suiteB.with.toolsDev(async ({ webUrl: b }) => {
        const seed = await seedGitHistory(a);
        const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
        const imageDigest = createHash('sha256').update(image).digest('hex');
        await mutate(a, seed.projectId, `/api/projects/${seed.projectId}/files`, { name: 'reference.png', content: image.toString('base64'), encoding: 'base64' });
        await mutate(a, seed.projectId, `/api/projects/${seed.projectId}`, { customInstructions: 'Keep the original blue design' }, 'PATCH');
        await mutate(a, seed.projectId, `/api/projects/${seed.projectId}/conversations/${seed.conversationId}/messages/${randomUUID()}`, {
          role: 'assistant', content: 'Historical visual reference', createdAt: 3,
          attachments: [{ path: 'reference.png', name: 'reference.png', kind: 'image', size: image.length }],
        }, 'PUT');
        await gitOperation(a, seed.projectId, '/sync');
        const target = (await state(a, seed.projectId)).localHead!;
        const previewCli = await runOd(a, ['git', 'bind-preview', '--project', seed.projectId, '--url', fixture.remoteUrl, '--branch', 'main', '--json']);
        expect(previewCli.code, previewCli.stderr).toBe(0);
        const previewOp = await waitOperation(a, JSON.parse(previewCli.stdout).id);
        expect(previewOp.status, JSON.stringify(previewOp)).toBe('succeeded');
        expect(previewOp.result?.preview?.binding?.classification).toBe('empty');
        const bindCli = await runOd(a, ['git', 'bind', '--project', seed.projectId, '--preview', previewOp.result!.preview!.id, '--json']);
        expect(bindCli.code, bindCli.stderr).toBe(0);
        expect((await waitOperation(a, JSON.parse(bindCli.stdout).id)).status).toBe('succeeded');
        await gitOperation(a, seed.projectId, '', { action: 'pause' }, 'PATCH');
        await gitOperation(a, seed.projectId, '/sync');
        const aPushed = await state(a, seed.projectId);
        expect(aPushed.confirmedRemoteHead).toBe(await fixture.git(fixture.bare, 'rev-parse', 'refs/heads/main'));
        const openCli = await runOd(b, ['git', 'open', '--url', fixture.remoteUrl, '--branch', 'main', '--json']);
        expect(openCli.code, openCli.stderr).toBe(0);
        const open = await waitOperation(b, JSON.parse(openCli.stdout).id);
        expect(open.status, JSON.stringify(open)).toBe('succeeded');
        const projectB = open.result!.projectId!;
        await gitOperation(b, projectB, '', { action: 'pause' }, 'PATCH');
        const conversations = await requestJson<{ conversations: Array<{ id: string; title: string }> }>(b, `/api/projects/${projectB}/conversations`);
        const conversationB = conversations.body.conversations.find(item => item.title === 'Versioned conversation')!.id;
        const imported = await requestJson<MessagesResponse>(b, `/api/projects/${projectB}/conversations/${conversationB}/messages`);
        expect(imported.body.messages.map(item => item.content)).toEqual(['version-one message', 'version-two message', 'Historical visual reference']);
        expect(createHash('sha256').update(Buffer.from(await (await fetch(`${b}/api/projects/${projectB}/raw/reference.png`)).arrayBuffer())).digest('hex')).toBe(imageDigest);
        const changed = seed.targetContent.replaceAll('one', 'from-b');
        await mutate(b, projectB, `/api/projects/${projectB}/files`, { name: 'index.html', content: changed });
        await mutate(b, projectB, `/api/projects/${projectB}`, { customInstructions: 'Revision from computer B' }, 'PATCH');
        await mutate(b, projectB, `/api/projects/${projectB}/conversations/${conversationB}/messages/${randomUUID()}`, { role: 'user', content: 'new message from B', createdAt: 4 }, 'PUT');
        await gitOperation(b, projectB, '/sync');
        const bPushed = await state(b, projectB);
        await gitOperation(a, seed.projectId, '/sync');
        expect(await (await fetch(`${a}/api/projects/${seed.projectId}/raw/index.html`)).text()).toBe(changed);
        const beforeRestore = await state(a, seed.projectId);
        const restorePreview = await gitOperation(a, seed.projectId, '/restore-preview', { oid: target });
        await gitOperation(a, seed.projectId, '/restore', { previewId: restorePreview.result!.preview!.id });
        const restored = await state(a, seed.projectId);
        const commit = await requestJson<{ parents: string[] }>(a, `/api/projects/${seed.projectId}/git/commits/${restored.localHead}`);
        expect(commit.body.parents).toEqual([beforeRestore.localHead]);
        expect(restored.projectRevision).toBeGreaterThan(beforeRestore.projectRevision);
        await gitOperation(a, seed.projectId, '/sync');
        await gitOperation(b, projectB, '/sync');
        expect(await (await fetch(`${b}/api/projects/${projectB}/raw/index.html`)).text()).toBe(seed.targetContent.replaceAll('one', 'two'));
        const restoredMessages = await requestJson<MessagesResponse>(b, `/api/projects/${projectB}/conversations/${conversationB}/messages`);
        expect(restoredMessages.body.messages.map(item => item.content)).toEqual(imported.body.messages.map(item => item.content));
        const project = await requestJson<{ project: { customInstructions: string } }>(b, `/api/projects/${projectB}`);
        expect(project.body.project.customInstructions).toBe('Keep the original blue design');
        await fixture.git(fixture.cloneA, 'fetch', 'origin', 'main');
        await fixture.git(fixture.cloneB, 'fetch', 'origin', 'main');
        expect(await fixture.git(fixture.cloneA, 'rev-parse', 'FETCH_HEAD')).toBe((await state(b, projectB)).localHead);
        await fixture.git(fixture.cloneB, 'merge-base', '--is-ancestor', bPushed.localHead!, 'FETCH_HEAD');
        const snapshot = await requestJson<PortableSnapshot>(b, `/api/projects/${projectB}/git/commits/${(await state(b, projectB)).localHead}/conversations`);
        expect(snapshot.body.manifest.resources.some(resource => resource.digest === imageDigest)).toBe(true);
        await suiteA.report.json('two-clone-evidence.json', { seed, target, aPushed, bPushed, beforeRestore, restored, parents: commit.body.parents, imageDigest, finalA: await state(a, seed.projectId), finalB: await state(b, projectB), settings: project.body.project, messages: restoredMessages.body });
      }, { env: fixture.env });
    }, { env: fixture.env });
  } finally { await fixture.close(); }
}, T.xlong * 10);

it('[P1] default prototype creation can checkpoint its already persisted scenario content', async () => {
  const suite = await createSmokeSuite('project-git-prototype', { dataDir: await mkdtemp(join(tmpdir(), 'od-git-prototype-')) });
  const fixture = await createProjectGitE2eFixture(suite.scratchDir);
  try {
    await suite.with.toolsDev(async ({ webUrl }) => {
      const projectId = randomUUID();
      const created = await requestJson<{ appliedPluginSnapshotId?: string }>(webUrl, '/api/projects', { method: 'POST',
        body: JSON.stringify({ id: projectId, name: 'Default prototype acceptance', metadata: { kind: 'prototype' } }) });
      expect(created.status).toBe(200);
      const snapshots = await requestJson(webUrl, `/api/projects/${projectId}/applied-plugins`);
      const current = await state(webUrl, projectId);
      await suite.report.json('prototype-public-evidence.json', { request: { metadata: { kind: 'prototype' } }, created, snapshots, current });
      expect(current.enabled, JSON.stringify(current)).toBe(true);
      expect(current.localHead).toMatch(/^[a-f0-9]{40}$/);
      const snapshot = await requestJson<PortableSnapshot>(webUrl, `/api/projects/${projectId}/git/commits/${current.localHead}/conversations`);
      const resource = snapshot.body.manifest.resources[0]!;
      const blob = await requestJson<ProjectGitFileResponse>(webUrl, `/api/projects/${projectId}/git/commits/${current.localHead}/files/${resource.locations[0]!.path}`);
      const bytes = Buffer.from(blob.body.content, 'base64');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(resource.digest);
      const content = JSON.parse(bytes.toString()) as { assets: Array<{ path: string; content: string; sha256: string }> };
      expect(content.assets.map(asset => asset.path)).toEqual(['assets/template.html', 'example.html', 'references/checklist.md', 'references/layouts.md']);
      for (const asset of content.assets) expect(createHash('sha256').update(Buffer.from(asset.content, 'base64')).digest('hex')).toBe(asset.sha256);
      for (const field of ['capabilitiesGranted', 'pipeline', 'resolvedSource', 'connectorsResolved']) expect(bytes.toString()).not.toContain(`"${field}"`);
      await suite.report.json('prototype-checkpoint-assets.json', { head: current.localHead, resource, assets: content.assets.map(({ path, sha256 }) => ({ path, sha256 })) });
    }, { env: fixture.env });
  } finally { await fixture.close(); }
}, T.xlong * 5);
