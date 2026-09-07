import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { closeDatabase, insertProject, openDatabase } from '../../../src/db.js';
import { createSnapshot } from '../../../src/plugins/snapshots.js';
import { createProjectGitStore, type ProjectGitRecoveryData } from '../../../src/storage/project-git.js';
import { canonicalJson, exportPortableProject, parsePortableEntries, portableImportMarker, serializePortableMetadata } from '../../../src/services/project-git/portable.js';
import { importPortableRecords } from '../../../src/services/project-git/portable-db.js';
import { createProjectGitOwnedResourceReader } from '../../../src/services/project-git/owned-resources.js';

const roots: string[] = [];
const databases: Database.Database[] = [];
afterEach(async () => {
  closeDatabase();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(assetPath = './image.bin', fragments?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'od-git-owned-resource-')); roots.push(root);
  openDatabase(root, { dataDir: root }); closeDatabase();
  const db = new Database(join(root, 'app.sqlite')); databases.push(db);
  const pluginRoot = join(root, 'plugin'); await mkdir(pluginRoot);
  const projectRoot = join(root, 'project'); await mkdir(projectRoot);
  const assetBytes = Buffer.from([0, 255, 13, 10]);
  await writeFile(join(pluginRoot, 'image.bin'), assetBytes);
  await writeFile(join(pluginRoot, 'notes.txt'), 'Declared only in staged assets');
  await writeFile(join(pluginRoot, '.env'), 'PRIVATE_CREDENTIAL');
  await mkdir(join(pluginRoot, '.git'));
  await writeFile(join(pluginRoot, '.git', 'config'), 'PRIVATE_GIT_CONFIG');
  insertProject(db, { id: 'project', name: 'Owned content', createdAt: 1, updatedAt: 1 });
  insertProject(db, { id: 'other', name: 'Another project', createdAt: 1, updatedAt: 1 });
  const snapshot = createSnapshot(db, {
    projectId: 'project', pluginId: 'example', pluginVersion: '1.0.0', pluginTitle: 'Example', pluginDescription: 'An inert example',
    manifestSourceDigest: 'a'.repeat(64), resolvedSource: pluginRoot, taskKind: 'new-generation', inputs: { secret: 'PRIVATE_INPUT' },
    resolvedContext: { items: [{ kind: 'asset', path: assetPath, label: 'Reference' }], ...(fragments ? { promptFragments: fragments } : {}) },
    assetsStaged: [{ path: './notes.txt', src: './notes.txt', stageAt: 'run-start' }], craftRequires: [],
    capabilitiesGranted: ['PRIVATE_GRANT'], capabilitiesRequired: [], connectorsRequired: [], connectorsResolved: [], mcpServers: [],
    pipeline: { stages: [{ id: 'private-runtime', atoms: ['PRIVATE_EXECUTION'] }] },
  });
  db.prepare('UPDATE projects SET applied_plugin_snapshot_id = ? WHERE id = ?').run(snapshot.snapshotId, 'project');
  const store = createProjectGitStore(db);
  const reader = createProjectGitOwnedResourceReader({ db });
  const reference = `plugin:project:${snapshot.snapshotId}`;
  const exportProject = () => exportPortableProject({ db, store, root: projectRoot, projectId: 'project', repositoryProjectId: 'repository', cloneId: 'clone',
    readOwnedResource: reference => reader('project', reference) });
  return { root, db, store, snapshot, pluginRoot, projectRoot, assetBytes, reader, reference, exportProject };
}

it('freezes every declared asset as inert bytes, including mixed prompt-fragment snapshots', async () => {
  const f = await fixture('./image.bin', { description: 'Frozen prompt' });
  const exported = await f.exportProject();
  expect(parsePortableEntries(exported.entries)).toEqual(exported.snapshot);
  const resource = exported.snapshot.manifest.resources[0]!;
  const blob = Buffer.from(exported.entries.get(resource.locations[0]!.path)!);
  const content = JSON.parse(blob.toString());
  expect(content.promptFragments).toEqual({ description: 'Frozen prompt' });
  expect(content.assets).toEqual([
    { path: 'image.bin', encoding: 'base64', content: 'AP8NCg==', sha256: createHash('sha256').update(f.assetBytes).digest('hex') },
    { path: 'notes.txt', encoding: 'base64', content: Buffer.from('Declared only in staged assets').toString('base64'), sha256: createHash('sha256').update('Declared only in staged assets').digest('hex') },
  ]);
  expect(resource.digest).toBe(createHash('sha256').update(blob).digest('hex'));
  for (const forbidden of ['PRIVATE_INPUT', 'PRIVATE_GRANT', 'PRIVATE_EXECUTION', 'resolvedSource', f.pluginRoot, 'capabilities', 'pipeline']) expect(blob.toString()).not.toContain(forbidden);
});

it('uses native project and snapshot ownership instead of parsing opaque reference IDs', async () => {
  const f = await fixture();
  expect(await f.reader('other', f.reference)).toBeNull();
  f.db.prepare('UPDATE projects SET applied_plugin_snapshot_id = ? WHERE id = ?').run(f.snapshot.snapshotId, 'other');
  expect(await f.reader('other', `plugin:other:${f.snapshot.snapshotId}`)).toBeNull();
  expect(await f.reader('project', `plugin:project:${f.snapshot.snapshotId}:extra`)).toBeNull();
  expect(await f.reader('project', 'plugin:project:unknown')).toBeNull();
});

it.each(['../outside.txt', '/tmp/outside.txt', './nested/../image.bin', './nested\\image.bin', './.env', './.git/config'])('rejects an unsafe declared asset path %s', async asset => {
  const f = await fixture(asset);
  await expect(f.exportProject()).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_MISSING' });
});

it.each([undefined, { description: 'Frozen prompt' }])('rejects missing required bytes and linked assets with fragments %s', async fragments => {
  const f = await fixture('./image.bin', fragments);
  await rm(join(f.pluginRoot, 'notes.txt'));
  await expect(f.exportProject()).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_MISSING' });
  await symlink(join(f.pluginRoot, 'image.bin'), join(f.pluginRoot, 'notes.txt'));
  await expect(f.exportProject()).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_MISSING' });
});

it('re-exports imported content after both native source directories disappear without restoring plugin authority', async () => {
  const source = await fixture(); const target = await fixture();
  const exported = await source.exportProject();
  for (const [path, bytes] of exported.entries) {
    await mkdir(dirname(join(target.projectRoot, path)), { recursive: true });
    await writeFile(join(target.projectRoot, path), bytes);
  }
  const binding = target.store.saveBinding({ projectId: 'project', cloneId: 'clone-target', repositoryProjectId: 'repository',
    canonicalRoot: target.projectRoot, commonDir: join(target.projectRoot, '.git'), branch: 'main', remoteUrl: null,
    generation: 0, autoSync: false, localHead: null, observedRemoteHead: null, confirmedRemoteHead: null,
    projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: null, dirty: false });
  const basis = { bindingGeneration: binding.generation, projectRevision: 0, contentRevision: 0, localHead: null, remoteHead: null };
  const marker = portableImportMarker(exported.snapshot);
  const op = target.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'restore', basis,
    idempotencyKey: 'import', requestDigest: marker, payload: {} });
  const data: ProjectGitRecoveryData = { operationRoot: join(target.root, 'operation'), baseHead: null,
    previewContentDigest: marker, candidateTreeOid: 'tree', publishBase: null, publicationParents: [],
    publishHead: 'candidate', candidateOid: 'candidate', paths: [],
    index: { path: join(target.projectRoot, '.git/index'), oldDigest: null, candidateDigest: 'index', backupPath: null, ownerToken: 'owner', published: false },
    records: { importMarker: marker, applied: false }, refPublished: false };
  for (const phase of ['prepared', 'protected', 'files_applied'] as const) {
    target.store.setPhase(op.id, phase, data); target.store.completePhase(op.id, phase, data);
  }
  target.store.setPhase(op.id, 'records_applied', data);
  importPortableRecords({ db: target.db, store: target.store, projectId: 'project', cloneId: 'clone-target', snapshot: exported.snapshot, operationId: op.id });
  await rm(source.pluginRoot, { recursive: true }); await rm(target.pluginRoot, { recursive: true });
  const again = await exportPortableProject({ db: target.db, store: target.store, root: target.projectRoot, projectId: 'project', repositoryProjectId: 'repository', cloneId: 'clone-target',
    readOwnedResource: reference => target.reader('project', reference) });
  expect([...again.entries]).toEqual([...exported.entries]);
  expect(await target.reader('project', target.reference)).toBeNull();
});

it('does not treat an old prompt-only resource as proof that declared native assets were saved', async () => {
  const f = await fixture('./image.bin', { description: 'Old fragments' });
  const exported = await f.exportProject();
  const partial = Buffer.from(canonicalJson({ schemaVersion: 1, pluginId: 'example', pluginVersion: '1.0.0', promptFragments: { description: 'Old fragments' } }));
  const digest = createHash('sha256').update(partial).digest('hex');
  const resource = exported.snapshot.manifest.resources[0]!;
  resource.digest = digest;
  for (const location of resource.locations) location.path = `.open-design/resources/${digest}/content`;
  exported.snapshot.project.contentRefs = [digest];
  const entries = serializePortableMetadata(exported.snapshot);
  entries.set(resource.locations[0]!.path, partial);
  for (const [path, bytes] of entries) {
    await mkdir(dirname(join(f.projectRoot, path)), { recursive: true });
    await writeFile(join(f.projectRoot, path), bytes);
  }
  await rm(f.pluginRoot, { recursive: true });
  await expect(f.exportProject()).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_MISSING' });
});
