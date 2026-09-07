'use client';

import type { ProjectGitPhase, ProjectGitState } from '@open-design/contracts';
import { useI18n } from '../../i18n';
import styles from './ProjectGit.module.css';

const phaseKeys: Record<ProjectGitPhase, `projectGit.phase.${ProjectGitPhase}`> = {
  enable_pending: 'projectGit.phase.enable_pending', waiting_idle: 'projectGit.phase.waiting_idle', dirty: 'projectGit.phase.dirty',
  checkpointing: 'projectGit.phase.checkpointing', local_saved: 'projectGit.phase.local_saved', pending_push: 'projectGit.phase.pending_push',
  syncing: 'projectGit.phase.syncing', synced: 'projectGit.phase.synced', paused: 'projectGit.phase.paused', conflict: 'projectGit.phase.conflict',
  auth_required: 'projectGit.phase.auth_required', external_git_busy: 'projectGit.phase.external_git_busy', recovering: 'projectGit.phase.recovering', failed: 'projectGit.phase.failed',
};

export interface ProjectGitStatusProps {
  state: ProjectGitState;
  onHistory: () => void;
  onSync: () => void;
  onToggleAutoSync: () => void;
}

export function ProjectGitStatus({ state, onHistory, onSync, onToggleAutoSync }: ProjectGitStatusProps) {
  const { t } = useI18n();
  const busy = state.phase === 'syncing' || state.phase === 'checkpointing' || state.phase === 'recovering';
  return <div className={styles.statusBar}>
    <div role="status" aria-live="polite" data-testid="project-git-status">{t(phaseKeys[state.phase])}</div>
    <button type="button" className={styles.textButton} onClick={onHistory}>{t('projectGit.history')}</button>
    <button type="button" className={styles.textButton} disabled={busy} onClick={onSync}>{t('projectGit.syncNow')}</button>
    <button type="button" className={styles.textButton} disabled={busy} onClick={onToggleAutoSync}>
      {t(state.autoSync ? 'projectGit.pause' : 'projectGit.resume')}
    </button>
  </div>;
}
