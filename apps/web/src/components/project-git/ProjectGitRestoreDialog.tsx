'use client';

import type { ProjectGitBasis, ProjectGitPreview, ProjectGitState } from '@open-design/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { ProjectGitHttpError, type ProjectGitClient } from '../../providers/project-git';
import { subscribeProjectEvents } from '../../providers/project-events';
import { ProjectGitDependencies, ProjectGitDialogPortal, useGitDialog } from './ProjectGitFeedback';
import styles from './ProjectGit.module.css';

export function gitBasisMatches(basis: ProjectGitBasis, state: ProjectGitState) {
  return basis.projectRevision === state.projectRevision && basis.contentRevision === state.contentRevision
    && basis.localHead === state.localHead && basis.remoteHead === state.observedRemoteHead
    && basis.bindingGeneration === state.bindingGeneration;
}

export function gitRequestKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export interface ProjectGitRestoreDialogProps {
  projectId: string; targetOid: string; client: ProjectGitClient;
  onCompleted: (state: ProjectGitState) => void | Promise<void>; onClose: () => void;
}

export function ProjectGitRestoreDialog({ projectId, targetOid, client, onCompleted, onClose }: ProjectGitRestoreDialogProps) {
  const { t } = useI18n();
  const dialog = useGitDialog(onClose);
  const [preview, setPreview] = useState<ProjectGitPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ProjectGitState | null>(null);
  const request = useRef<AbortController | null>(null);
  const previewRef = useRef<ProjectGitPreview | null>(null);
  const latestEventState = useRef<ProjectGitState | null>(null);
  const invalidate = useCallback(() => {
    previewRef.current = null; setPreview(null); setError(t('projectGit.stalePreview'));
  }, [t]);

  const requestPreview = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    latestEventState.current = null;
    previewRef.current = null; setPreview(null); setError(null); setPending(true);
    try {
      const current = await client.state(projectId, controller.signal);
      if (controller.signal.aborted) return;
      setState(current);
      if (current.phase === 'conflict') { invalidate(); return; }
      const result = await client.execute(projectId, { kind: 'restore_preview', oid: targetOid }, current.projectRevision, { idempotencyKey: gitRequestKey(), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.status !== 'succeeded') throw new ProjectGitHttpError(409, result.error ?? { code: 'INTERNAL_ERROR', message: '' });
      const next = result.result?.preview;
      if (!next || next.kind !== 'restore' || next.targetOid !== targetOid) throw new Error('Invalid restore preview');
      const fresh = await client.state(projectId, controller.signal);
      if (controller.signal.aborted) return;
      setState(fresh);
      // The subscription can update this ref while the requests above await.
      const observed = latestEventState.current as ProjectGitState | null;
      if (next.expiresAt <= Date.now() || !gitBasisMatches(next.basis, fresh) || fresh.phase === 'conflict'
        || (observed && (!gitBasisMatches(next.basis, observed) || observed.phase === 'conflict'))) { invalidate(); return; }
      previewRef.current = next; setPreview(next);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof ProjectGitHttpError && ['PREVIEW_STALE', 'PROJECT_STATE_CHANGED'].includes(cause.apiError.code) ? t('projectGit.stalePreview') : t('projectGit.phase.failed'));
    } finally { if (!controller.signal.aborted) setPending(false); }
  }, [client, projectId, targetOid, invalidate, t]);

  useEffect(() => { void requestPreview(); return () => request.current?.abort(); }, [requestPreview]);
  useEffect(() => subscribeProjectEvents(projectId, event => {
    if (event.type !== 'project-git-state' || event.projectId !== projectId) return;
    latestEventState.current = event.state;
    setState(event.state);
    const current = previewRef.current;
    if (current && (!gitBasisMatches(current.basis, event.state) || event.state.phase === 'conflict')) invalidate();
  }), [projectId, invalidate]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(invalidate, Math.max(0, preview.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [preview, invalidate]);

  const confirm = async () => {
    const selected = previewRef.current;
    if (pending || !selected) return;
    setPending(true); setError(null);
    const controller = new AbortController(); request.current = controller;
    try {
      const fresh = await client.state(projectId, controller.signal);
      if (controller.signal.aborted) return;
      if (previewRef.current !== selected || selected.expiresAt <= Date.now() || !gitBasisMatches(selected.basis, fresh) || fresh.phase === 'conflict') { invalidate(); return; }
      // Never rebase an old preview onto freshly read authority.
      previewRef.current = null; setPreview(null);
      const result = await client.execute(projectId, { kind: 'restore', previewId: selected.id }, selected.basis.projectRevision, { idempotencyKey: gitRequestKey(), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.status !== 'succeeded') throw new ProjectGitHttpError(409, result.error ?? { code: 'INTERNAL_ERROR', message: '' });
      const completed = await client.state(projectId, controller.signal);
      if (!controller.signal.aborted) await onCompleted(completed);
    } catch (cause) {
      if (!controller.signal.aborted) {
        previewRef.current = null; setPreview(null);
        setError(cause instanceof ProjectGitHttpError && ['PREVIEW_STALE', 'PROJECT_STATE_CHANGED'].includes(cause.apiError.code) ? t('projectGit.stalePreview') : t('projectGit.phase.failed'));
      }
    } finally { if (!controller.signal.aborted) setPending(false); }
  };

  return <ProjectGitDialogPortal><div className={styles.backdrop}>
    <section {...dialog} role="dialog" aria-modal="true" aria-labelledby="git-restore-title" className={styles.modal}>
      <header className={styles.header}><h2 id="git-restore-title">{t('projectGit.restore')}</h2><button type="button" aria-label={t('common.close')} onClick={onClose}>×</button></header>
      <p>{targetOid}</p><p>{t('projectGit.restoreImpact')}</p><p>{t('projectGit.externalEditorNotice')}</p>
      {preview ? <div className={styles.preview}>
        <h3>{t(preview.changes.historyMode === 'complete' ? 'projectGit.completeVersion' : 'projectGit.fileVersion')}</h3>
        {preview.changes.historyMode === 'files_only' ? <p>{t('projectGit.filesOnlyRestore')}</p> : null}
        <p>{t('projectGit.settings')}: {preview.changes.settingsChanged} · {t('projectGit.records')}: {preview.changes.conversationsChanged}</p>
        {([['+', preview.changes.addedPaths], ['~', preview.changes.modifiedPaths], ['−', preview.changes.deletedPaths]] as const).map(([label, paths]) => <ul key={label}>{paths.map(path => <li key={path}>{label} {path}</li>)}</ul>)}
        {preview.changes.missingPaths.length ? <p>{t('projectGit.missing')}: {preview.changes.missingPaths.join(', ')}</p> : null}
        <ProjectGitDependencies dependencies={preview.dependencies} />
      </div> : null}
      <button type="button" disabled={pending || state?.phase === 'conflict'} onClick={() => void requestPreview()}>{t('projectGit.preview')}</button>
      <button type="button" disabled={pending || !preview || state?.phase === 'conflict' || preview.dependencies.some(item => item.requiredForContent) || preview.changes.missingPaths.length > 0} onClick={() => void confirm()}>{t('projectGit.confirmRestore')}</button>
      {pending ? <p role="status">{t('common.loading')}</p> : null}
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    </section>
  </div></ProjectGitDialogPortal>;
}
