'use client';

import type { PortableSnapshot, ProjectGitCommit, ProjectGitFileResponse } from '@open-design/contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { ProjectGitClient } from '../../providers/project-git';
import styles from './ProjectGit.module.css';
import { ProjectGitDialogPortal, useGitDialog } from './ProjectGitFeedback';

export function ProjectGitPanel({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  const dialog = useGitDialog(onClose);
  return <ProjectGitDialogPortal><div className={styles.backdrop}><section {...dialog} className={`${styles.modal} ${wide ? styles.wideModal : ''}`} role="dialog" aria-modal="true" aria-label={title}>
    <header className={styles.header}><h2>{title}</h2><button type="button" aria-label={t('common.close')} onClick={onClose}>×</button></header>{children}
  </section></div></ProjectGitDialogPortal>;
}

export function decodeGitFile(file: ProjectGitFileResponse) {
  return new TextDecoder().decode(Uint8Array.from(atob(file.content), char => char.charCodeAt(0)));
}

export interface ProjectGitHistoryProps {
  projectId: string; client: ProjectGitClient; onRestore: (oid: string) => void;
  path?: string; restoreDisabled?: boolean;
}

export function ProjectGitHistory({ projectId, client, onRestore, path: initialPath = '', restoreDisabled = false }: ProjectGitHistoryProps) {
  const { t } = useI18n();
  const [path, setPath] = useState(initialPath);
  const [commits, setCommits] = useState<ProjectGitCommit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [file, setFile] = useState<ProjectGitFileResponse | null>(null);
  const [snapshot, setSnapshot] = useState<PortableSnapshot | null>(null);
  const [resources, setResources] = useState<Record<string, ProjectGitFileResponse>>({});
  const [missingResources, setMissingResources] = useState<string[]>([]);
  const detailRequest = useRef<AbortController | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const load = async (next?: string) => {
    listRequest.current?.abort(); const controller = new AbortController(); listRequest.current = controller;
    setPending(true); setError(false);
    try {
      const page = await client.history(projectId, next, path || undefined, controller.signal);
      if (!controller.signal.aborted) { setCommits(current => next ? [...current, ...page.commits] : page.commits); setCursor(page.nextCursor); }
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setPending(false); }
  };
  useEffect(() => {
    setCommits([]); setCursor(null); setFile(null); setSnapshot(null); setResources({}); setMissingResources([]); detailRequest.current?.abort();
    void load();
    return () => { listRequest.current?.abort(); detailRequest.current?.abort(); };
    // Reads are bound to the project/path, pagination is an explicit action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId, path]);
  const inspect = async (oid: string, selectedPath?: string) => {
    detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller;
    setFile(null); setSnapshot(null); setResources({}); setMissingResources([]); setError(false);
    try {
      if (selectedPath) {
        const value = await client.file(projectId, oid, selectedPath, controller.signal);
        if (!controller.signal.aborted) setFile(value);
      } else {
        const value = await client.conversations(projectId, oid, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(value);
        if (value) {
          const images = value.manifest.resources.filter(resource => resource.locations.some(location => /\.(png|jpe?g|gif|webp|avif)$/i.test(location.path)));
          const loaded = await Promise.allSettled(images.map(async resource => {
            const location = resource.locations.find(item => /\.(png|jpe?g|gif|webp|avif)$/i.test(item.path))!;
            return [resource.digest, await client.file(projectId, oid, location.path, controller.signal)] as const;
          }));
          if (controller.signal.aborted) return;
          setResources(Object.fromEntries(loaded.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])));
          setMissingResources(loaded.flatMap((result, index) => result.status === 'rejected' ? [images[index]!.locations[0]!.path] : []));
        }
      }
    } catch { if (!controller.signal.aborted) setError(true); }
  };
  return <section className={styles.history} aria-label={t('projectGit.history')}>
    <label>{t('projectGit.gitPathHistory')}<input value={path} onChange={event => setPath(event.target.value)} /></label>
    {commits.map(commit => <article key={commit.oid} data-testid={`git-commit-${commit.oid}`} className={styles.preview}>
      <h3>{commit.oid.slice(0, 8)} · {commit.message}</h3>
      <p>{commit.author.name} · <time dateTime={new Date(commit.authoredAt).toISOString()}>{new Date(commit.authoredAt).toLocaleString()}</time> · {commit.source}</p>
      <p>{t(commit.snapshotKind === 'complete' ? 'projectGit.completeVersion' : 'projectGit.fileVersion')}</p>
      <p>{t('projectGit.parents')}: {commit.parents.join(', ') || '—'}</p>
      <ul>{Array.from(new Set([...commit.changedPaths.added, ...commit.changedPaths.modified])).map(value => <li key={value}><button type="button" onClick={() => void inspect(commit.oid, value)}>{value}</button></li>)}</ul>
      {commit.changedPaths.deleted.map(value => <p key={value}>− {value}</p>)}
      {commit.snapshotKind === 'complete' ? <button type="button" onClick={() => void inspect(commit.oid)}>{t('projectGit.records')}</button> : null}
      <button type="button" disabled={restoreDisabled} onClick={() => onRestore(commit.oid)}>{t('projectGit.restore')}</button>
    </article>)}
    {cursor ? <button type="button" disabled={pending} onClick={() => void load(cursor)}>{t('projectGit.moreHistory')}</button> : null}
    {file ? <div className={styles.preview}>
      {file.mediaType.startsWith('text/html') ? <iframe title={t('projectGit.historicalPreview')} sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${decodeGitFile(file)}`} />
        : file.mediaType.startsWith('image/') && file.mediaType !== 'image/svg+xml' ? <img alt={t('projectGit.historicalPreview')} src={`data:${file.mediaType};base64,${file.content}`} />
          : <pre>{decodeGitFile(file)}</pre>}
    </div> : null}
    {snapshot ? <div className={styles.preview}><p>{t('projectGit.historicalReadOnly')}</p><pre>{JSON.stringify(snapshot.project, null, 2)}</pre>{snapshot.conversations.map(conversation => {
      const messages = snapshot.messages.filter(message => message.conversationId === conversation.id);
      const successors = new Map(messages.map(message => [message.predecessorId, message]));
      const ordered: typeof messages = []; let next = successors.get(null);
      while (next && ordered.length < messages.length) { ordered.push(next); next = successors.get(next.id); }
      return <section key={conversation.id}><h3>{conversation.title}</h3>{ordered.map(message => <article key={message.id}>
        <p>{message.role} · {message.turnId} · <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString()}</time></p><pre>{message.content}</pre><pre>{JSON.stringify({ context: message.context, events: message.displayEvents }, null, 2)}</pre>
        {message.resourceRefs.map(ref => { const resource = resources[ref]; const label = message.context.attachments?.find(item => item.resourceRef === ref)?.name ?? ref; return resource && /^image\/(png|jpeg|gif|webp|avif)$/.test(resource.mediaType) ? <img key={ref} alt={label} src={`data:${resource.mediaType};base64,${resource.content}`} /> : null; })}
      </article>)}</section>;
    })}{missingResources.length ? <p>{t('projectGit.missing')}: {missingResources.join(', ')}</p> : null}</div> : null}
    {pending ? <p role="status">{t('common.loading')}</p> : null}
    {error ? <p role="alert">{t('projectGit.phase.failed')}</p> : null}
  </section>;
}
