import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitFixture } from '../../helpers/project-git.js';
import { initializeRepository, runGit, runGitTransport } from '../../../src/services/project-git/git-process.js';
import { discoverObjectStore, discoverRepository, redactGitText, resolveCommit, validateBranch, validateRemote, validateTreeEntries } from '../../../src/services/project-git/repository.js';

const fixtures: Awaited<ReturnType<typeof createGitFixture>>[] = [];
async function fixture() { const f = await createGitFixture(); fixtures.push(f); return f; }
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(fixtures.splice(0).map(f => f.close())); });
const identity = { GIT_AUTHOR_NAME: 'OD Test', GIT_AUTHOR_EMAIL: 'od@example.invalid', GIT_COMMITTER_NAME: 'OD Test', GIT_COMMITTER_EMAIL: 'od@example.invalid' };
const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
const hostConfig = { GIT_CONFIG_GLOBAL: nullConfig, GIT_CONFIG_SYSTEM: nullConfig };
async function executable(path: string, content: string) { await writeFile(path, content); await chmod(path, 0o700); }

describe('controlled project Git', () => {
  it('discovers an unborn root and refuses implicitly managing a parent repository', async () => {
    const f = await fixture();
    expect(await discoverRepository(f.a)).toEqual({ root: f.a, gitDir: join(f.a, '.git'), commonDir: join(f.a, '.git'), branch: 'main', head: null });
    await mkdir(join(f.a, 'nested'));
    await expect(discoverRepository(join(f.a, 'nested'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('resolves linked worktree common directories and detached HEADs', async () => {
    const f = await fixture();
    await f.git(f.a, 'commit', '--allow-empty', '-m', 'first');
    const head = await f.git(f.a, 'rev-parse', 'HEAD');
    const linked = join(f.root, 'linked');
    await f.git(f.a, 'worktree', 'add', '--detach', linked, head);
    expect(await discoverRepository(linked)).toMatchObject({ root: linked, commonDir: join(f.a, '.git'), branch: null, head });
    expect(await resolveCommit(f.a, head)).toBe(head);
    for (const value of ['HEAD', `${head}~0`, `${head}:file`, '--all']) await expect(resolveCommit(f.a, value)).rejects.toThrow();
    const blob = await f.git(f.a, 'hash-object', '-w', '--stdin');
    await expect(resolveCommit(f.a, blob)).rejects.toThrow();
  });

  it('allows only credential-free HTTPS and SSH locations', () => {
    for (const remote of ['https://example.invalid/team/repo.git', 'ssh://git@example.invalid:2222/team/repo.git', 'git@example.invalid:team/design.git']) expect(validateRemote(remote)).toBe(remote);
    for (const remote of ['--upload-pack=sh', 'ext::sh -c anything', 'file:///tmp/repo', '/tmp/repo', 'http://example.invalid/repo', 'https://token@example.invalid/repo', 'ssh://git:secret@example.invalid/repo', 'ssh://-option/repo', 'https://example.invalid/repo?token=secret', 'git@example.invalid:repo\nextra', 'git@example.invalid:repo\0']) expect(() => validateRemote(remote)).toThrow();
  });

  it('validates literal branch names without checkout expressions', async () => {
    expect(await validateBranch('feature/design')).toBe('feature/design');
    for (const value of ['@{-1}', '-main', 'HEAD', 'a..b', 'a\nb']) await expect(validateBranch(value)).rejects.toThrow();
  });

  it('retains exact binary blob bytes through stdin and stdout', async () => {
    const f = await fixture();
    const content = Buffer.from([0, 255, 10, 32, 10]);
    const { stdout } = await runGit({ cwd: f.a, args: ['hash-object', '-w', '--stdin'], stdin: content });
    expect((await runGit({ cwd: f.a, args: ['cat-file', 'blob', stdout.toString().trim()] })).stdout).toEqual(content);
  });

  it('rejects unsafe tree paths, platform collisions and symlinks before materialization', () => {
    const entry = (path: string, mode = '100644') => ({ path, mode });
    expect(() => validateTreeEntries([entry('.open-design/project.json'), entry('src/main.ts')])).not.toThrow();
    for (const path of ['../outside', '/absolute', 'a/../../b', 'a\\b', '.git/config', 'A/.GIT/config', 'NUL.txt', 'a/COM1', 'a/COM¹', 'a/file.', 'a/file ', 'C:/file', 'a\0b', 'a?b', 'a*b', 'a|b', 'git~1/config', '.\u200cgit/config']) expect(() => validateTreeEntries([entry(path)])).toThrow();
    expect(() => validateTreeEntries([entry('A.txt'), entry('a.txt')])).toThrow();
    expect(() => validateTreeEntries([entry('outside', '120000')])).toThrow();
  });

  it('redacts address credentials and token-bearing diagnostic text', () => {
    const value = redactGitText('fatal https://alice:secret@example.invalid/repo?access_token=token123 Authorization: Bearer bearer456 password=hunter2');
    for (const secret of ['alice', 'secret', 'token123', 'bearer456', 'hunter2']) expect(value).not.toContain(secret);
  });

  it.each([
    ['A/one.txt', 'a/two.txt'],
    ['caf\u00e9/one.txt', 'cafe\u0301/two.txt'],
    ['outer/A/one.txt', 'outer/a/two.txt'],
  ])('rejects implicit directory spelling collisions between %s and %s', (first, second) => {
    expect(() => validateTreeEntries([{ path: first, mode: '100644' }, { path: second, mode: '100644' }])).toThrow();
  });

  it('accepts shared implicit directories and matching explicit directory entries', () => {
    expect(() => validateTreeEntries([
      { path: 'same/one.txt', mode: '100644' }, { path: 'same/two.txt', mode: '100644' },
      { path: 'same', mode: '040000' },
    ])).not.toThrow();
  });

  it.each(['working-file', 'cacheinfo-trailing-file', 'index-info-trailing-file'] as const)('rejects update-index %s without executing a clean filter', async form => {
    const f = await fixture();
    const shimDir = join(f.root, 'bin');
    await mkdir(shimDir);
    await executable(join(shimDir, 'ssh'), '#!/bin/sh\nexit 1\n');
    const marker = join(f.root, 'clean-filter-ran');
    const filter = join(f.root, 'clean-filter');
    await executable(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    await writeFile(join(f.a, '.gitattributes'), 'file filter=evil\n');
    await writeFile(join(f.a, 'file'), 'working content\n');
    await f.git(f.a, 'config', 'filter.evil.clean', filter);
    const blob = (await runGit({ cwd: f.a, args: ['hash-object', '-w', '--stdin'], stdin: Buffer.from('cached content\n') })).stdout.toString().trim();
    const env = { ...hostConfig, GIT_INDEX_FILE: join(f.root, 'private-index'), PATH: `${shimDir}:${process.env.PATH}` };
    const args = form === 'working-file' ? ['update-index', '--add', 'file']
      : form === 'cacheinfo-trailing-file' ? ['update-index', '--add', '--cacheinfo', `100644,${blob},cached`, 'file']
        : ['update-index', '--add', '--index-info', 'file'];
    const result = await runGit({ cwd: f.a, args, env, stdin: Buffer.from(`100644 ${blob}\tcached\n`) }).catch(error => error);
    expect.soft(result).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect.soft(existsSync(marker)).toBe(false);
    expect(existsSync(join(f.a, '.git', 'index'))).toBe(false);
  });

  it('preserves combined and separate cacheinfo forms and NUL-delimited index-info', async () => {
    const f = await fixture();
    const blob = (await runGit({ cwd: f.a, args: ['hash-object', '-w', '--stdin'], stdin: Buffer.from('cached\n') })).stdout.toString().trim();
    const env = { ...hostConfig, GIT_INDEX_FILE: join(f.root, 'private-index') };
    await runGit({ cwd: f.a, args: ['update-index', '--add', '--cacheinfo', `100644,${blob},combined`], env });
    await runGit({ cwd: f.a, args: ['update-index', '--add', '--cacheinfo', '100644', blob, 'separate'], env });
    await runGit({ cwd: f.a, args: ['update-index', '-z', '--index-info'], stdin: Buffer.from(`100644 ${blob}\tfrom-stdin\0`), env });
    const result = (await runGit({ cwd: f.a, args: ['ls-files', '--cached', '-z'], env })).stdout.toString();
    expect(result).toBe('combined\0from-stdin\0separate\0');
    expect(existsSync(join(f.a, '.git', 'index'))).toBe(false);
  });

  it('rejects execution-capable commands/options even for internal callers', async () => {
    const f = await fixture();
    for (const args of [['checkout', 'HEAD'], ['add', '.'], ['-c', 'alias.x=!sh', 'x'], ['cat-file', '--filters', 'HEAD:file'], ['hash-object', '--path=file', '--stdin'], ['diff', '--ext-diff'], ['commit-tree', '-S', 'HEAD'], ['fetch', 'origin']]) await expect(runGit({ cwd: f.a, args })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('disables repository hooks, filters, fsmonitor and signing with real Git plumbing', async () => {
    const f = await fixture();
    await writeFile(join(f.a, 'staged-by-user'), 'keep this staged\n');
    await f.git(f.a, 'add', 'staged-by-user');
    const originalIndex = await readFile(join(f.a, '.git', 'index'));
    const marker = join(f.root, 'executed');
    const script = join(f.root, 'attack');
    await executable(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await f.git(f.a, 'config', 'core.hooksPath', join(f.root, 'hooks'));
    await mkdir(join(f.root, 'hooks'));
    for (const hook of ['reference-transaction', 'pre-commit', 'post-checkout']) await executable(join(f.root, 'hooks', hook), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    for (const key of ['core.fsmonitor', 'filter.evil.clean', 'filter.evil.smudge', 'filter.evil.process', 'diff.external', 'diff.evil.textconv', 'gpg.program']) await f.git(f.a, 'config', key, script);
    await f.git(f.a, 'config', 'commit.gpgsign', 'true');
    await writeFile(join(f.a, '.gitattributes'), '* filter=evil diff=evil\n');
    const blob = (await runGit({ cwd: f.a, args: ['hash-object', '-w', '--stdin'], stdin: Buffer.from('safe\n') })).stdout.toString().trim();
    const index = join(f.root, 'private-index');
    await runGit({ cwd: f.a, args: ['read-tree', '--empty'], env: { GIT_INDEX_FILE: index } });
    await runGit({ cwd: f.a, args: ['update-index', '--add', '--cacheinfo', `100644,${blob},file`], env: { GIT_INDEX_FILE: index } });
    const tree = (await runGit({ cwd: f.a, args: ['write-tree'], env: { GIT_INDEX_FILE: index } })).stdout.toString().trim();
    const head = (await runGit({ cwd: f.a, args: ['commit-tree', tree], stdin: Buffer.from('safe commit\n'), env: { ...hostConfig, ...identity } })).stdout.toString().trim();
    await runGit({ cwd: f.a, args: ['update-ref', 'refs/heads/main', head], env: { ...hostConfig, ...identity } });
    expect((await runGit({ cwd: f.a, args: ['ls-files', '--stage'], env: { GIT_INDEX_FILE: index } })).stdout.toString()).toContain('file');
    expect((await runGit({ cwd: f.a, args: ['cat-file', 'blob', blob] })).stdout.toString()).toBe('safe\n');
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(join(f.a, '.git', 'index'))).toEqual(originalIndex);
  });

  it('drops inherited Git redirections while honoring the explicit private index', async () => {
    const f = await fixture();
    vi.stubEnv('GIT_DIR', join(f.b, '.git'));
    vi.stubEnv('GIT_WORK_TREE', f.b);
    vi.stubEnv('GIT_INDEX_FILE', join(f.b, 'stolen-index'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.sshCommand');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'malicious');
    expect((await discoverRepository(f.a)).root).toBe(f.a);
    await runGit({ cwd: f.a, args: ['read-tree', '--empty'], env: { GIT_INDEX_FILE: join(f.root, 'private-index') } });
    expect(existsSync(join(f.root, 'private-index'))).toBe(true);
    expect(existsSync(join(f.b, 'stolen-index'))).toBe(false);
    await expect(runGit({ cwd: f.a, args: ['write-tree'], env: { GIT_CONFIG_COUNT: '1' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('does not lazy-fetch absent promisor objects or execute a repository remote helper', async () => {
    const f = await fixture();
    const marker = join(f.root, 'lazy-fetch');
    const shimDir = join(f.root, 'bin');
    await mkdir(shimDir);
    await executable(join(shimDir, 'git-remote-evil'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await f.git(f.a, 'config', 'extensions.partialClone', 'origin');
    await f.git(f.a, 'config', 'remote.origin.promisor', 'true');
    await f.git(f.a, 'config', 'remote.origin.url', 'evil::anything');
    await expect(runGit({ cwd: f.a, args: ['cat-file', '-e', '1234567890123456789012345678901234567890'], env: { PATH: `${shimDir}:${process.env.PATH}` } })).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it('reports missing Git and missing trusted identity without exposing stderr', async () => {
    const f = await fixture();
    await expect(runGit({ cwd: f.a, args: ['rev-parse', '--git-dir'], env: { PATH: f.root } })).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' });
    const tree = await f.git(f.a, 'mktree');
    await expect(runGit({ cwd: f.a, args: ['commit-tree', tree], stdin: Buffer.from('commit'), env: hostConfig })).rejects.toMatchObject({ code: 'GIT_IDENTITY_REQUIRED' });
  });

  it('fails on oversized output without returning truncated blob content', async () => {
    const f = await fixture();
    await writeFile(join(f.a, 'large'), Buffer.alloc(17 * 1024 * 1024, 65));
    const blob = await f.git(f.a, 'hash-object', '-w', '--no-filters', 'large');
    await expect(runGit({ cwd: f.a, args: ['cat-file', 'blob', blob] })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('reads trusted host identity and ignores the fixture repository identity', async () => {
    const f = await fixture();
    const config = join(f.root, 'identity.gitconfig');
    await writeFile(config, '[user]\n name = Host Identity\n email = host@example.invalid\n');
    const tree = await f.git(f.a, 'mktree');
    const head = (await runGit({ cwd: f.a, args: ['commit-tree', tree], stdin: Buffer.from('host identity'), env: { ...hostConfig, GIT_CONFIG_GLOBAL: config } })).stdout.toString().trim();
    expect((await runGit({ cwd: f.a, args: ['cat-file', 'commit', head] })).stdout.toString()).toContain('author Host Identity <host@example.invalid>');
  });

  it('fetches complete ancestry through isolated SSH transport without changing the real refs or index', async () => {
    const f = await fixture();
    await f.git(f.a, 'commit', '--allow-empty', '-m', 'first');
    const first = await f.git(f.a, 'rev-parse', 'HEAD');
    await writeFile(join(f.a, 'file'), 'second\n');
    await f.git(f.a, 'add', 'file');
    await f.git(f.a, 'commit', '-m', 'second');
    await f.git(f.a, 'push', 'origin', 'main');
    const head = await f.git(f.a, 'rev-parse', 'HEAD');
    const shimDir = join(f.root, 'bin');
    await mkdir(shimDir);
    await executable(join(shimDir, 'ssh'), `#!/bin/sh\nunset GIT_DIR GIT_OBJECT_DIRECTORY\ncase "$*" in *git-receive-pack*) exec git receive-pack '${f.remote}';; *) exec git upload-pack '${f.remote}';; esac\n`);
    const env = { ...hostConfig, PATH: `${shimDir}:${process.env.PATH}` };
    const store = await discoverObjectStore(f.b);
    expect(store).toEqual({ objectDirectory: join(f.b, '.git', 'objects'), objectFormat: 'sha1' });
    const result = await runGitTransport({ preparationRoot: f.root, args: ['fetch', 'ssh://git@example.invalid/team/repo.git', 'refs/heads/main'], ...store, env });
    expect(result.fetchedHead).toBe(head);
    expect(await resolveCommit(f.b, first)).toBe(first);
    expect((await discoverRepository(f.b)).head).toBe(null);
    expect(existsSync(join(f.b, '.git', 'index'))).toBe(false);
    expect(existsSync(join(f.b, '.git', 'refs', 'od-transfer'))).toBe(false);
    expect((await runGit({ cwd: f.b, args: ['cat-file', 'blob', (await f.git(f.a, 'rev-parse', 'HEAD:file'))] })).stdout.toString()).toBe('second\n');
    await runGitTransport({ preparationRoot: f.root, args: ['push', 'ssh://git@example.invalid/team/repo.git', `${head}:refs/heads/copied`], ...store, env });
    expect(await f.git(f.remote, 'rev-parse', 'refs/heads/copied')).toBe(head);
    await expect(runGitTransport({ preparationRoot: f.root, args: ['push', 'ssh://git@example.invalid/team/repo.git', `+${head}:refs/heads/main`], ...store, env })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(runGitTransport({ preparationRoot: f.root, args: ['push', 'ssh://git@example.invalid/team/repo.git', `${first}:refs/heads/main`], ...store, env })).rejects.toThrow();
    expect(await f.git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(head);
  });

  it('discovers SHA-256 objects and rejects a mismatched shared-object format', async () => {
    const f = await fixture();
    const repo = join(f.root, 'sha256');
    await f.git(f.root, 'init', '--object-format=sha256', '--initial-branch=main', repo);
    await f.git(repo, 'commit', '--allow-empty', '-m', 'sha256');
    const head = await f.git(repo, 'rev-parse', 'HEAD');
    expect(await resolveCommit(repo, head)).toBe(head);
    const store = await discoverObjectStore(repo);
    expect(store.objectFormat).toBe('sha256');
    const shimDir = join(f.root, 'bin');
    await mkdir(shimDir);
    await executable(join(shimDir, 'ssh'), `#!/bin/sh\nunset GIT_DIR GIT_OBJECT_DIRECTORY\nexec git upload-pack '${repo}'\n`);
    await expect(runGitTransport({ preparationRoot: f.root, args: ['fetch', 'ssh://git@example.invalid/repo', 'refs/heads/main'], ...store, objectFormat: 'sha1', env: { ...hostConfig, PATH: `${shimDir}:${process.env.PATH}` } })).rejects.toMatchObject({ code: 'PORTABLE_FORMAT_UNSUPPORTED' });
    await expect(runGitTransport({ preparationRoot: f.root, args: ['fetch', 'ssh://git@example.invalid/repo', 'refs/heads/main'], ...await discoverObjectStore(f.b), env: { ...hostConfig, PATH: `${shimDir}:${process.env.PATH}` } })).rejects.toMatchObject({ code: 'PORTABLE_FORMAT_UNSUPPORTED' });
  });

  it.each(['feature/设计', 'topic+fix'])('validates, fetches and pushes the native Git branch %s', async branch => {
    const f = await fixture();
    const shimDir = join(f.root, 'bin');
    await mkdir(shimDir);
    await executable(join(shimDir, 'ssh'), `#!/bin/sh\nunset GIT_DIR GIT_OBJECT_DIRECTORY\ncase "$*" in *git-receive-pack*) exec git receive-pack '${f.remote}';; *) exec git upload-pack '${f.remote}';; esac\n`);
    const env = { ...hostConfig, PATH: `${shimDir}:${process.env.PATH}` };
    await f.git(f.a, 'commit', '--allow-empty', '-m', 'native branch');
    const head = await f.git(f.a, 'rev-parse', 'HEAD');
    await f.git(f.a, 'push', 'origin', `${head}:refs/heads/${branch}`);
    expect(await validateBranch(branch)).toBe(branch);
    const store = await discoverObjectStore(f.b);
    const remote = 'ssh://git@example.invalid/repo';
    expect((await runGitTransport({ preparationRoot: f.root, args: ['fetch', remote, `refs/heads/${branch}`], ...store, env })).fetchedHead).toBe(head);
    await runGitTransport({ preparationRoot: f.root, args: ['push', remote, `${head}:refs/heads/${branch}-copy`], ...store, env });
    expect(await f.git(f.remote, 'rev-parse', `refs/heads/${branch}-copy`)).toBe(head);
    await expect(runGitTransport({ preparationRoot: f.root, args: ['push', remote, `+${head}:refs/heads/${branch}`], ...store, env })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await discoverRepository(f.b)).head).toBe(null);
    expect(existsSync(join(f.b, '.git', 'index'))).toBe(false);
  });

  it('initializes explicit repositories without copying host templates or executing hooks', async () => {
    const f = await fixture();
    const repo = join(f.root, 'initialized');
    await mkdir(repo);
    const template = join(f.root, 'template');
    await mkdir(join(template, 'hooks'), { recursive: true });
    const marker = join(f.root, 'template-ran');
    await executable(join(template, 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`);
    const config = join(f.root, 'init.gitconfig');
    await writeFile(config, `[init]\n templateDir = ${template}\n`);
    vi.stubEnv('GIT_TEMPLATE_DIR', template);
    await writeFile(join(repo, 'existing.txt'), 'preserved\n');
    await initializeRepository({ root: repo, initialBranch: 'main', objectFormat: 'sha256', env: { ...hostConfig, GIT_CONFIG_GLOBAL: config } });
    expect((await discoverRepository(repo)).head).toBe(null);
    expect((await discoverObjectStore(repo)).objectFormat).toBe('sha256');
    expect(existsSync(join(repo, '.git', 'hooks', 'reference-transaction'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(join(repo, 'existing.txt'), 'utf8')).toBe('preserved\n');
    await expect(runGit({ cwd: repo, args: ['init', `--template=${template}`] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(runGit({ cwd: repo, args: ['init', `--separate-git-dir=${join(f.root, 'elsewhere')}`] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('preserves existing and unrecognized Git targets and refuses parent repositories during initialization', async () => {
    const f = await fixture();
    const config = await readFile(join(f.a, '.git', 'config'));
    await expect(initializeRepository({ root: f.a, initialBranch: 'other', objectFormat: 'sha1' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await readFile(join(f.a, '.git', 'config'))).toEqual(config);
    const nested = join(f.a, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'file'), 'preserved');
    await expect(initializeRepository({ root: nested, initialBranch: 'main', objectFormat: 'sha1' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(existsSync(join(nested, '.git'))).toBe(false);
    expect(await readFile(join(nested, 'file'), 'utf8')).toBe('preserved');
    const standalone = join(f.root, 'unknown');
    await mkdir(standalone);
    await writeFile(join(standalone, '.git'), 'unrecognized content');
    await expect(initializeRepository({ root: standalone, initialBranch: 'main', objectFormat: 'sha1' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await readFile(join(standalone, '.git'), 'utf8')).toBe('unrecognized content');
    const unavailable = join(f.root, 'missing-git');
    await mkdir(unavailable);
    await writeFile(join(unavailable, 'file'), 'preserved');
    await expect(initializeRepository({ root: unavailable, initialBranch: 'main', objectFormat: 'sha1', env: { PATH: unavailable } })).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' });
    expect(await readFile(join(unavailable, 'file'), 'utf8')).toBe('preserved');
    expect(existsSync(join(unavailable, '.git'))).toBe(false);
  });

  it('requires a retained object store for fetch and push', async () => {
    const f = await fixture();
    const shimDir = join(f.root, 'bin');
    await mkdir(shimDir);
    await executable(join(shimDir, 'ssh'), '#!/bin/sh\nexit 1\n');
    for (const args of [['fetch', 'ssh://git@example.invalid/repo', 'refs/heads/main'], ['push', 'ssh://git@example.invalid/repo', '12345678:refs/heads/main']]) await expect(runGitTransport({ preparationRoot: f.root, args, env: { ...hostConfig, PATH: `${shimDir}:${process.env.PATH}` } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('redacts successful transport stderr before it can reach logs', async () => {
    const f = await fixture();
    const shimDir = join(f.root, 'bin');
    await mkdir(shimDir);
    await executable(join(shimDir, 'ssh'), `#!/bin/sh\nprintf 'https://alice:secret@example.invalid/repo?token=token123\\n' >&2\nunset GIT_DIR GIT_OBJECT_DIRECTORY\nexec git upload-pack '${f.remote}'\n`);
    const result = await runGitTransport({ preparationRoot: f.root, args: ['ls-remote', 'ssh://git@example.invalid/repo'], env: { ...hostConfig, PATH: `${shimDir}:${process.env.PATH}` } });
    expect(result.stderr.toString()).not.toMatch(/alice|secret|token123/);
  });

  it('puts mandatory SSH noninteractive options before trusted host arguments and rejects shell wrappers', async () => {
    const f = await fixture();
    const shimDir = join(f.root, 'bin');
    await mkdir(shimDir);
    const argsFile = join(f.root, 'ssh-args');
    const config = join(f.root, 'ssh.gitconfig');
    await writeFile(config, '[core]\n sshCommand = ssh -o BatchMode=no -o NumberOfPasswordPrompts=5\n');
    await executable(join(shimDir, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nunset GIT_DIR GIT_OBJECT_DIRECTORY\nexec git upload-pack '${f.remote}'\n`);
    const input = { preparationRoot: f.root, args: ['ls-remote', 'ssh://git@example.invalid/repo'], env: { ...hostConfig, GIT_CONFIG_GLOBAL: config, PATH: `${shimDir}:${process.env.PATH}` } };
    await runGitTransport(input);
    const args = (await readFile(argsFile, 'utf8')).split('\n');
    expect(args.slice(0, 4)).toEqual(['-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0']);
    expect(args.indexOf('BatchMode=yes')).toBeLessThan(args.indexOf('BatchMode=no'));
    expect(args.indexOf('NumberOfPasswordPrompts=0')).toBeLessThan(args.indexOf('NumberOfPasswordPrompts=5'));
    await writeFile(config, '[core]\n sshCommand = sh -c anything\n');
    await expect(runGitTransport(input)).rejects.toMatchObject({ code: 'GIT_AUTH_REQUIRED', details: { nextStep: expect.stringContaining('OpenSSH') } });
  });

  it('uses isolated transport config, preserves the trusted helper, and never runs local helpers or SSH commands', async () => {
    const f = await fixture();
    const marker = join(f.root, 'untrusted');
    const trustedMarker = join(f.root, 'trusted');
    const config = join(f.root, 'trusted.gitconfig');
    const helper = join(f.root, 'credential-helper');
    await executable(helper, `#!/bin/sh\ntouch '${trustedMarker}'\nprintf 'username=fixture\\npassword=fixture-secret\\n'\n`);
    await writeFile(config, `[credential]\n helper = ${helper}\n`);
    for (const key of ['credential.helper', 'credential.https://example.invalid.helper', 'core.sshCommand']) await f.git(f.a, 'config', key, `!touch '${marker}'`);
    const shimDir = join(f.root, 'bin');
    await mkdir(shimDir);
    // The real Git transport invokes this controlled SSH process. The shim invokes
    // real Git credential fill inside its inherited isolated configuration.
    await executable(join(shimDir, 'ssh'), `#!/bin/sh\nprintf 'protocol=https\\nhost=example.invalid\\n\\n' | git credential fill >/dev/null\nprintf 'fatal https://alice:secret@example.invalid/repo?token=token123\\n' >&2\nexit 1\n`);
    const result = runGitTransport({ preparationRoot: f.root, args: ['ls-remote', 'ssh://git@example.invalid/team/repo.git'], env: { ...hostConfig, GIT_CONFIG_GLOBAL: config, PATH: `${shimDir}:${process.env.PATH}` } });
    await expect(result).rejects.toMatchObject({ code: 'GIT_AUTH_REQUIRED' });
    expect(existsSync(trustedMarker)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    try { await result; } catch (error) { expect(JSON.stringify(error)).not.toMatch(/secret|token123/); }
  });

  it.each(['timeout', 'cancel'] as const)('reaps the owned SSH subtree on %s', async kind => {
    const f = await fixture();
    const shimDir = join(f.root, 'bin');
    await mkdir(shimDir);
    const pidPath = join(f.root, 'child-pid');
    const marker = join(f.root, 'survived');
    await executable(join(shimDir, 'ssh'), `#!/bin/sh\n(sleep 2; touch '${marker}') &\necho $! > '${pidPath}'\nwait\n`);
    const controller = new AbortController();
    const pending = runGitTransport({ preparationRoot: f.root, args: ['ls-remote', 'ssh://git@example.invalid/team/repo.git'], signal: controller.signal, timeoutMs: kind === 'timeout' ? 500 : 5000, env: { ...hostConfig, PATH: `${shimDir}:${process.env.PATH}` } });
    const caught = pending.catch(error => error);
    for (let attempt = 0; attempt < 100 && !existsSync(pidPath); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(pidPath)).toBe(true);
    if (kind === 'cancel') controller.abort();
    expect(await caught).toMatchObject({ details: { reason: kind === 'timeout' ? 'timeout' : 'cancelled' } });
    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    // Linux can briefly retain an adopted zombie, but no live descendant may remain.
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    expect(stat === '' || /^\d+ \(.+\) Z /u.test(stat)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
