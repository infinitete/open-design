import { acquireRepositoryLease, getRepositoryOwnerDomain } from '../../src/services/project-git/repository-lease.js';

// A real independent process, loaded through tsx. Never inherit user Git config.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null';
process.env.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_SYSTEM;
let lease: Awaited<ReturnType<typeof acquireRepositoryLease>> | undefined;
process.on('message', async (message: { action: string; root: string; dataRootId?: string }) => {
  try {
    if (message.action === 'acquire') {
      lease = await acquireRepositoryLease({ root: message.root, instanceId: `worker-${process.pid}`,
        ownerDomain: (await getRepositoryOwnerDomain()) ?? 'unknown', dataRootId: message.dataRootId ?? 'fixture-data' });
      process.send?.({ status: 'acquired', pid: process.pid });
    } else if (message.action === 'release') {
      await lease?.release(); process.send?.({ status: 'released' });
    }
  } catch (error) {
    process.send?.({ status: 'error', code: (error as { code?: string }).code, message: (error as Error).message });
  }
});
process.send?.({ status: 'ready' });
