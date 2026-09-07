'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ProjectGitClient } from '../../providers/project-git';
import type { ProjectGitDependency } from '@open-design/contracts';
import { ProjectGitDependencies, useGitDialog } from './ProjectGitFeedback';
import styles from './ProjectGit.module.css';

export interface OpenGitProjectDialogProps { client: ProjectGitClient; onOpened: (projectId: string) => void; onClose: () => void }
export function OpenGitProjectDialog({ client, onOpened, onClose }: OpenGitProjectDialogProps) {
  const { t } = useI18n(); const [url, setUrl] = useState(''); const [branch, setBranch] = useState('main'); const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const close = () => { request.current?.abort(); onClose(); };
  const dialog = useGitDialog(close);
  useEffect(() => () => request.current?.abort(), []);
  const [dependencies, setDependencies] = useState<ProjectGitDependency[]>([]);
  const open = async () => { if (request.current) return; const controller = new AbortController(); request.current = controller; setPending(true); setError(null); try {
    const idempotencyKey = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const result = await client.execute(null, { kind: 'open', url, branch }, undefined, { idempotencyKey, signal: controller.signal });
    if (controller.signal.aborted) return;
    setDependencies(result.result?.dependencies ?? []);
    const projectId = result.status === 'succeeded' ? result.result?.projectId : undefined;
    if (!projectId) { setError(t('projectGit.openFailed')); return; }
    onOpened(projectId); onClose();
  } catch { if (!controller.signal.aborted) setError(t('projectGit.openFailed')); } finally { if (!controller.signal.aborted) { request.current = null; setPending(false); } } };
  return <div className={styles.backdrop}><section {...dialog} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="open-git-project-title">
    <header className={styles.header}><h2 id="open-git-project-title">{t('projectGit.open')}</h2><button type="button" onClick={close} aria-label={t('common.close')}>×</button></header>
    <p>{t('projectGit.autoSyncNotice')}</p>
    <p>{t('projectGit.daemonAuthNotice')}</p>
    <ProjectGitDependencies dependencies={dependencies} />
    {pending ? <p role="status" aria-live="polite">{t('projectGit.phase.syncing')}</p> : null}
    <label>{t('projectGit.url')}<input disabled={pending} aria-label={t('projectGit.url')} value={url} onChange={e => setUrl(e.target.value)} /></label>
    <label>{t('projectGit.branch')}<input disabled={pending} aria-label={t('projectGit.branch')} value={branch} onChange={e => setBranch(e.target.value)} /></label>
    <button type="button" disabled={pending || !url.trim() || !branch.trim()} onClick={() => void open()}>{pending ? t('common.loading') : t('projectGit.open')}</button>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
  </section></div>;
}
