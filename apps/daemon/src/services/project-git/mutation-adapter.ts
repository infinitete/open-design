import type { ProjectGitBasis } from '@open-design/contracts';
import type { ProjectGitBindingRecord, ProjectGitStore } from '../../storage/project-git.js';
import { GitDomainError } from './errors.js';
import type { MutationPermit, ProjectGate } from './gate.js';
import type { ProjectMutationSession, ProjectRunAdmission, ProjectRunMutationContext } from './runtime-adapter.js';
import type { RecoveredProjectTerminals } from './runtime-adapter.js';

type ProjectBindingEpoch = Pick<
  ProjectGitBindingRecord,
  'projectRevision' | 'contentRevision' | 'generation' | 'localHead' | 'observedRemoteHead'
>;

interface MutationStore {
  getBinding(projectId: string): ProjectBindingEpoch | null;
  bumpContent: ProjectGitStore['bumpContent'];
}

export interface ProjectMutationInput {
  projectId: string;
  expectedProjectRevision?: number;
  source: string;
  permit?: MutationPermit;
}

export interface ProjectGitMutationAdapter {
  withProjectMutation<T>(input: ProjectMutationInput, work: () => Promise<T>): Promise<T>;
  withProjectRead<T>(projectId: string, work: () => Promise<T>): Promise<T>;
}

export interface ProjectGitStartupCoordination {
  repairIfNeeded<T>(input: {
    projectId: string;
    bindingGeneration: number;
    projectRevision: number;
    source: string;
    recheck(): Promise<boolean>;
    work(): Promise<T>;
  }): Promise<{ mutated: false } | { mutated: true; value: T }>;
}

export interface ProjectGitCoordination extends ProjectGitMutationAdapter {
  readonly recoveryReady: Promise<void>;
  startup: ProjectGitStartupCoordination;
  runtime: {
    admit(projectId: string, expectedProjectRevision?: number): Promise<ProjectRunAdmission>;
    admitSession(projectId: string, expectedProjectRevision?: number): Promise<ProjectMutationSession>;
    attach(
      runId: string,
      projectId: string,
      admission: ProjectRunAdmission,
      executionAttempt: number,
    ): { bindingGeneration: number; projectRevision: number } | null;
    detach(runId: string, admission: ProjectRunAdmission): void;
    mutationContext(runId: string, projectId: string): ProjectRunMutationContext | null;
    onTerminal(runId: string, projectId: string, terminal: string): void;
    onSettled(runId: string): void;
    reconcileTerminal(
      runId: string,
      projectId: string,
      bindingGeneration: number,
      projectRevision: number,
      terminal: string,
      executionAttempt: number,
    ): void;
    reconcileTerminalsWithLocalRepair(
      group: RecoveredProjectTerminals,
      repair: () => Promise<void>,
    ): Promise<void>;
  };
}

export interface ProjectGitMutationAdapterDeps {
  store: MutationStore;
  gateFor(projectId: string): ProjectGate;
  recoveryReady: Promise<void>;
  notify(projectId: string): void;
}

export function assertProjectRevision(
  managed: boolean,
  actual: number,
  expected: number | undefined,
): void {
  if (managed && expected !== actual) {
    throw new GitDomainError(
      'PROJECT_STATE_CHANGED',
      409,
      'Reload the project before editing.',
    );
  }
}

export function expectedProjectRevisionFromTransport(input: {
  body?: unknown;
  header?: unknown;
}): number | undefined {
  const parse = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const revision = typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new GitDomainError('BAD_REQUEST', 400, 'Invalid project revision.');
    }
    return revision;
  };
  const body = parse(input.body);
  const header = parse(input.header);
  if (body !== undefined && header !== undefined && body !== header) {
    throw new GitDomainError('BAD_REQUEST', 400, 'Invalid project revision.');
  }
  return body ?? header;
}

export function createUnavailableProjectGitCoordination(store: {
  getBinding(projectId: string): { projectRevision: number } | null;
}): ProjectGitCoordination {
  const assertAvailable = (projectId: string): void => {
    if (store.getBinding(projectId)) {
      throw new GitDomainError(
        'RECOVERY_REQUIRED',
        409,
        'Project versioning is unavailable until recovery completes.',
      );
    }
  };
  return {
    recoveryReady: Promise.resolve(),
    async withProjectMutation(input, work) {
      assertAvailable(input.projectId);
      return work();
    },
    async withProjectRead(projectId, work) {
      assertAvailable(projectId);
      return work();
    },
    startup: {
      async repairIfNeeded(input) {
        assertAvailable(input.projectId);
        if (input.bindingGeneration !== 0 || input.projectRevision !== 0) {
          throw new GitDomainError('RECOVERY_REQUIRED', 409, 'Startup repair does not match the current project version.');
        }
        if (!await input.recheck()) return { mutated: false };
        return { mutated: true, value: await input.work() };
      },
    },
    runtime: {
      async admit(projectId) {
        assertAvailable(projectId);
        return Object.freeze({ projectId, projectRevision: 0, release() {} });
      },
      async admitSession(projectId) {
        assertAvailable(projectId);
        return Object.freeze({
          projectId,
          expectedProjectRevision: 0,
          release() {},
        });
      },
      attach() { return null; },
      detach() {},
      mutationContext() { return null; },
      onTerminal() {},
      onSettled() {},
      reconcileTerminal() {},
      async reconcileTerminalsWithLocalRepair(group, repair) {
        assertAvailable(group.projectId);
        if (group.bindingGeneration !== 0 || group.projectRevision !== 0) {
          throw new GitDomainError('RECOVERY_REQUIRED', 409, 'Recovered run terminal does not match the current project version.');
        }
        await repair();
      },
    },
  };
}

function basisFor(binding: ProjectBindingEpoch): ProjectGitBasis {
  return {
    bindingGeneration: binding.generation,
    projectRevision: binding.projectRevision,
    contentRevision: binding.contentRevision,
    localHead: binding.localHead ?? null,
    remoteHead: binding.observedRemoteHead ?? null,
  };
}

export function createProjectGitMutationAdapter(
  deps: ProjectGitMutationAdapterDeps,
): ProjectGitMutationAdapter & { startup: ProjectGitStartupCoordination } {
  return {
    async withProjectMutation<T>(input: ProjectMutationInput, work: () => Promise<T>): Promise<T> {
      await deps.recoveryReady;
      return deps.gateFor(input.projectId).mutate(async () => {
        const binding = deps.store.getBinding(input.projectId);
        assertProjectRevision(
          binding !== null,
          binding?.projectRevision ?? 0,
          input.expectedProjectRevision,
        );
        if (binding) deps.store.bumpContent(input.projectId, basisFor(binding));
        try {
          return await work();
        } finally {
          if (binding) {
            try { deps.notify(input.projectId); } catch { /* Preserve the mutation result. */ }
          }
        }
      }, input.permit);
    },
    async withProjectRead<T>(projectId: string, work: () => Promise<T>): Promise<T> {
      await deps.recoveryReady;
      return deps.gateFor(projectId).read(work);
    },
    startup: {
      async repairIfNeeded<T>(input: {
        projectId: string;
        bindingGeneration: number;
        projectRevision: number;
        source: string;
        recheck(): Promise<boolean>;
        work(): Promise<T>;
      }): Promise<{ mutated: false } | { mutated: true; value: T }> {
        await deps.recoveryReady;
        return deps.gateFor(input.projectId).mutate(async () => {
          const binding = deps.store.getBinding(input.projectId);
          const exactManagedEpoch = binding !== null
            && binding.generation === input.bindingGeneration
            && binding.projectRevision === input.projectRevision;
          const exactUnmanagedEpoch = binding === null
            && input.bindingGeneration === 0
            && input.projectRevision === 0;
          if (!exactManagedEpoch && !exactUnmanagedEpoch) {
            throw new GitDomainError(
              'PROJECT_STATE_CHANGED',
              409,
              'Reload the project before editing.',
            );
          }
          if (!await input.recheck()) return { mutated: false };
          if (binding) deps.store.bumpContent(input.projectId, basisFor(binding));
          try {
            return { mutated: true, value: await input.work() };
          } finally {
            if (binding) {
              try { deps.notify(input.projectId); } catch { /* Preserve repair result. */ }
            }
          }
        });
      },
    },
  };
}
