import { randomUUID } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { GitDomainError } from './errors.js';
import { runGit } from './git-process.js';
import { discoverRepository } from './repository.js';

export interface RepositoryLeaseInput {
  root: string;
  instanceId: string;
  ownerDomain: string;
  dataRootId: string;
}
export interface RepositoryLease { release(): Promise<void> }
interface LeaseOwner extends Omit<RepositoryLeaseInput, 'root'> { token: string; pid: number }
const LOCK_REF = 'refs/open-design/locks/repository';

function busy(): GitDomainError {
  return new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'The repository is owned by another operation or requires recovery.',
    { nextStep: 'Wait for the owner or coordinate recovery with its data root.' });
}

/** Unknown platforms/domains can acquire a free lease, but cannot prove stale ownership. */
export async function getRepositoryOwnerDomain(): Promise<string | null> {
  if (process.platform !== 'linux' || !process.getuid) return null;
  try {
    const [boot, pidNamespace, userNamespace] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readlink('/proc/self/ns/pid'), readlink('/proc/self/ns/user'),
    ]);
    if (!/^[a-f0-9-]{36}$/u.test(boot.trim()) || !/^pid:\[\d+\]$/u.test(pidNamespace)
      || !/^user:\[\d+\]$/u.test(userNamespace)) return null;
    return JSON.stringify([hostname(), process.getuid(), boot.trim(), pidNamespace, userNamespace]);
  } catch { return null; }
}

function parseOid(bytes: Buffer): string {
  const value = bytes.toString('utf8');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n$/u.test(value)) throw busy();
  return value.trim();
}

function parseOwner(bytes: Buffer): LeaseOwner {
  if (bytes.length > 16_384) throw busy();
  let value: Partial<LeaseOwner> | null;
  try { value = JSON.parse(bytes.toString('utf8')) as Partial<LeaseOwner> | null; } catch { throw busy(); }
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.pid) || value.pid! <= 0
    || typeof value.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.token)
    || [value.instanceId, value.ownerDomain, value.dataRootId].some(field => typeof field !== 'string' || !field.trim())) throw busy();
  return value as LeaseOwner;
}

export async function acquireRepositoryLease(input: RepositoryLeaseInput): Promise<RepositoryLease> {
  const { instanceId, ownerDomain, dataRootId } = input;
  if ([instanceId, ownerDomain, dataRootId].some(value => !value.trim() || value.length > 4096)) {
    throw new GitDomainError('VALIDATION_FAILED', 400, 'Repository ownership identifiers are required.');
  }
  const { root } = await discoverRepository(input.root);
  const readRef = async (): Promise<string | null> => {
    try { return parseOid((await runGit({ cwd: root, args: ['rev-parse', '--verify', '--quiet', LOCK_REF] })).stdout); }
    catch (error) {
      if (error instanceof GitDomainError && error.details?.exitCode === 1) return null;
      throw error;
    }
  };
  const previousOid = await readRef();
  if (previousOid) {
    let owner: LeaseOwner;
    try { owner = parseOwner((await runGit({ cwd: root, args: ['cat-file', 'blob', previousOid] })).stdout); }
    catch { throw busy(); }
    // Operation ownership is checked before liveness. This layer never replays a journal.
    const localDomain = await getRepositoryOwnerDomain();
    if (!localDomain || ownerDomain !== localDomain || owner.ownerDomain !== localDomain
      || owner.dataRootId !== dataRootId) throw busy();
    try { process.kill(owner.pid, 0); throw busy(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw busy(); }
  }
  const owner: LeaseOwner = { token: randomUUID(), pid: process.pid, instanceId, ownerDomain, dataRootId };
  const ownerOid = parseOid((await runGit({ cwd: root, args: ['hash-object', '-w', '--stdin'],
    stdin: Buffer.from(JSON.stringify(owner)) })).stdout);
  try {
    await runGit({ cwd: root, args: ['update-ref', '--no-deref', LOCK_REF, ownerOid, previousOid ?? ''] });
  } catch (error) {
    if (error instanceof GitDomainError && error.code === 'GIT_UNAVAILABLE') throw error;
    throw busy();
  }
  let release: Promise<void> | undefined;
  return { release: () => release ??= (async () => {
    try {
      // Native conditional stdin delete: never dereference or remove a successor owner.
      await runGit({ cwd: root, args: ['update-ref', '--no-deref', '--stdin'],
        stdin: Buffer.from(`delete ${LOCK_REF} ${ownerOid}\n`) });
    } catch (error) {
      if (await readRef() === ownerOid) throw error;
    }
  })() };
}
