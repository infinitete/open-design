import type { ApiErrorCode, JsonValue } from '@open-design/contracts';

/** Safe domain boundary: never attach tool stderr, credentials, or environment values. */
export class ProjectDomainError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly details?: Record<string, JsonValue>,
  ) {
    super(message);
    this.name = 'ProjectDomainError';
  }
}

export interface ProjectMutationInput {
  projectId: string;
  source: string;
}

export interface ProjectMutationAdapter {
  withProjectMutation<T>(input: ProjectMutationInput, work: () => Promise<T>): Promise<T>;
  withProjectRead<T>(projectId: string, work: () => Promise<T>): Promise<T>;
}

export interface ProjectStartupCoordination {
  repairIfNeeded<T>(input: {
    projectId: string;
    source: string;
    recheck(): Promise<boolean>;
    work(): Promise<T>;
  }): Promise<{ mutated: false } | { mutated: true; value: T }>;
}

export interface ProjectRunAdmission {
  projectId: string;
  release(): void;
}

export interface ProjectMutationSession {
  projectId: string;
  release(): void;
}

export interface RecoveredProjectTerminals {
  projectId: string;
  terminals: ReadonlyArray<{ runId: string; executionAttempt: number; terminal: string }>;
}

export interface ProjectMutationCoordination extends ProjectMutationAdapter {
  readonly recoveryReady: Promise<void>;
  startup: ProjectStartupCoordination;
  runtime: {
    admit(projectId: string): Promise<ProjectRunAdmission>;
    admitSession(projectId: string): Promise<ProjectMutationSession>;
    attach(
      runId: string,
      projectId: string,
      admission: ProjectRunAdmission,
      executionAttempt: number,
    ): null;
    detach(runId: string, admission: ProjectRunAdmission): void;
    onTerminal(runId: string, projectId: string, terminal: string): void;
    onSettled(runId: string): void;
    reconcileTerminal(
      runId: string,
      projectId: string,
      terminal: string,
      executionAttempt: number,
    ): void;
    reconcileTerminalsWithLocalRepair(
      group: RecoveredProjectTerminals,
      repair: () => Promise<void>,
    ): Promise<void>;
  };
}

/**
 * Pass-through project mutation coordination. Project writes run directly;
 * run admission/terminal bookkeeping is structural only.
 */
export function createPassThroughProjectMutationCoordination(): ProjectMutationCoordination {
  return {
    recoveryReady: Promise.resolve(),
    async withProjectMutation(_input, work) {
      return work();
    },
    async withProjectRead(_projectId, work) {
      return work();
    },
    startup: {
      async repairIfNeeded(input) {
        if (!await input.recheck()) return { mutated: false };
        return { mutated: true, value: await input.work() };
      },
    },
    runtime: {
      async admit(projectId) {
        return Object.freeze({ projectId, release() {} });
      },
      async admitSession(projectId) {
        return Object.freeze({ projectId, release() {} });
      },
      attach() { return null; },
      detach() {},
      onTerminal() {},
      onSettled() {},
      reconcileTerminal() {},
      async reconcileTerminalsWithLocalRepair(_group, repair) {
        await repair();
      },
    },
  };
}
