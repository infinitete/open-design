import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export async function createGitFixture() {
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'od-git-test-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = async (cwd: string, ...args: string[]) => {
    const pending = exec('git', args, {
    cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'OD Test', GIT_AUTHOR_EMAIL: 'od@example.invalid',
      GIT_COMMITTER_NAME: 'OD Test', GIT_COMMITTER_EMAIL: 'od@example.invalid' },
    });
    pending.child.stdin?.end();
    return (await pending).stdout.trim();
  };
  const remote = join(root, 'remote.git');
  const a = join(root, 'a');
  const b = join(root, 'b');
  try {
    await git(root, 'init', '--bare', '--initial-branch=main', remote);
    await git(root, 'clone', remote, a);
    await git(root, 'clone', remote, b);
    for (const clone of [a, b]) {
      await git(clone, 'config', '--local', 'user.name', 'OD Test');
      await git(clone, 'config', '--local', 'user.email', 'od@example.invalid');
    }
    return { root, remote, a, b, git, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
