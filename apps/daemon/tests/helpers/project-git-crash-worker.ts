import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import Database from 'better-sqlite3';
import type { PortableSnapshot, ProjectGitBasis } from '@open-design/contracts';
import { closeDatabase, getProject, insertProject, openDatabase } from '../../src/db.js';
import { createProjectGitStore } from '../../src/storage/project-git.js';
import { getProjectGate } from '../../src/services/project-git/gate.js';
import { getRepositoryOwnerDomain } from '../../src/services/project-git/repository-lease.js';
import { exportPortableProject, serializePortableMetadata } from '../../src/services/project-git/portable.js';
import { runGit } from '../../src/services/project-git/git-process.js';
import { createGitFixture } from './project-git.js';
import type { MaterializeInput } from '../../src/services/project-git/materialize.js';
import type { RecoveryProject } from '../../src/services/project-git/recovery.js';
import type { ProjectGitStore } from '../../src/storage/project-git.js';
import type { ProjectGate } from '../../src/services/project-git/gate.js';
import { computeCheckpointContentDigest } from '../../src/services/project-git/checkpoint.js';
import { safeFile, sha256 } from '../../src/services/project-git/recovery.js';
import { createProjectGitBindingService, type ProjectGitBindingServiceInput } from '../../src/services/project-git/binding.js';
import { createProjectGitSyncDeps, syncProject, type ProjectGitSyncProject } from '../../src/services/project-git/sync.js';
import { createProjectGitScheduler } from '../../src/services/project-git/scheduler.js';

export const fixtureGitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Materialize Test', GIT_AUTHOR_EMAIL: 'materialize@example.invalid',
  GIT_COMMITTER_NAME: 'Materialize Test', GIT_COMMITTER_EMAIL: 'materialize@example.invalid' };

export function portableSnapshot(name: string): PortableSnapshot {
  return { manifest: { schemaVersion: 1, repositoryProjectId: 'repository', resources: [] },
    project: { schemaVersion: 1, name, createdAt: 1, kind: 'prototype', preferences: {}, contentRefs: [], linkedFolderRequirements: [] },
    conversations: name === 'After' ? [{ schemaVersion: 1, id: 'conversation', title: 'Restored chat', mode: 'design', createdAt: 1 }] : [],
    messages: name === 'After' ? [{ schemaVersion: 1, id: 'message', conversationId: 'conversation', role: 'user', content: 'materialized message', createdAt: 2,
      predecessorId: null, turnId: 'turn', terminal: 'historical', resourceRefs: [], displayEvents: [], context: {} }] : [] };
}
export async function writeFixtureEntries(root: string, entries: Map<string, Uint8Array>): Promise<void> {
  for (const [path, bytes] of entries) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
}
export async function fixtureCommit(root: string, index: string, entries: Map<string, Uint8Array>, parents: string[]): Promise<string> {
  const env = { ...fixtureGitEnv, GIT_INDEX_FILE: index };
  await runGit({ cwd: root, args: ['read-tree', '--empty'], env });
  const records: Buffer[] = [];
  for (const [path, bytes] of entries) {
    const oid = (await runGit({ cwd: root, args: ['hash-object', '-w', '--stdin'], stdin: bytes })).stdout.toString().trim();
    records.push(Buffer.from(`100644 ${oid}\t${path}\0`));
  }
  await runGit({ cwd: root, args: ['update-index', '-z', '--index-info'], env, stdin: Buffer.concat(records) });
  const tree = (await runGit({ cwd: root, args: ['write-tree'], env })).stdout.toString().trim();
  return (await runGit({ cwd: root, args: ['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])],
    env, stdin: Buffer.from('Materialization fixture\n') })).stdout.toString().trim();
}
interface FixtureDescription { operationId: string; basis: ProjectGitBasis; candidateOid: string; snapshot: PortableSnapshot; previewContentDigest: string }
interface CrashFixtureState {
  input: MaterializeInput; db: Database.Database; store: ProjectGitStore; gate: ProjectGate; description: FixtureDescription;
  recoveryInput: { db: Database.Database; store: ProjectGitStore; operationRoot: string; resolveProject(): RecoveryProject };
}

export async function openCrashFixture(root: string): Promise<CrashFixtureState> {
  const description = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8')) as FixtureDescription;
  const db = new Database(join(root, 'data/app.sqlite')); db.pragma('foreign_keys = ON');
  const store = createProjectGitStore(db); const projectRoot = join(root, 'a');
  const readBasis = (): ProjectGitBasis => {
    const binding = store.getBinding('project')!;
    return { bindingGeneration: binding.generation, projectRevision: binding.projectRevision,
      contentRevision: binding.contentRevision, localHead: binding.localHead, remoteHead: binding.observedRemoteHead };
  };
  const gate = await getProjectGate({ root: projectRoot, instanceId: 'materialization-fixture',
    ownerDomain: (await getRepositoryOwnerDomain()) ?? 'unknown', dataRootId: root });
  const input = { ...description, projectId: 'project', root: projectRoot, branch: 'main', operationDir: join(root, 'operations'),
    db, store, gate, readBasis, gitEnv: fixtureGitEnv,
    exportCurrentPortable: async () => (await exportPortableProject({ db, store, projectId: 'project',
      repositoryProjectId: 'repository', cloneId: 'clone', root: projectRoot })).entries };
  return { input, db, store, gate, description,
    recoveryInput: { db, store, operationRoot: join(root, 'operations'), resolveProject: () => ({ root: projectRoot, branch: 'main', gate, readBasis, gitEnv: fixtureGitEnv,
      exportCurrentPortable: input.exportCurrentPortable }) } };
}

type Fixture = Awaited<ReturnType<typeof createGitFixture>> & CrashFixtureState & { head: string | null; target: Map<string, Uint8Array> };
export async function captureFixturePreview(input: Pick<MaterializeInput, 'root' | 'exportCurrentPortable'>): Promise<string> {
  const listed = (await runGit({ cwd: input.root, args: ['ls-files', '--cached', '--others', '--exclude-standard', '-z'] })).stdout.toString();
  const paths = [...new Set(listed.split('\0').filter(Boolean))];
  const sourceDigests: Record<string, string> = {}; const sourceModes: Record<string, string> = {};
  for (const path of paths) { const file = await safeFile(input.root, path); sourceDigests[path] = file.bytes === null ? 'missing' : sha256(file.bytes); sourceModes[path] = file.mode; }
  const portable = await input.exportCurrentPortable();
  return computeCheckpointContentDigest({ sourceDigests, sourceModes,
    portableDigests: Object.fromEntries([...portable].map(([path, bytes]) => [path, sha256(Buffer.from(bytes))])),
    removedPaths: paths.filter(path => path.startsWith('.open-design/') && !portable.has(path)) });
}
async function makeCrashFixture(unborn: boolean): Promise<Fixture> {
  const f = await createGitFixture(); const old = serializePortableMetadata(portableSnapshot('Before'));
  if (unborn) old.clear();
  old.set('index.html', Buffer.from('before\n')); old.set('obsolete.txt', Buffer.from('remove me\n'));
  old.set('.gitignore', Buffer.from('ignored.txt\n'));
  await writeFixtureEntries(f.a, old); await writeFile(join(f.a, 'ignored.txt'), 'keep ignored');
  if (!unborn) { await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'base'); }
  const head = unborn ? null : await f.git(f.a, 'rev-parse', 'HEAD');
  const dataRoot = join(f.root, 'data'); await mkdir(dataRoot);
  openDatabase(dataRoot, { dataDir: dataRoot }); closeDatabase();
  const db = new Database(join(dataRoot, 'app.sqlite')); const store = createProjectGitStore(db);
  insertProject(db, { id: 'project', name: 'Before', createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype' } });
  db.exec('CREATE TABLE fixture_imports (value INTEGER); CREATE TRIGGER fixture_count_import AFTER UPDATE ON projects BEGIN INSERT INTO fixture_imports VALUES (1); END;');
  const b = store.saveBinding({ projectId: 'project', cloneId: 'clone', repositoryProjectId: 'repository',
    canonicalRoot: f.a, commonDir: join(f.a, '.git'), branch: 'main', remoteUrl: null, generation: 0,
    autoSync: false, localHead: head, observedRemoteHead: null, confirmedRemoteHead: null,
    projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: head, dirty: false });
  const basis: ProjectGitBasis = { bindingGeneration: b.generation, projectRevision: 0, contentRevision: 0, localHead: head, remoteHead: null };
  const snapshot = portableSnapshot('After'); const target = serializePortableMetadata(snapshot);
  target.set('index.html', Buffer.from('after\n')); target.set('nested/new.txt', Buffer.from('new\n')); target.set('.gitignore', old.get('.gitignore')!);
  const candidateOid = await fixtureCommit(f.a, join(f.root, 'fixture.index'), target, head === null ? [] : [head]);
  const operationId = store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'sync', basis,
    idempotencyKey: randomUUID(), requestDigest: randomUUID(), payload: {} }).id;
  const previewContentDigest = await captureFixturePreview({ root: f.a, exportCurrentPortable: async () => (await exportPortableProject({ db, store,
    projectId: 'project', repositoryProjectId: 'repository', cloneId: 'clone', root: f.a })).entries });
  await writeFile(join(f.root, 'fixture.json'), JSON.stringify({ operationId, basis, candidateOid, snapshot, previewContentDigest })); db.close();
  return { ...f, head, target, ...(await openCrashFixture(f.root)) };
}
export async function createCrashFixture(): Promise<Fixture & { head: string }> {
  const f = await makeCrashFixture(false); if (f.head === null) throw new Error('Expected fixture HEAD.'); return { ...f, head: f.head };
}
export async function createUnbornCrashFixture(): Promise<Fixture & { head: null }> {
  const f = await makeCrashFixture(true); if (f.head !== null) throw new Error('Expected unborn fixture.'); return { ...f, head: null };
}

async function registrationWorker(root: string, window: string): Promise<void> {
  const config = JSON.parse(await readFile(join(root, 'binding-fixture.json'), 'utf8')) as Pick<ProjectGitBindingServiceInput,
    'operationRoot' | 'preparationRoot' | 'ownedProjectsRoot' | 'ownership' | 'gitEnv'> & { data: string; enableProject?: { id: string; root: string; previewId: string } };
  const db = new Database(join(config.data, 'app.sqlite')); const store = createProjectGitStore(db);
  const projects = new Map<string, ProjectGitSyncProject>();
  for (const b of store.listBindings()) projects.set(b.projectId, { root: b.canonicalRoot, branch: b.localBranch ?? b.branch,
    gate: await getProjectGate({ root: b.canonicalRoot, ...config.ownership }), ...(config.gitEnv ? { gitEnv: config.gitEnv } : {}) });
  if (config.enableProject && !projects.has(config.enableProject.id)) {
    const { getUnmanagedProjectGate, resumeInitializedProjectGate } = await import('../../src/services/project-git/gate.js');
    const prior = store.findOperation({ projectId: config.enableProject.id, actorId: 'local', kind: 'enable', idempotencyKey: 'process-enable' });
    let initialized = true;
    try { await fsPromises.lstat(join(config.enableProject.root, '.git')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; initialized = false; }
    const gate = initialized && prior && store.getEnableInitialization(prior.id)
      ? await resumeInitializedProjectGate({ root: config.enableProject.root, ...config.ownership, store, operationRoot: config.operationRoot, operationId: prior.id })
      : await getUnmanagedProjectGate({ root: config.enableProject.root, ...config.ownership });
    projects.set(config.enableProject.id, { root: config.enableProject.root, branch: 'main', gate, ...(config.gitEnv ? { gitEnv: config.gitEnv } : {}) });
  }
  let service!: ReturnType<typeof createProjectGitBindingService>;
  const resolveProject = (id: string): ProjectGitSyncProject => {
    const project = projects.get(id); if (!project) throw new Error('Missing trusted fixture registration');
    return { ...project, prepareRegistrationCompletion: operationId => service.prepareRegistrationCompletion(operationId) };
  };
  const deps = createProjectGitSyncDeps({ db, store, ...config, resolveProject, now: () => 100_000, random: () => 0.5 });
  const scheduler = createProjectGitScheduler({ store, now: deps.now, random: deps.random, detect: deps.detect,
    sync: (projectId, oneShot) => syncProject({ projectId, oneShot, deps }) });
  service = createProjectGitBindingService({ ...config, db, store, scheduler, checkpointCurrent: deps.checkpoint, recoveryReady: deps.recoveryReady,
    resolveProject, now: deps.now, newId: randomUUID, resolveAvailability: async () => true,
    requireCreate: actor => { if (actor !== 'local') throw new Error('Fixture authorization failed'); },
    requireProject: (actor, id) => { if (actor !== 'local' || !getProject(db, id)) throw new Error('Fixture authorization failed'); },
    reserveProject: ({ projectId, root: projectRoot, localBranch, gate }) => {
      const previous = projects.get(projectId);
      if (previous && (previous.root !== projectRoot || previous.branch !== localBranch || previous.gate !== gate)) throw new Error('Conflicting fixture reservation');
      projects.set(projectId, { root: projectRoot, branch: localBranch, gate, ...(config.gitEnv ? { gitEnv: config.gitEnv } : {}) });
      return () => { if (!previous) projects.delete(projectId); };
    } });
  if (window === 'owner') {
    const original = fsPromises.mkdtemp;
    fsPromises.mkdtemp = (async (...args: Parameters<typeof original>) => {
      if (String(args[0]).startsWith(join(config.operationRoot, 'materialize-'))) process.exit(73);
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
  }
  if (window === 'records') {
    const original = store.completeRecords;
    store.completeRecords = (id, completion, records) => { const result = original(id, completion, records); process.exit(73); return result; };
  }
  if (window === 'index') {
    const original = store.completePhase;
    store.completePhase = (id, phase, data) => { original(id, phase, data); if (phase === 'index_published') process.exit(73); };
  }
  if (window === 'terminal') {
    const original = store.completeRegistration;
    store.completeRegistration = intent => { const result = original(intent); process.exit(73); return result; };
  }
  if (window === 'candidate') {
    const freeze = store.freezeOpenPreparation;
    store.freezeOpenPreparation = (id, preparation) => { freeze(id, preparation); if (preparation.candidate) process.exit(73); };
  }
  if (window === 'enable-init') store.prepareRegistration = () => { process.exit(73); };
  if (window === 'enable-intent') {
    const freeze = store.freezeEnableInitialization;
    store.freezeEnableInitialization = (id, initialization) => { freeze(id, initialization); process.exit(73); };
  }
  if (config.enableProject) await service.enable(config.enableProject.id, config.enableProject.previewId,
    { actorId: 'local', idempotencyKey: 'process-enable', expectedProjectRevision: 0 });
  else await service.openRepository({ url: 'ssh://git@example.invalid/repo', branch: 'main', actorId: 'local', idempotencyKey: 'process-open' });
  await scheduler.stop(); db.close();
}

async function worker(): Promise<void> {
  const [root, requestedWindow, method] = process.argv.slice(2);
  const window = requestedWindow?.replace(/^dirty:/u, '');
  if (!root || !window) throw new Error('Fixture root and crash window are required.');
  if (window.startsWith('registration:')) return registrationWorker(root, window.slice('registration:'.length));
  const f = await openCrashFixture(root);
  if (requestedWindow?.startsWith('dirty:') || window.startsWith('protection:')) {
    await writeFile(join(f.input.root, 'index.html'), 'protected user bytes\n');
    f.input.previewContentDigest = await captureFixturePreview(f.input);
  }
  const crash = () => { if (method === 'kill') process.kill(process.pid, 'SIGKILL'); else process.exit(73); };
  if (window === 'before_file_rename') {
    const original = fsPromises.rename;
    fsPromises.rename = async (source, target) => { if (String(source).includes('/.od-materialize-')) crash(); return original(source, target); };
    syncBuiltinESMExports();
  }
  if (window === 'after_file_rename_before_sync' || window === 'after_index_rename_before_sync') {
    const original = fsPromises.rename;
    fsPromises.rename = async (source, target) => {
      await original(source, target);
      if (window === 'after_file_rename_before_sync' ? String(source).includes('/.od-materialize-') : target === join(f.input.root, '.git/index')) crash();
    };
    syncBuiltinESMExports();
  }
  if (window.startsWith('protection:')) {
    const boundary = window.slice('protection:'.length);
    const enqueue = f.store.enqueueCheckpoint;
    f.store.enqueueCheckpoint = input => { const result = enqueue(input); if (boundary === 'enqueued') crash(); return result; };
    const complete = f.store.completePhase;
    f.store.completePhase = (id, phase, data) => { complete(id, phase, data); if (f.store.getJournal(id)!.kind === 'checkpoint' && phase === boundary) crash(); };
    const records = f.store.completeRecords;
    f.store.completeRecords = (id, input, apply) => { const result = records(id, input, apply); if (f.store.getJournal(id)!.kind === 'checkpoint' && boundary === 'records_applied') crash(); return result; };
    const finish = f.store.completeMaterialization;
    f.store.completeMaterialization = (id, input) => { const result = finish(id, input); if (f.store.getJournal(id)!.kind === 'checkpoint' && boundary === 'complete') crash(); return result; };
  }
  if (window.startsWith('checkpoint:')) {
    const boundary = window.slice('checkpoint:'.length);
    f.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run('Checkpoint', 'project');
    await writeFile(join(f.input.root, 'index.html'), 'checkpoint user work\n');
    const { prepareCheckpoint, publishCheckpoint, journalCheckpoint } = await import('../../src/services/project-git/checkpoint.js');
    const candidate = await prepareCheckpoint({ root: f.input.root, operationDir: f.input.operationDir, head: f.input.basis.localHead,
      portableEntries: await f.input.exportCurrentPortable(), coordination: { projectId: 'project', basis: f.input.basis,
        gate: f.gate, readBasis: f.input.readBasis, gitEnv: fixtureGitEnv } });
    const operationId = f.store.enqueueCheckpoint({ projectId: 'project', actorId: 'local', basis: f.input.basis,
      idempotencyKey: 'checkpoint-crash', requestDigest: 'checkpoint-crash', payload: {} }).id;
    await writeFile(join(root, 'checkpoint-operation'), operationId);
    const complete = f.store.completePhase;
    f.store.completePhase = (id, phase, data) => {
      if (boundary === `after_${phase}`) crash();
      complete(id, phase, data); if (boundary === phase) crash();
    };
    const records = f.store.completeRecords;
    f.store.completeRecords = (id, input, apply) => { const result = records(id, input, apply); if (boundary === 'records_applied') crash(); return result; };
    const completeMaterialization = f.store.completeMaterialization;
    f.store.completeMaterialization = (id, input) => { const result = completeMaterialization(id, input); if (boundary === 'complete') crash(); return result; };
    const publication = { root: f.input.root, branch: 'main', candidate, operationId, store: f.store };
    await journalCheckpoint(publication); await publishCheckpoint(publication); f.db.close(); return;
  }
  if (window === 'inside_records_transaction') {
    f.db.function('fixture_crash', () => { crash(); return 0; });
    f.db.exec('CREATE TEMP TRIGGER fixture_interrupt AFTER UPDATE ON projects BEGIN SELECT fixture_crash(); END;');
  }
  const { materializeProject } = await import('../../src/services/project-git/materialize.js');
  await materializeProject({ ...f.input,
    afterDurablePhase: async phase => { if (phase === window) crash(); },
    afterEffect: async point => { if (point === window) crash(); } });
  f.db.close();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void worker().catch(error => { console.error(error); process.exitCode = 1; });
}
