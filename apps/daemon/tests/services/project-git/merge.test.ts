import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parsePortableSnapshot, type JsonValue, type PortableSnapshot, type PortableMessage } from '@open-design/contracts';
import { mergeFileTrees, mergePortableSnapshots, mergeValue } from '../../../src/services/project-git/merge.js';
import { parsePortableEntries, serializePortableMetadata } from '../../../src/services/project-git/portable.js';
import { runGit } from '../../../src/services/project-git/git-process.js';
import { createGitFixture } from '../../helpers/project-git.js';

function snapshot(): PortableSnapshot {
  return { manifest: { schemaVersion: 1, repositoryProjectId: 'repository', resources: [] },
    project: { schemaVersion: 1, name: 'Project', createdAt: 1, kind: 'prototype', preferences: {}, contentRefs: [], linkedFolderRequirements: [] },
    conversations: [{ schemaVersion: 1, id: 'chat', title: 'Chat', mode: 'design', createdAt: 1 }], messages: [] };
}
function message(id: string, predecessorId: string | null = null, conversationId = 'chat'): PortableMessage {
  return { schemaVersion: 1, id, conversationId, role: 'user', content: id, createdAt: 1,
    predecessorId, turnId: `turn-${id}`, terminal: 'historical', resourceRefs: [], displayEvents: [], context: {} };
}
const clone = <T>(value: T): T => structuredClone(value);

describe('portable three-way merge', () => {
  it('does not silently choose deletion over an edited message', () => {
    expect(mergeValue('old', undefined, 'edited')).toEqual({ kind: 'conflict', base: 'old', local: undefined, remote: 'edited' });
    expect(mergeValue('old', undefined, 'old')).toEqual({ kind: 'merged', value: undefined });
    expect(mergeValue('old', 'new', 'new')).toEqual({ kind: 'merged', value: 'new' });
  });

  it('compares canonical JSON while retaining semantic array order and rejecting unsupported objects', () => {
    expect(mergeValue(undefined, { z: 1, a: 2 }, { a: 2, z: 1 })).toEqual({ kind: 'merged', value: { a: 2, z: 1 } });
    expect(mergeValue([1, 2], [2, 1], [1, 2, 3]).kind).toBe('conflict');
    expect(() => mergeValue(undefined, new Date() as unknown as JsonValue, {})).toThrow();
  });

  it('merges independent fields and nested preferences without choosing by timestamps', () => {
    const base = snapshot(); const local = clone(base); const remote = clone(base);
    local.project.name = 'Local name'; local.project.preferences.agentId = 'local-agent';
    remote.project.customInstructions = 'Remote instructions'; remote.project.preferences.model = 'remote-model';
    const result = mergePortableSnapshots(base, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.snapshot?.project).toMatchObject({ name: 'Local name', customInstructions: 'Remote instructions',
      preferences: { agentId: 'local-agent', model: 'remote-model' } });
    expect(parsePortableSnapshot(result.snapshot)).toEqual(result.snapshot);
  });

  it('returns inspectable field conflicts and rejects another repository project', () => {
    const base = snapshot(); const local = clone(base); const remote = clone(base);
    local.project.name = 'Local'; remote.project.name = 'Remote';
    expect(mergePortableSnapshots(base, local, remote)).toMatchObject({ snapshot: null, conflicts: [{ kind: 'field', path: 'project/name',
      base: { kind: 'json', value: 'Project' }, local: { kind: 'json', value: 'Local' }, remote: { kind: 'json', value: 'Remote' } }] });
    remote.manifest.repositoryProjectId = 'another';
    expect(() => mergePortableSnapshots(base, local, remote)).toThrow(/repository project/i);
  });

  it('preserves arbitrary review field keys when nested preference objects merge', () => {
    const base = snapshot(); base.project.preferences.designSystemReview = {};
    const local = clone(base); const remote = clone(base);
    local.project.preferences.designSystemReview = JSON.parse('{"__proto__":{"decision":"looks-good","updatedAt":"special"},"constructor":{"decision":"looks-good","updatedAt":"local"}}');
    local.project.preferences.examplePromptBrief = JSON.parse('{"__proto__":"special","constructor":"local"}');
    remote.project.preferences.designSystemReview = { color: { decision: 'needs-work', updatedAt: 'remote' } };
    remote.project.preferences.examplePromptBrief = { color: 'remote' };
    const result = mergePortableSnapshots(base, local, remote);
    expect(result.conflicts).toEqual([]);
    const reviews = result.snapshot!.project.preferences.designSystemReview!;
    expect(Object.keys(reviews).sort()).toEqual(['__proto__', 'color', 'constructor']); expect(Object.getPrototypeOf(reviews)).toBe(Object.prototype);
    expect(result.snapshot!.project.preferences.examplePromptBrief).toEqual(JSON.parse('{"__proto__":"special","constructor":"local","color":"remote"}'));
  });

  it('merges independent conversations and identical appends by stable message IDs', () => {
    const base = snapshot(); const local = clone(base); const remote = clone(base);
    local.messages.push(message('same')); remote.messages.push(message('same'));
    remote.conversations.push({ ...base.conversations[0]!, id: 'other' }); remote.messages.push(message('other-message', null, 'other'));
    const result = mergePortableSnapshots(base, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.snapshot?.messages.map(m => m.id).sort()).toEqual(['other-message', 'same']);
  });

  it('merges edits to different messages but keeps content, feedback and displayEvents indivisible', () => {
    const base = snapshot(); base.messages = [message('first'), message('second', 'first')];
    const local = clone(base); const remote = clone(base);
    local.messages[0]!.content = 'local edit'; remote.messages[1]!.content = 'remote edit';
    expect(mergePortableSnapshots(base, local, remote).snapshot?.messages.map(m => m.content)).toEqual(['local edit', 'remote edit']);
    remote.messages[0]!.displayEvents = [{ kind: 'text', text: 'remote display' }];
    remote.messages[0]!.context.feedback = { rating: 'positive', createdAt: 2 };
    expect(mergePortableSnapshots(base, local, remote)).toMatchObject({ snapshot: null, conflicts: [{ kind: 'message', recordId: 'first',
      local: { kind: 'json', value: { content: 'local edit' } }, remote: { kind: 'json', value: { displayEvents: [{ kind: 'text', text: 'remote display' }] } } }] });
  });

  it('keeps both full turns visible when independent appends compete for the same predecessor', () => {
    const base = snapshot(); base.messages.push(message('base'));
    const local = clone(base); const remote = clone(base);
    for (const [side, id] of [[local, 'local'], [remote, 'remote']] as const) {
      side.messages.push(message(id, 'base'), { ...message(`${id}-reply`, id), role: 'assistant', turnId: `turn-${id}` });
    }
    const result = mergePortableSnapshots(base, local, remote);
    expect(result.snapshot).toBeNull();
    expect(result.conflicts).toContainEqual(expect.objectContaining({ kind: 'conversation_order', recordId: 'chat',
      local: { kind: 'json', value: local.messages }, remote: { kind: 'json', value: remote.messages } }));
  });

  it('rejects a partial turn deletion even when the remaining predecessor graph is valid', () => {
    const base = snapshot(); base.messages = [message('user'), { ...message('reply', 'user'), role: 'assistant', turnId: 'turn-user' }];
    const local = clone(base); local.messages.pop();
    expect(mergePortableSnapshots(base, local, base)).toMatchObject({ snapshot: null, conflicts: [{ kind: 'conversation_order', recordId: 'chat' }] });
  });

  it('rejects a cycle assembled from two valid predecessor chains', () => {
    const base = snapshot(); base.messages = [message('a'), message('b', 'a'), message('c', 'b'), message('d', 'c')];
    const local = clone(base); const remote = clone(base);
    local.messages = [message('a'), message('c', 'a'), message('d', 'c'), message('b', 'd')];
    remote.messages = [message('d'), message('b', 'd'), message('c', 'b'), message('a', 'c')];
    expect(parsePortableSnapshot(local)).toEqual(local); expect(parsePortableSnapshot(remote)).toEqual(remote);
    expect(mergePortableSnapshots(base, local, remote)).toMatchObject({ snapshot: null,
      conflicts: [expect.objectContaining({ kind: 'conversation_order', recordId: 'chat' })] });
  });

  it('does not split an existing user/reply pair by changing only one turn ID', () => {
    const base = snapshot(); base.messages = [message('user'), { ...message('reply', 'user'), role: 'assistant', turnId: 'turn-user' }];
    const local = clone(base); local.messages[1]!.turnId = 'split';
    expect(mergePortableSnapshots(base, local, base)).toMatchObject({ snapshot: null,
      conflicts: [expect.objectContaining({ kind: 'conversation_order', recordId: 'chat' })] });
  });

  it('reports cross-conversation predecessors created by independently moving messages', () => {
    const base = snapshot(); base.conversations.push({ ...base.conversations[0]!, id: 'other' });
    base.messages = [message('a'), message('b', null, 'other')];
    const local = clone(base); const remote = clone(base);
    local.messages[0]!.conversationId = 'other'; local.messages[0]!.predecessorId = 'b';
    remote.messages[1]!.conversationId = 'chat'; remote.messages[1]!.predecessorId = 'a';
    expect(parsePortableSnapshot(local)).toEqual(local); expect(parsePortableSnapshot(remote)).toEqual(remote);
    const result = mergePortableSnapshots(base, local, remote);
    expect(result.snapshot).toBeNull(); expect(result.conflicts.map(value => [value.kind, 'recordId' in value ? value.recordId : value.path]))
      .toEqual([['conversation_order', 'chat'], ['conversation_order', 'other']]);
  });

  it('does not silently delete a resource whose role/path aliases were edited remotely', () => {
    const base = snapshot(); const digest = 'a'.repeat(64); const path = `.open-design/resources/${digest}/file`;
    base.manifest.resources = [{ digest, locations: [{ path, purpose: 'attachment' }], references: [] }];
    const local = clone(base); local.manifest.resources = []; const remote = clone(base);
    remote.manifest.resources[0]!.locations.push({ path, purpose: 'skill' });
    expect(mergePortableSnapshots(base, local, remote)).toMatchObject({ snapshot: null,
      conflicts: [expect.objectContaining({ kind: 'resource' })] });
  });

  it('keeps every shared resource alias and rebuilds reciprocal references from merged records', () => {
    const base = snapshot(); const local = clone(base); const remote = clone(base); const digest = 'a'.repeat(64);
    const path = `.open-design/resources/${digest}/shared`;
    local.messages = [message('local')]; local.messages[0]!.resourceRefs = [digest];
    remote.conversations = [{ ...base.conversations[0]!, id: 'other' }]; remote.messages = [message('remote', null, 'other')]; remote.messages[0]!.resourceRefs = [digest];
    local.manifest.resources = [{ digest, locations: [{ path, purpose: 'attachment' }], references: ['local'] }];
    remote.manifest.resources = [{ digest, locations: [{ path, purpose: 'skill' }, { path: '.open-design/legacy-file-history/archive.html', purpose: 'legacy-history' }], references: ['remote'] }];
    // Keep the original conversation so the remote side does not concurrently delete it.
    remote.conversations.push(base.conversations[0]!);
    const result = mergePortableSnapshots(base, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.snapshot?.manifest.resources).toEqual([{ digest, locations: expect.arrayContaining([
      { path, purpose: 'attachment' }, { path, purpose: 'skill' }, { path: '.open-design/legacy-file-history/archive.html', purpose: 'legacy-history' },
    ]), references: ['local', 'remote'] }]);
  });

  it('reports a missing resource when one side removes it and another new message still requires it', () => {
    const digest = 'a'.repeat(64); const base = snapshot(); base.messages = [message('first')]; base.messages[0]!.resourceRefs = [digest];
    base.manifest.resources = [{ digest, locations: [{ path: `.open-design/resources/${digest}/file`, purpose: 'attachment' }], references: ['first'] }];
    const local = clone(base); const remote = clone(base); local.messages[0]!.resourceRefs = []; local.manifest.resources = [];
    remote.messages.push({ ...message('second', 'first'), resourceRefs: [digest] }); remote.manifest.resources[0]!.references.push('second');
    expect(mergePortableSnapshots(base, local, remote)).toMatchObject({ snapshot: null, conflicts: [expect.objectContaining({ kind: 'resource' })] });
  });

  it('returns the semantic array conflict before reading an unresolved required project field', () => {
    const base = snapshot(); const local = clone(base); const remote = clone(base);
    for (const [side, digest] of [[local, 'a'.repeat(64)], [remote, 'b'.repeat(64)]] as const) {
      side.project.contentRefs = [digest]; side.manifest.resources = [{ digest,
        locations: [{ path: `.open-design/resources/${digest}/file`, purpose: 'skill' }], references: ['repository'] }];
    }
    expect(mergePortableSnapshots(base, local, remote)).toMatchObject({ snapshot: null,
      conflicts: [expect.objectContaining({ kind: 'field', path: 'project/contentRefs' })] });
  });
});

describe('candidate Git tree merge', () => {
  const fixtures: Awaited<ReturnType<typeof createGitFixture>>[] = []; let sequence = 0;
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.close())); });
  async function fixture() {
    const f = await createGitFixture(); fixtures.push(f); const stagingDir = join(f.root, 'operation'); await mkdir(stagingDir);
    return { ...f, stagingDir };
  }
  async function commit(f: Awaited<ReturnType<typeof fixture>>, files: Record<string, string | Uint8Array>, portable: PortableSnapshot | null = snapshot(), omit?: string, parent?: string) {
    const entries = portable ? serializePortableMetadata(portable) : new Map<string, Uint8Array>();
    for (const [name, content] of Object.entries(files)) entries.set(name, typeof content === 'string' ? Buffer.from(content) : content);
    if (omit) entries.delete(omit);
    const env = { GIT_INDEX_FILE: join(f.root, `fixture-index-${sequence++}`),
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'OD Test', GIT_AUTHOR_EMAIL: 'od@example.invalid', GIT_COMMITTER_NAME: 'OD Test', GIT_COMMITTER_EMAIL: 'od@example.invalid' };
    await runGit({ cwd: f.a, args: ['read-tree', '--empty'], env });
    for (const [name, content] of entries) {
      const oid = (await runGit({ cwd: f.a, args: ['hash-object', '-w', '--stdin'], stdin: content })).stdout.toString().trim();
      await runGit({ cwd: f.a, args: ['update-index', '--add', '--cacheinfo', '100644', oid, name], env });
    }
    const tree = (await runGit({ cwd: f.a, args: ['write-tree'], env })).stdout.toString().trim();
    return (await runGit({ cwd: f.a, args: ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], env, stdin: Buffer.from('fixture\n') })).stdout.toString().trim();
  }
  async function readTree(root: string, tree: string) {
    const list = (await runGit({ cwd: root, args: ['ls-tree', '-r', '-z', tree] })).stdout.toString().split('\0').filter(Boolean);
    const entries = new Map<string, Uint8Array>();
    for (const line of list) {
      const [record, name] = line.split('\t'); const oid = record!.split(' ')[2]!;
      entries.set(name!, (await runGit({ cwd: root, args: ['cat-file', 'blob', oid] })).stdout);
    }
    return entries;
  }

  it('merges nonoverlapping text with real Git and preserves HEAD, staged bytes and working files', async () => {
    const f = await fixture(); const base = await commit(f, { 'file.txt': 'first\nmiddle\nlast\n' });
    const local = await commit(f, { 'file.txt': 'LOCAL\nmiddle\nlast\n' }); const remote = await commit(f, { 'file.txt': 'first\nmiddle\nREMOTE\n' });
    await writeFile(join(f.a, 'user.txt'), 'staged'); await f.git(f.a, 'add', 'user.txt');
    const index = await readFile(join(f.a, '.git/index')); await writeFile(join(f.a, 'user.txt'), 'unstaged');
    const head = await readFile(join(f.a, '.git/HEAD'));
    const result = await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote });
    expect(result.conflicts).toEqual([]); expect(result.tree).toMatch(/^[a-f0-9]{40}$/);
    const entries = await readTree(f.a, result.tree!);
    expect(Buffer.from(entries.get('file.txt')!).toString()).toBe('LOCAL\nmiddle\nREMOTE\n'); expect(parsePortableEntries(entries)).toEqual(snapshot());
    expect(await readFile(join(f.a, '.git/index'))).toEqual(index); expect(await readFile(join(f.a, '.git/HEAD'))).toEqual(head);
    expect(await readFile(join(f.a, 'user.txt'), 'utf8')).toBe('unstaged'); expect(existsSync(join(f.a, 'file.txt'))).toBe(false);
  });

  it('composes a real plain-repository side with explicitly selected metadata without changing commit history or user state', async () => {
    const f = await fixture(); const portable = snapshot(); portable.project.name = 'Preview-selected metadata';
    const bytes = Buffer.from('selected resource'); const digest = createHash('sha256').update(bytes).digest('hex');
    const alias = `.open-design/resources/${digest}/attachment`; const archive = '.open-design/legacy-file-history/original.html';
    portable.project.contentRefs = [digest]; portable.manifest.resources = [{ digest, references: ['repository'],
      locations: [{ path: alias, purpose: 'attachment' }, { path: alias, purpose: 'skill' }, { path: archive, purpose: 'legacy-history' }] }];
    const base = await commit(f, { 'file.txt': 'first\nmiddle\nlast\n' }, null);
    const local = await commit(f, { 'file.txt': 'LOCAL\nmiddle\nlast\n', [alias]: bytes, [archive]: bytes }, portable, undefined, base);
    const remote = await commit(f, { 'file.txt': 'first\nmiddle\nREMOTE\n', 'external.txt': 'external repository file' }, null, undefined, base);
    await f.git(f.a, 'update-ref', 'refs/heads/main', local); await f.git(f.a, 'update-ref', 'refs/heads/external', remote);
    await writeFile(join(f.a, 'user.txt'), 'staged'); await f.git(f.a, 'add', 'user.txt');
    const index = await readFile(join(f.a, '.git/index')); await writeFile(join(f.a, 'user.txt'), 'unstaged');
    const heads = await f.git(f.a, 'show-ref'); const head = await readFile(join(f.a, '.git/HEAD'));
    const commits = async () => (await f.git(f.a, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)')).split('\n').filter(line => line.endsWith(' commit')).sort();
    const originalCommits = await commits();
    const originalBytes = await Promise.all([base, local, remote].map(oid => runGit({ cwd: f.a, args: ['cat-file', 'commit', oid] })));
    const result = await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote, metadataSource: 'local' });
    expect(result.conflicts).toEqual([]); const entries = await readTree(f.a, result.tree!);
    expect(parsePortableEntries(entries)).toEqual(portable);
    expect(Buffer.from(entries.get('file.txt')!).toString()).toBe('LOCAL\nmiddle\nREMOTE\n');
    expect(Buffer.from(entries.get('external.txt')!).toString()).toBe('external repository file');
    expect(entries.get(alias)).toEqual(bytes); expect(entries.get(archive)).toEqual(bytes);
    expect(await commits()).toEqual(originalCommits); expect(await f.git(f.a, 'show-ref')).toBe(heads);
    for (const [i, oid] of [base, local, remote].entries()) expect((await runGit({ cwd: f.a, args: ['cat-file', 'commit', oid] })).stdout).toEqual(originalBytes[i]!.stdout);
    expect(originalBytes[1]!.stdout.toString()).toContain(`parent ${base}\n`); expect(originalBytes[2]!.stdout.toString()).toContain(`parent ${base}\n`);
    expect(await readFile(join(f.a, '.git/index'))).toEqual(index); expect(await readFile(join(f.a, '.git/HEAD'))).toEqual(head);
    expect(await readFile(join(f.a, 'user.txt'), 'utf8')).toBe('unstaged'); expect(existsSync(join(f.a, 'file.txt'))).toBe(false);
  });

  it('requires an explicit portable metadata source for ordinary-input composition', async () => {
    const f = await fixture(); const base = await commit(f, {}, null); const local = await commit(f, {}); const remote = await commit(f, { 'plain.txt': 'plain' }, null);
    const input = { root: f.a, stagingDir: f.stagingDir, base, local, remote };
    await expect(mergeFileTrees(input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(mergeFileTrees({ ...input, metadataSource: 'remote' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(mergeFileTrees({ ...input, local: base, metadataSource: 'local' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(mergeFileTrees({ ...input, metadataSource: 'base' as 'local' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'metadata_source_invalid' } });
  });

  it('uses the selected remote portable head when local is plain and base metadata differs', async () => {
    const f = await fixture(); const old = snapshot(); old.project.name = 'Historical metadata';
    const selected = snapshot(); selected.project.name = 'Selected remote metadata'; selected.project.customInstructions = 'Remote instructions';
    const base = await commit(f, { 'file.txt': 'base' }, old);
    const local = await commit(f, { 'file.txt': 'base', 'local-only.txt': 'keep' }, null);
    const remote = await commit(f, { 'file.txt': 'remote edit' }, selected);
    const result = await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote, metadataSource: 'remote' });
    const entries = await readTree(f.a, result.tree!);
    expect(result.conflicts).toEqual([]); expect(parsePortableEntries(entries)).toEqual(selected);
    expect(Buffer.from(entries.get('file.txt')!).toString()).toBe('remote edit'); expect(entries.has('local-only.txt')).toBe(true);
  });

  it.each(['partial', 'malformed', 'higher-schema', 'reserved-case'] as const)('does not degrade %s metadata into a plain repository when another source is selected', async kind => {
    const f = await fixture(); const local = await commit(f, {}); const remote = await commit(f, {}, null);
    const files = kind === 'partial' ? { '.open-design/project.json': '{}' }
      : kind === 'malformed' ? { '.open-design/manifest.json': '{' }
        : kind === 'higher-schema' ? { '.open-design/manifest.json': '{"schemaVersion":2,"repositoryProjectId":"repository","resources":[]}' }
          : { '.OPEN-DESIGN/manifest.json': '{}' };
    const base = await commit(f, files, null);
    await expect(mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote, metadataSource: 'local' })).rejects.toThrow();
  });

  it('does not select away a foreign portable project or override the all-portable structural merge', async () => {
    const f = await fixture(); const base = await commit(f, {}); const remote = await commit(f, {}, null);
    const other = snapshot(); other.manifest.repositoryProjectId = 'foreign'; const local = await commit(f, {}, other);
    await expect(mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote, metadataSource: 'local' })).rejects.toThrow(/repository project/i);
    await expect(mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local: base, remote: base, metadataSource: 'local' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('composes equal portable heads over a plain base but refuses to select away different metadata histories', async () => {
    const f = await fixture(); const base = await commit(f, {}, null);
    const local = await commit(f, { 'local.txt': 'local' }); const remote = await commit(f, { 'remote.txt': 'remote' });
    const input = { root: f.a, stagingDir: f.stagingDir, base, local, remote, metadataSource: 'remote' as const };
    const result = await mergeFileTrees(input); const entries = await readTree(f.a, result.tree!);
    expect(parsePortableEntries(entries)).toEqual(snapshot()); expect(entries.has('local.txt')).toBe(true); expect(entries.has('remote.txt')).toBe(true);
    const changed = snapshot(); changed.project.name = 'Different metadata'; const changedRemote = await commit(f, {}, changed);
    await expect(mergeFileTrees({ ...input, remote: changedRemote })).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'metadata_baseline_missing' } });
  });

  it.each(['overlap', 'binary', 'delete-modify', 'add-add'] as const)('returns viewable %s conflicts without writing project conflict markers', async kind => {
    const f = await fixture(); const baseBytes = kind === 'binary' ? Buffer.from([0, 1]) : Buffer.from('old\n');
    const localBytes = kind === 'binary' ? Buffer.from([0, 2]) : Buffer.from('local\n');
    const remoteBytes = kind === 'binary' ? Buffer.from([0, 3]) : Buffer.from('remote\n');
    const base = await commit(f, kind === 'add-add' ? {} : { 'file.txt': baseBytes });
    const local = await commit(f, kind === 'delete-modify' ? {} : { 'file.txt': localBytes });
    const remote = await commit(f, { 'file.txt': remoteBytes });
    const result = await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote });
    expect(result).toMatchObject({ tree: null, conflicts: [{ kind: 'file', path: 'file.txt',
      remote: { kind: 'file', file: { encoding: 'base64', content: remoteBytes.toString('base64') } } }] });
    if (kind === 'delete-modify') expect(result.conflicts[0]!.local).toEqual({ kind: 'missing' });
    expect(existsSync(join(f.a, 'file.txt'))).toBe(false); expect(existsSync(join(f.a, '.git/index'))).toBe(false);
  });

  it('merges fields structurally even when canonical metadata changes occupy one text line', async () => {
    const f = await fixture(); const b = snapshot(); const l = clone(b); const r = clone(b);
    l.project.name = 'Local'; r.project.customInstructions = 'Remote';
    const base = await commit(f, {}, b); const local = await commit(f, {}, l); const remote = await commit(f, {}, r);
    const result = await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote });
    expect(result.conflicts).toEqual([]);
    expect(parsePortableEntries(await readTree(f.a, result.tree!)).project).toMatchObject({ name: 'Local', customInstructions: 'Remote' });
  });

  it.each(['same-destination', 'different-destinations'] as const)('reports exact rename collisions for %s', async kind => {
    const f = await fixture(); const base = await commit(f, { 'one.txt': 'same\n', 'two.txt': 'same\n' });
    const local = await commit(f, { 'target.txt': 'same\n', 'two.txt': 'same\n' });
    const remote = await commit(f, kind === 'same-destination' ? { 'one.txt': 'same\n', 'target.txt': 'same\n' } : { 'other.txt': 'same\n', 'two.txt': 'same\n' });
    const result = await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote });
    expect(result.tree).toBeNull(); expect(result.conflicts).toContainEqual(expect.objectContaining({ kind: 'file' }));
  });

  it('does not collapse two edited source renames into one identical destination file', async () => {
    const f = await fixture(); const base = await commit(f, { 'one.txt': 'first source', 'two.txt': 'second source' });
    const local = await commit(f, { 'target.txt': 'same edited bytes', 'two.txt': 'second source' });
    const remote = await commit(f, { 'one.txt': 'first source', 'target.txt': 'same edited bytes' });
    const result = await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote });
    expect(result.tree).toBeNull(); expect(result.conflicts).toContainEqual(expect.objectContaining({ kind: 'file', path: 'target.txt' }));
  });

  it.each(['folder/child.txt', 'Folder'] as const)('rejects a cross-side path collision between folder and %s', async other => {
    const f = await fixture(); const base = await commit(f, {}); const local = await commit(f, { 'folder': 'file' });
    const remote = await commit(f, { [other]: 'child' });
    expect(await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote })).toMatchObject({ tree: null, conflicts: expect.arrayContaining([expect.objectContaining({ kind: 'file' })]) });
  });

  it('verifies resource bytes and retains every role/path alias through the final candidate parser', async () => {
    const f = await fixture(); const bytes = Buffer.from('shared'); const digest = createHash('sha256').update(bytes).digest('hex');
    const b = snapshot(); const l = clone(b); const r = clone(b); const resourcePath = `.open-design/resources/${digest}/content`;
    for (const side of [l, r]) { side.project.contentRefs = [digest]; side.manifest.resources = [{ digest, locations: [{ path: resourcePath, purpose: 'skill' }], references: ['repository'] }]; }
    r.manifest.resources[0]!.locations.push({ path: '.open-design/legacy-file-history/old.html', purpose: 'legacy-history' });
    const base = await commit(f, {}, b); const local = await commit(f, { [resourcePath]: bytes }, l);
    const remote = await commit(f, { [resourcePath]: bytes, '.open-design/legacy-file-history/old.html': bytes }, r);
    const result = await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote });
    const entries = await readTree(f.a, result.tree!); expect(parsePortableEntries(entries).manifest.resources[0]!.locations).toHaveLength(2);
    expect(entries.get('.open-design/legacy-file-history/old.html')).toEqual(bytes);
    const corrupt = await commit(f, { [resourcePath]: 'wrong digest' }, l);
    expect(await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote: corrupt })).toMatchObject({ tree: null, conflicts: [expect.objectContaining({ kind: 'resource' })] });
    const missing = await commit(f, {}, l);
    expect(await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote: missing })).toMatchObject({ tree: null,
      conflicts: [expect.objectContaining({ kind: 'resource', path: resourcePath })] });
  });

  it('refuses another repository project and revision expressions before producing a candidate', async () => {
    const f = await fixture(); const b = snapshot(); const r = clone(b); r.manifest.repositoryProjectId = 'another';
    const base = await commit(f, {}, b); const remote = await commit(f, {}, r);
    await expect(mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local: base, remote })).rejects.toThrow(/repository project/i);
    await expect(mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base: 'HEAD', local: base, remote: base })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('returns explicit resource conflicts when merged aliases collide by case with no ordinary files', async () => {
    const f = await fixture(); const bytes = Buffer.from('shared'); const digest = createHash('sha256').update(bytes).digest('hex');
    const b = snapshot(); const l = clone(b); const r = clone(b);
    const localPath = `.open-design/resources/${digest}/File`; const remotePath = `.open-design/resources/${digest}/file`;
    l.manifest.resources = [{ digest, locations: [{ path: localPath, purpose: 'skill' }], references: [] }];
    r.manifest.resources = [{ digest, locations: [{ path: remotePath, purpose: 'plugin' }], references: [] }];
    const base = await commit(f, {}, b); const local = await commit(f, { [localPath]: bytes }, l); const remote = await commit(f, { [remotePath]: bytes }, r);
    const result = await mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local, remote });
    expect(result.tree).toBeNull(); expect(result.conflicts).toContainEqual(expect.objectContaining({ kind: 'resource', path: localPath }));
  });

  it('rejects preparation directories inside the project even when their name starts with two dots', async () => {
    const f = await fixture(); const base = await commit(f, {}); const nested = join(f.a, '..operation'); await mkdir(nested);
    await expect(mergeFileTrees({ root: f.a, stagingDir: nested, base, local: base, remote: base })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(existsSync(join(f.a, '.git/index'))).toBe(false);
  });

  it('rejects invalid UTF-8 Git path bytes instead of silently renaming the candidate file', async () => {
    const f = await fixture(); const base = await commit(f, {});
    await writeFile(Buffer.concat([Buffer.from(`${f.a}/`), Buffer.from([255])]), 'content');
    await f.git(f.a, 'read-tree', base);
    await f.git(f.a, 'add', '--ignore-removal', '.'); await f.git(f.a, 'commit', '-m', 'invalid path fixture');
    const remote = await f.git(f.a, 'rev-parse', 'HEAD');
    await expect(mergeFileTrees({ root: f.a, stagingDir: f.stagingDir, base, local: base, remote })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
