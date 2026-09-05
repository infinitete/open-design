import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { GitDomainError } from './errors.js';
import { discoverObjectStore, redactGitText, validateBranch, validateRemote, validateTreeEntries } from './repository.js';

export interface GitProcessInput {
  cwd: string;
  args: readonly string[];
  stdin?: Uint8Array;
  signal?: AbortSignal;
  /** Trusted service inputs only. Never map a request body into this object. */
  env?: Record<string, string>;
  timeoutMs?: number;
}
export interface GitProcessResult { stdout: Buffer; stderr: Buffer }

const NULL_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null';
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30_000;
const IDENTITY_KEYS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const;
const TRUSTED_ENV = new Set([...IDENTITY_KEYS, 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'PATH', 'SSH_AUTH_SOCK']);
const SAFE_CONFIG = [
  'core.hooksPath=' + NULL_CONFIG, 'core.fsmonitor=false', 'core.sshCommand=ssh -o BatchMode=yes',
  'core.askPass=', 'core.pager=cat', 'commit.gpgSign=false', 'tag.gpgSign=false', 'log.showSignature=false',
  'diff.external=', 'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'push.recurseSubmodules=no',
  'gc.auto=0', 'maintenance.auto=false', 'protocol.allow=never', 'protocol.https.allow=always', 'protocol.ssh.allow=always',
];

function invalid(message = 'Unsupported automatic Git command.'): never {
  throw new GitDomainError('VALIDATION_FAILED', 400, message);
}

function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_') && !['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'].includes(key.toUpperCase())) result[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!TRUSTED_ENV.has(key) || value.includes('\0')) invalid('Unsupported trusted Git environment override.');
    if (['GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'].includes(key) && value !== NULL_CONFIG && !isAbsolute(value)) invalid('Git internal paths must be absolute.');
    result[key] = value;
  }
  return { ...result, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o NumberOfPasswordPrompts=0', GIT_SSH_VARIANT: 'ssh', LC_ALL: 'C' };
}

function validateArgs(args: readonly string[]): void {
  if (!args.length || args.some(arg => /[\x00\r\n]/u.test(arg))) invalid();
}

function indexCommand(args: readonly string[]): void {
  const operands = args[0] === '--add' ? args.slice(1) : args;
  // --index-info consumes object records, never working-file operands. Git owns
  // record syntax validation; no argv may follow this stdin-consuming option.
  if ((operands.length === 1 && operands[0] === '--index-info')
    || (operands.length === 2 && operands[0] === '-z' && operands[1] === '--index-info')) return;
  if (operands[0] !== '--cacheinfo') invalid('Index updates require cacheinfo or index-info records.');
  let fields: readonly string[];
  if (operands.length === 2) {
    const match = /^([^,]+),([^,]+),(.+)$/u.exec(operands[1]!);
    if (!match) invalid('Invalid cacheinfo record.');
    fields = match.slice(1);
  } else if (operands.length === 4) fields = operands.slice(1);
  else invalid('Cacheinfo cannot include working-file operands.');
  const [mode, oid, path] = fields;
  if (!mode || !['100644', '100755', '120000', '160000'].includes(mode) || !oid || !/^[a-fA-F0-9]{4,}$/u.test(oid) || !path) invalid('Invalid cacheinfo record.');
  // Validate the pathname independently of its object mode. Storing a link object
  // is non-executing plumbing; materialization separately rejects linked content.
  validateTreeEntries([{ path, mode: '100644' }]);
}

/** Commands here cannot checkout files, invoke filters, or start transports. */
function localCommand(args: readonly string[]): void {
  validateArgs(args);
  const [command, ...rest] = args;
  if (command === 'update-index') { indexCommand(rest); return; }
  const allowed: Record<string, readonly string[]> = {
    'rev-parse': ['--show-toplevel', '--git-common-dir', '--git-dir', '--absolute-git-dir', '--show-object-format', '--verify', '--quiet', '--end-of-options'],
    'symbolic-ref': ['--quiet', '--short', '--no-recurse'],
    'cat-file': ['-t', '-e', '-s', '--batch', '--batch-check'],
    'hash-object': ['-w', '--stdin'],
    'read-tree': ['--empty'],
    'write-tree': [],
    'commit-tree': ['-p', '-m'],
    'update-ref': ['--stdin', '-z', '--no-deref', '--create-reflog'],
    'ls-files': ['--stage', '--cached', '--others', '--exclude-standard', '-z'],
    'ls-tree': ['-z', '-r', '-t', '--full-tree', '--name-only'],
    'rev-list': ['--parents', '--topo-order', '--reverse', '--all', '--objects'],
    'merge-base': ['--is-ancestor', '--all'],
    'diff-tree': ['--no-commit-id', '--name-status', '--name-only', '--raw', '--numstat', '-r', '-z', '--root', '--no-renames'],
    'diff-index': ['--cached', '--name-status', '--name-only', '--raw', '--numstat', '-z', '--no-renames'],
    'show-ref': ['--head', '--heads', '--verify', '--hash'],
  };
  if (command === 'check-ref-format') {
    if (rest.length !== 2 || rest[0] !== '--branch' || rest[1]?.startsWith('-') || rest[1]?.includes('@{')) invalid();
    return;
  }
  const flags = command ? allowed[command] : undefined;
  if (!flags) invalid();
  for (const arg of rest) {
    if (arg.startsWith('-') && !flags.includes(arg)
      && !(command === 'rev-list' && /^--(?:max-count|skip)=\d+$/u.test(arg))) invalid();
  }
  if (command === 'hash-object' && (!rest.includes('--stdin') || rest.some(arg => !flags.includes(arg)))) invalid();
  if (command === 'write-tree' && rest.length) invalid();
  if (command === 'diff-index' && !rest.includes('--cached')) invalid();
}

/** Buffered public result, bounded while streaming; overflow never returns partial success. */
async function execute(input: GitProcessInput, env: NodeJS.ProcessEnv, config = SAFE_CONFIG): Promise<GitProcessResult> {
  if (input.signal?.aborted) throw new GitDomainError('CONFLICT', 409, 'Git operation cancelled.', { reason: 'cancelled' });
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) invalid('Git timeout must be positive.');
  if ((input.stdin?.byteLength ?? 0) > OUTPUT_LIMIT) throw new GitDomainError('PAYLOAD_TOO_LARGE', 413, 'Git input exceeds the size limit.', { limitBytes: OUTPUT_LIMIT });
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', '--no-lazy-fetch', ...config.flatMap(value => ['-c', value]), ...input.args], {
      cwd: input.cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: GitDomainError | undefined;
    let reap: Promise<void> | undefined;
    const terminate = (reason: GitDomainError) => {
      if (failure) return;
      failure = reason;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        reap = new Promise(done => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
          killer.once('error', () => { child.kill('SIGKILL'); done(); });
          killer.once('close', () => done());
        });
      } else {
        // The detached process owns a group including Git's SSH/helper descendants.
        // SIGKILL avoids a parent exiting on TERM before its children are stopped.
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    };
    const abort = () => terminate(new GitDomainError('CONFLICT', 409, 'Git operation cancelled.', { reason: 'cancelled' }));
    const timer = setTimeout(() => terminate(new GitDomainError('CONFLICT', 409, 'Git operation timed out.', { reason: 'timeout' })), timeoutMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) terminate(new GitDomainError('PAYLOAD_TOO_LARGE', 413, 'Git output exceeds the size limit.', { limitBytes: OUTPUT_LIMIT }));
      else if (!failure) target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on('error', () => { /* EPIPE is reported through the exit status. */ });
    child.once('error', error => {
      failure ??= new GitDomainError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'INTERNAL_ERROR', 503,
        'System Git is unavailable.', { nextStep: 'Check the system Git installation.' });
    });
    child.once('close', async code => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      await reap;
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString('utf8');
        const explicitAuth = /authentication|permission denied|could not read Username|could not read Password/iu.test(diagnostic);
        const explicitNetwork = /could not resolve (?:host|hostname)|connection refused|network (?:is )?unreachable|connection timed out|failed to connect/iu.test(diagnostic);
        const errorCode = /mismatched algorithms|object format|hash algorithm/iu.test(diagnostic) ? 'PORTABLE_FORMAT_UNSUPPORTED'
          : explicitAuth || (!explicitNetwork && /could not read from remote repository/iu.test(diagnostic)) ? 'GIT_AUTH_REQUIRED'
          : /unable to create.*\.lock|index\.lock.*exists|cannot lock ref/iu.test(diagnostic) ? 'EXTERNAL_GIT_BUSY' : 'CONFLICT';
        reject(new GitDomainError(errorCode, 409, 'Git operation failed.', { exitCode: code,
          ...(/not a git repository/iu.test(diagnostic) ? { reason: 'not_repository' } : {}),
          nextStep: errorCode === 'GIT_AUTH_REQUIRED' ? 'Check host Git authentication.'
            : errorCode === 'PORTABLE_FORMAT_UNSUPPORTED' ? 'Prepare a repository with the matching Git object format.' : 'Check repository state and retry.' }));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.from(redactGitText(Buffer.concat(stderr).toString('utf8'))) });
    });
    child.stdin.end(input.stdin);
  });
}

async function resolveGitIdentity(input: Pick<GitProcessInput, 'cwd' | 'env' | 'signal' | 'timeoutMs'>, env: NodeJS.ProcessEnv): Promise<void> {
  // Read identity only from explicitly trusted host scopes, never local config.
  const values = new Map<string, string>();
  for (const scope of ['--system', '--global']) {
    try {
      const result = await execute({ ...input, args: ['config', scope, '--includes', '--null', '--list'] }, env);
      for (const line of result.stdout.toString().split('\0')) {
        const separator = line.indexOf('\n');
        if (separator > 0) values.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1));
      }
    } catch (error) {
      if (!(error instanceof GitDomainError) || error.details?.exitCode !== 128) throw error;
    }
  }
  for (const key of IDENTITY_KEYS) env[key] = input.env?.[key] ?? values.get(key.endsWith('_NAME') ? 'user.name' : 'user.email') ?? '';
  if (IDENTITY_KEYS.some(key => !env[key]?.trim())) throw new GitDomainError('GIT_IDENTITY_REQUIRED', 409, 'Configure a host Git name and email to save versions.', { nextStep: 'Configure the host Git identity.' });
}

/** Preflight identity before constructing candidate objects; commit-tree repeats this check. */
export async function assertGitIdentity(input: Pick<GitProcessInput, 'cwd' | 'env' | 'signal' | 'timeoutMs'>): Promise<void> {
  await resolveGitIdentity(input, environment(input.env));
}

export async function runGit(input: GitProcessInput): Promise<GitProcessResult> {
  localCommand(input.args);
  const env = environment(input.env);
  if (input.args[0] === 'commit-tree') {
    const { stdin: _stdin, ...identityInput } = input;
    await resolveGitIdentity(identityInput, env);
  }
  // Local plumbing never needs host execution settings. Repository programs are
  // disabled by mandatory command options, independently of mutable local config.
  env.GIT_CONFIG_SYSTEM = NULL_CONFIG;
  env.GIT_CONFIG_GLOBAL = NULL_CONFIG;
  env.GIT_CONFIG_NOSYSTEM = '1';
  const args = ['diff-tree', 'diff-index'].includes(input.args[0] ?? '')
    ? [input.args[0]!, '--no-ext-diff', '--no-textconv', ...input.args.slice(1)] : input.args;
  return execute({ ...input, args }, env);
}

export interface GitTextMergeInput extends Pick<GitProcessInput, 'signal' | 'timeoutMs'> {
  /** Absolute operation-owned preparation directory; caller fences its lifecycle and location. */
  stagingDir: string;
  base: Uint8Array;
  local: Uint8Array;
  remote: Uint8Array;
}

/** Native text only, with no repository attributes, merge drivers or writable worktree operands.
 * Scratch operands/config remain under the caller-owned operation directory for recovery/inspection.
 */
export async function mergeGitText(input: GitTextMergeInput): Promise<{ kind: 'merged'; content: Buffer } | { kind: 'conflict' }> {
  if (!isAbsolute(input.stagingDir)) invalid('Text merging requires an absolute preparation directory.');
  const bytes = input.base.byteLength + input.local.byteLength + input.remote.byteLength;
  if (!Number.isFinite(bytes) || bytes > OUTPUT_LIMIT) throw new GitDomainError('PAYLOAD_TOO_LARGE', 413, 'Git input exceeds the size limit.', { limitBytes: OUTPUT_LIMIT });
  if (input.signal?.aborted) throw new GitDomainError('CONFLICT', 409, 'Git operation cancelled.', { reason: 'cancelled' });
  const scratch = await mkdtemp(join(await realpath(input.stagingDir), 'git-text-'));
  const env = environment();
  env.GIT_DIR = join(scratch, 'repository');
  env.GIT_CONFIG_SYSTEM = NULL_CONFIG; env.GIT_CONFIG_GLOBAL = NULL_CONFIG; env.GIT_CONFIG_NOSYSTEM = '1';
  const invoke = (args: string[]) => execute({ cwd: scratch, args,
    ...(input.signal ? { signal: input.signal } : {}), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) }, env);
  await invoke(['init', '--bare', '--template=', '--object-format=sha1', env.GIT_DIR]);
  await writeFile(join(scratch, 'base'), input.base, { flag: 'wx', mode: 0o600 });
  await writeFile(join(scratch, 'local'), input.local, { flag: 'wx', mode: 0o600 });
  await writeFile(join(scratch, 'remote'), input.remote, { flag: 'wx', mode: 0o600 });
  try {
    const result = await invoke(['merge-file', '--stdout', '--diff3', '--', 'local', 'base', 'remote']);
    return { kind: 'merged', content: result.stdout };
  } catch (error) {
    const exitCode = error instanceof GitDomainError ? error.details?.exitCode : undefined;
    if (typeof exitCode === 'number' && exitCode >= 1 && exitCode <= 127) return { kind: 'conflict' };
    throw error;
  }
}

export interface GitTransportInput extends Omit<GitProcessInput, 'cwd' | 'stdin'> {
  preparationRoot: string;
  /** Caller-resolved object directory only; refs and index always remain isolated. */
  objectDirectory?: string;
  objectFormat?: 'sha1' | 'sha256';
}

export interface GitInitializationInput extends Pick<GitProcessInput, 'env' | 'signal' | 'timeoutMs'> {
  root: string;
  initialBranch: string;
  objectFormat: 'sha1' | 'sha256';
}

/** Initialize only a new standalone root; never reinitialize or replace a .git target. */
export async function initializeRepository(input: GitInitializationInput): Promise<void> {
  if (!isAbsolute(input.root) || !['sha1', 'sha256'].includes(input.objectFormat)) invalid('Initialization requires an absolute root and supported object format.');
  const root = await realpath(input.root);
  if (!(await lstat(root)).isDirectory()) invalid('The project root must be a directory.');
  // Reject even malformed/dangling target entries, which Git discovery may ignore.
  // Ancestors are checked by actual Git discovery below; an unrelated malformed
  // .git directory in an ancestor does not make it a repository.
  try {
    await lstat(join(root, '.git'));
    invalid('Initialization requires a directory without an existing .git target.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await runGit({ ...input, cwd: root, args: ['rev-parse', '--git-dir'] });
    invalid('Initialization cannot run inside an existing repository.');
  } catch (error) {
    if (!(error instanceof GitDomainError) || error.details?.reason !== 'not_repository') throw error;
  }
  if (!input.initialBranch || input.initialBranch === 'HEAD' || input.initialBranch.includes('@{') || /[\x00-\x20\x7f]/u.test(input.initialBranch)) invalid('Invalid initial branch.');
  await runGit({ ...input, cwd: root, args: ['check-ref-format', '--branch', input.initialBranch] });
  const gitDir = join(root, '.git');
  try { await mkdir(gitDir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') invalid('The repository was created by another writer.');
    throw error;
  }
  const env = environment(input.env);
  delete env.GIT_INDEX_FILE;
  env.GIT_DIR = gitDir;
  env.GIT_CONFIG_SYSTEM = NULL_CONFIG;
  env.GIT_CONFIG_GLOBAL = NULL_CONFIG;
  env.GIT_CONFIG_NOSYSTEM = '1';
  // On failure retain the reserved/partial .git for inspection. Never delete a
  // directory another process may already have started using, or any project files.
  await execute({ ...input, cwd: root, args: ['init', '--template=', `--initial-branch=${input.initialBranch}`, `--object-format=${input.objectFormat}`, root] }, env);
}

/** Full-branch fetch is the no-checkout clone equivalent; publication is a later CAS. */
export async function runGitTransport(input: GitTransportInput): Promise<GitProcessResult & { fetchedHead?: string }> {
  validateArgs(input.args);
  const [operation, remote, refspec] = input.args;
  if (!['ls-remote', 'fetch', 'push'].includes(operation ?? '') || !remote || input.args.length > 3) invalid();
  validateRemote(remote);
  let branchRef = refspec;
  if (operation === 'push') {
    const separator = refspec?.indexOf(':') ?? -1;
    if (separator < 0 || !/^[a-fA-F0-9]{4,}$/u.test(refspec!.slice(0, separator))) invalid('Push requires a commit ID and a non-force branch reference.');
    branchRef = refspec!.slice(separator + 1);
  }
  if ((operation !== 'ls-remote' || branchRef !== undefined) && !branchRef?.startsWith('refs/heads/')) invalid('Transport requires an explicit branch reference.');
  if (operation !== 'ls-remote' && !input.objectDirectory) invalid('Fetch and push require a retained Git object store.');
  if (branchRef) await validateBranch(branchRef.slice('refs/heads/'.length));
  if (!isAbsolute(input.preparationRoot) || (input.objectDirectory && !isAbsolute(input.objectDirectory))) invalid('Transport paths must be absolute.');
  if (input.objectDirectory && !input.objectFormat) invalid('Shared Git objects require an explicit object format.');
  if (input.objectDirectory) {
    const directory = await realpath(input.objectDirectory);
    const actual = await discoverObjectStore(dirname(directory));
    if (actual.objectDirectory !== directory || actual.objectFormat !== input.objectFormat) {
      throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Git object formats do not match.', { nextStep: 'Prepare a repository with the matching Git object format.' });
    }
  }
  const env = environment(input.env);
  delete env.GIT_INDEX_FILE;
  const scratch = await mkdtemp(join(await realpath(input.preparationRoot), 'git-transport-'));
  try {
    env.GIT_DIR = scratch;
    if (input.objectDirectory) env.GIT_OBJECT_DIRECTORY = await realpath(input.objectDirectory);
    const invoke = (args: readonly string[], config = SAFE_CONFIG) => execute({ ...input, cwd: scratch, args }, env, config);
    await invoke(['init', '--bare', '--template=', `--object-format=${input.objectFormat ?? 'sha1'}`, scratch]);
    // This config lookup can see trusted host config and our own fresh bare config only.
    const sshConfig = await invoke(['config', '--get', 'core.sshCommand'], SAFE_CONFIG.filter(value => !value.startsWith('core.sshCommand='))).catch(error => {
      if (error instanceof GitDomainError && error.details?.exitCode === 1) return null;
      throw error;
    });
    const ssh = sshConfig?.stdout.toString().trim() || 'ssh';
    const sshParts = /^(ssh|(?:\/[a-zA-Z0-9._-]+)+\/ssh)(?=\s|$)(.*)$/su.exec(ssh);
    if (!sshParts || /[;&|`$\r\n<>]/u.test(ssh)) {
      throw new GitDomainError('GIT_AUTH_REQUIRED', 409, 'The configured SSH wrapper cannot guarantee noninteractive Git.', { nextStep: 'Use standard OpenSSH configuration or a plain ssh command.' });
    }
    env.GIT_SSH_COMMAND = `${sshParts[1]} -o BatchMode=yes -o NumberOfPasswordPrompts=0${sshParts[2]}`;
    if (operation === 'fetch') {
      const result = await invoke(['fetch', '--no-recurse-submodules', '--no-tags', '--no-auto-maintenance', '--no-write-fetch-head', remote, `${refspec}:refs/od-transfer/head`]);
      const type = await invoke(['cat-file', '-t', 'refs/od-transfer/head']);
      if (type.stdout.toString().trim() !== 'commit') invalid('The remote branch does not contain a commit.');
      const head = await invoke(['rev-parse', '--verify', 'refs/od-transfer/head']);
      return { ...result, fetchedHead: head.stdout.toString().trim() };
    }
    if (operation === 'push') {
      const type = await invoke(['cat-file', '-t', refspec!.split(':')[0]!]);
      if (type.stdout.toString().trim() !== 'commit') invalid('Push requires a Git commit object ID.');
      return await invoke(['push', '--porcelain', '--no-verify', '--recurse-submodules=no', remote, refspec!]);
    }
    return await invoke(['ls-remote', '--heads', remote, ...(refspec ? [refspec] : [])]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
