import { GitDomainError } from './errors.js';
import { acquireRepositoryLease, type RepositoryLease, type RepositoryLeaseInput } from './repository-lease.js';
import { discoverObjectStore, discoverRepository } from './repository.js';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { initializeRepository, runGit, type GitInitializationInput } from './git-process.js';
import type { ProjectGitStore } from '../../storage/project-git.js';
import { isDeepStrictEqual } from 'node:util';
import { readBindingEvidence, rootInventory } from './binding-evidence.js';
import { isPrivateProjectGitPath } from './checkpoint.js';
import { safeFile, sha256 } from './recovery.js';

declare const permitBrand: unique symbol;
export interface MutationPermit { readonly [permitBrand]: true }
export interface RunRelease { (): void; readonly permit: MutationPermit }
export interface ProjectGateOptions { acquireLease?: () => Promise<RepositoryLease> }
export interface ProjectRecoveryBarrier {
  readonly operationId: string;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  release(): void;
}
export interface ProjectGate {
  read<T>(work: () => Promise<T>, timeoutMs?: number): Promise<T>;
  mutate<T>(work: (permit: MutationPermit) => Promise<T>, permit?: MutationPermit): Promise<T>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  beginRun(): Promise<RunRelease>;
  activeRuns(): number;
  holdRecovery(operationId: string): ProjectRecoveryBarrier;
}

/** Reference counts admitted daemon work; a release in flight is an acquisition barrier. */
function shareLease(acquire: () => Promise<RepositoryLease>): () => Promise<RepositoryLease> {
  let current: { users: number; lease: Promise<RepositoryLease> } | undefined;
  let releasing: Promise<void> | undefined;
  let failure: unknown;
  return async () => {
    if (releasing) await releasing;
    if (failure) throw failure;
    const cycle = current ??= { users: 0, lease: acquire() };
    cycle.users++;
    let lease: RepositoryLease;
    try { lease = await cycle.lease; }
    catch (error) { if (--cycle.users === 0) current = undefined; throw error; }
    let released = false;
    return { release: async () => {
      if (released) return;
      released = true;
      if (--cycle.users !== 0) return;
      current = undefined;
      const pending = lease.release();
      releasing = pending;
      try { await pending; } catch (error) { failure = error; throw error; }
      finally { releasing = undefined; }
    } };
  };
}

export function createProjectGate(options: ProjectGateOptions = {}): ProjectGate {
  return createGate(options);
}
const bootstrapExclusive = new WeakMap<ProjectGate, <T>(work: () => Promise<T>) => Promise<T>>();
function createGate(options: ProjectGateOptions, validateAdmission?: () => Promise<void>): ProjectGate {
  const acquire = shareLease(options.acquireLease ?? (async () => ({ release: async () => {} })));
  const permits = new WeakSet<MutationPermit>();
  const barriers = new Set<ProjectRecoveryBarrier>();
  const queue: { exclusive: boolean; read: boolean; recovery: ProjectRecoveryBarrier | undefined; enter(): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> | undefined }[] = [];
  let active = 0;
  let runs = 0;
  let exclusiveActive = false;
  let failure: unknown;
  const busy = () => new GitDomainError('PROJECT_BUSY', 409, 'The project is busy.', { nextStep: 'Retry after the current project operation.' });
  const recoveryRequired = () => new GitDomainError('RECOVERY_REQUIRED', 409, 'The project has an unfinished recovery operation.');

  function drain(): void {
    if (failure) {
      for (const item of queue.splice(0)) { clearTimeout(item.timer); item.reject(failure); }
      return;
    }
    if (exclusiveActive) return;
    while (queue.length) {
      const index = barriers.size ? queue.findIndex(item => item.recovery && barriers.has(item.recovery)) : 0;
      if (index < 0) return;
      const item = queue[index]!;
      if (item.exclusive && active !== 0) return;
      queue.splice(index, 1); clearTimeout(item.timer); item.enter();
      if (item.exclusive) return;
    }
  }

  function schedule<T>(kind: 'read' | 'mutation' | 'exclusive' | 'run', work: (permit: MutationPermit) => Promise<T>,
    owner?: MutationPermit, timeoutMs?: number, recovery?: ProjectRecoveryBarrier, bootstrap = false): Promise<T> {
    if (failure) return Promise.reject(failure);
    if ((recovery && !barriers.has(recovery)) || (barriers.size && kind !== 'read' && !recovery && !(owner && permits.has(owner)))) return Promise.reject(recoveryRequired());
    if (owner && !permits.has(owner)) return Promise.reject(busy());
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) return Promise.reject(busy());
    return new Promise<T>((resolve, reject) => {
      const item = { exclusive: kind === 'exclusive', read: kind === 'read', recovery, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined,
        enter: () => {
          active++;
          if (kind === 'exclusive') exclusiveActive = true;
          const permit = Object.freeze({}) as MutationPermit;
          let lease: RepositoryLease | undefined;
          let finished = false;
          const finish = async () => {
            if (finished) return;
            finished = true; permits.delete(permit);
            try { await lease?.release(); }
            catch (error) { failure = error; throw error; }
            finally { active--; if (kind === 'exclusive') exclusiveActive = false; drain(); }
          };
          void (async () => {
            try {
              if (kind !== 'read' && !bootstrap) { await validateAdmission?.(); lease = await acquire(); }
              if (kind === 'run') {
                runs++; permits.add(permit);
                let released = false;
                const done = Object.assign(() => {
                  if (released) return;
                  released = true; runs--; permits.delete(permit);
                  void finish().catch(() => { /* Stored failure rejects all queued/future admission. */ });
                }, { permit }) as RunRelease;
                resolve(done as T); return;
              }
              if (kind === 'mutation') permits.add(permit);
              let result: T;
              try { result = await work(permit); } finally { await finish(); }
              resolve(result);
            } catch (error) {
              try { await finish(); } catch (releaseError) { reject(releaseError); return; }
              reject(error);
            }
          })();
        } };
      // Ownership only skips the waiting queue; the nested operation still owns an active slot and lease.
      if (owner) { item.enter(); return; }
      queue.push(item);
      if (timeoutMs !== undefined) item.timer = setTimeout(() => {
        const index = queue.indexOf(item);
        if (index !== -1) { queue.splice(index, 1); reject(busy()); drain(); }
      }, timeoutMs);
      drain();
    });
  }

  const gate: ProjectGate = {
    read: (work, timeoutMs) => schedule('read', work, undefined, timeoutMs),
    mutate: (work, permit) => schedule('mutation', work, permit),
    exclusive: work => schedule('exclusive', work),
    beginRun: () => schedule<RunRelease>('run', async () => { throw new Error('Unreachable run callback.'); }),
    activeRuns: () => runs,
    holdRecovery: operationId => {
      if (!operationId || [...barriers].some(item => item.operationId === operationId)) throw recoveryRequired();
      const barrier: ProjectRecoveryBarrier = Object.freeze({ operationId,
        exclusive: <T>(work: () => Promise<T>) => schedule('exclusive', work, undefined, undefined, barrier),
        release: () => {
          if (!barriers.delete(barrier)) return;
          for (let index = queue.length - 1; index >= 0; index--) if (queue[index]!.recovery === barrier) {
            const [item] = queue.splice(index, 1); clearTimeout(item!.timer); item!.reject(recoveryRequired());
          }
          drain();
        },
      });
      barriers.add(barrier);
      for (let index = queue.length - 1; index >= 0; index--) if (!queue[index]!.read && !queue[index]!.recovery) {
        const [item] = queue.splice(index, 1); clearTimeout(item!.timer); item!.reject(recoveryRequired());
      }
      return barrier;
    },
  };
  bootstrapExclusive.set(gate, work => schedule('exclusive', work, undefined, undefined, undefined, true));
  return gate;
}

const repositories = new Map<string, { identity: string; acquire: () => Promise<RepositoryLease>; gates: Map<string, ProjectGate> }>();
interface UnmanagedGate { identity: string; gate: ProjectGate; acquire: (() => Promise<RepositoryLease>) | null }
const unmanagedRoots = new Map<string, UnmanagedGate>();
const ownershipIdentity = (input: RepositoryLeaseInput) => JSON.stringify([input.instanceId, input.ownerDomain, input.dataRootId]);
const unexpectedRepository = () => new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'The project repository changed. Refresh its registration before writing.');

async function assertUnmanagedRoot(root: string): Promise<void> {
  if (await realpath(root) !== root) throw unexpectedRepository();
  const present = async (path: string) => {
    try { return await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null; }
  };
  for (let directory = root; ; directory = dirname(directory)) {
    const marker = await present(join(directory, '.git'));
    if ((marker && (directory === root || !marker.isDirectory() || await present(join(directory, '.git', 'HEAD'))))
      || (await present(join(directory, 'HEAD')) && await present(join(directory, 'objects')) && await present(join(directory, 'refs')))) throw unexpectedRepository();
    if (directory === dirname(directory)) break;
  }
}

/** Register local admission before initialization. Managed Git roots never use this lane. */
export async function getUnmanagedProjectGate(input: RepositoryLeaseInput): Promise<ProjectGate> {
  if ([input.instanceId, input.ownerDomain, input.dataRootId].some(value => !value.trim())) throw unexpectedRepository();
  const identity = ownershipIdentity(input); const current = unmanagedRoots.get(input.root);
  if (current?.identity !== undefined && current.identity !== identity) throw unexpectedRepository();
  if (current?.acquire) return current.gate;
  await assertUnmanagedRoot(input.root);
  const raced = unmanagedRoots.get(input.root);
  if (raced) { if (raced.identity !== identity) throw unexpectedRepository(); return raced.gate; }
  const entry: UnmanagedGate = { identity, acquire: null,
    gate: createGate({ acquireLease: async () => entry.acquire ? entry.acquire() : { release: async () => {} } },
      async () => { if (!entry.acquire) await assertUnmanagedRoot(input.root); }) };
  unmanagedRoots.set(input.root, entry); return entry.gate;
}

/** Initializes under the existing local gate, then holds a real shared commonDir lease for registration.
 * The callback must not re-enter this gate. Promotion remains installed after callback failure.
 */
export async function initializeProjectRepository<T>(input: RepositoryLeaseInput & Omit<GitInitializationInput, 'root'>,
  work: () => Promise<T>, verifyBeforeInitialize?: () => Promise<void>): Promise<T> {
  const entry = unmanagedRoots.get(input.root);
  if (!entry || entry.identity !== ownershipIdentity(input)) throw unexpectedRepository();
  return entry.gate.exclusive(async () => {
    if (entry.acquire) return work();
    await verifyBeforeInitialize?.();
    await assertUnmanagedRoot(input.root);
    await initializeRepository(input);
    const repository = await discoverRepository(input.root);
    let shared = repositories.get(repository.commonDir);
    if (shared && (shared.identity !== entry.identity || (shared.gates.has(repository.root) && shared.gates.get(repository.root) !== entry.gate))) throw unexpectedRepository();
    shared ??= { identity: entry.identity, acquire: shareLease(() => acquireRepositoryLease(input)), gates: new Map() };
    // Install only after actual lease acquisition. An ambiguous competing initialization fails above.
    const lease = await shared.acquire();
    shared.gates.set(repository.root, entry.gate); repositories.set(repository.commonDir, shared); entry.acquire = shared.acquire;
    try { return await work(); } finally { await lease.release(); }
  });
}

/** Bootstrap-only recovery of an exact durable first-enable initialization. */
export async function resumeInitializedProjectGate(input: RepositoryLeaseInput & { store: ProjectGitStore; operationRoot: string; operationId: string }): Promise<ProjectGate> {
  const intent = input.store.getEnableInitialization(input.operationId); const op = input.store.getJournal(input.operationId);
  if (!intent || op?.kind !== 'enable' || op.projectId !== intent.projectId || input.root !== intent.canonicalRoot
    || await realpath(input.root) !== input.root) throw unexpectedRepository();
  let entry = unmanagedRoots.get(input.root);
  if (entry && entry.identity !== ownershipIdentity(input)) throw unexpectedRepository();
  if (!entry) {
    const created: UnmanagedGate = { identity: ownershipIdentity(input), acquire: null,
      gate: createGate({ acquireLease: async () => created.acquire ? created.acquire() : { release: async () => {} } },
        async () => { if (!created.acquire) await assertUnmanagedRoot(input.root); }) };
    unmanagedRoots.set(input.root, created); entry = created;
  }
  const stable = entry;
  return bootstrapExclusive.get(stable.gate)!(async () => {
  const gitPath = join(input.root, '.git'); const gitInfo = await lstat(gitPath);
  if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink() || await realpath(gitPath) !== gitPath) throw unexpectedRepository();
  const repository = await discoverRepository(input.root);
  if (repository.commonDir !== gitPath || repository.gitDir !== gitPath) throw unexpectedRepository();
  let shared = repositories.get(repository.commonDir);
  if (shared && (shared.identity !== stable.identity || (shared.gates.has(repository.root) && shared.gates.get(repository.root) !== stable.gate))) throw unexpectedRepository();
  shared ??= { identity: stable.identity, acquire: shareLease(() => acquireRepositoryLease(input)), gates: new Map() };
  const lease = await shared.acquire();
  try {
  const preview = input.store.getJournal(intent.previewId);
  if (!preview || preview.kind !== 'enable_preview' || preview.actorId !== op.actorId || preview.projectId !== op.projectId
    || (preview.payload as { evidenceDigest?: string }).evidenceDigest !== intent.previewEvidenceDigest) throw unexpectedRepository();
  const captured = await readBindingEvidence(input.operationRoot, preview);
  if (captured.git !== null || captured.root !== input.root || captured.localBranch !== intent.branch
    || !isDeepStrictEqual(captured.basis, intent.basis) || !isDeepStrictEqual(await rootInventory(input.root), captured.inventory)) throw unexpectedRepository();
  for (const path of Object.keys(captured.sourceDigests)) {
    if (isPrivateProjectGitPath(path)) throw unexpectedRepository();
    const file = await safeFile(input.root, path);
    if ((file.bytes === null ? 'missing' : sha256(file.bytes)) !== captured.sourceDigests[path] || file.mode !== captured.sourceModes[path]) throw unexpectedRepository();
  }
  const info = await lstat(input.root); const currentRepository = await discoverRepository(input.root);
  if (!isDeepStrictEqual(repository, currentRepository)) throw unexpectedRepository();
  if (String(info.dev) !== intent.dev || String(info.ino) !== intent.ino || repository.root !== input.root || repository.head !== null
    || repository.branch !== intent.branch || (await discoverObjectStore(input.root)).objectFormat !== intent.objectFormat) throw unexpectedRepository();
  if ((await runGit({ cwd: input.root, args: ['ls-files', '--stage', '-z'] })).stdout.length) throw unexpectedRepository();
  const refs = (await runGit({ cwd: input.root, args: ['show-ref'] })).stdout.toString().trim().split('\n').filter(Boolean).map(line => line.split(' ')[1]);
  if (!isDeepStrictEqual(refs, ['refs/open-design/locks/repository'])) throw unexpectedRepository();
  shared.gates.set(repository.root, stable.gate); repositories.set(repository.commonDir, shared); stable.acquire = shared.acquire;
  return stable.gate;
  } finally { await lease.release(); }
  });
}

/** All callers for a canonical worktree receive the same gate, independent of project IDs. */
export async function getProjectGate(input: RepositoryLeaseInput): Promise<ProjectGate> {
  const registration = { ...input };
  const repository = await discoverRepository(registration.root);
  const identity = JSON.stringify([registration.instanceId, registration.ownerDomain, registration.dataRootId]);
  const promoted = unmanagedRoots.get(repository.root);
  if (promoted && (promoted.identity !== identity || !promoted.acquire)) throw unexpectedRepository();
  let shared = repositories.get(repository.commonDir);
  if (shared && shared.identity !== identity) {
    throw new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'The repository is registered to a different daemon ownership context.');
  }
  if (!shared) {
    shared = { identity, acquire: shareLease(() => acquireRepositoryLease({ ...registration, root: repository.root })), gates: new Map() };
    repositories.set(repository.commonDir, shared);
  }
  let gate = shared.gates.get(repository.root);
  if (!gate) { gate = createProjectGate({ acquireLease: shared.acquire }); shared.gates.set(repository.root, gate); }
  return gate;
}
