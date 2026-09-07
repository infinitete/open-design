'use client';

import type { ProjectGitConflict, ProjectGitConflictContent, ProjectGitOperation, ProjectGitResolution, ProjectGitState } from '@open-design/contracts';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ProjectGitClient } from '../../providers/project-git';
import { subscribeProjectEvents } from '../../providers/project-events';
import { gitBasisMatches, gitRequestKey } from './ProjectGitRestoreDialog';
import { decodeGitFile } from './ProjectGitHistory';
import styles from './ProjectGit.module.css';

function contentText(content: ProjectGitConflictContent): string {
  switch (content.kind) {
    case 'missing': return '—';
    case 'text': return content.content;
    case 'json': return JSON.stringify(content.value, null, 2);
    case 'resource': return content.resourceRef;
    case 'file': return content.file.mediaType.startsWith('text/') ? decodeGitFile(content.file) : `${content.file.mediaType}\n${content.file.content}`;
  }
}

function resolution(conflict: ProjectGitConflict, choice: string | undefined, edit: string | undefined): ProjectGitResolution | null {
  if (conflict.kind === 'conversation_order') {
    try {
      const ids: unknown = JSON.parse(edit ?? '');
      const retained = retainedTurnIds(conflict);
      if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string') || ids.length !== retained.size || new Set(ids).size !== ids.length || ids.some(id => !retained.has(id))) return null;
      return { conflictId: conflict.id, kind: 'order', orderedTurnIds: ids };
    } catch { return null; }
  }
  if (choice === 'base' || choice === 'local' || choice === 'remote') return { conflictId: conflict.id, kind: 'select', selectedSide: choice };
  if (choice === 'delete') return { conflictId: conflict.id, kind: 'delete' };
  if (choice === 'edit') {
    if (conflict.kind === 'file') return { conflictId: conflict.id, kind: 'edit', file: { encoding: 'base64', mediaType: 'text/plain', content: btoa(Array.from(new TextEncoder().encode(edit ?? ''), byte => String.fromCharCode(byte)).join('')) } };
    try { return { conflictId: conflict.id, kind: 'edit', value: JSON.parse(edit ?? '') }; } catch { return null; }
  }
  return null;
}

function retainedTurnIds(conflict: ProjectGitConflict): Set<string> {
  // Order conflicts carry complete portable message records, not turn-id arrays.
  // A record removed on one side and unchanged on the other is not retained.
  const records = (side: ProjectGitConflictContent) => new Map(side.kind === 'json' && Array.isArray(side.value)
    ? side.value.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string' && typeof value.turnId === 'string' ? [[value.id, value.turnId] as const] : []) : []);
  const base = records(conflict.base); const local = records(conflict.local); const remote = records(conflict.remote);
  const turns = new Set<string>();
  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    const localTurn = local.get(id); const remoteTurn = remote.get(id);
    if (base.has(id) && (!localTurn || !remoteTurn)) continue;
    const turn = localTurn === base.get(id) ? remoteTurn : localTurn ?? remoteTurn;
    if (turn) turns.add(turn);
  }
  return turns;
}

export interface ProjectGitConflictsProps {
  projectId: string; operationId: string; client: ProjectGitClient; onCompleted: (state: ProjectGitState) => void | Promise<void>;
}

export function ProjectGitConflicts({ projectId, operationId, client, onCompleted }: ProjectGitConflictsProps) {
  const { t } = useI18n();
  const [conflicts, setConflicts] = useState<ProjectGitConflict[]>([]);
  const [operation, setOperation] = useState<ProjectGitOperation | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const load = async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setPending(true); setError(false); setStale(false); setOperation(null); setConflicts([]); setChoices({}); setEdits({});
    try {
      const [op, result, state] = await Promise.all([client.operation(operationId, controller.signal), client.conflicts(projectId, controller.signal), client.state(projectId, controller.signal)]);
      if (controller.signal.aborted) return;
      if (op.id !== operationId || op.projectId !== projectId || state.operationId !== operationId || state.phase !== 'conflict' || !gitBasisMatches(op.basis, state)) { setStale(true); return; }
      setOperation(op); setConflicts(result.conflicts);
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setPending(false); }
  };
  useEffect(() => {
    void load(); return () => request.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId, operationId]);
  useEffect(() => subscribeProjectEvents(projectId, event => {
    if (event.type === 'project-git-state' && operation && (!gitBasisMatches(operation.basis, event.state) || event.state.operationId !== operationId || event.state.phase !== 'conflict')) setStale(true);
  }), [projectId, operationId, operation]);
  const proposals = conflicts.map(conflict => resolution(conflict, choices[conflict.id], edits[conflict.id]));
  const submit = async () => {
    if (busy.current || !operation || stale || !proposals.length || proposals.some(item => item === null)) return;
    busy.current = true; setPending(true); setError(false);
    const controller = new AbortController(); request.current = controller;
    try {
      const fresh = await client.state(projectId, controller.signal);
      if (controller.signal.aborted) return;
      if (!gitBasisMatches(operation.basis, fresh) || fresh.operationId !== operationId || fresh.phase !== 'conflict') { setStale(true); return; }
      const result = await client.execute(projectId, { kind: 'resolve', operationId, basis: operation.basis, resolutions: proposals.filter((item): item is ProjectGitResolution => item !== null) }, operation.basis.projectRevision, { idempotencyKey: gitRequestKey(), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.status !== 'succeeded') { setStale(true); setError(true); return; }
      const completed = await client.state(projectId, controller.signal);
      if (!controller.signal.aborted) await onCompleted(completed);
    } catch { if (!controller.signal.aborted) { setStale(true); setError(true); } }
    finally { busy.current = false; if (!controller.signal.aborted) setPending(false); }
  };
  return <section className={styles.history} aria-label={t('projectGit.conflicts')}>
    <p>{t('projectGit.conflictEditingNotice')}</p>
    {conflicts.map(conflict => {
      const label = conflict.path ?? conflict.recordId;
      const binary = conflict.kind === 'resource' || [conflict.base, conflict.local, conflict.remote].some(side => side.kind === 'file' && !side.file.mediaType.startsWith('text/'));
      return <fieldset key={conflict.id} disabled={pending || stale} className={styles.preview}><legend>{label}</legend>
        <div className={styles.sides}>{(['base', 'local', 'remote'] as const).map(side => <div key={side}><h3>{t(side === 'base' ? 'projectGit.ancestor' : side === 'local' ? 'projectGit.localSide' : 'projectGit.remoteSide')}</h3><pre>{contentText(conflict[side])}</pre></div>)}</div>
        {conflict.kind === 'conversation_order' ? <><pre>{JSON.stringify([...retainedTurnIds(conflict)])}</pre><label>{t('projectGit.turnOrder')}<textarea value={edits[conflict.id] ?? ''} onChange={event => setEdits(current => ({ ...current, [conflict.id]: event.target.value }))} /></label></> : <>
          <label>{label}<select value={choices[conflict.id] ?? ''} onChange={event => setChoices(current => ({ ...current, [conflict.id]: event.target.value }))}>
            <option value="">{t('projectGit.choose')}</option><option value="base">{t('projectGit.ancestor')}</option><option value="local">{t('projectGit.localSide')}</option><option value="remote">{t('projectGit.remoteSide')}</option><option value="delete">{t('common.delete')}</option>
            {!binary ? <option value="edit">{t('common.edit')}</option> : null}
          </select></label>
          {choices[conflict.id] === 'edit' ? <label>{t('common.edit')} {label}<textarea value={edits[conflict.id] ?? ''} onChange={event => setEdits(current => ({ ...current, [conflict.id]: event.target.value }))} /></label> : null}
        </>}
      </fieldset>;
    })}
    <button type="button" disabled={pending || stale || !operation || !proposals.length || proposals.some(item => item === null)} onClick={() => void submit()}>{t('projectGit.submitResolution')}</button>
    {stale ? <><p role="alert">{t('projectGit.stalePreview')}</p><button type="button" disabled={pending} onClick={() => void load()}>{t('projectGit.preview')}</button></> : null}
    {error ? <p role="alert">{t('projectGit.phase.failed')}</p> : null}
    {pending ? <p role="status">{t('common.loading')}</p> : null}
  </section>;
}
