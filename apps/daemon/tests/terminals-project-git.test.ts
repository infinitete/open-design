import { describe, expect, it, vi } from 'vitest';
import { createTerminalService } from '../src/terminals.js';
import { createProjectGate } from '../src/services/project-git/gate.js';

function fakePty() {
  let onData = (_chunk: string) => {};
  let onExit = (_event: { exitCode: number; signal?: number }) => {};
  const child = {
    onData: vi.fn((handler: typeof onData) => { onData = handler; }),
    onExit: vi.fn((handler: typeof onExit) => { onExit = handler; }),
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
  };
  return {
    child,
    module: { spawn: vi.fn(() => child) },
    exit(event: { exitCode: number; signal?: number } = { exitCode: 0 }) { onExit(event); },
  };
}

describe('terminal project mutation session lifecycle', () => {
  it('retains the private session until actual PTY exit and releases exactly once', async () => {
    const pty = fakePty();
    const release = vi.fn();
    const terminals = createTerminalService({ loadPty: async () => pty.module as never });
    const session = await terminals.create({
      projectId: 'project',
      cwd: '/imported/project',
      projectMutationSession: {
        projectId: 'project', expectedProjectRevision: 3, permit: {} as never, release,
      },
    });
    expect(release).not.toHaveBeenCalled();
    let exited = false;
    void terminals.waitForExit(session).then(() => { exited = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(exited).toBe(false);

    pty.exit();
    pty.exit();
    await terminals.waitForExit(session);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('shutdown escalates after grace but does not release before the real exit', async () => {
    const pty = fakePty();
    const gate = createProjectGate();
    const admitted = await gate.beginRun();
    const release = vi.fn(() => admitted());
    const terminals = createTerminalService({
      loadPty: async () => pty.module as never,
      shutdownGraceMs: 1,
    });
    await terminals.create({
      projectId: 'project', cwd: '/project',
      projectMutationSession: {
        projectId: 'project', expectedProjectRevision: 0, permit: admitted.permit, release,
      },
    });

    const shutdown = terminals.shutdownActive();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    expect(pty.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(pty.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(release).not.toHaveBeenCalled();
    let exclusiveEntered = false;
    const exclusive = gate.exclusive(async () => { exclusiveEntered = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(exclusiveEntered).toBe(false);
    pty.exit({ exitCode: 137, signal: 9 });
    await shutdown;
    await exclusive;
    expect(exclusiveEntered).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not manufacture an exit or release when kill throws', async () => {
    const pty = fakePty();
    pty.child.kill.mockImplementation(() => { throw new Error('signal failed'); });
    const release = vi.fn();
    const terminals = createTerminalService({ loadPty: async () => pty.module as never });
    const session = await terminals.create({
      projectId: 'project', cwd: '/project',
      projectMutationSession: {
        projectId: 'project', expectedProjectRevision: 0, permit: {} as never, release,
      },
    });
    expect(terminals.kill(session, 'SIGTERM')).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(session.status).toBe('running');
    pty.exit({ exitCode: 1, signal: 15 });
    await terminals.waitForExit(session);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
