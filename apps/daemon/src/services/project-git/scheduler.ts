import type { ProjectGitStore } from '../../storage/project-git.js';

export function createProjectGitScheduler(input: {
  store: ProjectGitStore; now: () => number; random: () => number;
  detect(projectId: string): Promise<void>;
  sync(projectId: string, oneShot: boolean): Promise<void>;
}): { start(): void; notify(projectId: string): void; requestSync(projectId: string, oneShot: boolean): void; stop(): Promise<void> } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const detection = new Map<string, Promise<void>>();
  const network = new Map<string, Promise<void>>();
  const oneShots = new Set<string>();
  const remoteDue = new Map<string, number>();
  const pending = new Map<string, boolean>();
  const remoteDelay = () => Math.round(60_000 * (0.8 + input.random() * 0.4));
  function detect(id: string): void {
    if (!running || detection.has(id)) return;
    const work = Promise.resolve().then(() => input.detect(id)).catch(() => {}).finally(() => { detection.delete(id); });
    detection.set(id, work);
  }
  function requestSync(id: string, oneShot: boolean): void {
    if (!running) return;
    const binding = input.store.getBinding(id);
    if (!binding?.remoteUrl || (!oneShot && !binding.autoSync)) return;
    if (network.has(id)) { if (oneShot && !oneShots.has(id)) pending.set(id, true); return; }
    if (oneShot) oneShots.add(id);
    const work = Promise.resolve().then(() => input.sync(id, oneShot)).catch(() => {}).finally(() => {
      network.delete(id); oneShots.delete(id); remoteDue.set(id, input.now() + remoteDelay());
      if (pending.has(id)) { const next = pending.get(id)!; pending.delete(id); requestSync(id, next); }
    });
    network.set(id, work);
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
    start() { if (running) return; running = true; tick(); timer = setInterval(tick, 1_000); timer.unref?.(); },
    notify: detect,
    requestSync,
    async stop() {
      running = false; clearInterval(timer); timer = undefined;
      pending.clear();
      await Promise.allSettled([...detection.values(), ...network.values()]);
    },
  };
}
