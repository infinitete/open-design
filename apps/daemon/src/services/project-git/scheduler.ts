import type { ProjectGitStore } from '../../storage/project-git.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GitDomainError } from './errors.js';

export interface ProjectGitScheduler {
  start(): void;
  notify(projectId: string): void;
  /** False means no request was admitted; true includes coalescing with already admitted work. */
  requestSync(projectId: string, oneShot: boolean): boolean;
  /** Holds are serialized per project. Nested holds are rejected, including cross-project nesting. */
  withNetworkPaused<T>(projectId: string, work: () => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

export function createProjectGitScheduler(input: {
  store: ProjectGitStore; now: () => number; random: () => number;
  detect(projectId: string): Promise<void>;
  sync(projectId: string, oneShot: boolean): Promise<void>;
}): ProjectGitScheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let stopped = false;
  const detection = new Map<string, Promise<void>>();
  const network = new Map<string, Promise<void>>();
  const oneShots = new Set<string>();
  const remoteDue = new Map<string, number>();
  const pending = new Map<string, boolean>();
  const holds = new Map<string, number>();
  const transitions = new Map<string, Promise<void>>();
  const transitionContext = new AsyncLocalStorage<boolean>();
  const remoteDelay = () => Math.round(60_000 * (0.8 + input.random() * 0.4));
  function detect(id: string): void {
    if (!running || detection.has(id)) return;
    const work = Promise.resolve().then(() => input.detect(id)).catch(() => {}).finally(() => { detection.delete(id); });
    detection.set(id, work);
  }
  function requestSync(id: string, oneShot: boolean): boolean {
    if (!running || holds.has(id)) return false;
    const binding = input.store.getBinding(id);
    if (!binding?.remoteUrl || (!oneShot && !binding.autoSync)) return false;
    if (network.has(id)) { if (oneShot && !oneShots.has(id)) pending.set(id, true); return true; }
    if (oneShot) oneShots.add(id);
    const work = Promise.resolve().then(() => { if (!holds.has(id)) return input.sync(id, oneShot); }).catch(() => {}).finally(() => {
      network.delete(id); oneShots.delete(id); remoteDue.set(id, input.now() + remoteDelay());
      if (pending.has(id)) { const next = pending.get(id)!; pending.delete(id); requestSync(id, next); }
    });
    network.set(id, work);
    return true;
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
      detect(binding.projectId);
      if (!remoteDue.has(binding.projectId)) remoteDue.set(binding.projectId, input.now());
      if (!network.has(binding.projectId) && (due.has(binding.projectId) || remoteDue.get(binding.projectId)! <= input.now())) requestSync(binding.projectId, false);
    }
  }
  return {
    start() { if (running || stopped) return; running = true; tick(); timer = setInterval(tick, 1_000); timer.unref?.(); },
    notify: detect,
    requestSync,
    withNetworkPaused,
    async stop() {
      stopped = true; running = false; clearInterval(timer); timer = undefined;
      pending.clear();
      await Promise.allSettled([...detection.values(), ...network.values(), ...transitions.values()]);
    },
  };
}
