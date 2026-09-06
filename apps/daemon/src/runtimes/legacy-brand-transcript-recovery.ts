import type { Project } from '@open-design/contracts';
import {
  countMessages,
  getConversation,
  getProject,
  listProjects,
} from '../db.js';
import {
  backfillBrandExtractionTranscriptForProject,
  readBrandDetail,
} from '../brands/index.js';
import type { ProjectGitStartupCoordination } from '../services/project-git/mutation-adapter.js';

interface BindingEpoch {
  generation: number;
  projectRevision: number;
}

interface LegacyBrandTranscriptRecoveryOptions {
  db: Parameters<typeof listProjects>[0];
  brandsRoot: string;
  projectsRoot: string;
  recoveryReady: Promise<void>;
  bindingFor(projectId: string): BindingEpoch | null;
  coordination: ProjectGitStartupCoordination;
  randomId(): string;
  transcriptAgent?: { agentId: string; agentName: string };
  onError?(projectId: string, error: unknown): void;
}

interface TranscriptCandidate {
  project: Project;
  conversationId: string;
}

function candidateFor(
  db: LegacyBrandTranscriptRecoveryOptions['db'],
  brandsRoot: string,
  project: Project,
): TranscriptCandidate | null {
  const metadata = project.metadata;
  if (metadata?.kind !== 'brand' || metadata.importedFrom !== 'brand-extraction') return null;
  const brandId = metadata.brandId;
  if (!brandId) return null;
  const detail = readBrandDetail(brandsRoot, brandId);
  const conversationId = detail?.meta.extractionConversationId;
  if (
    !detail
    || detail.meta.projectId !== project.id
    || !conversationId
    || !(detail.meta.sourceUrl || metadata.brandSourceUrl)
  ) return null;
  const conversation = getConversation(db, conversationId);
  if (!conversation || conversation.projectId !== project.id) return null;
  if (countMessages(db, conversationId) !== 0) return null;
  return { project, conversationId };
}

export async function recoverLegacyBrandTranscriptsAtStartup(
  options: LegacyBrandTranscriptRecoveryOptions,
): Promise<{ examined: number; repaired: number; failed: number }> {
  await options.recoveryReady;
  const result = { examined: 0, repaired: 0, failed: 0 };
  for (const project of listProjects(options.db)) {
    const candidate = candidateFor(options.db, options.brandsRoot, project);
    if (!candidate) continue;
    result.examined += 1;
    const binding = options.bindingFor(project.id);
    const bindingGeneration = binding?.generation ?? 0;
    const projectRevision = binding?.projectRevision ?? 0;
    try {
      const repaired = await options.coordination.repairIfNeeded({
        projectId: project.id,
        bindingGeneration,
        projectRevision,
        source: 'legacy-brand-transcript-recovery',
        recheck: async () => {
          const current = getProject(options.db, project.id);
          return Boolean(current && candidateFor(options.db, options.brandsRoot, current));
        },
        work: async () => {
          const current = getProject(options.db, project.id);
          const currentCandidate = current
            ? candidateFor(options.db, options.brandsRoot, current)
            : null;
          if (!currentCandidate) {
            throw new Error('Legacy brand transcript candidate changed after recheck.');
          }
          await backfillBrandExtractionTranscriptForProject({
            db: options.db,
            conversationId: currentCandidate.conversationId,
            randomId: options.randomId,
            brandsRoot: options.brandsRoot,
            projectsRoot: options.projectsRoot,
            project: currentCandidate.project,
            ...(options.transcriptAgent ? { transcriptAgent: options.transcriptAgent } : {}),
          });
        },
      });
      if (repaired.mutated) result.repaired += 1;
    } catch (error) {
      result.failed += 1;
      options.onError?.(project.id, error);
    }
  }
  return result;
}
