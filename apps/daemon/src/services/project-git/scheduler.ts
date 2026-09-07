import type { ProjectGitStore } from '../../storage/project-git.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GitDomainError } from './errors.js';

export interface ProjectGitScheduler {
  start(): void;
  notify(projectId: string): void;
  /** False means no request was admitted; true includes coalescing with already admitted work. */
  requestSync(projectId: string, oneShot: boolean): boolean;
  checkRemote(projectId: string): Promise<void>;
  /** Holds are serialized per project. Nested holds are rejected, including cross-project nesting. */
  withNetworkPaused<T>(projectId: string, work: () => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

export function createProjectGitScheduler(input: {
  store: ProjectGitStore; now: () => number; random: () => number;
  /** Remaining quiet time for a coherent dirty observation, otherwise no follow-up. */
  detect(projectId: string): Promise<void | number>;
  sync(projectId: string, oneShot: boolean, checkBeforeUse?: boolean): Promise<void>;
}): ProjectGitScheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let stopped = false;
  const detection = new Map<string, Promise<void>>();
  const detectionPending = new Set<string>();
  const network = new Map<string, Promise<void>>();
  const checks = new Map<string, Promise<void>>();
  const oneShots = new Set<string>();
  const remoteDue = new Map<string, number>();
  const auditDue = new Map<string, number>();
  const quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const watcherBursts = new Set<string>();
  const pending = new Map<string, boolean>();
  const holds = new Map<string, number>();
  const transitions = new Map<string, Promise<void>>();
  const transitionContext = new AsyncLocalStorage<boolean>();
  const remoteDelay = () => Math.round(60_000 * (0.8 + input.random() * 0.4));
  function detect(id: string): void {
    if (!running) return;
    if (detection.has(id)) { detectionPending.add(id); return; }
    const work = Promise.resolve().then(async () => {
      const delay = await input.detect(id);
      if (typeof delay === 'number') scheduleQuietDetection(id, false, delay);
    }).catch(() => {}).finally(() => {
      detection.delete(id);
      if (detectionPending.delete(id)) detect(id);
    });
    detection.set(id, work);
  }
  function scheduleQuietDetection(id: string, prompt: boolean, delay = 5_000): void {
    if (!running) return;
    const current = quietTimers.get(id);
    if (current) clearTimeout(current);
    if (prompt && !watcherBursts.has(id)) {
      watcherBursts.add(id);
      detect(id);
    }
    const quiet = setTimeout(() => {
      quietTimers.delete(id);
      watcherBursts.delete(id);
      detect(id);
    }, Math.max(1, delay));
    quiet.unref?.(); quietTimers.set(id, quiet);
  }
  function requestSync(id: string, oneShot: boolean, checkBeforeUse = false): boolean {
    if (!running || holds.has(id)) return false;
    const binding = input.store.getBinding(id);
    if (!binding?.remoteUrl || (!oneShot && !binding.autoSync)) return false;
    if (network.has(id)) { if (oneShot && !oneShots.has(id)) pending.set(id, true); return true; }
    if (oneShot) oneShots.add(id);
    const work = Promise.resolve().then(() => { if (!holds.has(id)) return input.sync(id, oneShot, checkBeforeUse); }).catch(() => {}).finally(() => {
      network.delete(id); oneShots.delete(id); remoteDue.set(id, input.now() + remoteDelay());
      if (pending.has(id)) { const next = pending.get(id)!; pending.delete(id); requestSync(id, next); }
    });
    network.set(id, work);
    return true;
  }
  function checkRemote(id: string): Promise<void> {
    if (transitionContext.getStore()) return Promise.reject(new GitDomainError('PROJECT_BUSY', 409, 'A network transition cannot await its own remote check.'));
    const existing = checks.get(id);
    if (existing) return existing;
    // A scheduled attempt may stop at debounce/backoff; one shared explicit
    // follow-up must actually use the before-use lane after it settles.
    const issued = network.get(id);
    const transition = transitions.get(id);
    const work = Promise.resolve().then(async () => {
      await transition;
      await issued;
      if (requestSync(id, false, true)) await network.get(id);
    }).finally(() => { if (checks.get(id) === work) checks.delete(id); });
    checks.set(id, work);
    return work;
  }
  function withNetworkPaused<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (stopped) return Promise.reject(new GitDomainError('PROJECT_BUSY', 409, 'The project scheduler is shutting down.'));
    if (transitionContext.getStore()) return Promise.reject(new GitDomainError('PROJECT_BUSY', 409, 'Nested network transitions are not supported.'));
    // Admission closes before any await, including for a hold queued behind another transition.
    holds.set(id, (holds.get(id) ?? 0) + 1); pending.delete(id);
    const prior = transitions.get(id) ?? Promise.resolve();
    const issued = network.get(id);
    const result = prior.then(async () => {
      await issued;
      return transitionContext.run(true, work);
    });
    const completed = result.then(() => {}, () => {}).finally(() => {
      const count = holds.get(id)! - 1;
      if (count) holds.set(id, count); else holds.delete(id);
      if (transitions.get(id) === completed) transitions.delete(id);
    });
    transitions.set(id, completed);
    return result.then(async value => { await completed; return value; }, async error => { await completed; throw error; });
  }
  function tick(): void {
    const due = new Set(input.store.listDuePushes(input.now()).map(push => push.projectId));
    for (const binding of input.store.listBindings()) {
      const audit = auditDue.get(binding.projectId);
      if (audit === undefined || audit <= input.now()) {
        detect(binding.projectId);
        scheduleQuietDetection(binding.projectId, false);
        auditDue.set(binding.projectId, input.now() + 60_000);
      }
      if (!remoteDue.has(binding.projectId)) remoteDue.set(binding.projectId, input.now());
      if (!network.has(binding.projectId) && (due.has(binding.projectId) || remoteDue.get(binding.projectId)! <= input.now())) requestSync(binding.projectId, false);
    }
  }
  return {
    start() { if (running || stopped) return; running = true; tick(); timer = setInterval(tick, 1_000); timer.unref?.(); },
    notify(projectId) {
      if (!running) return;
      scheduleQuietDetection(projectId, true);
    },
    requestSync,
    checkRemote,
    withNetworkPaused,
    async stop() {
      stopped = true; running = false; clearInterval(timer); timer = undefined;
      pending.clear(); auditDue.clear(); detectionPending.clear();
      for (const quiet of quietTimers.values()) clearTimeout(quiet);
      quietTimers.clear(); watcherBursts.clear();
      await Promise.allSettled([...detection.values(), ...network.values(), ...checks.values(), ...transitions.values()]);
    },
  };
}
