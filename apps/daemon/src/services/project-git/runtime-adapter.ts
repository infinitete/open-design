import type { ProjectGitBindingRecord, ProjectGitStore } from '../../storage/project-git.js';
import type { MutationPermit, ProjectGate } from './gate.js';
import { assertProjectRevision } from './mutation-adapter.js';
import { GitDomainError } from './errors.js';

interface RuntimeStore {
  getBinding(projectId: string): Pick<
    ProjectGitBindingRecord,
    'projectRevision' | 'contentRevision' | 'generation'
  > | null;
  recordRunTerminal: ProjectGitStore['recordRunTerminal'];
}

export interface ProjectRunPermit {
  projectId: string;
  executionAttempt: number;
  bindingGeneration: number;
  projectRevision: number;
  permit: MutationPermit;
  release(): void;
}

export interface ProjectRunAdmission {
  projectId: string;
  projectRevision: number;
  bindingGeneration?: number;
  permit?: MutationPermit;
  release(): void;
}

export interface ProjectRunMutationContext {
  expectedProjectRevision: number;
  permit: MutationPermit;
}

export interface ProjectMutationSession {
  projectId: string;
  expectedProjectRevision: number;
  permit?: MutationPermit;
  release(): void;
}

export interface RecoveredProjectTerminals {
  projectId: string;
  bindingGeneration: number;
  projectRevision: number;
  terminals: ReadonlyArray<{ runId: string; executionAttempt: number; terminal: string }>;
}

export interface ProjectGitRuntimeAdapterDeps {
  store: RuntimeStore;
  gateFor(projectId: string): ProjectGate | Promise<ProjectGate>;
  recoveryReady: Promise<void>;
  notify(projectId: string): void;
  permits: Map<string, ProjectRunPermit>;
}

export function createProjectGitRuntimeAdapter(deps: ProjectGitRuntimeAdapterDeps): {
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
} {
  const admissionStates = new WeakMap<
    ProjectRunAdmission,
    { attachedRunId: string | null; released: boolean }
  >();
  const notify = (projectId: string): void => {
    try { deps.notify(projectId); } catch { /* Durable receipt remains authoritative. */ }
  };
  return {
    async admit(projectId, expectedProjectRevision) {
      await deps.recoveryReady;
      const release = await (await deps.gateFor(projectId)).beginRun();
      try {
        const binding = deps.store.getBinding(projectId);
        assertProjectRevision(
          binding !== null,
          binding?.projectRevision ?? 0,
          expectedProjectRevision,
        );
        const state = { attachedRunId: null, released: false };
        const admission: ProjectRunAdmission = Object.freeze({
          projectId,
          projectRevision: binding?.projectRevision ?? 0,
          ...(binding ? { bindingGeneration: binding.generation } : {}),
          permit: release.permit,
          release: () => {
            if (state.released) return;
            state.released = true;
            release();
          },
        });
        admissionStates.set(admission, state);
        return admission;
      } catch (error) {
        release();
        throw error;
      }
    },
    async admitSession(projectId, expectedProjectRevision) {
      await deps.recoveryReady;
      const release = await (await deps.gateFor(projectId)).beginRun();
      try {
        const binding = deps.store.getBinding(projectId);
        assertProjectRevision(
          binding !== null,
          binding?.projectRevision ?? 0,
          expectedProjectRevision,
        );
        return Object.freeze({
          projectId,
          expectedProjectRevision: binding?.projectRevision ?? 0,
          permit: release.permit,
          release,
        });
      } catch (error) {
        release();
        throw error;
      }
    },
    attach(runId, projectId, admission, executionAttempt) {
      const state = admissionStates.get(admission);
      if (!state) throw new Error('Project run admission is not owned by this runtime.');
      if (admission.projectId !== projectId) {
        throw new Error('Project run admission project mismatch.');
      }
      if (state.released) throw new Error('Project run admission is already released.');
      if (state.attachedRunId !== null) {
        throw new Error(`Project run admission is already attached to ${state.attachedRunId}.`);
      }
      if (deps.permits.has(runId)) {
        throw new Error(`Run ${runId} already has a project admission.`);
      }
      if (!admission.permit) {
        throw new Error('Project run admission has no mutation permit.');
      }
      if (!Number.isSafeInteger(executionAttempt) || executionAttempt < 0) {
        throw new Error('Project run execution attempt must be a nonnegative safe integer.');
      }
      state.attachedRunId = runId;
      deps.permits.set(runId, {
        projectId,
        executionAttempt,
        bindingGeneration: admission.bindingGeneration ?? 0,
        projectRevision: admission.projectRevision,
        permit: admission.permit,
        release: admission.release,
      });
      return admission.bindingGeneration === undefined ? null : {
        bindingGeneration: admission.bindingGeneration,
        projectRevision: admission.projectRevision,
      };
    },
    detach(runId, admission) {
      const state = admissionStates.get(admission);
      if (!state) throw new Error('Project run admission is not owned by this runtime.');
      if (state.released) throw new Error('Project run admission is already released.');
      if (state.attachedRunId !== runId) {
        throw new Error(`Project run admission is not attached to ${runId}.`);
      }
      const permit = deps.permits.get(runId);
      if (!permit || permit.release !== admission.release) {
        throw new Error(`Run ${runId} does not own the supplied project admission.`);
      }
      deps.permits.delete(runId);
      state.attachedRunId = null;
    },
    mutationContext(runId, projectId) {
      const admission = deps.permits.get(runId);
      if (!admission || admission.projectId !== projectId) return null;
      return {
        expectedProjectRevision: admission.projectRevision,
        permit: admission.permit,
      };
    },
    onTerminal(runId, projectId, _terminal) {
      const admission = deps.permits.get(runId);
      if (!admission || admission.projectId !== projectId) return;
      try {
        if (deps.store.recordRunTerminal({
          runId,
          executionAttempt: admission.executionAttempt,
          projectId,
          bindingGeneration: admission.bindingGeneration,
          projectRevision: admission.projectRevision,
          terminal: _terminal,
        })) notify(projectId);
      } catch { /* Preserve the model terminal state and finalizer convergence. */ }
    },
    onSettled(runId) {
      const admission = deps.permits.get(runId);
      if (!admission) return;
      deps.permits.delete(runId);
      admission.release();
    },
    reconcileTerminal(runId, projectId, bindingGeneration, projectRevision, terminal, executionAttempt) {
      if (deps.store.recordRunTerminal({
        runId,
        executionAttempt,
        projectId,
        bindingGeneration,
        projectRevision,
        terminal,
      })) notify(projectId);
    },
    async reconcileTerminalsWithLocalRepair(group, repair) {
      await deps.recoveryReady;
      const release = await (await deps.gateFor(group.projectId)).beginRun();
      try {
        const binding = deps.store.getBinding(group.projectId);
        const exactManagedEpoch = binding !== null
          && binding.generation === group.bindingGeneration
          && binding.projectRevision === group.projectRevision;
        const exactUnmanagedEpoch = binding === null
          && group.bindingGeneration === 0
          && group.projectRevision === 0;
        if (!exactManagedEpoch && !exactUnmanagedEpoch) {
          throw new GitDomainError(
            'RECOVERY_REQUIRED',
            409,
            'Recovered run terminal does not match the current project version.',
          );
        }
        await repair();
        if (binding) for (const terminal of group.terminals) {
          if (deps.store.recordRunTerminal({
            ...terminal,
            projectId: group.projectId,
            bindingGeneration: group.bindingGeneration,
            projectRevision: group.projectRevision,
          })) notify(group.projectId);
        }
      } finally {
        release();
      }
    },
  };
}
