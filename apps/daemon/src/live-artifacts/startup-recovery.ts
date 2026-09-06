import type { ProjectGitMutationAdapter, ProjectMutationInput } from '../services/project-git/mutation-adapter.js';
import {
  probeStaleLiveArtifactRefreshesForProject,
  recoverStaleLiveArtifactRefreshesForProject,
  type LiveArtifactProjectLocation,
  type LiveArtifactRefreshRecoveryCandidate,
  type LiveArtifactRefreshRecoveryResult,
} from './store.js';

export interface StartupLiveArtifactProject {
  id: string;
  projectMetadata?: unknown;
  expectedProjectRevision?: number | undefined;
}

type StartupRecoveryCoordination = Pick<ProjectGitMutationAdapter, 'withProjectRead' | 'withProjectMutation'>;

export interface RecoverLiveArtifactsAtStartupOptions {
  projectsRoot: string;
  projects: readonly StartupLiveArtifactProject[];
  recoveryReady: Promise<void>;
  coordination: StartupRecoveryCoordination;
  probe?: (location: LiveArtifactProjectLocation) => Promise<LiveArtifactRefreshRecoveryCandidate[]>;
  recover?: (location: LiveArtifactProjectLocation) => Promise<LiveArtifactRefreshRecoveryResult[]>;
  onError?: (projectId: string, error: unknown) => void;
}

/**
 * Coordinates daemon-startup repair without scanning arbitrary filesystem roots.
 * Task 13 supplies the real recoveryReady and shared coordination runtime.
 */
export async function recoverLiveArtifactsAtStartup(options: RecoverLiveArtifactsAtStartupOptions): Promise<void> {
  await options.recoveryReady;
  const probe = options.probe ?? probeStaleLiveArtifactRefreshesForProject;
  const recover = options.recover ?? recoverStaleLiveArtifactRefreshesForProject;
  for (const project of options.projects) {
    const location: LiveArtifactProjectLocation = {
      projectsRoot: options.projectsRoot,
      projectId: project.id,
      ...(project.projectMetadata === undefined ? {} : { projectMetadata: project.projectMetadata }),
    };
    try {
      const candidates = await options.coordination.withProjectRead(project.id, () => probe(location));
      if (candidates.length === 0) continue;
      const mutation: ProjectMutationInput = {
        projectId: project.id,
        source: 'live-artifact.startup-recovery',
        ...(project.expectedProjectRevision === undefined ? {} : { expectedProjectRevision: project.expectedProjectRevision }),
      };
      await options.coordination.withProjectMutation(mutation, async () => {
        if ((await probe(location)).length === 0) return [];
        return recover(location);
      });
    } catch (error) {
      options.onError?.(project.id, error);
    }
  }
}
