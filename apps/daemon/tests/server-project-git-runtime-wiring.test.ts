import fs from 'node:fs';

import { expect, it } from 'vitest';

it('wires prompt design-system sync to the exact active runtime mutation context', () => {
  const source = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const promptSync = source.slice(
    source.indexOf("source: 'run-prompt-design-system-sync'") - 700,
    source.indexOf("source: 'run-prompt-design-system-sync'") + 700,
  );

  expect(promptSync).toContain(
    'projectGitCoordination.runtime.mutationContext(runId, projectId)',
  );
  expect(promptSync).toContain('expectedProjectRevision: runMutationContext.expectedProjectRevision');
  expect(promptSync).toContain('permit: runMutationContext.permit');
  expect(source).not.toContain('projectGitRunPermits');
});

it('observes and logs detached shutdown failures after server close', () => {
  const source = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const closeHandler = source.slice(
    source.indexOf("server.once('close'"),
    source.indexOf("server.once('close'") + 500,
  );

  expect(closeHandler).toContain('shutdownDaemonRuns()');
  expect(closeHandler).toContain('.finally(cleanupDaemonBackgroundWork)');
  expect(closeHandler).toContain('.catch((error) =>');
  expect(closeHandler).toContain("console.warn('[daemon] detached shutdown failed after server close', error)");
  expect(closeHandler.indexOf('.finally(cleanupDaemonBackgroundWork)'))
    .toBeLessThan(closeHandler.indexOf('.catch((error) =>'));
});
