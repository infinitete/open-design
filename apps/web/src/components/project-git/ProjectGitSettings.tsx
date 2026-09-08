'use client';

import type { ProjectGitAction, ProjectGitBindConfirmation, ProjectGitPreview, ProjectGitState } from '@open-design/contracts';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { ProjectGitHttpError, type ProjectGitClient } from '../../providers/project-git';
import { ProjectGitDependencies, ProjectGitDialogPortal, useGitDialog } from './ProjectGitFeedback';
import styles from './ProjectGit.module.css';

export interface ProjectGitSettingsProps { projectId: string; client: ProjectGitClient; onClose: () => void }

export function ProjectGitSettings({ projectId, client, onClose }: ProjectGitSettingsProps) {
  const { t } = useI18n();
  const dialog = useGitDialog(onClose);
  const [state, setState] = useState<ProjectGitState | null>(null);
  const [preview, setPreview] = useState<ProjectGitPreview | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [disconnect, setDisconnect] = useState(false);
  const [metadataSource, setMetadataSource] = useState<'local' | 'remote' | ''>('');
  const [paths, setPaths] = useState<Record<string, 'local' | 'remote' | 'delete'>>({});
  useEffect(() => {
    const controller = new AbortController();
    void client.state(projectId, controller.signal).then(value => {
      if (!controller.signal.aborted) setState(value);
    }).catch(() => { if (!controller.signal.aborted) setError(t('projectGit.phase.failed')); });
    return () => controller.abort();
  }, [client, projectId, t]);
  const run = async (work: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { await work(); }
    catch (cause) {
      setError(cause instanceof ProjectGitHttpError && ['PROJECT_STATE_CHANGED', 'PREVIEW_STALE'].includes(cause.apiError.code)
        ? t('projectGit.stalePreview') : t('projectGit.phase.failed'));
      setPreview(null);
    } finally { busy.current = false; setPending(false); }
  };
  const execute = async (action: ProjectGitAction, revision: number | undefined) => {
    const idempotencyKey = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const result = await client.execute(projectId, action, revision, { idempotencyKey });
    if (result.status !== 'succeeded') {
      const dependencies = result.result?.dependencies;
      if (dependencies) setState(current => current ? { ...current, dependencies } : current);
      throw new ProjectGitHttpError(409, result.error ?? { code: 'INTERNAL_ERROR', message: '' });
    }
    return result;
  };
  const requestPreview = () => run(async () => {
    setPreview(null); setDisconnect(false); setPaths({}); setMetadataSource('');
    let current = await client.state(projectId);
    setState(current);
    if (url.trim() && current.binding.remoteConfigured && current.autoSync) {
      await execute({ kind: 'pause' }, current.projectRevision);
      current = await client.state(projectId);
      setState(current);
    }
    const result = await execute(current.enabled && url.trim() ? { kind: 'binding_preview', url: url.trim(), branch: branch.trim() } : { kind: 'enable_preview' }, current.projectRevision);
    const next = result.result?.preview;
    if (!next) throw new Error('Missing preview');
    if (next.expiresAt <= Date.now()) { setError(t('projectGit.stalePreview')); return; }
    setPreview(next);
  });
  const confirm = () => run(async () => {
    if (disconnect) {
      await execute({ kind: 'unbind' }, state?.projectRevision);
      setDisconnect(false);
    } else if (preview) {
      if (preview.expiresAt <= Date.now()) { setError(t('projectGit.stalePreview')); setPreview(null); return; }
      const confirmation: ProjectGitBindConfirmation = {
        ...(metadataSource ? { metadataSource } : {}),
        ...(preview.binding?.requiredPaths.length ? { paths: preview.binding.requiredPaths.map(path => {
          const selectedSide = paths[path];
          if (!selectedSide) throw new Error('Missing binding choice');
          return { path, selectedSide };
        }) } : {}),
      };
      await execute(preview.kind === 'bind' ? { kind: 'bind', previewId: preview.id, ...(Object.keys(confirmation).length ? { confirmation } : {}) } : { kind: 'enable', previewId: preview.id }, preview.basis.projectRevision);
      setPreview(null);
    }
    setState(await client.state(projectId));
  });
  const choicesMissing = Boolean(preview?.binding && (
    (preview.binding.metadataSources.length > 0 && !metadataSource)
    || preview.binding.requiredPaths.some(path => !paths[path])
  ));
  return <ProjectGitDialogPortal><div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section {...dialog} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="project-git-settings-title">
      <header className={styles.header}><h2 id="project-git-settings-title">{t('projectGit.settings')}</h2><button type="button" onClick={onClose} aria-label={t('common.close')}>×</button></header>
      <p>{t('projectGit.daemonAuthNotice')}</p><p>{t('projectGit.externalEditorNotice')}</p>
      <ProjectGitDependencies dependencies={state?.dependencies ?? []} />
      {state && !state.enabled ? <p>{t('projectGit.phase.enable_pending')}</p> : null}
      {state?.binding.remoteConfigured ? <p>{t('projectGit.rebindNotice')}</p> : null}
      <label>{t('projectGit.url')}<input disabled={pending} value={url} onChange={event => { setUrl(event.target.value); setPreview(null); }} /></label>
      <label>{t('projectGit.branch')}<input disabled={pending} value={branch} onChange={event => { setBranch(event.target.value); setPreview(null); }} /></label>
      <button type="button" disabled={pending || (Boolean(state?.enabled && url.trim()) && !branch.trim())} onClick={() => void requestPreview()}>{t(state?.enabled && url.trim() ? 'projectGit.testConnection' : 'projectGit.preview')}</button>
      {state?.binding.remoteConfigured ? <button type="button" disabled={pending} onClick={() => { setDisconnect(true); setPreview(null); }}>{t('projectGit.unbind')}</button> : null}
      {preview ? <div className={styles.preview}>
        <p>{t('projectGit.fileOnlyWarning')}</p>
        {([
          ['projectGit.included', [...preview.changes.addedPaths, ...preview.changes.modifiedPaths, ...preview.changes.deletedPaths]],
          ['projectGit.ignored', preview.changes.ignoredPaths], ['projectGit.private', preview.changes.privatePaths], ['projectGit.missing', preview.changes.missingPaths],
        ] as const).map(([key, values]) => <div key={key}><h3>{t(key)}</h3><ul>{values.map(path => <li key={path}>{path}</li>)}</ul></div>)}
        <ProjectGitDependencies dependencies={preview.dependencies} />
        {preview.binding ? <>
          <p>{t(`projectGit.binding.${preview.binding.classification}`)}</p>
          {preview.binding.metadataSources.length ? <label>{t('projectGit.records')}<select disabled={pending} value={metadataSource} onChange={event => { const value = event.target.value; setMetadataSource(value === 'local' || value === 'remote' ? value : ''); }}>
            <option value="">{t('projectGit.choose')}</option>{preview.binding.metadataSources.map(side => <option key={side} value={side}>{t(side === 'local' ? 'projectGit.localSide' : 'projectGit.remoteSide')}</option>)}
          </select></label> : null}
          {preview.binding.requiredPaths.map(path => <label key={path}>{path}<select disabled={pending} value={paths[path] ?? ''} onChange={event => { const value = event.target.value; if (value === 'local' || value === 'remote' || value === 'delete') setPaths(current => ({ ...current, [path]: value })); }}>
            <option value="">{t('projectGit.choose')}</option><option value="local">{t('projectGit.localSide')}</option><option value="remote">{t('projectGit.remoteSide')}</option><option value="delete">{t('common.delete')}</option>
          </select></label>)}
        </> : null}
        <button type="button" disabled={pending || choicesMissing} onClick={() => void confirm()}>{t('projectGit.confirm')}</button>
      </div> : null}
      {disconnect ? <div className={styles.preview}><p>{t('projectGit.unbindNotice')}</p>{state?.operationId ? <p>{state.operationId}</p> : null}<button type="button" disabled={pending} onClick={() => void confirm()}>{t('projectGit.confirm')}</button></div> : null}
      {pending ? <p role="status" aria-live="polite">{t(disconnect ? 'projectGit.waitingUnbind' : 'common.loading')}</p> : null}
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    </section>
  </div></ProjectGitDialogPortal>;
}
