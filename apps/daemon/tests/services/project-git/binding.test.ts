import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { chmod, mkdir, writeFile, access, symlink } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { GitDomainError } from '../../../src/services/project-git/errors.js';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { classifyBinding, validateBindingConfirmation, inspectBindingCommit, prepareIndependentBinding, createProjectGitBindingService } from '../../../src/services/project-git/binding.js';
import { createProjectGitStore } from '../../../src/storage/project-git.js';
import { closeDatabase, openDatabase, insertProject, getProject, listProjects } from '../../../src/db.js';
import { createProjectGitScheduler } from '../../../src/services/project-git/scheduler.js';
import { createProjectGitSyncDeps, syncProject, type ProjectGitSyncProject } from '../../../src/services/project-git/sync.js';
import { getProjectGate, getUnmanagedProjectGate } from '../../../src/services/project-git/gate.js';
import { getRepositoryOwnerDomain } from '../../../src/services/project-git/repository-lease.js';
import { createGitFixture } from '../../helpers/project-git.js';
import { portableSnapshot, writeFixtureEntries, fixtureCommit, fixtureGitEnv } from '../../helpers/project-git-crash-worker.js';
import { serializePortableMetadata } from '../../../src/services/project-git/portable.js';
import * as gitProcess from '../../../src/services/project-git/git-process.js';

const cleanups: (() => Promise<void>)[] = [];
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function serviceFixture(transport: 'writable' | 'readonly' | 'denied' = 'writable',
  resolveAvailability: (request: { actorId: string; kind: 'agent' | 'model' | 'plugin' | 'linked_folder'; id: string }) => Promise<boolean> = async () => true) {
  const f = await createGitFixture();
  const data = join(f.root, 'data'); const operationRoot = join(data, 'operations');
  const preparationRoot = join(data, 'preparation'); const ownedProjectsRoot = join(data, 'projects');
  await mkdir(operationRoot, { recursive: true }); await mkdir(preparationRoot); await mkdir(ownedProjectsRoot);
  openDatabase(data, { dataDir: data }); closeDatabase(); const db = new Database(join(data, 'app.sqlite'));
  const store = createProjectGitStore(db); const bin = join(f.root, 'bin'); await mkdir(bin);
  const denied = "echo 'Permission denied' >&2; exit 1";
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\nunset GIT_DIR GIT_OBJECT_DIRECTORY\n${transport === 'denied' ? denied : ''}\ncase "$*" in *git-receive-pack*) ${transport === 'readonly' ? denied : `exec git receive-pack '${f.remote}'`};; *) exec git upload-pack '${f.remote}';; esac\n`);
  await chmod(join(bin, 'ssh'), 0o700);
  const gitEnv = { ...fixtureGitEnv, PATH: `${bin}:${process.env.PATH}` };
  const registry = new Map<string, ProjectGitSyncProject>();
  const deniedProjects = new Set<string>();
  const resolveProject = (id: string) => { const project = registry.get(id); if (!project) throw new Error('Unregistered fixture project'); return project; };
  const ownership = { instanceId: 'binding-fixture', ownerDomain: await getRepositoryOwnerDomain() ?? 'fixture-domain', dataRootId: data };
  const deps = createProjectGitSyncDeps({ db, store, operationRoot, preparationRoot, resolveProject, now: () => 100_000, random: () => 0.5 });
  const scheduler = createProjectGitScheduler({ store, now: deps.now, random: deps.random, detect: deps.detect,
    sync: (projectId, oneShot) => syncProject({ projectId, oneShot, deps }) });
  const service = createProjectGitBindingService({ db, store, operationRoot, preparationRoot, ownedProjectsRoot, ownership, scheduler,
    checkpointCurrent: deps.checkpoint, recoveryReady: deps.recoveryReady, resolveAvailability,
    resolveProject, requireProject: (actor: string, id: string) => { if (actor !== 'local' || deniedProjects.has(id) || !getProject(db, id)) throw new Error('Not authorized'); },
    requireCreate: (actor: string) => { if (actor !== 'local') throw new Error('Not authorized'); },
    reserveProject: ({ projectId, root, localBranch, gate }: { projectId: string; root: string; localBranch: string; gate: ProjectGitSyncProject['gate'] }) => {
      const prior = registry.get(projectId);
      if (prior && (prior.root !== root || prior.gate !== gate || prior.branch !== localBranch)) throw new Error('Conflicting reservation');
      registry.set(projectId, { root, branch: localBranch, gate, gitEnv });
      return () => { if (!prior) registry.delete(projectId); };
    }, now: deps.now, newId: randomUUID, gitEnv });
  cleanups.push(async () => { await scheduler.stop(); if (db.open) db.close(); await f.close(); });
  async function existing(managedGit = false) {
    const root = join(f.root, 'unmanaged'); await mkdir(root); await writeFile(join(root, 'index.html'), 'user file');
    insertProject(db, { id: 'existing', name: 'Existing', createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype', baseDir: root } });
    if (managedGit) await gitProcess.initializeRepository({ root, initialBranch: 'main', objectFormat: 'sha1', env: gitEnv });
    registry.set('existing', { root, branch: 'main', gate: await (managedGit ? getProjectGate : getUnmanagedProjectGate)({ root, ...ownership }), gitEnv });
    return root;
  }
  return { f, db, store, service, registry, existing, scheduler, deps, deniedProjects,
    configuration: { data, operationRoot, preparationRoot, ownedProjectsRoot, ownership, gitEnv } };
}

it('previews without initializing the user root, then enables the same captured DB and files without a baseline advance', async () => {
  const { f, db, store, service, existing } = await serviceFixture(); const root = await existing();
  const preview = await service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'preview' });
  await expect(access(join(root, '.git'))).rejects.toBeDefined();
  expect(preview.result?.preview).toMatchObject({ kind: 'enable', basis: { bindingGeneration: 0, projectRevision: 0 } });
  const operation = await service.enable('existing', preview.result!.preview!.id, { actorId: 'local', idempotencyKey: 'enable', expectedProjectRevision: 0 });
  expect(operation).toMatchObject({ kind: 'enable', status: 'succeeded', basis: { bindingGeneration: 0 } });
  expect(store.getBinding('existing')).toMatchObject({ projectRevision: 0, remoteUrl: null });
  expect(getProject(db, 'existing')!.name).toBe('Existing');
  expect(await f.git(root, 'show', 'HEAD:index.html')).toBe('user file');
  expect(await service.enable('existing', preview.result!.preview!.id, { actorId: 'local', idempotencyKey: 'enable', expectedProjectRevision: 0 })).toEqual(operation);
});

it('previews the selected remote deletion before applying that exact tree', async () => {
  const { f, service, existing } = await serviceFixture(); const root = await existing();
  await writeFile(join(root, 'obsolete.txt'), 'old'); const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const p = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  await service.enable('existing', p.id, { ...ctx, idempotencyKey: 'e' });
  await f.git(root, 'push', f.remote, 'HEAD:main'); await f.git(f.a, 'pull', '--ff-only', 'origin', 'main');
  await f.git(f.a, 'rm', 'obsolete.txt'); await f.git(f.a, 'commit', '-m', 'delete'); await f.git(f.a, 'push', 'origin', 'HEAD:main');
  const preview = await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'main', { ...ctx, idempotencyKey: 'p-bind' });
  expect(preview.result!.preview!.changes).toMatchObject({ addedPaths: [], modifiedPaths: [], deletedPaths: ['obsolete.txt'], settingsChanged: 0, conversationsChanged: 0 });
  expect(await service.bind('existing', preview.id, { ...ctx, idempotencyKey: 'b' })).toMatchObject({ status: 'succeeded' });
  await expect(access(join(root, 'obsolete.txt'))).rejects.toBeDefined();
});

it('offers both explicit metadata sources for equal portable heads above a genuine plain merge base', async () => {
  const { f, service, existing } = await serviceFixture(); const root = await existing(true);
  await f.git(root, 'add', '.'); await f.git(root, 'commit', '-m', 'plain base');
  await f.git(root, 'push', f.remote, 'HEAD:main'); await f.git(f.b, 'pull', '--ff-only', 'origin', 'main');
  const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const p = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  await service.enable('existing', p.id, { ...ctx, idempotencyKey: 'e' });
  await fs.cp(join(root, '.open-design'), join(f.b, '.open-design'), { recursive: true });
  await writeFile(join(f.b, 'remote.html'), 'remote'); await f.git(f.b, 'add', '.'); await f.git(f.b, 'commit', '-m', 'equal metadata');
  await f.git(f.b, 'push', 'origin', 'HEAD:main');
  const preview = await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'main', { ...ctx, idempotencyKey: 'p-bind' });
  expect(preview.result!.preview!.binding!.metadataSources).toEqual(['local', 'remote']);
  await expect(service.bind('existing', preview.id, { ...ctx, idempotencyKey: 'implicit' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await service.bind('existing', preview.id, { ...ctx, idempotencyKey: 'explicit', confirmation: { metadataSource: 'local' } })).toMatchObject({ status: 'succeeded' });
});

it('reports a private directory without traversing it or reading its bytes', async () => {
  const { service, existing } = await serviceFixture(); const root = await existing();
  await mkdir(join(root, '.ssh')); await writeFile(join(root, '.ssh', 'key'), 'FIXTURE_PRIVATE_ONLY');
  const openOriginal = fs.open; const readdirOriginal = fs.readdir;
  vi.spyOn(fs, 'open').mockImplementation((...args) => {
    if (String(args[0]).startsWith(join(root, '.ssh'))) throw new Error('private read');
    return openOriginal(...args);
  });
  vi.spyOn(fs, 'readdir').mockImplementation((...args) => {
    if (String(args[0]).startsWith(join(root, '.ssh'))) throw new Error('private traversal');
    return readdirOriginal(...args);
  });
  const op = await service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'private' });
  expect(op.result!.preview!.changes.privatePaths).toEqual(['.ssh']);
  await expect(service.enable('existing', op.id, { actorId: 'local', idempotencyKey: 'confirm' })).rejects.toBeDefined();
  await expect(access(join(root, '.git'))).rejects.toBeDefined();
});

it('rolls back first-enable admission before registration and converges the original consumer on retry', async () => {
  const { service, store, existing, registry } = await serviceFixture(); await existing();
  const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const preview = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  const fault = vi.spyOn(store, 'prepareRegistration').mockImplementationOnce(() => { throw new Error('before registration'); });
  const request = { ...ctx, idempotencyKey: 'e' };
  await expect(service.enable('existing', preview.id, request)).rejects.toThrow('before registration'); fault.mockRestore();
  expect(store.getBinding('existing')).toBeNull(); expect(store.listPendingRegistrations()).toEqual([]);
  expect(await registry.get('existing')!.gate.mutate(async () => 'editable')).toBe('editable');
  const original = store.findOperation({ actorId: 'local', projectId: 'existing', kind: 'enable', idempotencyKey: 'e' })!;
  expect(await service.enable('existing', preview.id, request)).toMatchObject({ id: original.id, status: 'succeeded' });
});

it('coalesces identical concurrent enable calls into the same durable result', async () => {
  const { service, existing, store } = await serviceFixture(); await existing();
  const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const preview = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  const request = { ...ctx, idempotencyKey: 'e' };
  const results = await Promise.all([service.enable('existing', preview.id, request), service.enable('existing', preview.id, request)]);
  expect(results[0]).toEqual(results[1]); expect(results[0]!.status).toBe('succeeded');
  expect(store.listBindings()).toHaveLength(1);
});

it('keeps ordinary unmanaged mutations available when Git disappears after registration of the stable gate', async () => {
  const { service, existing, registry, f } = await serviceFixture(); const root = await existing();
  const noGit = join(f.root, 'no-git'); await mkdir(noGit); const oldPath = process.env.PATH;
  try {
    process.env.PATH = noGit;
    const preview = await service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'git-missing' });
    expect(preview.result!.preview!.dependencies).toContainEqual(expect.objectContaining({ kind: 'git', requiredForContent: false }));
    await registry.get('existing')!.gate.mutate(() => writeFile(join(root, 'edited.html'), 'ordinary edit'));
    expect(await fs.readFile(join(root, 'edited.html'), 'utf8')).toBe('ordinary edit');
    await mkdir(join(root, '.git'));
    await expect(registry.get('existing')!.gate.mutate(async () => {})).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  } finally { process.env.PATH = oldPath; }
});

it('admits identical concurrent opens before allocating exactly one owned root', async () => {
  const { service, configuration, store } = await serviceFixture();
  const request = { actorId: 'local', idempotencyKey: 'open', url: 'ssh://git@example.invalid/repo', branch: 'main' };
  const results = await Promise.all([service.openRepository(request), service.openRepository(request)]);
  expect(results[0]).toEqual(results[1]); expect(results[0]!.status).toBe('succeeded');
  expect(await fs.readdir(configuration.ownedProjectsRoot)).toEqual([results[0]!.result!.projectId]);
  expect(store.listBindings()).toHaveLength(1);
});

it.each(['plain', 'empty'])('freezes the %s open identity and candidate across pre-registration retries', async mode => {
  const { f, service, store } = await serviceFixture();
  if (mode === 'plain') { await writeFile(join(f.a, 'index.html'), 'plain'); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'plain'); await f.git(f.a, 'push', 'origin', 'HEAD:main'); }
  const candidates: string[] = []; const identities: string[] = []; const clones: string[] = [];
  const fault = vi.spyOn(store, 'prepareRegistration').mockImplementation(intent => {
    candidates.push(intent.initialImport!.candidateOid); identities.push(intent.repositoryProjectId); clones.push(intent.cloneId);
    throw new Error('before registration');
  });
  const request = { actorId: 'local', idempotencyKey: 'open', url: 'ssh://git@example.invalid/repo', branch: 'main' };
  await expect(service.openRepository(request)).rejects.toThrow('before registration');
  await expect(service.openRepository(request)).rejects.toThrow('before registration'); fault.mockRestore();
  expect(candidates[0]).toBe(candidates[1]); expect(identities[0]).toBe(identities[1]); expect(clones[0]).toBe(clones[1]);
  const complete = await service.openRepository(request);
  expect(complete).toMatchObject({ status: 'succeeded', result: { head: candidates[0] } });
  expect(store.getBinding(complete.result!.projectId!)!).toMatchObject({ repositoryProjectId: identities[0], cloneId: clones[0] });
});

it('rejects a private reserved resource by path before the exporter can read its bytes', async () => {
  const { service, existing } = await serviceFixture(); const root = await existing();
  const bytes = Buffer.from('FIXTURE_PRIVATE_RESOURCE'); const digest = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const path = `.open-design/resources/${digest}/config.yaml`;
  const entries = serializePortableMetadata(portableSnapshot('Before'));
  entries.set('.open-design/manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 1, repositoryProjectId: 'repository',
    resources: [{ digest, locations: [{ path, purpose: 'attachment' }], references: [] }] }))); entries.set(path, bytes);
  await writeFixtureEntries(root, entries);
  const original = fs.open; let reads = 0;
  vi.spyOn(fs, 'open').mockImplementation((...args) => {
    if (String(args[0]) === join(root, path)) { reads++; throw new Error('private bytes read'); }
    return original(...args);
  });
  await expect(service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'private-resource' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(reads).toBe(0);
});

it('enables existing portable file history using its actual repository identity and original parent', async () => {
  const { service, existing, f, store } = await serviceFixture(); const root = await existing(true);
  await writeFixtureEntries(root, serializePortableMetadata(portableSnapshot('Before')));
  await f.git(root, 'add', '.'); await f.git(root, 'commit', '-m', 'existing portable files'); const head = await f.git(root, 'rev-parse', 'HEAD');
  const preview = await service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'preview' });
  const result = await service.enable('existing', preview.id, { actorId: 'local', idempotencyKey: 'enable', expectedProjectRevision: 0 });
  expect(result.status).toBe('succeeded'); const b = store.getBinding('existing')!;
  expect(b.repositoryProjectId).toBe('repository');
  expect(await f.git(root, 'rev-list', '--parents', '--max-count=1', 'HEAD')).toBe(`${b.localHead} ${head}`);
});

it('reports symlink content as a dependency and applies nested gitignore rules without copying ignored bytes', async () => {
  const { f, service, existing } = await serviceFixture(); const root = await existing();
  await mkdir(join(root, 'nested')); await writeFile(join(root, 'nested', '.gitignore'), '*.tmp\n!keep.tmp\n');
  await writeFile(join(root, 'nested', 'ignore.tmp'), 'ignored fixture'); await writeFile(join(root, 'nested', 'keep.tmp'), 'kept fixture');
  await symlink(f.a, join(root, 'linked'));
  const original = fs.open;
  vi.spyOn(fs, 'open').mockImplementation((...args) => {
    if (String(args[0]) === join(root, 'nested', 'ignore.tmp')) throw new Error('ignored bytes copied');
    return original(...args);
  });
  const op = await service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'paths' });
  expect(op.result!.preview!.changes.ignoredPaths).toContain('nested/ignore.tmp');
  expect(op.result!.preview!.changes.addedPaths).toContain('nested/keep.tmp');
  expect(op.result!.preview!.dependencies).toContainEqual({ kind: 'resource', label: 'linked', requiredForContent: true, nextStep: null });
});

it.each(['GIT_UNAVAILABLE', 'GIT_IDENTITY_REQUIRED'] as const)('returns %s as a dependency without initializing or claiming the user root', async code => {
  const { service, existing, store } = await serviceFixture(); const root = await existing();
  if (code === 'GIT_UNAVAILABLE') vi.spyOn(gitProcess, 'runGit').mockRejectedValue(new GitDomainError(code, 409, 'Fixture Git unavailable'));
  else vi.spyOn(gitProcess, 'assertGitIdentity').mockRejectedValue(new GitDomainError(code, 409, 'Fixture identity missing'));
  const op = await service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'dependency' });
  expect(op.result!.preview!.dependencies.map(item => item.kind)).toContain(code === 'GIT_UNAVAILABLE' ? 'git' : 'identity');
  await expect(access(join(root, '.git'))).rejects.toBeDefined();
  expect(store.getBinding('existing')).toBeNull();
});

it('opens a validated portable remote at its exact tip with one visible project for the original idempotency key', async () => {
  const { f, db, store, service } = await serviceFixture();
  const entries = serializePortableMetadata(portableSnapshot('After')); entries.set('index.html', Buffer.from('remote source'));
  await writeFixtureEntries(f.a, entries); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'portable');
  await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main'); const tip = await f.git(f.a, 'rev-parse', 'HEAD');
  const request = { url: 'ssh://git@example.invalid/repo', branch: 'main', actorId: 'local', idempotencyKey: 'open' };
  const operation = await service.openRepository(request);
  expect(operation).toMatchObject({ kind: 'open', status: 'succeeded' });
  expect(listProjects(db)).toHaveLength(1);
  expect(store.getBinding(operation.result!.projectId!)!.localHead).toBe(tip);
  expect(await service.openRepository(request)).toEqual(operation);
  expect(listProjects(db)).toHaveLength(1);
});

it.each((['agent', 'model', 'plugin', 'linked_folder'] as const).flatMap(kind => [[kind, false], [kind, true]] as const))('reports %s availability with resolver error=%s before visible registration', async (kind, failed) => {
  const resolver = vi.fn(async () => { if (failed) throw new Error('/private/runtime/diagnostic'); return false; });
  const { f, service, db, store, configuration } = await serviceFixture('writable', resolver);
  const snapshot = portableSnapshot('After');
  const label = 'logical-fixture'; const bytes = Buffer.from('portable plugin'); const digest = createHash('sha256').update(bytes).digest('hex');
  if (kind === 'agent') { snapshot.project.preferences.agentId = label; snapshot.conversations[0]!.preferences = { agentId: label }; }
  if (kind === 'model') { snapshot.project.preferences.model = label; snapshot.conversations[0]!.preferences = { model: label }; }
  if (kind === 'linked_folder') snapshot.project.linkedFolderRequirements = [{ label, purpose: 'reference' }];
  if (kind === 'plugin') { snapshot.project.contentRefs = [digest]; snapshot.manifest.resources = [{ digest,
    locations: [{ path: `.open-design/resources/${digest}/plugin.txt`, purpose: 'plugin', sourceLabel: label }], references: ['repository'] }]; }
  const entries = serializePortableMetadata(snapshot); if (kind === 'plugin') entries.set(`.open-design/resources/${digest}/plugin.txt`, bytes);
  await writeFixtureEntries(f.a, entries); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'dependencies');
  await f.git(f.a, 'push', 'origin', 'HEAD:main');
  const request = { actorId: 'local', idempotencyKey: 'availability', url: 'ssh://git@example.invalid/repo', branch: 'main' };
  const operation = await service.openRepository(request);
  expect(resolver).toHaveBeenCalledExactlyOnceWith({ actorId: 'local', kind, id: label });
  expect(operation.result!.dependencies).toEqual([{ kind, label, requiredForContent: kind === 'linked_folder',
    nextStep: { action: failed ? 'retry' : kind === 'linked_folder' ? 'locate_folder' : 'install_dependency', label } }]);
  expect(operation.status).toBe(kind === 'linked_folder' || failed ? 'failed' : 'succeeded');
  expect(listProjects(db)).toHaveLength(operation.status === 'succeeded' ? 1 : 0);
  expect(JSON.stringify(operation)).not.toContain('/private/');
  if (operation.status === 'succeeded') {
    expect(store.getRegistration(operation.id)!.dependencies).toEqual(operation.result!.dependencies);
    expect(await service.openRepository(request)).toEqual(operation); expect(resolver).toHaveBeenCalledOnce();
    const reopened = new Database(join(configuration.data, 'app.sqlite')); const restored = createProjectGitStore(reopened);
    const { state: _state, ...intent } = restored.getRegistration(operation.id)!;
    reopened.transaction(() => restored.completeRegistration(intent)).immediate();
    expect(restored.getOperation(operation.id)).toEqual(operation); reopened.close();
  } else expect(store.getRegistration(operation.id)).toBeNull();
});

it('freezes full deterministic dependency lists from project and conversation preferences in previews', async () => {
  const resolver = vi.fn(async () => false); const { service, db, existing } = await serviceFixture('writable', resolver); const root = await existing();
  db.prepare('UPDATE projects SET metadata_json=? WHERE id=?').run(JSON.stringify({ kind: 'prototype', baseDir: root,
    agentId: 'z-agent', model: 'a-model', linkedDirs: ['/original-machine/folder-label'] }), 'existing');
  const preview = await service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'dependencies' });
  expect(preview.result!.preview!.dependencies.map(item => [item.kind, item.label])).toEqual([
    ['agent', 'z-agent'], ['linked_folder', 'folder-label'], ['model', 'a-model'],
  ]);
  expect(JSON.stringify(preview)).not.toContain('/original-machine/');
});

it('rejects registration fields inconsistent with the durable open candidate and receipt', async () => {
  const { service, store } = await serviceFixture(); const prepare = store.prepareRegistration;
  const freeze = store.freezeOpenPreparation;
  vi.spyOn(store, 'freezeOpenPreparation').mockImplementation((id, preparation) => {
    if (preparation.candidate) {
      const candidate = preparation.candidate; const canonicalSnapshotJson = JSON.stringify(JSON.parse(candidate.canonicalSnapshotJson), null, 2);
      expect(() => freeze(id, { candidate: { ...candidate, canonicalSnapshotJson,
        snapshotDigest: createHash('sha256').update(canonicalSnapshotJson).digest('hex') } })).toThrow();
    }
    freeze(id, preparation);
  });
  const checked = vi.spyOn(store, 'prepareRegistration').mockImplementation(intent => {
    expect(() => prepare({ ...intent, initialImport: { ...intent.initialImport!, candidateOid: 'a'.repeat(40) } })).toThrow();
    expect(() => prepare({ ...intent, initialImport: { ...intent.initialImport!, rootIno: '0' } })).toThrow();
    expect(() => prepare({ ...intent, dependencies: [{ kind: 'linked_folder', label: 'folder', requiredForContent: true, nextStep: { action: 'locate_folder', label: 'folder' } }] })).toThrow();
    expect(() => prepare({ ...intent, dependencies: [{ kind: 'agent', label: 'not-in-snapshot', requiredForContent: false,
      nextStep: { action: 'install_dependency', label: 'not-in-snapshot' } }] })).toThrow();
    prepare(intent);
  });
  expect(await service.openRepository({ actorId: 'local', idempotencyKey: 'integrity', url: 'ssh://git@example.invalid/repo', branch: 'main' })).toMatchObject({ status: 'succeeded' });
  expect(checked).toHaveBeenCalledOnce();
});

it('adds complete portable metadata to a plain remote as a real child of its original tip', async () => {
  const { f, db, store, service } = await serviceFixture();
  await writeFile(join(f.a, 'index.html'), 'plain source'); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'plain');
  await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main'); const parent = await f.git(f.a, 'rev-parse', 'HEAD');
  const op = await service.openRepository({ url: 'ssh://git@example.invalid/repo', branch: 'main', actorId: 'local', idempotencyKey: 'plain' });
  const binding = store.getBinding(op.result!.projectId!)!;
  expect(await f.git(binding.canonicalRoot, 'rev-list', '--parents', '--max-count=1', 'HEAD')).toBe(`${binding.localHead} ${parent}`);
  expect((await inspectBindingCommit(binding.canonicalRoot, binding.localHead!)).snapshot).not.toBeNull();
  expect(listProjects(db)).toHaveLength(1);
});

it('opens independent clones and reports only authorized existing copies of the same portable project', async () => {
  const { f, service, store, deniedProjects } = await serviceFixture();
  await writeFixtureEntries(f.a, serializePortableMetadata(portableSnapshot('After')));
  await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'portable'); await f.git(f.a, 'push', 'origin', 'HEAD:main');
  const request = { url: 'ssh://git@example.invalid/repo', branch: 'main', actorId: 'local', idempotencyKey: 'first' };
  const first = await service.openRepository(request); const firstId = first.result!.projectId!;
  const prepare = store.prepareRegistration;
  const validation = vi.spyOn(store, 'prepareRegistration').mockImplementation(intent => {
    for (const ids of [[firstId, firstId], [intent.projectId], ['missing-project']]) {
      expect(() => prepare({ ...intent, existingProjectIds: ids })).toThrow();
    }
    prepare(intent);
  });
  const second = await service.openRepository({ ...request, idempotencyKey: 'second' }); const secondId = second.result!.projectId!;
  validation.mockRestore();
  expect(secondId).not.toBe(firstId);
  expect(second.result).toMatchObject({ existingProjectIds: [firstId] });
  expect(store.getBinding(secondId)!.cloneId).not.toBe(store.getBinding(firstId)!.cloneId);
  expect(store.getBinding(secondId)!.canonicalRoot).not.toBe(store.getBinding(firstId)!.canonicalRoot);
  expect(await service.openRepository({ ...request, idempotencyKey: 'second' })).toEqual(second);
  deniedProjects.add(firstId);
  const third = await service.openRepository({ ...request, idempotencyKey: 'third' });
  expect(third.result).toMatchObject({ existingProjectIds: [secondId] });
  expect(store.listBindings()).toHaveLength(3);
});

it('replays the frozen authorized copy list and omits a copy removed before terminal registration', async () => {
  const { f, service, store, db } = await serviceFixture();
  await writeFixtureEntries(f.a, serializePortableMetadata(portableSnapshot('After')));
  await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'portable'); await f.git(f.a, 'push', 'origin', 'HEAD:main');
  const request = { url: 'ssh://git@example.invalid/repo', branch: 'main', actorId: 'local', idempotencyKey: 'first' };
  const first = await service.openRepository(request); const firstId = first.result!.projectId!;
  const run = gitProcess.runGit; let crashed = false;
  const fault = vi.spyOn(gitProcess, 'runGit').mockImplementation(async args => {
    const result = await run(args);
    if (!crashed && args.args[0] === 'update-ref' && args.stdin?.toString().includes('refs/open-design/bindings/')) {
      crashed = true; throw new Error('copy fixture interrupted');
    }
    return result;
  });
  const secondRequest = { ...request, idempotencyKey: 'second' };
  await expect(service.openRepository(secondRequest)).rejects.toThrow('copy fixture interrupted'); fault.mockRestore();
  const pending = store.findOperation({ projectId: null, actorId: 'local', kind: 'open', idempotencyKey: 'second' })!;
  expect(store.getRegistration(pending.id)!.existingProjectIds).toEqual([firstId]);
  db.prepare('DELETE FROM projects WHERE id = ?').run(firstId);
  const complete = await service.openRepository(secondRequest);
  expect(complete).toMatchObject({ id: pending.id, status: 'succeeded', result: { existingProjectIds: [] } });
  expect(store.getRegistration(pending.id)!.existingProjectIds).toEqual([firstId]);
  expect(await service.openRepository(secondRequest)).toEqual(complete);
});

it('opens a readable remote without claiming push authorization and retains local saves when push is denied', async () => {
  const { f, service, store, deps } = await serviceFixture('readonly');
  await writeFixtureEntries(f.a, serializePortableMetadata(portableSnapshot('After')));
  await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'readable'); await f.git(f.a, 'push', 'origin', 'HEAD:main');
  const tip = await f.git(f.a, 'rev-parse', 'HEAD');
  const opened = await service.openRepository({ url: 'ssh://git@example.invalid/repo', branch: 'main', actorId: 'local', idempotencyKey: 'readonly' });
  const id = opened.result!.projectId!; const root = store.getBinding(id)!.canonicalRoot;
  await writeFile(join(root, 'index.html'), 'saved locally');
  await expect(syncProject({ projectId: id, oneShot: true, deps })).rejects.toMatchObject({ code: 'GIT_AUTH_REQUIRED' });
  expect(await f.git(root, 'show', 'HEAD:index.html')).toBe('saved locally');
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(tip);
  expect(store.listPendingOperations()).toContainEqual(expect.objectContaining({ phase: 'auth_required' }));
});

it('retains an authentication failure as an operation without exposing an imported project', async () => {
  const { service, store, db } = await serviceFixture('denied');
  await expect(service.openRepository({ url: 'ssh://git@example.invalid/repo', branch: 'main', actorId: 'local', idempotencyKey: 'denied' }))
    .resolves.toMatchObject({ kind: 'open', status: 'failed', error: { code: 'GIT_AUTH_REQUIRED' } });
  expect(listProjects(db)).toEqual([]); expect(store.listBindings()).toEqual([]);
  expect(store.findOperation({ actorId: 'local', projectId: null, kind: 'open', idempotencyKey: 'denied' }))
    .toMatchObject({ status: 'failed', error: { code: 'GIT_AUTH_REQUIRED' } });
});

it('refuses a different portable project at confirmation without changing local history or consuming the preview', async () => {
  const { f, service, existing, store } = await serviceFixture(); const root = await existing();
  const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const enable = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  await service.enable('existing', enable.id, { ...ctx, idempotencyKey: 'e' });
  const head = await f.git(root, 'rev-parse', 'HEAD');
  await writeFixtureEntries(f.a, serializePortableMetadata(portableSnapshot('After')));
  await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'other project'); await f.git(f.a, 'push', 'origin', 'HEAD:main');
  const preview = await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'main', { ...ctx, idempotencyKey: 'bp' });
  expect(preview.result!.preview!.binding!.classification).toBe('different_project');
  await expect(service.bind('existing', preview.id, { ...ctx, idempotencyKey: 'b' })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(store.findOperation({ actorId: 'local', projectId: 'existing', kind: 'bind', idempotencyKey: 'b' })).toBeNull();
  expect(await f.git(root, 'rev-parse', 'HEAD')).toBe(head); expect(store.getBinding('existing')!.generation).toBe(1);
});

it.each(['local', 'remote'])('rejects %s edits after the binding preview before consumption or owner changes', async side => {
  const { f, service, existing, store } = await serviceFixture(); const root = await existing();
  const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const enable = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  await service.enable('existing', enable.id, { ...ctx, idempotencyKey: 'e' });
  const refs = await f.git(root, 'show-ref');
  const preview = await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'main', { ...ctx, idempotencyKey: 'bp' });
  if (side === 'local') await writeFile(join(root, 'index.html'), 'external edit');
  else { await writeFile(join(f.a, 'remote.html'), 'new remote'); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'remote changed'); await f.git(f.a, 'push', 'origin', 'HEAD:main'); }
  await expect(service.bind('existing', preview.id, { ...ctx, idempotencyKey: 'b' })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(store.findOperation({ actorId: 'local', projectId: 'existing', kind: 'bind', idempotencyKey: 'b' })).toBeNull();
  expect(await f.git(root, 'show-ref')).toBe(refs); expect(store.getBinding('existing')!.generation).toBe(1);
});

it.each(['private', 'lfs', 'submodule', 'unknown-schema', 'missing-resource'])('retains only failed operation evidence for unsafe %s imports', async fault => {
  const { f, db, store, service } = await serviceFixture();
  const entries = serializePortableMetadata(portableSnapshot('Before')); entries.set('index.html', Buffer.from('safe'));
  if (fault === 'private') entries.set('.env', Buffer.from('FIXTURE_PRIVATE_VALUE'));
  if (fault === 'lfs') entries.set('asset.bin', Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${'1'.repeat(64)}\nsize 42\n`));
  if (fault === 'unknown-schema') entries.set('.open-design/manifest.json', Buffer.from('{"schemaVersion":2,"repositoryProjectId":"repository","resources":[]}'));
  if (fault === 'missing-resource') entries.set('.open-design/manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 1, repositoryProjectId: 'repository',
    resources: [{ digest: '1'.repeat(64), locations: [{ path: `.open-design/resources/${'1'.repeat(64)}/missing.bin`, purpose: 'attachment' }], references: [] }] })));
  await writeFixtureEntries(f.a, entries); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'unsafe fixture');
  if (fault === 'submodule') { const oid = await f.git(f.a, 'rev-parse', 'HEAD');
    await f.git(f.a, 'update-index', '--add', '--cacheinfo', `160000,${oid},linked`); await f.git(f.a, 'commit', '-m', 'submodule fixture'); }
  await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main');
  const request = { url: 'ssh://git@example.invalid/repo', branch: 'main', actorId: 'local', idempotencyKey: 'unsafe' };
  const original = gitProcess.runGit; let blobReads = 0;
  vi.spyOn(gitProcess, 'runGit').mockImplementation(async args => {
    if (args.args[0] === 'cat-file' && args.args[1] !== '-t') blobReads++;
    return original(args);
  });
  await expect(service.openRepository(request)).resolves.toMatchObject({ kind: 'open', status: 'failed' });
  expect(listProjects(db)).toEqual([]); expect(store.listBindings()).toEqual([]);
  const op = store.findOperation({ projectId: null, actorId: 'local', kind: 'open', idempotencyKey: 'unsafe' })!;
  expect(op.status).toBe('failed');
  if (fault === 'private' || fault === 'submodule') expect(blobReads).toBe(0);
  if (['lfs', 'submodule', 'missing-resource'].includes(fault)) {
    expect(op.result?.dependencies).toContainEqual(expect.objectContaining({ kind: fault === 'missing-resource' ? 'resource' : fault, requiredForContent: true }));
  }
});

it('retries a claimed phase-null open using the original tip even if the remote advances', async () => {
  const { f, db, store, service } = await serviceFixture();
  const entries = serializePortableMetadata(portableSnapshot('After')); entries.set('index.html', Buffer.from('original'));
  await writeFixtureEntries(f.a, entries); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'original');
  await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main'); const originalTip = await f.git(f.a, 'rev-parse', 'HEAD');
  const run = gitProcess.runGit; let injected = false;
  const fault = vi.spyOn(gitProcess, 'runGit').mockImplementation(async args => {
    const result = await run(args);
    if (!injected && args.args[0] === 'update-ref' && args.stdin?.toString().includes('refs/open-design/bindings/')) {
      injected = true; throw new Error('fixture crash after owner CAS');
    }
    return result;
  });
  const request = { url: 'ssh://git@example.invalid/repo', branch: 'main', actorId: 'local', idempotencyKey: 'interrupted' };
  await expect(service.openRepository(request)).rejects.toThrow('fixture crash after owner CAS'); fault.mockRestore();
  const pending = store.findOperation({ projectId: null, actorId: 'local', kind: 'open', idempotencyKey: 'interrupted' })!;
  expect(pending.journalPhase).toBeNull(); expect(store.getRegistration(pending.id)!.state).toBe('pending');
  expect(listProjects(db)).toEqual([]);
  await writeFile(join(f.a, 'index.html'), 'new remote'); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'advance'); await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main');
  const complete = await service.openRepository(request);
  expect(complete.id).toBe(pending.id); expect(store.getBinding(complete.result!.projectId!)!.localHead).toBe(originalTip);
  expect(listProjects(db)).toHaveLength(1);
});

it('keeps the first observed remote tip across a pre-registration dependency retry and performs no second fetch', async () => {
  const { f, db, store, service } = await serviceFixture();
  await writeFile(join(f.a, 'index.html'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'1'.repeat(64)}\nsize 42\n`);
  await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'missing payload'); await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main');
  const originalTip = await f.git(f.a, 'rev-parse', 'HEAD');
  const request = { url: 'ssh://git@example.invalid/repo', branch: 'main', actorId: 'local', idempotencyKey: 'frozen-failure' };
  await expect(service.openRepository(request)).resolves.toMatchObject({ status: 'failed', error: { code: 'PORTABLE_RESOURCE_MISSING' } });
  await writeFile(join(f.a, 'index.html'), 'later actual bytes'); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'later'); await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main');
  const network = vi.spyOn(gitProcess, 'runGitTransport');
  await expect(service.openRepository(request)).resolves.toMatchObject({ status: 'failed', error: { code: 'PORTABLE_RESOURCE_MISSING' } });
  expect(network).not.toHaveBeenCalled(); expect(listProjects(db)).toEqual([]);
  const op = store.findOperation({ projectId: null, actorId: 'local', kind: 'open', idempotencyKey: 'frozen-failure' })!;
  expect(store.getOpenRemote(op.id)).toEqual({ head: originalTip, objectFormat: 'sha1' });
});

it('rejects an unauthorized preview before reading the project binding and rejects fresh external edits without consuming its preview', async () => {
  const { service, existing, store } = await serviceFixture(); const root = await existing();
  const read = vi.spyOn(store, 'getBinding');
  await expect(service.previewEnable('existing', { actorId: 'foreign', idempotencyKey: 'denied' })).rejects.toThrow('Not authorized');
  expect(read).not.toHaveBeenCalled(); read.mockRestore();
  const preview = await service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'stale' });
  await writeFile(join(root, 'index.html'), 'external changed bytes');
  await expect(service.enable('existing', preview.id, { actorId: 'local', idempotencyKey: 'confirm' })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(store.findOperation({ projectId: 'existing', actorId: 'local', kind: 'enable', idempotencyKey: 'confirm' })).toBeNull();
  await expect(access(join(root, '.git'))).rejects.toBeDefined();
  await writeFile(join(root, 'index.html'), 'user file');
  expect((await service.enable('existing', preview.id, { actorId: 'local', idempotencyKey: 'confirm', expectedProjectRevision: 0 })).status).toBe('succeeded');
});

it('resumes the original enable consumer after owner claim without refreshing the generation-zero preview', async () => {
  const { service, existing, store } = await serviceFixture(); await existing();
  const preview = await service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'preview' });
  const run = gitProcess.runGit; let injected = false;
  const fault = vi.spyOn(gitProcess, 'runGit').mockImplementation(async args => {
    const result = await run(args);
    if (!injected && args.args[0] === 'update-ref' && args.stdin?.toString().includes('refs/open-design/bindings/')) {
      injected = true; throw new Error('fixture interrupted enable');
    }
    return result;
  });
  const request = { actorId: 'local', idempotencyKey: 'enable', expectedProjectRevision: 0 };
  await expect(service.enable('existing', preview.id, request)).rejects.toThrow('fixture interrupted enable'); fault.mockRestore();
  const original = store.findOperation({ projectId: 'existing', actorId: 'local', kind: 'enable', idempotencyKey: 'enable' })!;
  const result = await service.enable('existing', preview.id, request);
  expect(result).toMatchObject({ id: original.id, status: 'succeeded', basis: { bindingGeneration: 0 } });
  expect(store.getBinding('existing')!.projectRevision).toBe(0);
});

it('binds an empty remote from a frozen preview and unbinds only the remote while retaining local ownership', async () => {
  const { service, existing, store, f } = await serviceFixture(); const root = await existing();
  const request = { actorId: 'local', idempotencyKey: 'enable-preview', expectedProjectRevision: 0 };
  const enablePreview = await service.previewEnable('existing', request);
  await service.enable('existing', enablePreview.id, { ...request, idempotencyKey: 'enable' });
  const head = await f.git(root, 'rev-parse', 'HEAD');
  const preview = await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'main', { ...request, idempotencyKey: 'bind-preview' });
  expect(preview.result!.preview!.binding!.classification).toBe('empty');
  const bound = await service.bind('existing', preview.id, { ...request, idempotencyKey: 'bind' });
  expect(bound.status).toBe('succeeded');
  expect(store.getBinding('existing')).toMatchObject({ generation: 2, autoSync: true, remoteUrl: 'ssh://git@example.invalid/repo', localHead: head });
  const unbound = await service.unbind('existing', { ...request, idempotencyKey: 'unbind' });
  expect(unbound.status).toBe('succeeded');
  expect(store.getBinding('existing')).toMatchObject({ generation: 3, remoteUrl: null, localHead: head, projectRevision: 0 });
  expect(await f.git(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(store.listBindings()).toHaveLength(1);
});

it('waits the same scheduler admitted real push result before unbind advances generation', async () => {
  const { service, existing, store, scheduler, f } = await serviceFixture(); const root = await existing();
  const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const p = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  await service.enable('existing', p.id, { ...ctx, idempotencyKey: 'e' });
  const b = await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'main', { ...ctx, idempotencyKey: 'bp' });
  await service.bind('existing', b.id, { ...ctx, idempotencyKey: 'b' });
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); let issued = false;
  const run = gitProcess.runGitTransport;
  vi.spyOn(gitProcess, 'runGitTransport').mockImplementation(async args => {
    const result = await run(args);
    if (args.args[0] === 'push') { issued = true; await pending; }
    return result;
  });
  scheduler.start();
  await vi.waitFor(() => expect(issued).toBe(true));
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(await f.git(root, 'rev-parse', 'HEAD'));
  const unbind = service.unbind('existing', { ...ctx, idempotencyKey: 'u' });
  await new Promise(resolve => setImmediate(resolve));
  expect(store.getBinding('existing')!.generation).toBe(2);
  release();
  expect((await unbind).status).toBe('succeeded'); expect(store.getBinding('existing')!.generation).toBe(3);
});

it('rejects stale unbind revision after waiting for an already admitted real gate mutation', async () => {
  const { service, existing, store, registry } = await serviceFixture(); await existing(); const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const preview = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  await service.enable('existing', preview.id, { ...ctx, idempotencyKey: 'e' });
  const b = store.getBinding('existing')!; let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
  const ongoing = registry.get('existing')!.gate.exclusive(async () => {
    await paused; store.bumpProject('existing', { bindingGeneration: b.generation, projectRevision: b.projectRevision,
      contentRevision: b.contentRevision, localHead: b.localHead, remoteHead: b.observedRemoteHead });
  });
  const assert = store.assertRevision; const check = vi.spyOn(store, 'assertRevision').mockImplementation((id, revision) => { assert(id, revision); release(); });
  await expect(service.unbind('existing', { ...ctx, idempotencyKey: 'stale' })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  check.mockRestore(); await ongoing;
  expect(store.findOperation({ projectId: 'existing', actorId: 'local', kind: 'unbind', idempotencyKey: 'stale' })).toBeNull();
  expect(store.listPendingRegistrations()).toEqual([]);
});

it('does not refresh a persisted unbind capture after pre-registration interruption and external editing', async () => {
  const { service, existing, store, f } = await serviceFixture(); const root = await existing();
  const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const p = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  await service.enable('existing', p.id, { ...ctx, idempotencyKey: 'e' });
  const bp = await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'main', { ...ctx, idempotencyKey: 'bp' });
  await service.bind('existing', bp.id, { ...ctx, idempotencyKey: 'b' });
  const fault = vi.spyOn(store, 'prepareRegistration').mockImplementationOnce(() => { throw new Error('before registration'); });
  const request = { ...ctx, idempotencyKey: 'u' };
  await expect(service.unbind('existing', request)).rejects.toThrow('before registration'); fault.mockRestore();
  const original = store.findOperation({ projectId: 'existing', actorId: 'local', kind: 'unbind', idempotencyKey: 'u' })!;
  expect(store.getRegistration(original.id)).toBeNull();
  const refs = await f.git(root, 'show-ref'); await writeFile(join(root, 'index.html'), 'external edit');
  await expect(service.unbind('existing', request)).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(await f.git(root, 'show-ref')).toBe(refs); expect(store.getBinding('existing')!.remoteUrl).not.toBeNull();
  expect(store.getJournal(original.id)!.payload).toEqual(original.payload);
});

it('switches only the target branch owner ref while preserving the actual local branch', async () => {
  const { service, existing, store, f } = await serviceFixture(); const root = await existing();
  const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const p = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  await service.enable('existing', p.id, { ...ctx, idempotencyKey: 'e' });
  const oldRefs = await f.git(root, 'show-ref');
  const b = await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'release', { ...ctx, idempotencyKey: 'bp' });
  await service.bind('existing', b.id, { ...ctx, idempotencyKey: 'b' });
  const oldOwner = oldRefs.split('\n').find(line => line.includes('refs/open-design/bindings/'))!.split(' ')[1]!;
  await expect(f.git(root, 'rev-parse', '--verify', oldOwner)).rejects.toBeDefined();
  expect(await f.git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(store.getBinding('existing')).toMatchObject({ localBranch: 'main', branch: 'release', generation: 2 });
});

it('binds a shared portable descendant by its exact remote OID without synthesizing a merge commit', async () => {
  const { service, existing, store, f } = await serviceFixture(); const root = await existing();
  const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const p = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' });
  await service.enable('existing', p.id, { ...ctx, idempotencyKey: 'e' });
  await f.git(root, 'push', f.remote, 'HEAD:refs/heads/main'); await f.git(f.a, 'pull', '--ff-only', 'origin', 'main');
  await writeFile(join(f.a, 'index.html'), 'remote descendant'); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'remote');
  await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main'); const remote = await f.git(f.a, 'rev-parse', 'HEAD');
  const preview = await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'main', { ...ctx, idempotencyKey: 'bp' });
  expect(preview.result!.preview!.binding!.classification).toBe('shared_history');
  const bound = await service.bind('existing', preview.id, { ...ctx, idempotencyKey: 'b' });
  expect(bound.status).toBe('succeeded'); expect(await f.git(root, 'rev-parse', 'HEAD')).toBe(remote);
  expect(store.getBinding('existing')).toMatchObject({ localHead: remote, generation: 2, projectRevision: 1 });
  expect(store.getJournal(bound.id)!.recoveryData!.publicationMode).toBe('fast_forward');
  expect(await service.bind('existing', preview.id, { ...ctx, idempotencyKey: 'b' })).toEqual(bound);
  await expect(service.bind('existing', preview.id, { ...ctx, expectedProjectRevision: 1, idempotencyKey: 'b' })).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(service.bind('existing', preview.id, { ...ctx, actorId: 'foreign', idempotencyKey: 'b' })).rejects.toThrow('Not authorized');
  expect(await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' })).toEqual(p);
  expect((await service.enable('existing', p.id, { ...ctx, idempotencyKey: 'e' })).status).toBe('succeeded');
  expect(await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'main', { ...ctx, idempotencyKey: 'bp' })).toEqual(preview);
  await expect(service.previewEnable('existing', { ...ctx, expectedProjectRevision: 1, idempotencyKey: 'p' })).rejects.toMatchObject({ code: 'CONFLICT' });
  const unbindRequest = { ...ctx, expectedProjectRevision: 1, idempotencyKey: 'u' };
  const unbound = await service.unbind('existing', unbindRequest);
  store.bumpProject('existing', { ...preview.basis, bindingGeneration: 3, projectRevision: 1, localHead: remote, remoteHead: null });
  expect(await service.unbind('existing', unbindRequest)).toEqual(unbound);
  await expect(service.unbind('existing', { ...unbindRequest, expectedProjectRevision: 2 })).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('requires the full frozen union and explicit local metadata source for an independent plain remote', async () => {
  const { service, existing, store, f } = await serviceFixture(); const root = await existing();
  const ctx = { actorId: 'local', expectedProjectRevision: 0 };
  const p = await service.previewEnable('existing', { ...ctx, idempotencyKey: 'p' }); await service.enable('existing', p.id, { ...ctx, idempotencyKey: 'e' });
  const local = await f.git(root, 'rev-parse', 'HEAD');
  await writeFile(join(f.a, 'index.html'), 'independent source'); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'independent');
  await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main'); const remote = await f.git(f.a, 'rev-parse', 'HEAD');
  const preview = await service.previewBinding('existing', 'ssh://git@example.invalid/repo', 'main', { ...ctx, idempotencyKey: 'bp' });
  const choices = preview.result!.preview!.binding!;
  expect(choices).toMatchObject({ classification: 'independent_history', metadataSources: ['local'] });
  await expect(service.bind('existing', preview.id, { ...ctx, idempotencyKey: 'missing' })).rejects.toBeDefined();
  const confirmation = { metadataSource: 'local' as const, paths: choices.requiredPaths.map(path => ({ path,
    selectedSide: path === 'index.html' ? 'remote' as const : 'local' as const })) };
  const bound = await service.bind('existing', preview.id, { ...ctx, idempotencyKey: 'b', confirmation });
  const head = await f.git(root, 'rev-parse', 'HEAD');
  expect(await f.git(root, 'rev-list', '--parents', '--max-count=1', head)).toBe(`${head} ${local} ${remote}`);
  expect(await f.git(root, 'show', 'HEAD:index.html')).toBe('independent source');
  expect(store.getJournal(bound.id)!.protection).toBeNull();
});

it.each(['owner', 'records', 'index', 'terminal'])('restarts the same open after an actual child process exits at %s', async window => {
  const { f, db, configuration } = await serviceFixture();
  const entries = serializePortableMetadata(portableSnapshot('After')); entries.set('index.html', Buffer.from('process source'));
  await writeFixtureEntries(f.a, entries); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'process'); await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main');
  const tip = await f.git(f.a, 'rev-parse', 'HEAD');
  await writeFile(join(f.root, 'binding-fixture.json'), JSON.stringify(configuration)); db.close();
  async function child(window: string) {
    const worker = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../helpers/project-git-crash-worker.ts', import.meta.url)),
      f.root, `registration:${window}`, 'exit'], { env: { ...process.env, ...fixtureGitEnv, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; worker.stderr.on('data', bytes => { stderr += String(bytes); });
    const result = await once(worker, 'exit'); expect(stderr).toBe(''); return result;
  }
  expect(await child(window)).toEqual([73, null]);
  const interrupted = new Database(join(configuration.data, 'app.sqlite')); const store = createProjectGitStore(interrupted);
  const original = store.findOperation({ projectId: null, actorId: 'local', kind: 'open', idempotencyKey: 'process-open' })!;
  expect(original.journalPhase).toBe(window === 'owner' ? null : window === 'records' ? 'records_applied' : 'index_published');
  expect(store.getRegistration(original.id)!.state).toBe('pending');
  expect(listProjects(interrupted)).toEqual([]); interrupted.close();
  expect(await child('resume')).toEqual([0, null]);
  const reopened = new Database(join(configuration.data, 'app.sqlite')); const restored = createProjectGitStore(reopened);
  expect(restored.getOperation(original.id)).toMatchObject({ status: 'succeeded', result: { head: tip } });
  expect(listProjects(reopened)).toHaveLength(1); expect(reopened.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 }); reopened.close();
});

async function registrationChild(root: string, window: string) {
  const worker = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../helpers/project-git-crash-worker.ts', import.meta.url)),
    root, `registration:${window}`, 'exit'], { env: { ...process.env, ...fixtureGitEnv, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; worker.stderr.on('data', bytes => { stderr += String(bytes); });
  const result = await once(worker, 'exit'); return { result, stderr };
}

it.each(['plain', 'empty'])('reuses the frozen %s candidate after an actual process exits before registration', async mode => {
  const { f, db, configuration } = await serviceFixture();
  if (mode === 'plain') { await writeFile(join(f.a, 'index.html'), 'plain'); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'plain'); await f.git(f.a, 'push', 'origin', 'HEAD:main'); }
  await writeFile(join(f.root, 'binding-fixture.json'), JSON.stringify(configuration)); db.close();
  expect(await registrationChild(f.root, 'candidate')).toEqual({ result: [73, null], stderr: '' });
  const interrupted = new Database(join(configuration.data, 'app.sqlite')); const store = createProjectGitStore(interrupted);
  const operation = store.findOperation({ projectId: null, actorId: 'local', kind: 'open', idempotencyKey: 'process-open' })!;
  const frozen = store.getOpenPreparation(operation.id)!; expect(frozen.candidate).toBeDefined(); expect(store.listBindings()).toEqual([]); interrupted.close();
  expect(await registrationChild(f.root, 'resume')).toEqual({ result: [0, null], stderr: '' });
  const reopened = new Database(join(configuration.data, 'app.sqlite')); const restored = createProjectGitStore(reopened);
  expect(restored.getOpenPreparation(operation.id)).toEqual(frozen);
  expect(restored.getOperation(operation.id)).toMatchObject({ status: 'succeeded', result: { head: frozen.candidate!.candidateOid } }); reopened.close();
});

it.each(['exact', 'file', 'index', 'ref', 'extra-ref', 'git-symlink', 'evidence-path', 'evidence-digest', 'live-owner', 'reused-pid', 'foreign-owner', 'unknown-owner', 'malformed-owner'])('handles %s first-enable restart after actual initialization and process exit', async fault => {
  const { f, service, db, existing, configuration } = await serviceFixture(); const root = await existing();
  const preview = await service.previewEnable('existing', { actorId: 'local', idempotencyKey: 'process-preview', expectedProjectRevision: 0 });
  await writeFile(join(f.root, 'binding-fixture.json'), JSON.stringify({ ...configuration, enableProject: { id: 'existing', root, previewId: preview.id } })); db.close();
  expect(await registrationChild(f.root, 'enable-init')).toEqual({ result: [73, null], stderr: '' });
  const interrupted = new Database(join(configuration.data, 'app.sqlite')); const store = createProjectGitStore(interrupted);
  const operation = store.findOperation({ projectId: 'existing', actorId: 'local', kind: 'enable', idempotencyKey: 'process-enable' })!;
  expect(store.getEnableInitialization(operation.id)).not.toBeNull(); expect(store.listBindings()).toEqual([]);
  if (fault === 'git-symlink') { const relocated = join(f.root, 'relocated-git'); await fs.rename(join(root, '.git'), relocated); await symlink(relocated, join(root, '.git')); }
  if (fault === 'file') await writeFile(join(root, 'index.html'), 'external');
  if (fault === 'index') await f.git(root, 'add', 'index.html');
  if (fault === 'ref') { await f.git(root, 'add', '.'); await f.git(root, 'commit', '-m', 'external'); }
  if (fault === 'extra-ref') await f.git(root, 'update-ref', 'refs/external/evidence', await f.git(root, 'rev-parse', 'refs/open-design/locks/repository'));
  if (fault.endsWith('-owner') || fault === 'reused-pid') {
    const owner = JSON.parse(await f.git(root, 'cat-file', 'blob', 'refs/open-design/locks/repository')) as Record<string, unknown>;
    if (fault === 'live-owner' || fault === 'reused-pid') owner.pid = process.pid;
    if (fault === 'foreign-owner') owner.dataRootId = 'foreign';
    if (fault === 'unknown-owner') owner.ownerDomain = 'unknown';
    const bytes = Buffer.from(fault === 'malformed-owner' ? 'malformed' : JSON.stringify(owner));
    const oid = (await gitProcess.runGit({ cwd: root, args: ['hash-object', '-w', '--stdin'], stdin: bytes })).stdout.toString().trim();
    await f.git(root, 'update-ref', 'refs/open-design/locks/repository', oid);
  }
  if (fault.startsWith('evidence-')) {
    const payload = store.getJournal(preview.id)!.payload as Record<string, unknown>;
    if (fault === 'evidence-path') payload.evidencePath = '../outside.json'; else payload.evidenceDigest = '0'.repeat(64);
    interrupted.prepare('UPDATE project_git_operations SET payload_json=? WHERE id=?').run(JSON.stringify(payload), preview.id);
  }
  interrupted.close(); const resumed = await registrationChild(f.root, 'resume');
  if (fault === 'exact') expect(resumed).toEqual({ result: [0, null], stderr: '' }); else expect(resumed.result[0]).not.toBe(0);
  if (fault === 'extra-ref') expect(await f.git(root, 'rev-parse', 'refs/external/evidence')).toMatch(/^[a-f0-9]{40}$/u);
  const reopened = new Database(join(configuration.data, 'app.sqlite')); const restored = createProjectGitStore(reopened);
  expect(restored.listBindings()).toHaveLength(fault === 'exact' ? 1 : 0);
  expect(restored.getOperation(operation.id)!.status === 'succeeded').toBe(fault === 'exact'); reopened.close();
});

it('constructs explicitly selected independent history with both original parents and preserves the working tree', async () => {
  const f = await createGitFixture(); cleanups.push(f.close);
  const left = serializePortableMetadata(portableSnapshot('Portable')); left.set('index.html', Buffer.from('local'));
  left.set('local.html', Buffer.from('keep local'));
  const right = serializePortableMetadata(portableSnapshot('Portable')); right.set('index.html', Buffer.from('remote'));
  right.set('remote.html', Buffer.from('keep remote'));
  const local = await fixtureCommit(f.a, join(f.root, 'left.index'), left, []);
  const remote = await fixtureCommit(f.a, join(f.root, 'right.index'), right, []);
  await f.git(f.a, 'update-ref', 'refs/heads/main', local);
  const stagingDir = join(f.root, 'prepare'); await mkdir(stagingDir);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const preview = { classification: 'independent_history' as const, metadataSources: [], requiredPaths: paths };
  const confirmation = { paths: paths.map(path => ({ path, selectedSide: path === 'index.html' || path === 'remote.html' ? 'remote' as const : 'local' as const })) };
  const candidate = await prepareIndependentBinding({ root: f.a, local, remote, stagingDir, preview, confirmation, gitEnv: fixtureGitEnv });
  expect(await f.git(f.a, 'rev-list', '--parents', '--max-count=1', candidate.oid)).toBe(`${candidate.oid} ${local} ${remote}`);
  expect(await f.git(f.a, 'show', `${candidate.oid}:index.html`)).toBe('remote');
  expect(await f.git(f.a, 'show', `${candidate.oid}:local.html`)).toBe('keep local');
  expect(await f.git(f.a, 'show', `${candidate.oid}:remote.html`)).toBe('keep remote');
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(local);
  await expect(prepareIndependentBinding({ root: f.a, local, remote, stagingDir, preview,
    confirmation: { paths: confirmation.paths.filter(item => item.path !== '.open-design/project.json') }, gitEnv: fixtureGitEnv })).rejects.toBeDefined();
  await expect(prepareIndependentBinding({ root: f.a, local, remote, stagingDir, preview,
    confirmation: { paths: confirmation.paths.map(item => item.path === '.open-design/project.json' ? { ...item, selectedSide: 'delete' as const } : item) }, gitEnv: fixtureGitEnv })).rejects.toBeDefined();
});

describe('binding candidate preflight', () => {
  it('rejects private members before reading any candidate blob and reports paths only', async () => {
    const f = await createGitFixture(); cleanups.push(f.close);
    await writeFile(join(f.a, '.env'), 'FIXTURE_PRIVATE_VALUE'); await writeFile(join(f.a, 'index.html'), 'safe');
    await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'private fixture');
    const oid = await f.git(f.a, 'rev-parse', 'HEAD');
    const original = gitProcess.runGit; const reads: string[] = [];
    vi.spyOn(gitProcess, 'runGit').mockImplementation(async input => {
      if (input.args[0] === 'cat-file' && input.args[1] !== '-t') reads.push(input.args.join(' '));
      return original(input);
    });
    await expect(inspectBindingCommit(f.a, oid)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { paths: ['.env'] } });
    expect(reads).toEqual([]);
  });

  it('identifies a plain repository and a strict portable snapshot without changing worktree or HEAD', async () => {
    const f = await createGitFixture(); cleanups.push(f.close);
    await writeFile(join(f.a, 'index.html'), '<h1>fixture</h1>'); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'ordinary');
    const plain = await f.git(f.a, 'rev-parse', 'HEAD');
    expect((await inspectBindingCommit(f.a, plain)).snapshot).toBeNull();
    await writeFixtureEntries(f.a, serializePortableMetadata(portableSnapshot('Portable')));
    await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'portable');
    const portable = await f.git(f.a, 'rev-parse', 'HEAD');
    expect((await inspectBindingCommit(f.a, portable)).snapshot?.project.name).toBe('Portable');
    expect(await f.git(f.a, 'status', '--porcelain')).toBe('');
    expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(portable);
  });

  it.each(['partial', 'newer', 'case-variant'])('does not downgrade %s reserved metadata into plain files', async kind => {
    const f = await createGitFixture(); cleanups.push(f.close);
    const entries = serializePortableMetadata(portableSnapshot('Portable'));
    if (kind === 'partial') entries.delete('.open-design/project.json');
    if (kind === 'newer') entries.set('.open-design/manifest.json', Buffer.from('{"schemaVersion":2,"repositoryProjectId":"repository","resources":[]}'));
    if (kind === 'case-variant') for (const [path, bytes] of [...entries]) { entries.delete(path); entries.set(path.replace('.open-design', '.OPEN-DESIGN'), bytes); }
    await writeFixtureEntries(f.a, entries); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'invalid reserved fixture');
    await expect(inspectBindingCommit(f.a, await f.git(f.a, 'rev-parse', 'HEAD'))).rejects.toBeDefined();
  });
});

describe('binding choices', () => {
  const preview = { classification: 'independent_history' as const, metadataSources: [], requiredPaths: ['index.html', '.open-design/project.json'] };
  it('requires exactly one decision for every ordinary and reserved path from the original preview', () => {
    const decisions = { paths: [{ path: 'index.html', selectedSide: 'local' as const },
      { path: '.open-design/project.json', selectedSide: 'remote' as const }] };
    expect(validateBindingConfirmation(preview, decisions)).toEqual(decisions);
    for (const invalid of [undefined, {}, { paths: [] }, { paths: [decisions.paths[0]] },
      { paths: [...decisions.paths, decisions.paths[0]] },
      { paths: [...decisions.paths, { path: 'unknown.html', selectedSide: 'local' }] }]) {
      expect(() => validateBindingConfirmation(preview, invalid)).toThrow();
    }
  });

  it('requires an explicitly available metadata source and rejects selecting portable histories away', () => {
    const plain = { classification: 'shared_history' as const, metadataSources: ['local' as const], requiredPaths: [] };
    expect(validateBindingConfirmation(plain, { metadataSource: 'local' })).toEqual({ metadataSource: 'local' });
    expect(() => validateBindingConfirmation(plain, {})).toThrow();
    expect(() => validateBindingConfirmation(plain, { metadataSource: 'remote' })).toThrow();
    expect(() => validateBindingConfirmation({ ...preview, requiredPaths: [] }, { metadataSource: 'local' })).toThrow();
    expect(() => validateBindingConfirmation({ ...plain, classification: 'different_project' }, { metadataSource: 'local' })).toThrow();
  });
});

describe('classifyBinding', () => {
  it('does not combine two independent Open Design projects', () => {
    expect(classifyBinding({ localProjectId: 'product-a', remoteProjectId: 'product-b',
      hasCommonAncestor: true, remoteHead: 'abc' })).toBe('different_project');
    expect(classifyBinding({ localProjectId: 'product-a', remoteProjectId: null,
      hasCommonAncestor: false, remoteHead: 'abc' })).toBe('independent_history');
  });

  it('checks identity before emptiness and distinguishes shared and independent histories', () => {
    expect(classifyBinding({ localProjectId: 'product-a', remoteProjectId: 'product-b',
      hasCommonAncestor: false, remoteHead: null })).toBe('different_project');
    expect(classifyBinding({ localProjectId: 'product-a', remoteProjectId: null,
      hasCommonAncestor: false, remoteHead: null })).toBe('empty');
    expect(classifyBinding({ localProjectId: 'product-a', remoteProjectId: 'product-a',
      hasCommonAncestor: true, remoteHead: 'abc' })).toBe('shared_history');
    expect(classifyBinding({ localProjectId: 'product-a', remoteProjectId: 'product-a',
      hasCommonAncestor: false, remoteHead: 'abc' })).toBe('independent_history');
  });
});
