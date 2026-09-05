import { GitDomainError } from './errors.js';
import { acquireRepositoryLease, type RepositoryLease, type RepositoryLeaseInput } from './repository-lease.js';
import { discoverRepository } from './repository.js';

declare const permitBrand: unique symbol;
export interface MutationPermit { readonly [permitBrand]: true }
export interface RunRelease { (): void; readonly permit: MutationPermit }
export interface ProjectGateOptions { acquireLease?: () => Promise<RepositoryLease> }
export interface ProjectGate {
  read<T>(work: () => Promise<T>, timeoutMs?: number): Promise<T>;
  mutate<T>(work: (permit: MutationPermit) => Promise<T>, permit?: MutationPermit): Promise<T>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  beginRun(): Promise<RunRelease>;
  activeRuns(): number;
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
  const acquire = shareLease(options.acquireLease ?? (async () => ({ release: async () => {} })));
  const permits = new WeakSet<MutationPermit>();
  const queue: { exclusive: boolean; enter(): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> | undefined }[] = [];
  let active = 0;
  let runs = 0;
  let exclusiveActive = false;
  let failure: unknown;
  const busy = () => new GitDomainError('PROJECT_BUSY', 409, 'The project is busy.', { nextStep: 'Retry after the current project operation.' });

  function drain(): void {
    if (failure) {
      for (const item of queue.splice(0)) { clearTimeout(item.timer); item.reject(failure); }
      return;
    }
    if (exclusiveActive) return;
    while (queue.length) {
      const item = queue[0]!;
      if (item.exclusive && active !== 0) return;
      queue.shift(); clearTimeout(item.timer); item.enter();
      if (item.exclusive) return;
    }
  }

  function schedule<T>(kind: 'read' | 'mutation' | 'exclusive' | 'run', work: (permit: MutationPermit) => Promise<T>,
    owner?: MutationPermit, timeoutMs?: number): Promise<T> {
    if (failure) return Promise.reject(failure);
    if (owner && !permits.has(owner)) return Promise.reject(busy());
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) return Promise.reject(busy());
    return new Promise<T>((resolve, reject) => {
      const item = { exclusive: kind === 'exclusive', reject, timer: undefined as ReturnType<typeof setTimeout> | undefined,
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
              if (kind !== 'read') lease = await acquire();
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

  return {
    read: (work, timeoutMs) => schedule('read', work, undefined, timeoutMs),
    mutate: (work, permit) => schedule('mutation', work, permit),
    exclusive: work => schedule('exclusive', work),
    beginRun: () => schedule<RunRelease>('run', async () => { throw new Error('Unreachable run callback.'); }),
    activeRuns: () => runs,
  };
}

const repositories = new Map<string, { identity: string; acquire: () => Promise<RepositoryLease>; gates: Map<string, ProjectGate> }>();

/** All callers for a canonical worktree receive the same gate, independent of project IDs. */
export async function getProjectGate(input: RepositoryLeaseInput): Promise<ProjectGate> {
  const registration = { ...input };
  const repository = await discoverRepository(registration.root);
  const identity = JSON.stringify([registration.instanceId, registration.ownerDomain, registration.dataRootId]);
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
