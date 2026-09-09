import type { ProjectMutationAdapter, ProjectMutationInput } from '../services/project-mutation.js';
import {
  probeStaleLiveArtifactRefreshesForProject,
  recoverStaleLiveArtifactRefreshesForProject,
  type LiveArtifactProjectLocation,
  type LiveArtifactRefreshRecoveryCandidate,
  type LiveArtifactRefreshRecoveryResult,
} from './store.js';

interface StartupLiveArtifactProject {
  id: string;
  projectMetadata?: unknown;
}

type StartupRecoveryCoordination = Pick<ProjectMutationAdapter, 'withProjectRead' | 'withProjectMutation'>;

export interface RecoverLiveArtifactsAtStartupOptions {
  projectsRoot: string;
  projects: readonly StartupLiveArtifactProject[];
  coordination: StartupRecoveryCoordination;
  probe?: (location: LiveArtifactProjectLocation) => Promise<LiveArtifactRefreshRecoveryCandidate[]>;
  recover?: (location: LiveArtifactProjectLocation) => Promise<LiveArtifactRefreshRecoveryResult[]>;
  onError?: (projectId: string, error: unknown) => void;
}

/**
 * Coordinates daemon-startup repair without scanning arbitrary filesystem roots.
 */
export async function recoverLiveArtifactsAtStartup(options: RecoverLiveArtifactsAtStartupOptions): Promise<void> {
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
