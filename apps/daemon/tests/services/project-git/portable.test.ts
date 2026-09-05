import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { JsonValue } from '@open-design/contracts';
import { canonicalJson, exportProjectPreferences, exportPortableProject, portableImportMarker, portableIdSegment, parsePortableEntries, serializePortableMetadata } from '../../../src/services/project-git/portable.js';
import { importPortableRecords, readPortableRecords } from '../../../src/services/project-git/portable-db.js';
import { appendMessageAgentEvent, closeDatabase, insertConversation, insertProject, listMessages,
  openDatabase, upsertMessage } from '../../../src/db.js';
import { createProjectGitStore, type ProjectGitRecoveryData, type ProjectGitStore } from '../../../src/storage/project-git.js';

describe('portable serialization', () => {
  it('serializes deterministically and never migrates local authority', () => {
    expect(canonicalJson({ z: 2, a: { y: 1, x: 0 } })).toBe('{"a":{"x":0,"y":1},"z":2}\n');
    expect(exportProjectPreferences({ kind: 'prototype', imageModel: 'chosen-model',
      baseDir: '/private/local', fromTrustedPicker: true, linkedDirs: ['/private/source'] }))
      .toEqual({ imageModel: 'chosen-model' });
    expect(canonicalJson([3, { z: 2, a: 1 }, 1])).toBe('[3,{"a":1,"z":2},1]\n');
  });

  it.each([undefined, NaN, Infinity, { a: undefined }, [undefined], new Date(),
    { n: 1n }, () => 1, Symbol('x')])('rejects invalid JSON instead of silently changing bytes: %s', (value) => {
    expect(() => canonicalJson(value as JsonValue)).toThrow();
  });

  it('preserves allowed prompt and review display while excluding queued work', () => {
    expect(exportProjectPreferences({ kind: 'image', promptTemplate: {
      id: 'template', surface: 'image', title: 'Cover', prompt: 'Draw a cover',
      source: { repo: 'catalog', license: 'MIT', author: 'author' },
    }, designSystemReview: { colors: {
      decision: 'needs-work', updatedAt: '2026-09-05', feedback: 'More contrast',
      files: ['colors.html'], task: { status: 'queued' },
    } } } as Parameters<typeof exportProjectPreferences>[0])).toEqual({
      promptTemplate: { id: 'template', surface: 'image', title: 'Cover', prompt: 'Draw a cover',
        source: { repo: 'catalog', license: 'MIT', author: 'author' } },
      designSystemReview: { colors: { decision: 'needs-work', updatedAt: '2026-09-05',
        feedback: 'More contrast', files: ['colors.html'] } },
    });
  });
});

describe('portable database roundtrip', () => {
  const roots: string[] = []; const databases: Database.Database[] = [];
  afterEach(async () => {
    closeDatabase();
    for (const db of databases.splice(0)) if (db.open) db.close();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  async function database() {
    const root = await mkdtemp(join(tmpdir(), 'od-portable-roundtrip-')); roots.push(root);
    openDatabase(root, { dataDir: root }); closeDatabase();
    const db = new Database(join(root, 'app.sqlite')); databases.push(db);
    db.pragma('foreign_keys = ON');
    return { db, root, store: createProjectGitStore(db) };
  }
  function recordsOperation(store: ProjectGitStore, root: string, projectId: string, marker: string) {
    const binding = store.saveBinding({ projectId, cloneId: 'clone-two', repositoryProjectId: 'repository',
      canonicalRoot: root, commonDir: join(root, '.git'), branch: 'main', remoteUrl: null,
      generation: 0, autoSync: false, localHead: null, observedRemoteHead: null, confirmedRemoteHead: null,
      projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: null, dirty: false });
    const basis = { bindingGeneration: binding.generation, projectRevision: 0, contentRevision: 0,
      localHead: null, remoteHead: null };
    const op = store.enqueueOperation({ projectId, actorId: 'local', kind: 'open', basis,
      idempotencyKey: 'import-once', requestDigest: marker, payload: {} });
    const data: ProjectGitRecoveryData = { operationRoot: join(root, 'operation'), baseHead: null,
      previewContentDigest: marker, candidateTreeOid: 'tree', publishBase: null, publicationParents: [],
      publishHead: 'candidate', candidateOid: 'candidate', paths: [],
      index: { path: join(root, '.git/index'), oldDigest: null, candidateDigest: 'index',
        backupPath: null, ownerToken: 'owner', published: false },
      records: { importMarker: marker, applied: false }, refPublished: false };
    for (const phase of ['prepared', 'protected', 'files_applied'] as const) {
      store.setPhase(op.id, phase, data); store.completePhase(op.id, phase, data);
    }
    store.setPhase(op.id, 'records_applied', data);
    return op.id;
  }
  async function materialize(root: string, entries: Map<string, Uint8Array>) {
    for (const [file, bytes] of entries) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), bytes); }
  }
  it('roundtrips all project conversations, merged display and resources into independent local IDs', async () => {
    const source = await database(); const target = await database();
    insertProject(source.db, { id: 'local-one', name: 'Portable project', createdAt: 10, updatedAt: 10,
      pendingPrompt: 'Continue only when asked', customInstructions: 'Keep contrast',
      metadata: { kind: 'prototype', entryFile: 'index.html', imageModel: 'chosen-model',
        baseDir: '/not-an-export-root', fromTrustedPicker: true, linkedDirs: ['/private/Brand assets'] } });
    for (const id of ['conversation-local', 'comment-anchor-project', 'comment-anchor-empty']) insertConversation(source.db,
      { id, projectId: 'local-one', title: id, sessionMode: 'design', createdAt: 11, updatedAt: 11 });
    source.db.prepare('INSERT INTO agent_sessions (conversation_id, agent_id, session_id, model, cwd, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('conversation-local', 'codex', 'PRIVATE_SESSION', 'chosen-chat-model', '/private/agent-cwd', 1);
    await writeFile(join(source.root, 'reference.png'), Buffer.from('image bytes'));
    upsertMessage(source.db, 'conversation-local', { id: 'user-local', role: 'user', content: 'Use the image',
      createdAt: 12, attachments: [{ path: 'reference.png', name: 'Reference', kind: 'image', order: 0 }] });
    upsertMessage(source.db, 'conversation-local', { id: 'assistant-local', role: 'assistant', content: 'Starting. ',
      createdAt: 13, runId: 'native-run-should-not-leak', runStatus: 'running', agentId: 'codex',
      events: [{ kind: 'tool_use', id: 'tool-local', name: 'Shell', input: { command: 'PRIVATE_COMMAND' } }] });
    appendMessageAgentEvent(source.db, 'assistant-local', { kind: 'text', text: 'Persisted batch.' });
    upsertMessage(source.db, 'comment-anchor-project', { id: 'comment-message', role: 'user', content: 'Anchored comment', createdAt: 14 });
    await mkdir(join(source.root, '.file-versions/old'), { recursive: true });
    const legacyManifest = Buffer.from('{ "entries": [{"contentPath":"v1.html"}] }\r\n');
    const legacyHtml = Buffer.from('<h1>old</h1>\r\n');
    await writeFile(join(source.root, '.file-versions/old/manifest.json'), legacyManifest);
    await writeFile(join(source.root, '.file-versions/old/v1.html'), legacyHtml);
    const input = { ...source, projectId: 'local-one', repositoryProjectId: 'repository', cloneId: 'clone-one' };
    const first = await exportPortableProject(input);
    expect(first.snapshot.conversations).toHaveLength(2);
    expect(first.snapshot.conversations.find(conversation => conversation.title === 'conversation-local')?.preferences)
      .toEqual({ agentId: 'codex', model: 'chosen-chat-model' });
    expect(first.snapshot.messages.map(message => message.content)).toContain('Starting. Persisted batch.');
    const serialized = canonicalJson(first.snapshot as JsonValue);
    for (const forbidden of ['PRIVATE_COMMAND', 'native-run-should-not-leak', '/private/', '/not-an-export-root',
      'fromTrustedPicker', 'baseDir', 'capabilitiesGranted', 'PRIVATE_SESSION']) expect(serialized).not.toContain(forbidden);
    expect(first.snapshot.project.linkedFolderRequirements).toEqual([{ label: 'Brand assets', purpose: 'reference; relocation required' }]);
    expect(first.snapshot.manifest.resources.flatMap(resource => resource.locations).filter(location => location.purpose === 'legacy-history')).toHaveLength(2);
    expect([...first.entries.values()].some(bytes => Buffer.from(bytes).equals(legacyManifest))).toBe(true);
    expect([...first.entries.values()].some(bytes => Buffer.from(bytes).equals(legacyHtml))).toBe(true);
    await materialize(source.root, first.entries);
    await rm(join(source.root, 'reference.png'));
    expect([...(await exportPortableProject(input)).entries]).toEqual([...first.entries]);
    expect(await readFile(join(source.root, '.file-versions/old/v1.html'))).toEqual(legacyHtml);
    await materialize(target.root, first.entries);
    const operationId = recordsOperation(target.store, target.root, 'local-two', portableImportMarker(first.snapshot));
    const importInput = { ...target, projectId: 'local-two', cloneId: 'clone-two', snapshot: first.snapshot, operationId };
    importPortableRecords(importInput); importPortableRecords(importInput);
    expect(target.store.getBinding('local-two')?.projectRevision).toBe(1);
    expect(target.store.getJournal(operationId)?.basis.projectRevision).toBe(0);
    expect(target.db.prepare('SELECT id FROM messages').all()).not.toContainEqual({ id: 'user-local' });
    expect(target.db.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get()).toEqual({ count: 0 });
    expect(target.db.prepare('SELECT run_id AS runId, run_context_json AS context FROM messages WHERE role = ?').get('assistant'))
      .toEqual({ runId: null, context: null });
    expect(readPortableRecords(target.db, 'local-two')?.messages.map(message => message.content)).toContain('Starting. Persisted batch.');
    const second = await exportPortableProject({ ...target, projectId: 'local-two', repositoryProjectId: 'repository', cloneId: 'clone-two' });
    expect([...second.entries]).toEqual([...first.entries]);
    const localConversation = target.store.mapId('repository', 'clone-two', 'conversation', first.snapshot.messages.find(message => message.context.attachments?.length)!.conversationId);
    const importedAttachment = listMessages(target.db, localConversation).flatMap(message => message.attachments ?? [])[0];
    expect(importedAttachment.path).toContain('/api/projects/local-two/raw/.open-design/resources/');
  });

  it('preserves structured comments, logical turns and inert plugin/skill/scenario content through import', async () => {
    const source = await database(); const target = await database();
    const plugin = { snapshotId: 'snapshot', pluginId: 'plugin-one', pluginVersion: '1.2.3', pluginTitle: 'Helpful plugin',
      resolvedContext: { promptFragments: { design: 'Use large readable typography.' }, items: [] },
      capabilitiesGranted: ['shell'], mcpServers: [{ command: 'PRIVATE_MCP' }], inputs: { key: 'PRIVATE_INPUT' },
      connectorsResolved: [{ status: 'connected', token: 'PRIVATE_TOKEN' }] };
    insertProject(source.db, { id: 'p', name: 'Context project', skillId: 'skill-one', designSystemId: 'design-one',
      createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype', contextPlugins: [{ id: 'plugin-two', title: 'Second' }],
        scenarioBinding: { schemaVersion: 1, pluginId: 'scenario-one', snapshotId: 'scenario-snapshot', boundAt: 1, provenance: 'explicit_user' } } });
    insertConversation(source.db, { id: 'c', projectId: 'p', title: 'Context', createdAt: 2, updatedAt: 2 });
    const comment = { id: 'local-comment', order: 0, filePath: 'index.html', elementId: 'hero', selector: '#hero',
      label: 'Hero', comment: 'Use larger type', currentText: 'Welcome', htmlHint: '<h1>Welcome</h1>',
      pagePosition: { x: 1, y: 2, width: 3, height: 4 }, style: { fontSize: '18px' }, selectionKind: 'pod', memberCount: 1,
      podMembers: [{ elementId: 'child', selector: 'span', label: 'Child', text: 'Welcome',
        position: { x: 5, y: 6, width: 7, height: 8 }, htmlHint: '<span>Welcome</span>', style: { color: '#fff' } }],
      slideIndex: 0, screenshotPath: 'screen.png', imageAttachments: [{ path: 'detail.png', name: 'Detail' }],
      markKind: 'click', intent: 'resize', commentContext: 'context', source: 'saved-comment' };
    await writeFile(join(source.root, 'screen.png'), 'screen'); await writeFile(join(source.root, 'detail.png'), 'detail');
    await writeFile(join(source.root, 'result.html'), '<h1>result</h1>');
    upsertMessage(source.db, 'c', { id: 'u', role: 'user', content: 'Improve heading', createdAt: 3, commentAttachments: [comment] });
    for (const [index, message] of ['a1', 'a2'].entries()) upsertMessage(source.db, 'c', {
      id: message, role: 'assistant', content: index === 0 ? 'Working' : 'Finished', createdAt: 4 + index,
      runId: `run-${index}`, runStatus: 'succeeded', appliedPluginSnapshot: plugin,
      taskAnalytics: { taskExecutionId: 'local-task', taskRunIndex: index },
      runContext: { skillIds: ['turn-skill'], workspaceItems: [{ id: 'folder', kind: 'local-code', label: 'Source', absolutePath: '/private/code' }] },
      producedFiles: index ? [{ name: 'result.html', kind: 'html', size: 15, mtime: 1, mime: 'text/html' }] : [],
    });
    const requests: string[] = [];
    const first = await exportPortableProject({ ...source, projectId: 'p', repositoryProjectId: 'repository', cloneId: 'clone-one',
      readOwnedResource: async reference => { requests.push(reference); return Buffer.from(`content for ${reference.split(':').at(-1)}`); } });
    expect(requests.some(reference => reference.startsWith('skill:'))).toBe(true);
    expect(requests.some(reference => reference.includes('/private/'))).toBe(false);
    expect(new Set(first.snapshot.manifest.resources.flatMap(resource => resource.locations.map(location => location.purpose)))).toEqual(new Set(['attachment', 'artifact', 'skill', 'design-system', 'plugin', 'scenario']));
    const assistants = first.snapshot.messages.filter(message => message.role === 'assistant');
    expect(assistants[0]!.turnId).toBe(assistants[1]!.turnId);
    expect(first.snapshot.messages.find(message => message.role === 'user')!.turnId).toBe(assistants[0]!.turnId);
    const selected = first.snapshot.messages.find(message => message.role === 'user')!.context.commentAttachments![0]!;
    expect(selected).toMatchObject({ order: 0, label: 'Hero', comment: 'Use larger type', currentText: 'Welcome',
      filePath: 'index.html', pagePosition: { x: 1, y: 2, width: 3, height: 4 }, podMembers: comment.podMembers });
    expect(selected).not.toHaveProperty('id'); expect(selected).not.toHaveProperty('screenshotPath');
    for (const bytes of first.entries.values()) for (const secret of ['PRIVATE_MCP', 'PRIVATE_INPUT', 'PRIVATE_TOKEN', 'capabilitiesGranted', '/private/code']) {
      expect(Buffer.from(bytes).toString()).not.toContain(secret);
    }
    await materialize(target.root, first.entries);
    const operationId = recordsOperation(target.store, target.root, 'new-project', portableImportMarker(first.snapshot));
    importPortableRecords({ ...target, projectId: 'new-project', cloneId: 'clone-two', snapshot: first.snapshot, operationId });
    expect(readPortableRecords(target.db, 'new-project')!.messages.find(message => message.role === 'user')!.context.commentAttachments).toEqual([selected]);
    expect(target.db.prepare('SELECT COUNT(*) AS count FROM applied_plugin_snapshots').get()).toEqual({ count: 0 });
    const second = await exportPortableProject({ ...target, projectId: 'new-project', cloneId: 'clone-two', repositoryProjectId: 'repository' });
    expect([...second.entries]).toEqual([...first.entries]);
    target.db.prepare("UPDATE messages SET run_status = 'running', agent_id = NULL WHERE role = 'assistant'").run();
    const edited = await exportPortableProject({ ...target, projectId: 'new-project', cloneId: 'clone-two', repositoryProjectId: 'repository' });
    for (const message of edited.snapshot.messages.filter(message => message.role === 'assistant')) {
      expect(message.terminal).toBe('historical'); expect(message.context.runStatus).toBeUndefined();
    }
    const changed = structuredClone(first.snapshot); changed.project.name = 'Changed after preview';
    expect(() => importPortableRecords({ ...target, projectId: 'new-project', cloneId: 'clone-two', snapshot: changed, operationId }))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
  });

  it('roundtrips feedback without telemetry and honors subsequent live edits and clearing', async () => {
    const source = await database(); const target = await database();
    insertProject(source.db, { id: 'p', name: 'P', createdAt: 1, updatedAt: 1 });
    insertConversation(source.db, { id: 'c', projectId: 'p', title: 'C', createdAt: 1, updatedAt: 1 });
    const feedback = { rating: 'negative', reasonCodes: ['weak_visual', 'other'], customReason: 'Contrast',
      createdAt: 1, reasonsSubmittedAt: 2, updatedAt: 3 };
    upsertMessage(source.db, 'c', { id: 'a', role: 'assistant', content: 'Result', createdAt: 2, feedback });
    const first = await exportPortableProject({ ...source, projectId: 'p', cloneId: 'clone-one', repositoryProjectId: 'repository' });
    expect(first.snapshot.messages[0]!.context).toHaveProperty('feedback', feedback);
    const operationId = recordsOperation(target.store, target.root, 'new-project', portableImportMarker(first.snapshot));
    importPortableRecords({ ...target, projectId: 'new-project', cloneId: 'clone-two', snapshot: first.snapshot, operationId });
    const input = { ...target, projectId: 'new-project', cloneId: 'clone-two', repositoryProjectId: 'repository' };
    expect([...(await exportPortableProject(input)).entries]).toEqual([...first.entries]);
    target.db.prepare('UPDATE messages SET feedback_json = ?').run(JSON.stringify({ rating: 'positive', createdAt: 4 }));
    expect((await exportPortableProject(input)).snapshot.messages[0]!.context)
      .toHaveProperty('feedback', { rating: 'positive', createdAt: 4 });
    target.db.prepare('UPDATE messages SET feedback_json = NULL').run();
    expect((await exportPortableProject(input)).snapshot.messages[0]!.context).not.toHaveProperty('feedback');
  });

  it('encodes arbitrary record IDs safely and rejects mismatched paths, corrupt UTF-8 and missing bytes', async () => {
    expect(portableIdSegment('record')).toBe('id-53d2ba397f4952247b60fcdc8abaf86b0b04ad9dc50028022bcd77226cbc20ec');
    const ids = ['../escape', 'CON', 'Foo', 'foo', '消息', 'é', 'e\u0301', 'a'.repeat(20000)];
    expect(new Set(ids.map(portableIdSegment)).size).toBe(ids.length);
    for (const id of ids) expect(portableIdSegment(id)).toMatch(/^id-[a-f0-9]{64}$/);
    const source = await database();
    insertProject(source.db, { id: 'p', name: 'Codec', createdAt: 1, updatedAt: 1 });
    insertConversation(source.db, { id: 'c', projectId: 'p', title: 'C', createdAt: 1, updatedAt: 1 });
    upsertMessage(source.db, 'c', { id: 'm', role: 'user', content: 'Text', createdAt: 2 });
    source.store.attachId('repository', 'clone-one', 'conversation', '../escape', 'c');
    source.store.attachId('repository', 'clone-one', 'message', '消息', 'm');
    const result = await exportPortableProject({ ...source, projectId: 'p', cloneId: 'clone-one', repositoryProjectId: 'repository' });
    expect(parsePortableEntries(result.entries)).toEqual(result.snapshot);
    expect([...serializePortableMetadata(result.snapshot)]).toEqual([...result.entries]);
    expect(parsePortableEntries(serializePortableMetadata(result.snapshot))).toEqual(result.snapshot);
    expect(() => serializePortableMetadata({ ...result.snapshot, project: { ...result.snapshot.project, schemaVersion: 2 } } as unknown as typeof result.snapshot)).toThrow();
    const mismatch = new Map(result.entries);
    const messageFile = [...mismatch.keys()].find(file => file.includes('/messages/'))!;
    const message = JSON.parse(Buffer.from(mismatch.get(messageFile)!).toString()); message.id = 'Changed';
    mismatch.set(messageFile, Buffer.from(JSON.stringify(message)));
    expect(() => parsePortableEntries(mismatch)).toThrow();
    const invalid = new Map(result.entries); invalid.set('.open-design/project.json', new Uint8Array([0xff]));
    expect(() => parsePortableEntries(invalid)).toThrow();
  });

  it('rolls back rows, adjunct, mappings, marker and epoch together; alias turns survive reopen and later local edits', async () => {
    const source = await database(); const target = await database();
    insertProject(source.db, { id: 'p', name: 'Before', createdAt: 1, updatedAt: 1 });
    insertConversation(source.db, { id: 'c', projectId: 'p', title: 'Before', createdAt: 1, updatedAt: 1 });
    upsertMessage(source.db, 'c', { id: 'u', role: 'user', content: 'Before', createdAt: 2 });
    const exported = await exportPortableProject({ ...source, projectId: 'p', cloneId: 'clone-one', repositoryProjectId: 'repository' });
    const snapshot = exported.snapshot; snapshot.messages[0]!.turnId = snapshot.messages[0]!.id;
    const operationId = recordsOperation(target.store, target.root, 'new-project', portableImportMarker(snapshot));
    const input = { ...target, projectId: 'new-project', cloneId: 'clone-two', snapshot, operationId };
    target.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'owned fixture failure'); END");
    expect(() => importPortableRecords(input)).toThrow('owned fixture failure');
    for (const table of ['projects', 'messages', 'conversations', 'project_git_id_map', 'project_git_portable_records']) {
      expect(target.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(target.store.getJournal(operationId)?.recordsTransition).toBeNull();
    expect(target.store.getBinding('new-project')?.projectRevision).toBe(0);
    target.db.exec('DROP TRIGGER fail_import'); importPortableRecords(input);
    target.db.close(); const reopened = new Database(join(target.root, 'app.sqlite')); databases.push(reopened);
    const store = createProjectGitStore(reopened);
    const localMessage = store.mapId('repository', 'clone-two', 'message', snapshot.messages[0]!.id);
    const localTurn = store.mapId('repository', 'clone-two', 'turn', snapshot.messages[0]!.id);
    expect(localTurn).not.toBe(localMessage);
    reopened.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Local edit', localMessage);
    reopened.prepare('UPDATE projects SET name = ?, metadata_json = ? WHERE id = ?')
      .run('Local name', JSON.stringify({ kind: 'prototype', imageModel: 'new-model' }), 'new-project');
    importPortableRecords({ ...input, db: reopened, store });
    const next = await exportPortableProject({ db: reopened, store, root: target.root, projectId: 'new-project', cloneId: 'clone-two', repositoryProjectId: 'repository' });
    expect(next.snapshot.messages[0]).toMatchObject({ id: snapshot.messages[0]!.id, turnId: snapshot.messages[0]!.id, content: 'Local edit' });
    expect(next.snapshot.project).toMatchObject({ name: 'Local name', preferences: { imageModel: 'new-model' } });
    expect(store.getBinding('new-project')?.projectRevision).toBe(1);
    reopened.prepare("DELETE FROM project_git_portable_records WHERE kind = 'message'").run();
    expect(() => readPortableRecords(reopened, 'new-project')).toThrowError(expect.objectContaining({ code: 'PORTABLE_FORMAT_UNSUPPORTED' }));
    reopened.prepare("UPDATE project_git_portable_records SET record_json = '{}' WHERE kind = 'project'").run();
    expect(() => readPortableRecords(reopened, 'new-project')).toThrow();
  });

  it('rejects another database handle even when both handles have active transactions', async () => {
    const source = await database(); const target = await database();
    insertProject(source.db, { id: 'p', name: 'P', createdAt: 1, updatedAt: 1 });
    const { snapshot } = await exportPortableProject({ ...source, projectId: 'p', cloneId: 'clone-one', repositoryProjectId: 'repository' });
    const operationId = recordsOperation(target.store, target.root, 'new-project', portableImportMarker(snapshot));
    const other = new Database(join(target.root, 'app.sqlite')); databases.push(other);
    target.db.exec('BEGIN'); other.exec('BEGIN');
    try {
      expect(() => importPortableRecords({ db: other, store: target.store, projectId: 'new-project', cloneId: 'clone-two', snapshot, operationId }))
        .toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
      expect(target.store.getJournal(operationId)?.recordsTransition).toBeNull();
      expect(other.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 0 });
      expect(other.prepare('SELECT COUNT(*) AS count FROM project_git_id_map').get()).toEqual({ count: 0 });
    } finally { other.exec('ROLLBACK'); target.db.exec('ROLLBACK'); }
  });

  it('removes locally removed attachments and content selections instead of retaining stale snapshot authority', async () => {
    const source = await database();
    insertProject(source.db, { id: 'p', name: 'P', skillId: 'old-skill', createdAt: 1, updatedAt: 1 });
    insertConversation(source.db, { id: 'c', projectId: 'p', title: 'C', createdAt: 1, updatedAt: 1 });
    upsertMessage(source.db, 'c', { id: 'u', role: 'user', content: 'Before', createdAt: 2,
      attachments: [{ path: 'attachment.txt', name: 'Attachment', kind: 'file' }] });
    await writeFile(join(source.root, 'attachment.txt'), 'file');
    const input = { ...source, projectId: 'p', cloneId: 'clone-one', repositoryProjectId: 'repository',
      readOwnedResource: async () => Buffer.from('skill content') };
    const first = await exportPortableProject(input); await materialize(source.root, first.entries);
    source.db.prepare('UPDATE messages SET attachments_json = ?, content = ? WHERE id = ?').run('[]', 'After', 'u');
    source.db.prepare('UPDATE projects SET skill_id = NULL WHERE id = ?').run('p');
    const next = await exportPortableProject(input);
    expect(next.snapshot.messages[0]).toMatchObject({ content: 'After', resourceRefs: [], context: { attachments: [] } });
    expect(next.snapshot.project.contentRefs).toEqual([]);
    expect(next.snapshot.manifest.resources).toEqual([]);
  });

  it('fails clearly without a required content reader and rewrites local event links without exporting raw tool inputs', async () => {
    const source = await database();
    insertProject(source.db, { id: 'p', name: 'P', skillId: 'missing-skill', createdAt: 1, updatedAt: 1 });
    const input = { ...source, projectId: 'p', cloneId: 'clone-one', repositoryProjectId: 'repository' };
    await expect(exportPortableProject(input)).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_MISSING' });
    source.db.prepare('UPDATE projects SET skill_id = NULL WHERE id = ?').run('p');
    insertConversation(source.db, { id: 'c', projectId: 'p', title: 'C', createdAt: 1, updatedAt: 1 });
    await writeFile(join(source.root, 'image.png'), 'image');
    upsertMessage(source.db, 'c', { id: 'a', role: 'assistant', content: 'See image', createdAt: 2,
      attachments: [{ path: 'http://localhost:12345/api/projects/p/raw/image.png', name: 'Image', kind: 'image' }],
      events: [{ kind: 'tool_result', toolUseId: 'tool', isError: false,
        content: 'http://localhost:12345/api/projects/p/raw/image.png' },
      { kind: 'diagnostic', name: 'trace', files: ['/private/unavailable'] }] });
    const result = await exportPortableProject(input);
    expect(result.snapshot.messages[0]!.displayEvents).toContainEqual({ kind: 'result', text: result.snapshot.manifest.resources[0]!.locations[0].path });
    expect(canonicalJson(result.snapshot as JsonValue)).not.toContain('localhost:12345');
    expect(result.snapshot.messages[0]!.displayEvents).toContainEqual({ kind: 'thinking', text: 'Diagnostic content unavailable', unavailable: true });
  });

  it('keeps all attachment, skill, plugin and legacy aliases of identical bytes and rejects a missing archive member', async () => {
    const source = await database();
    insertProject(source.db, { id: 'p', name: 'P', skillId: 'shared-skill', createdAt: 1, updatedAt: 1,
      metadata: { kind: 'prototype', contextPlugins: [{ id: 'shared-plugin', title: 'Plugin' }] } });
    insertConversation(source.db, { id: 'c', projectId: 'p', title: 'C', createdAt: 1, updatedAt: 1 });
    upsertMessage(source.db, 'c', { id: 'u', role: 'user', content: 'Keep this', createdAt: 2,
      attachments: [{ path: 'shared.html', name: 'Shared', kind: 'file' }] });
    const bytes = Buffer.from('<h1>shared</h1>\r\n');
    await writeFile(join(source.root, 'shared.html'), bytes);
    await mkdir(join(source.root, '.file-versions/old'), { recursive: true });
    const manifest = Buffer.from('{ "entries": [{"contentPath":"one.html"},{"contentPath":"two.html"}] }\r\n');
    await writeFile(join(source.root, '.file-versions/old/manifest.json'), manifest);
    await writeFile(join(source.root, '.file-versions/old/one.html'), bytes);
    await writeFile(join(source.root, '.file-versions/old/two.html'), bytes);
    const input = { ...source, projectId: 'p', cloneId: 'clone-one', repositoryProjectId: 'repository', readOwnedResource: async () => bytes };
    const result = await exportPortableProject(input);
    const resource = result.snapshot.manifest.resources.find(item => item.locations.some(location => location.purpose === 'attachment'))!;
    expect(resource.locations.map(location => location.purpose).sort()).toEqual(['attachment', 'legacy-history', 'legacy-history', 'plugin', 'skill']);
    for (const name of ['one.html', 'two.html']) expect(Buffer.from(result.entries.get(`.open-design/legacy-file-history/old/${name}`)!)).toEqual(bytes);
    expect(Buffer.from(result.entries.get('.open-design/legacy-file-history/old/manifest.json')!)).toEqual(manifest);
    expect(parsePortableEntries(result.entries)).toEqual(result.snapshot);
    const missing = new Map(result.entries); missing.delete('.open-design/legacy-file-history/old/two.html');
    expect(() => parsePortableEntries(missing)).toThrowError(expect.objectContaining({ code: 'PORTABLE_RESOURCE_MISSING' }));
    await rm(join(source.root, '.file-versions/old/two.html'));
    await expect(exportPortableProject(input)).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_MISSING' });
  });
  it('archives event-only project file links and marks unavailable machine diagnostics without reading foreign paths', async () => {
    const source = await database();
    insertProject(source.db, { id: 'p', name: 'P', createdAt: 1, updatedAt: 1 });
    insertConversation(source.db, { id: 'c', projectId: 'p', title: 'C', createdAt: 1, updatedAt: 1 });
    await writeFile(join(source.root, 'event.html'), '<h1>event result</h1>');
    upsertMessage(source.db, 'c', { id: 'a', role: 'assistant', content: 'Result', createdAt: 2, events: [
      { kind: 'tool_result', toolUseId: 'tool', isError: false,
        content: 'Result: http://localhost:9999/api/projects/p/raw/event.html' },
      { kind: 'thinking', text: 'Logs: file:///private/log.txt /api/projects/foreign/raw/private.txt' },
      { kind: 'text', text: 'Reference https://example.com/page' },
    ] });
    const requests: string[] = [];
    const input = { ...source, projectId: 'p', cloneId: 'clone-one', repositoryProjectId: 'repository',
      readOwnedResource: async (reference: string) => { requests.push(reference); return null; } };
    const result = await exportPortableProject(input);
    const resource = result.snapshot.manifest.resources[0]!;
    expect(resource).toBeDefined();
    expect(result.snapshot.messages[0]!.displayEvents).toContainEqual({ kind: 'result', text: `Result: ${resource.locations[0].path}` });
    expect(result.snapshot.messages[0]!.displayEvents).toContainEqual({ kind: 'thinking',
      text: 'Logs: [Local content unavailable] [Local content unavailable]', unavailable: true });
    expect(result.snapshot.messages[0]!.displayEvents).toContainEqual({ kind: 'text', text: 'Reference https://example.com/page' });
    expect(requests).toEqual([]);
    await materialize(source.root, result.entries); await rm(join(source.root, 'event.html'));
    expect([...(await exportPortableProject(input)).entries]).toEqual([...result.entries]);
  });
  it('refuses unknown or newer .open-design metadata before attaching IDs or overwriting bytes', async () => {
    const source = await database();
    insertProject(source.db, { id: 'p', name: 'P', createdAt: 1, updatedAt: 1 });
    await mkdir(join(source.root, '.open-design'));
    const input = { ...source, projectId: 'p', cloneId: 'clone-one', repositoryProjectId: 'repository' };
    await expect(exportPortableProject(input)).rejects.toMatchObject({ code: 'PORTABLE_FORMAT_UNSUPPORTED' });
    const newer = Buffer.from('{"schemaVersion":2,"repositoryProjectId":"repository","resources":[]}\n');
    await writeFile(join(source.root, '.open-design/manifest.json'), newer);
    await expect(exportPortableProject(input)).rejects.toThrow();
    expect(await readFile(join(source.root, '.open-design/manifest.json'))).toEqual(newer);
    expect(source.db.prepare('SELECT COUNT(*) AS count FROM project_git_id_map').get()).toEqual({ count: 0 });
  });
});
