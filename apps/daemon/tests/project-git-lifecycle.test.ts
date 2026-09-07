import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type StartServerOptions } from '../src/server.js';
import { fixtureGitEnv } from './helpers/project-git-crash-worker.js';
import Database from 'better-sqlite3';
import { closeDatabase, insertProject, insertTemplate, openDatabase } from '../src/db.js';
import type { ProjectGitState } from '@open-design/contracts';
import { createProjectGitServiceComposition } from '../src/services/project-git/service.js';
import { createProjectGitStore } from '../src/storage/project-git.js';

describe('new project Git lifecycle', () => {
  let server: Server | undefined;
  const imports: string[] = [];
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    await Promise.all(imports.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  async function create(options: StartServerOptions = {}) {
    const started = await startServer({ port: 0, returnServer: true, projectGitEnv: fixtureGitEnv, ...options }) as { server: Server; url: string };
    server = started.server;
    const id = `lifecycle-${randomUUID()}`;
    const root = join(process.env.OD_DATA_DIR!, 'projects', id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'index.html'), 'editable content');
    const response = await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name: 'Lifecycle project' }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const state = await (await fetch(`${started.url}/api/projects/${id}/git`)).json() as ProjectGitState;
    return { id, root, state, url: started.url };
  }

  it('keeps creation and editing usable with durable enable_pending when Git is absent', async () => {
    const { root, state, url, id } = await create({ projectGitExecutableResolver: () => '/nonexistent/od-fixture-git' } as StartServerOptions);
    expect(await readFile(join(root, 'index.html'), 'utf8')).toBe('editable content');
    expect(state).toMatchObject({ enabled: false, phase: 'enable_pending', error: { code: 'GIT_UNAVAILABLE' } });
    const edited = await fetch(`${url}/api/projects/${id}/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'second.html', content: 'still editable' }),
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
  });

  it('creates a real complete first commit using the supplied local identity', async () => {
    const { root, state, url, id } = await create();
    expect(state).toMatchObject({ enabled: true, phase: 'local_saved', error: null });
    expect(state.localHead).toMatch(/^[0-9a-f]{40}$/);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    expect(git('show', 'HEAD:index.html')).toBe('editable content');
    expect(JSON.parse(git('show', 'HEAD:.open-design/project.json')).name).toBe('Lifecycle project');
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
    const write = (expectedProjectRevision?: number) => fetch(`${url}/api/projects/${id}/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'second.html', content: 'epoch guarded', expectedProjectRevision }),
    });
    expect((await write()).status).toBe(409);
    expect((await write(state.projectRevision)).status).toBe(200);
  });

  it('initializes a duplicate after all copied files and its own conversation exist', async () => {
    const { url, id, state } = await create();
    const response = await fetch(`${url}/api/projects/${id}/duplicate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Independent duplicate', expectedProjectRevision: state.projectRevision }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { project } = await response.json() as { project: { id: string } };
    const copied = await (await fetch(`${url}/api/projects/${project.id}/git`)).json() as ProjectGitState;
    expect(copied).toMatchObject({ enabled: true, error: null });
    const root = join(process.env.OD_DATA_DIR!, 'projects', project.id);
    expect(execFileSync('git', ['-C', root, 'show', 'HEAD:index.html'], { encoding: 'utf8' })).toBe('editable content');
    const snapshot = await (await fetch(`${url}/api/projects/${project.id}/git/commits/${copied.localHead}/conversations`)).json() as { conversations: unknown[] };
    expect(snapshot.conversations).toHaveLength(1);
  });

  it('commits template seed files before reporting default versioning', async () => {
    const { url } = await create();
    const templateId = randomUUID();
    const db = new Database(join(process.env.OD_DATA_DIR!, 'app.sqlite'));
    try { insertTemplate(db, { id: templateId, name: 'Seed', files: [{ name: 'seed.html', content: 'template content' }], createdAt: 1 }); }
    finally { db.close(); }
    const id = `template-${randomUUID()}`;
    const response = await fetch(`${url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'Template project', metadata: { kind: 'template', templateId } }) });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await (await fetch(`${url}/api/projects/${id}/git`)).json()).toMatchObject({ enabled: true, error: null });
    expect(execFileSync('git', ['-C', join(process.env.OD_DATA_DIR!, 'projects', id), 'show', 'HEAD:seed.html'], { encoding: 'utf8' })).toBe('template content');
  });

  it('keeps a missing identity pending without rolling back the created files', async () => {
    const { root, state } = await create({ projectGitEnv: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    expect(state).toMatchObject({ enabled: false, phase: 'enable_pending', error: { code: 'GIT_IDENTITY_REQUIRED' } });
    expect(await readFile(join(root, 'index.html'), 'utf8')).toBe('editable content');
  });

  it('keeps unsupported Orbit metadata editable with actionable pending state before Git initialization', async () => {
    const { url } = await create();
    const id = `orbit-${randomUUID()}`;
    const root = join(process.env.OD_DATA_DIR!, 'projects', id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'index.html'), 'orbit content');
    const response = await fetch(`${url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'Orbit project', metadata: { kind: 'orbit', trigger: 'manual' } }) });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await (await fetch(`${url}/api/projects/${id}/git`)).json()).toMatchObject({
      enabled: false, phase: 'enable_pending', localHead: null,
      error: { code: 'PORTABLE_FORMAT_UNSUPPORTED', details: { nextStep: 'This project type does not support local versioning yet. Continue editing without versioning.' } },
    });
    await expect(readFile(join(root, '.git', 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'index.html'), 'utf8')).toBe('orbit content');
    const edited = await fetch(`${url}/api/projects/${id}/files`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'second.html', content: 'still editable' }) });
    expect(edited.status, await edited.clone().text()).toBe(200);
  });

  it('imports an independent folder but never writes to a containing repository or external orchestrator workspace', async () => {
    const { url } = await create();
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'od-lifecycle-import-'));
    imports.push(fixtureRoot);
    const parent = join(fixtureRoot, 'parent');
    const child = join(parent, 'child');
    await mkdir(child, { recursive: true });
    await writeFile(join(child, 'index.html'), 'import content');
    execFileSync('git', ['init', '--quiet', parent]);
    const importFolder = async (baseDir: string, extra: object = {}) => {
      const response = await fetch(`${url}/api/import/folder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseDir, ...extra }) });
      expect(response.status, await response.clone().text()).toBe(200);
      const { project } = await response.json() as { project: { id: string } };
      return (await fetch(`${url}/api/projects/${project.id}/git`)).json() as Promise<ProjectGitState>;
    };
    const nested = await importFolder(child);
    expect(nested.enabled).toBe(false);
    expect(nested.phase).toBe('enable_pending');
    expect(execFileSync('git', ['-C', parent, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('?? child/\n');
    const external = join(fixtureRoot, 'external');
    await mkdir(external);
    await writeFile(join(external, 'index.html'), 'external content');
    expect(await importFolder(external, { orchestratorWorkspace: { kind: 'scratch', writeback: 'external' } }))
      .toMatchObject({ enabled: false, phase: 'enable_pending', error: { code: 'FORBIDDEN' } });
    await expect(readFile(join(external, '.git', 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
    const independent = join(fixtureRoot, 'independent');
    await mkdir(independent);
    await writeFile(join(independent, 'index.html'), 'independent content');
    expect(await importFolder(independent)).toMatchObject({ enabled: true, localHead: expect.any(String) });
    expect(execFileSync('git', ['-C', independent, 'show', 'HEAD:index.html'], { encoding: 'utf8' })).toBe('independent content');
  });

  it('checkpoints with no page subscriber and preserves old projects and the baseline across repeated startup', async () => {
    const { id, root, state, url } = await create();
    const db = new Database(join(process.env.OD_DATA_DIR!, 'app.sqlite'));
    const oldId = `old-${randomUUID()}`;
    insertProject(db, { id: oldId, name: 'Existing project', createdAt: 1, updatedAt: 1 });
    db.close();
    await writeFile(join(root, 'index.html'), 'external edit');
    await expect.poll(async () => execFileSync('git', ['-C', root, 'show', 'HEAD:index.html'], { encoding: 'utf8' }), { timeout: 12_000 }).toBe('external edit')
      .catch(async error => { throw new Error(`${String(error)}; state=${JSON.stringify(await (await fetch(`${url}/api/projects/${id}/git`)).json())}`); });
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(head).not.toBe(state.localHead);
    expect(await (await fetch(`${url}/api/projects/${oldId}/git`)).json()).toMatchObject({ enabled: false, error: null });
    for (let n = 0; n < 2; n++) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      const started = await startServer({ port: 0, returnServer: true, projectGitEnv: fixtureGitEnv }) as { server: Server; url: string };
      server = started.server;
      expect(await (await fetch(`${started.url}/api/projects/${oldId}/git`)).json()).toMatchObject({ enabled: false, error: null });
      expect(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(head);
    }
  }, 25_000);

  it.each(['succeeded', 'failed', 'canceled'])('drains the %s run checkpoint after final writes and before stopping', async terminal => {
    const data = await mkdtemp(join(tmpdir(), 'od-lifecycle-terminal-'));
    imports.push(data);
    openDatabase(data, { dataDir: data }); closeDatabase();
    const db = new Database(join(data, 'app.sqlite'));
    const root = join(data, 'projects', 'project');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'index.html'), 'before run');
    insertProject(db, { id: 'project', name: 'Terminal project', createdAt: 1, updatedAt: 1 });
    const store = createProjectGitStore(db);
    const { service, coordination } = await createProjectGitServiceComposition({ db, store,
      operationRoot: join(data, 'project-git-operations'), resolveProjectRoot: async () => root,
      gitEnv: fixtureGitEnv, emit: () => {} });
    try {
      await service.start();
      await service.initializeNewProjectGit('project');
      const admission = await coordination.runtime.admit('project', store.getBinding('project')!.projectRevision);
      coordination.runtime.attach('run', 'project', admission, 0);
      await writeFile(join(root, 'index.html'), 'final partial result');
      coordination.runtime.onTerminal('run', 'project', terminal);
      coordination.runtime.onSettled('run');
      await service.stop();
      expect(execFileSync('git', ['-C', root, 'show', 'HEAD:index.html'], { encoding: 'utf8' })).toBe('final partial result');
    } finally { await service.stop(); db.close(); }
  });

  it.each(['succeeded', 'failed', 'canceled'])('initializes a newly created internal project only after its %s initial run settles', async terminal => {
    const data = await mkdtemp(join(tmpdir(), 'od-lifecycle-internal-'));
    imports.push(data);
    openDatabase(data, { dataDir: data }); closeDatabase();
    const db = new Database(join(data, 'app.sqlite'));
    const root = join(data, 'projects', 'internal');
    await mkdir(root, { recursive: true });
    const store = createProjectGitStore(db);
    const { service, coordination } = await createProjectGitServiceComposition({ db, store,
      operationRoot: join(data, 'project-git-operations'), resolveProjectRoot: async () => root,
      gitEnv: fixtureGitEnv, emit: () => {} });
    try {
      await service.start();
      const admission = await coordination.runtime.admit('internal');
      coordination.runtime.attach('run', 'internal', admission, 0);
      insertProject(db, { id: 'internal', name: 'Internal project', createdAt: 1, updatedAt: 1 });
      expect(await Promise.race([
        service.initializeNewProjectGit('internal').then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
      ])).toBe(true);
      await service.initializeNewProjectGit('internal');
      expect(await service.getState('internal')).toMatchObject({ enabled: false, phase: 'enable_pending' });
      await writeFile(join(root, 'index.html'), 'initial run result');
      coordination.runtime.onTerminal('run', 'internal', terminal);
      coordination.runtime.onSettled('run');
      await service.stop();
      expect(execFileSync('git', ['-C', root, 'show', 'HEAD:index.html'], { encoding: 'utf8' })).toBe('initial run result');
      expect(execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('1');
    } finally { coordination.runtime.onSettled('run'); await service.stop(); db.close(); }
  });

  it('replays only durable new-project default intent after startup recovery', async () => {
    const data = await mkdtemp(join(tmpdir(), 'od-lifecycle-restart-'));
    imports.push(data);
    openDatabase(data, { dataDir: data }); closeDatabase();
    const db = new Database(join(data, 'app.sqlite'));
    const root = join(data, 'projects', 'internal');
    await mkdir(root, { recursive: true });
    const store = createProjectGitStore(db);
    const input = { db, store, instanceId: randomUUID(), operationRoot: join(data, 'project-git-operations'),
      resolveProjectRoot: async () => root, gitEnv: fixtureGitEnv, emit: () => {} };
    let composition = await createProjectGitServiceComposition(input);
    try {
      await composition.service.start();
      const admission = await composition.coordination.runtime.admit('internal');
      composition.coordination.runtime.attach('interrupted', 'internal', admission, 0);
      insertProject(db, { id: 'internal', name: 'Interrupted project', createdAt: 1, updatedAt: 1 });
      insertProject(db, { id: 'old', name: 'Old project', createdAt: 1, updatedAt: 1 });
      await writeFile(join(root, 'index.html'), 'retained partial result');
      const legacyRoot = join(root, '.file-versions', 'old');
      await mkdir(legacyRoot, { recursive: true });
      const originalManifest = '{"entries":[{"contentPath":"one.html"}]}';
      await writeFile(join(legacyRoot, 'manifest.json'), originalManifest);
      await writeFile(join(legacyRoot, 'one.html'), 'old history');
      await composition.service.initializeNewProjectGit('internal');
      await composition.service.stop();
      composition = await createProjectGitServiceComposition(input);
      await composition.service.start();
      expect(await composition.service.getState('internal')).toMatchObject({ enabled: true, error: null });
      expect(await composition.service.getState('old')).toMatchObject({ enabled: false, error: null });
      expect(execFileSync('git', ['-C', root, 'show', 'HEAD:index.html'], { encoding: 'utf8' })).toBe('retained partial result');
      const archived = join(root, '.open-design', 'legacy-file-history', 'old', 'manifest.json');
      expect(await readFile(archived, 'utf8')).toBe(originalManifest);
      const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      const advancedManifest = '{"entries":[{"contentPath":"one.html"},{"contentPath":"two.html"}]}';
      await writeFile(join(legacyRoot, 'manifest.json'), advancedManifest);
      await writeFile(join(legacyRoot, 'two.html'), 'later native history');
      await composition.service.stop();
      composition = await createProjectGitServiceComposition(input);
      await composition.service.start();
      expect(await readFile(archived, 'utf8')).toBe(originalManifest);
      expect(await readFile(join(legacyRoot, 'manifest.json'), 'utf8')).toBe(advancedManifest);
      expect(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(head);
    } finally { await composition.service.stop(); db.close(); }
  });
});
