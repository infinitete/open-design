import type Database from 'better-sqlite3';
import {
  parsePortableConversation, parsePortableManifest, parsePortableMessage, parsePortableProject,
  parsePortableSnapshot, type PortableSnapshot, type ProjectMetadata,
} from '@open-design/contracts';
import { getProject } from '../../db.js';
import type { ProjectGitStore } from '../../storage/project-git.js';
import { GitDomainError } from './errors.js';
import { portableImportMarker } from './portable.js';

/** One batched adjunct read for history surfaces; live application rows remain authoritative. */
export function readPortableRecords(db: Database.Database, projectId: string): PortableSnapshot | null {
  const rows = db.prepare('SELECT kind, record_json, snapshot_digest FROM project_git_portable_records WHERE project_id = ? ORDER BY kind, ordinal')
    .all(projectId) as { kind: string; record_json: string; snapshot_digest: string | null }[];
  if (!rows.length) return null;
  const projects = rows.filter(row => row.kind === 'project');
  const manifests = rows.filter(row => row.kind === 'manifest');
  if (projects.length !== 1 || manifests.length !== 1) throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Incomplete portable history records');
  const snapshot = parsePortableSnapshot({
    manifest: parsePortableManifest(JSON.parse(manifests[0]!.record_json)),
    project: parsePortableProject(JSON.parse(projects[0]!.record_json)),
    conversations: rows.filter(row => row.kind === 'conversation').map(row => parsePortableConversation(JSON.parse(row.record_json))),
    messages: rows.filter(row => row.kind === 'message').map(row => parsePortableMessage(JSON.parse(row.record_json))),
  });
  if (projects[0]!.snapshot_digest !== portableImportMarker(snapshot)) throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Portable history records are incomplete or corrupt');
  return snapshot;
}

/** Caller has already materialized verified bytes and recorded records_applied intent under the gate. */
export function importPortableRecords(input: {
  db: Database.Database; projectId: string; cloneId: string; snapshot: PortableSnapshot;
  store: ProjectGitStore; operationId: string;
}): void {
  const { db, projectId, cloneId, store } = input;
  store.assertDatabase(db);
  const snapshot = parsePortableSnapshot(input.snapshot);
  const op = store.getJournal(input.operationId);
  const binding = store.getBinding(projectId);
  const marker = portableImportMarker(snapshot);
  if (!op || op.projectId !== projectId || op.kind === 'checkpoint' || op.recoveryData?.records?.importMarker !== marker
    || binding?.repositoryProjectId !== snapshot.manifest.repositoryProjectId || binding.cloneId !== cloneId) {
    throw new GitDomainError('RECOVERY_REQUIRED', 409, 'Portable import does not match the prepared operation');
  }
  store.completeRecords(op.id, { basis: op.basis, importMarker: marker, advanceProjectRevision: true }, () => {
    store.assertDatabase(db);
    if (!db.inTransaction) throw new GitDomainError('RECOVERY_REQUIRED', 409, 'Portable records require the operation database transaction');
    const repo = snapshot.manifest.repositoryProjectId;
    store.attachId(repo, cloneId, 'project', repo, projectId);
    const existing = getProject(db, projectId);
    const metadata = { kind: snapshot.project.kind, ...snapshot.project.preferences } as ProjectMetadata;
    if (snapshot.project.entryFile !== undefined) metadata.entryFile = snapshot.project.entryFile;
    // Existing local registration authority comes only from this database, never the snapshot.
    if (existing?.metadata?.baseDir) metadata.baseDir = existing.metadata.baseDir;
    if (existing?.metadata?.fromTrustedPicker === true) metadata.fromTrustedPicker = true;
    db.prepare(`INSERT INTO projects (id, name, skill_id, design_system_id, pending_prompt, metadata_json,
      custom_instructions, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, skill_id=NULL, design_system_id=NULL,
      applied_plugin_snapshot_id=NULL, pending_prompt=excluded.pending_prompt, metadata_json=excluded.metadata_json,
      custom_instructions=excluded.custom_instructions, created_at=excluded.created_at, updated_at=excluded.updated_at`)
      .run(projectId, snapshot.project.name, snapshot.project.pendingPrompt ?? null, JSON.stringify(metadata),
        snapshot.project.customInstructions ?? null, snapshot.project.createdAt, snapshot.project.createdAt);
    db.prepare('DELETE FROM conversations WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM project_git_portable_records WHERE project_id = ?').run(projectId);
    const adjunct = db.prepare('INSERT INTO project_git_portable_records (project_id, kind, local_id, record_json, ordinal, snapshot_digest) VALUES (?, ?, ?, ?, ?, ?)');
    adjunct.run(projectId, 'manifest', projectId, JSON.stringify(snapshot.manifest), 0, null);
    adjunct.run(projectId, 'project', projectId, JSON.stringify(snapshot.project), 0, marker);
    const resources = new Map(snapshot.manifest.resources.map(resource => [resource.digest, resource]));
    const conversations = new Map<string, string>();
    for (const [ordinal, conversation] of snapshot.conversations.entries()) {
      const localId = store.mapId(repo, cloneId, 'conversation', conversation.id); conversations.set(conversation.id, localId);
      db.prepare('INSERT INTO conversations (id, project_id, title, session_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(localId, projectId, conversation.title, conversation.mode, conversation.createdAt, conversation.createdAt);
      adjunct.run(projectId, 'conversation', localId, JSON.stringify(conversation), ordinal, null);
    }
    const successors = new Map(snapshot.messages.map(message => [message.predecessorId, message]));
    for (const conversation of snapshot.conversations) {
      let message = snapshot.messages.find(item => item.conversationId === conversation.id && item.predecessorId === null);
      let position = 0;
      while (message) {
        const localId = store.mapId(repo, cloneId, 'message', message.id);
        store.mapId(repo, cloneId, 'turn', message.turnId);
        const attachments = message.context.attachments?.map(attachment => ({
          path: `/api/projects/${encodeURIComponent(projectId)}/raw/${(resources.get(attachment.resourceRef)!.locations.find(location => location.purpose === 'attachment')
            ?? resources.get(attachment.resourceRef)!.locations[0]).path.split('/').map(encodeURIComponent).join('/')}`,
          name: attachment.name, kind: attachment.kind,
          ...(attachment.size === undefined ? {} : { size: attachment.size }),
          ...(attachment.order === undefined ? {} : { order: attachment.order }),
        }));
        db.prepare(`INSERT INTO messages (id, conversation_id, role, content, agent_id, agent_name, run_id,
          run_status, result_delivery_state, events_json, attachments_json, session_mode, run_context_json, feedback_json, created_at, position)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`)
          .run(localId, conversations.get(conversation.id), message.role, message.content, message.context.agentId ?? null,
            message.context.agentName ?? null, message.terminal === 'historical' ? null : message.terminal === 'cancelled' ? 'canceled' : message.terminal,
            message.context.resultDeliveryState ?? null, attachments ? JSON.stringify(attachments) : null,
            message.context.sessionMode ?? null, message.context.feedback ? JSON.stringify(message.context.feedback) : null,
            message.createdAt, position++);
        adjunct.run(projectId, 'message', localId, JSON.stringify(message), snapshot.messages.indexOf(message), null);
        message = successors.get(message.id);
      }
    }
    return undefined;
  });
}
