import { readFile } from 'node:fs/promises';
import { startServer } from '../../src/server.js';
import { fixtureGitEnv } from './project-git-crash-worker.js';

interface WorkerSettings {
  gitBin: string;
  holdRetryKinds?: string[];
}

const settings = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as WorkerSettings;
const heldKinds = new Set(settings.holdRetryKinds ?? []);
const started = await startServer({
  host: '127.0.0.1',
  port: 0,
  returnServer: true,
  projectGitEnv: { ...fixtureGitEnv, PATH: `${settings.gitBin}:${process.env.PATH}` },
  projectGitAfterRetryAttemptStarted: async operation => {
    if (!heldKinds.has(operation.kind)) return;
    process.send?.({ type: 'retry-started', operationId: operation.id, kind: operation.kind });
    await new Promise<void>(() => {});
  },
});

if (
  !started
  || typeof started !== 'object'
  || !('url' in started)
  || !('shutdown' in started)
  || typeof started.shutdown !== 'function'
) throw new Error('daemon did not return a server');
const shutdown = started.shutdown;
process.send?.({ type: 'ready', url: started.url });
process.on('message', message => {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'shutdown') return;
  void Promise.resolve(shutdown()).then(() => process.exit(0), error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
});
