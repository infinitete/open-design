'use client';

import type { ProjectGitOperation, ProjectGitPhase, ProjectGitState } from '@open-design/contracts';
import { useRef, useState } from 'react';
import { ProjectGitHttpError } from '../../providers/project-git';
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
  pending?: boolean;
  error?: string | null;
}

export function useProjectGitStatusActions(
  execute: (action: { kind: 'sync' | 'pause' | 'resume' }) => Promise<ProjectGitOperation>,
  autoSync: boolean,
) {
  const { t } = useI18n();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: 'sync' | 'pause' | 'resume') => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const operation = await execute({ kind });
      if (operation.status !== 'succeeded') setError(t('projectGit.phase.failed'));
    } catch (cause) {
      setError(cause instanceof ProjectGitHttpError && cause.status === 409
        ? t('projectGit.stalePreview') : t('projectGit.phase.failed'));
    } finally { busy.current = false; setPending(false); }
  };
  return { pending, error, onSync: () => { void run('sync'); }, onToggleAutoSync: () => { void run(autoSync ? 'pause' : 'resume'); } };
}

export function ProjectGitStatus({ state, onHistory, onSync, onToggleAutoSync, pending = false, error }: ProjectGitStatusProps) {
  const { t } = useI18n();
  const busy = pending || state.phase === 'syncing' || state.phase === 'checkpointing' || state.phase === 'recovering';
  return <div className={styles.statusBar}>
    <div role="status" aria-live="polite" data-testid="project-git-status">{t(phaseKeys[state.phase])}</div>
    <button type="button" className={styles.textButton} onClick={onHistory}>{t('projectGit.history')}</button>
    <button type="button" className={styles.textButton} disabled={busy} onClick={onSync}>{t('projectGit.syncNow')}</button>
    <button type="button" className={styles.textButton} disabled={busy} onClick={onToggleAutoSync}>
      {t(state.autoSync ? 'projectGit.pause' : 'projectGit.resume')}
    </button>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
  </div>;
}
