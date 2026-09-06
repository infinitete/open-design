import {
  PORTABLE_PROJECT_PREFERENCE_KEYS,
  parsePortableProject,
  type JsonValue,
  type PortableProjectPreferences,
  type ProjectMetadata,
  parsePortableSnapshot, parsePortableManifest, parsePortableConversation, parsePortableMessage,
  type PortableSnapshot, type PortableMessage, type PortableResource, type PortableDisplayEvent, type PortableResourcePurpose,
  type PortableMessageContext,
  type PortableCommentAttachment, type ChatCommentAttachment, type PreviewAnnotationStyle,
  type PortableExecutionPreferences,
} from '@open-design/contracts';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getProject, listMessages, isProjectCommentAnchorConversationId } from '../../db.js';
import { strategyTaskTurnsForRunIds } from '../../strategies/task-store.js';
import type { ProjectGitStore, ProjectGitIdKind } from '../../storage/project-git.js';
import { GitDomainError } from './errors.js';
import { collectReferencedResources, readPortableResource } from './resources.js';
import { readPortableRecords } from './portable-db.js';
import { getSnapshot } from '../../plugins/snapshots.js';
import { emittedRenderableQuestionForm } from '../../question-form-detect.js';
import { validateTreeEntries } from './repository.js';
import { nativeHistoryRoot } from './paths.js';

/** Canonical UTF-8 JSON: sorted object keys, semantic array order, exactly one LF. */
export function canonicalJson(value: JsonValue): string {
  const ancestors = new Set<object>();
  const normalize = (item: JsonValue): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || ancestors.has(item)) throw new Error('Invalid JSON value');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return Array.from(item, normalize);
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error('Invalid JSON object');
      }
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key]!)]));
    } finally { ancestors.delete(item); }
  };
  return JSON.stringify(normalize(value)) + '\n';
}

/** Preferences are display/user intent only; authority-bearing metadata is never copied. */
export function exportProjectPreferences(metadata: ProjectMetadata): Record<string, JsonValue> {
  const preferences: Record<string, JsonValue> = {};
  for (const key of PORTABLE_PROJECT_PREFERENCE_KEYS) {
    if (key === 'promptTemplate' || key === 'designSystemReview') continue;
    const value: unknown = (metadata as unknown as Record<string, unknown>)[key];
    if (value !== undefined) preferences[key] = JSON.parse(canonicalJson(value as JsonValue)) as JsonValue;
  }
  const template = metadata.promptTemplate;
  if (template) {
    const result: NonNullable<PortableProjectPreferences['promptTemplate']> = {
      id: template.id, surface: template.surface, title: template.title, prompt: template.prompt,
    };
    if (template.summary !== undefined) result.summary = template.summary;
    if (template.category !== undefined) result.category = template.category;
    if (template.tags !== undefined) result.tags = template.tags;
    if (template.model !== undefined) result.model = template.model;
    if (template.aspect !== undefined) result.aspect = template.aspect;
    if (template.source) {
      result.source = { repo: template.source.repo, license: template.source.license };
      if (template.source.author !== undefined) result.source.author = template.source.author;
      if (template.source.url !== undefined) result.source.url = template.source.url;
    }
    preferences.promptTemplate = result as JsonValue;
  }
  if (metadata.designSystemReview) {
    const reviews = Object.create(null) as NonNullable<PortableProjectPreferences['designSystemReview']>;
    for (const [key, review] of Object.entries(metadata.designSystemReview)) {
      const result: typeof reviews[string] = { decision: review.decision, updatedAt: review.updatedAt };
      if (review.feedback !== undefined) result.feedback = review.feedback;
      if (review.files !== undefined) result.files = review.files;
      reviews[key] = result;
    }
    preferences.designSystemReview = reviews as JsonValue;
  }
  return parsePortableProject({ schemaVersion: 1, name: 'preferences', createdAt: 0,
    kind: metadata.kind, preferences, contentRefs: [], linkedFolderRequirements: [] }).preferences as Record<string, JsonValue>;
}

export function portableImportMarker(snapshot: PortableSnapshot): string {
  return createHash('sha256').update(canonicalJson(parsePortableSnapshot(snapshot) as JsonValue)).digest('hex');
}

export function portableIdSegment(id: string): string {
  return 'id-' + createHash('sha256').update(canonicalJson(id)).digest('hex');
}

function metadataEntries(snapshot: PortableSnapshot): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const put = (file: string, value: JsonValue) => {
    if (entries.has(file)) throw new GitDomainError('CONFLICT', 409, 'Portable metadata path collision');
    entries.set(file, Buffer.from(canonicalJson(value)));
  };
  put('.open-design/manifest.json', snapshot.manifest as JsonValue);
  put('.open-design/project.json', snapshot.project as JsonValue);
  for (const conversation of snapshot.conversations) {
    put(`.open-design/conversations/${portableIdSegment(conversation.id)}/conversation.json`, conversation as JsonValue);
  }
  for (const message of snapshot.messages) {
    put(`.open-design/conversations/${portableIdSegment(message.conversationId)}/messages/${portableIdSegment(message.id)}.json`, message as JsonValue);
  }
  return entries;
}

/** Metadata only. Callers add verified resource aliases/ordinary files, then parsePortableEntries. */
export function serializePortableMetadata(snapshot: PortableSnapshot): Map<string, Uint8Array> {
  return metadataEntries(parsePortableSnapshot(snapshot));
}

function legacyMemberPaths(manifestPath: string, bytes: Uint8Array): string[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Legacy manifest cannot be decoded'); }
  const entries = (value as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Legacy manifest has no recognized entries');
  return entries.map(entry => {
    const name: unknown = entry?.contentPath ?? (typeof entry?.id === 'string' ? `${entry.id}.html` : null);
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+\.html$/.test(name) || name.includes('..')) {
      throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Legacy manifest contains an unsafe content reference');
    }
    return `${path.posix.dirname(manifestPath)}/${name}`;
  });
}

export const isPortableMetadataPath = (file: string): boolean => file === '.open-design/manifest.json' || file === '.open-design/project.json'
  || /^\.open-design\/conversations\/[^/]+\/(?:conversation\.json|messages\/[^/]+\.json)$/u.test(file);

/** Metadata/layout classification only; resource integrity belongs to parsePortableEntries. */
export function parsePortableMetadataEntries(
  entries: ReadonlyMap<string, Uint8Array>,
  availablePaths: ReadonlySet<string>,
  options?: { allowMissingResources?: boolean },
): PortableSnapshot {
  if ([...entries.keys()].some(file => !isPortableMetadataPath(file))) throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Only portable metadata is accepted.');
  validateTreeEntries([...availablePaths].filter(file => file.startsWith('.open-design/')).map(file => ({ path: file, mode: '100644' })));
  const decode = (file: string): unknown => {
    const bytes = entries.get(file);
    if (!bytes) throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Required portable metadata is missing');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Portable metadata is not valid UTF-8 JSON'); }
  };
  const manifest = parsePortableManifest(decode('.open-design/manifest.json'));
  const project = parsePortableProject(decode('.open-design/project.json'));
  const conversations = []; const messages = [];
  for (const file of entries.keys()) {
    if (/^\.open-design\/conversations\/[^/]+\/conversation\.json$/.test(file)) {
      const conversation = parsePortableConversation(decode(file));
      if (file !== `.open-design/conversations/${portableIdSegment(conversation.id)}/conversation.json`) {
        throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Portable conversation ID does not match its path');
      }
      conversations.push(conversation);
    } else if (/^\.open-design\/conversations\/[^/]+\/messages\/[^/]+\.json$/.test(file)) {
      const message = parsePortableMessage(decode(file));
      if (file !== `.open-design/conversations/${portableIdSegment(message.conversationId)}/messages/${portableIdSegment(message.id)}.json`) {
        throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Portable message ID does not match its path');
      }
      messages.push(message);
    }
  }
  const snapshot = parsePortableSnapshot({ manifest, project,
    conversations: conversations.sort((a, b) => a.id < b.id ? -1 : 1),
    messages: messages.sort((a, b) => a.id < b.id ? -1 : 1) });
  const allowed = new Set([...metadataEntries(snapshot).keys(), ...manifest.resources.flatMap(resource => resource.locations.map(location => location.path))]);
  for (const file of availablePaths) {
    if (file.startsWith('.open-design/') && !allowed.has(file)) throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Unrecognized portable layout');
  }
  const missing = [...allowed].filter(file => !availablePaths.has(file));
  if (missing.length && !options?.allowMissingResources) {
    throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Declared portable paths are missing', { paths: missing });
  }
  return snapshot;
}

/** Pure candidate-tree decoder. Git tree modes are validated by the caller. */
export function parsePortableEntries(entries: ReadonlyMap<string, Uint8Array>): PortableSnapshot {
  const snapshot = parsePortableMetadataEntries(new Map([...entries].filter(([file]) => isPortableMetadataPath(file))), new Set(entries.keys()));
  const { manifest } = snapshot;
  const allowed = new Set([...metadataEntries(snapshot).keys(), ...manifest.resources.flatMap(resource => resource.locations.map(location => location.path))]);
  const missing = manifest.resources.flatMap(resource => resource.locations.filter(location => {
    const bytes = entries.get(location.path);
    return !bytes || createHash('sha256').update(bytes).digest('hex') !== resource.digest;
  }).map(location => location.path));
  for (const resource of manifest.resources) for (const location of resource.locations) {
    if (location.purpose !== 'legacy-history' || !location.path.endsWith('/manifest.json') || !entries.has(location.path)) continue;
    for (const member of legacyMemberPaths(location.path, entries.get(location.path)!)) {
      if (!allowed.has(member) || !entries.has(member)) missing.push(member);
    }
  }
  if (missing.length) throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Portable resource content is missing or corrupt', { paths: missing });
  return snapshot;
}

async function storedSnapshot(root: string): Promise<PortableSnapshot | null> {
  try { if (!(await lstat(path.join(root, '.open-design'))).isDirectory()) throw new Error('invalid directory'); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Existing .open-design directory is not a portable project');
  }
  const entries = new Map<string, Uint8Array>();
  const load = async (file: string) => {
    const bytes = await readPortableResource(root, file);
    if (bytes) entries.set(file, bytes);
  };
  await load('.open-design/manifest.json'); await load('.open-design/project.json');
  if (!entries.has('.open-design/manifest.json')) throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Existing .open-design has no recognized manifest');
  const manifest = parsePortableManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entries.get('.open-design/manifest.json'))));
  for (const resource of manifest.resources) for (const location of resource.locations) await load(location.path);
  const walk = async (relative: string) => {
    let children;
    try {
      if (!(await lstat(path.join(root, relative))).isDirectory()) throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Portable metadata directory is unavailable');
      children = await readdir(path.join(root, relative), { withFileTypes: true });
    }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return; throw error; }
    for (const child of children) {
      const file = `${relative}/${child.name}`;
      if (child.isDirectory()) await walk(file);
      else if (child.isFile()) await load(file);
      else throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Portable metadata contains linked content');
    }
  };
  await walk('.open-design/conversations');
  return parsePortableEntries(entries);
}

function projectRelative(reference: string, projectId: string): string | null {
  let value = reference;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    value = url.pathname;
  }
  const prefix = `/api/projects/${encodeURIComponent(projectId)}/raw/`;
  if (value.startsWith(prefix)) {
    try { value = value.slice(prefix.length).split('/').map(decodeURIComponent).join('/'); } catch { return null; }
  }
  if (!value || value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\\') || value.includes('\0')
    || value.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return value;
}

function commentStyle(style: PreviewAnnotationStyle): NonNullable<PortableCommentAttachment['style']> {
  const result: NonNullable<PortableCommentAttachment['style']> = {};
  for (const key of ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign',
    'fontFamily', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderRadius'] as const) {
    if (style[key] !== undefined) result[key] = style[key];
  }
  return result;
}

function commentDisplay(comment: ChatCommentAttachment, projectId: string): PortableCommentAttachment {
  const result: PortableCommentAttachment = { order: comment.order, label: comment.label, comment: comment.comment,
    currentText: comment.currentText };
  const file = projectRelative(comment.filePath, projectId);
  if (file) result.filePath = file; else result.unavailable = true;
  for (const key of ['elementId', 'selector', 'htmlHint', 'selectionKind', 'memberCount', 'slideIndex',
    'markKind', 'intent', 'commentContext', 'source'] as const) {
    if (comment[key] !== undefined) Object.assign(result, { [key]: comment[key] });
  }
  if (comment.pagePosition) result.pagePosition = { x: comment.pagePosition.x, y: comment.pagePosition.y,
    width: comment.pagePosition.width, height: comment.pagePosition.height };
  if (comment.style) result.style = commentStyle(comment.style);
  if (comment.podMembers) result.podMembers = comment.podMembers.map(member => ({
    elementId: member.elementId, selector: member.selector, label: member.label, text: member.text,
    position: { x: member.position.x, y: member.position.y, width: member.position.width, height: member.position.height },
    ...(member.htmlHint === undefined ? {} : { htmlHint: member.htmlHint }),
    ...(member.style === undefined ? {} : { style: commentStyle(member.style) }),
  }));
  return result;
}

function inertPluginContent(value: unknown): Uint8Array | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const plugin = value as Record<string, unknown>;
  const context = plugin.resolvedContext as { promptFragments?: unknown } | undefined;
  if (!context?.promptFragments || typeof context.promptFragments !== 'object') return null;
  const fragments: Record<string, JsonValue> = {};
  for (const [key, fragment] of Object.entries(context.promptFragments)) {
    if (typeof fragment !== 'string') throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Invalid frozen plugin content');
    fragments[key] = fragment;
  }
  const content: Record<string, JsonValue> = { schemaVersion: 1, promptFragments: fragments };
  for (const key of ['pluginId', 'pluginVersion', 'pluginTitle', 'pluginDescription'] as const) {
    if (typeof plugin[key] === 'string') content[key] = plugin[key];
  }
  return Buffer.from(canonicalJson(content));
}

function displayResourceRefs(context: PortableMessageContext, events: PortableDisplayEvent[]): string[] {
  return [
    ...(context.attachments ?? []).map(item => item.resourceRef),
    ...(context.contentItems ?? []).flatMap(item => item.resourceRef ? [item.resourceRef] : []),
    ...(context.commentAttachments ?? []).flatMap(comment => [
      ...(comment.screenshotResourceRef ? [comment.screenshotResourceRef] : []),
      ...(comment.imageAttachments ?? []).map(item => item.resourceRef),
    ]),
    ...events.flatMap(event => event.kind === 'result' ? event.resourceRefs ?? [] : []),
  ];
}

export async function exportPortableProject(input: {
  db: Database.Database; projectId: string; repositoryProjectId: string; cloneId: string;
  root: string; nativeLegacyRoot?: string; store: ProjectGitStore; readOwnedResource?: (reference: string) => Promise<Uint8Array | null>;
}): Promise<{ snapshot: PortableSnapshot; entries: Map<string, Uint8Array> }> {
  const { db, projectId, repositoryProjectId: repo, cloneId, store, root } = input;
  const legacyRoot = await nativeHistoryRoot(root, input.nativeLegacyRoot);
  store.assertDatabase(db);
  const projectRow = getProject(db, projectId);
  if (!projectRow) throw new GitDomainError('NOT_FOUND', 404, 'Project not found');
  const adjunct = readPortableRecords(db, projectId);
  const diskSnapshot = await storedSnapshot(root);
  const previous = adjunct ?? diskSnapshot;
  if (diskSnapshot && diskSnapshot.manifest.repositoryProjectId !== repo) throw new GitDomainError('CONFLICT', 409, 'Portable directory belongs to another repository');
  if (previous && previous.manifest.repositoryProjectId !== repo) throw new GitDomainError('CONFLICT', 409, 'Portable repository identity does not match');
  const id = (kind: ProjectGitIdKind, local: string) => {
    const known = store.getPortableId(repo, cloneId, kind, local);
    if (known) return known;
    const portable = randomUUID(); store.attachId(repo, cloneId, kind, portable, local); return portable;
  };
  store.attachId(repo, cloneId, 'project', repo, projectId);
  const previousResources = previous?.manifest.resources ?? [];
  const resources = new Map<string, PortableResource>(); const bytesByPath = new Map<string, Uint8Array>();
  const add = (bytes: Uint8Array, purpose: PortableResourcePurpose, reference: string, label: string | undefined, fixedPath?: string) => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    let resource = resources.get(digest);
    const location = { path: fixedPath ?? `.open-design/resources/${digest}/content`, purpose,
      ...(label === undefined ? {} : { sourceLabel: label }) };
    if (!resource) {
      resource = { digest, locations: [location], references: [] };
      resources.set(digest, resource);
    }
    if (!resource.locations.some(item => item.path === location.path && item.purpose === purpose && item.sourceLabel === label)) resource.locations.push(location);
    bytesByPath.set(location.path, bytes);
    if (!resource.references.includes(reference)) resource.references.push(reference);
    return digest;
  };
  const retain = async (digest: string, record: string) => {
    const resource = previousResources.find(item => item.digest === digest);
    let bytes: Uint8Array | null = null;
    for (const location of resource?.locations ?? []) {
      const candidate = await readPortableResource(root, location.path);
      if (candidate && createHash('sha256').update(candidate).digest('hex') === digest) { bytes = candidate; break; }
    }
    if (!resource || !bytes) throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Required retained content is missing',
      { paths: resource?.locations.map(location => location.path) ?? [`.open-design/resources/${digest}/content`] });
    for (const location of resource.locations) add(bytes, location.purpose, record, location.sourceLabel, location.path);
    return digest;
  };
  const fileResource = async (reference: string, purpose: PortableResourcePurpose, record: string, label: string, opaque: string) => {
    const relative = projectRelative(reference, projectId);
    const byPath = previousResources.find(item => item.locations.some(location => location.path === relative));
    if (byPath) return retain(byPath.digest, record);
    const bytes = relative ? await readPortableResource(root, relative) : null;
    if (bytes) return add(bytes, purpose, record, relative!);
    const candidates = previousResources.filter(item => item.references.includes(record)
      && item.locations.some(location => location.purpose === purpose && location.sourceLabel === (relative ?? label)));
    if (candidates.length === 1) return retain(candidates[0]!.digest, record);
    const owned = await input.readOwnedResource?.(opaque);
    if (owned) return add(owned, purpose, record, relative ?? label);
    throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Required project content is missing', { paths: [relative ?? `${purpose}:${label}`] });
  };
  const contentResource = async (purpose: PortableResourcePurpose, contentId: string, record: string, frozen?: unknown) => {
    const frozenBytes = inertPluginContent(frozen);
    if (frozenBytes) return add(frozenBytes, purpose, record, contentId);
    const opaque = `${purpose}:${projectId}:${contentId}`;
    const bytes = await input.readOwnedResource?.(opaque);
    if (bytes) return add(bytes, purpose, record, contentId);
    const previous = previousResources.filter(item => item.references.includes(record)
      && item.locations.some(location => location.purpose === purpose && location.sourceLabel === contentId));
    if (previous.length === 1) return retain(previous[0]!.digest, record);
    throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Required content snapshot is missing', { paths: [`${purpose}:${contentId}`] });
  };
  const metadata = (projectRow.metadata ?? { kind: 'prototype' }) as ProjectMetadata;
  const snapshot: PortableSnapshot = { manifest: { schemaVersion: 1, repositoryProjectId: repo, resources: [] },
    project: { schemaVersion: 1, name: String(projectRow.name), createdAt: projectRow.createdAt,
      kind: metadata.kind ?? 'prototype', preferences: exportProjectPreferences(metadata), contentRefs: [],
      linkedFolderRequirements: metadata.linkedDirs?.map(directory => ({ label: path.basename(directory), purpose: 'reference; relocation required' }))
        ?? previous?.project.linkedFolderRequirements ?? [] }, conversations: [], messages: [] };
  if (metadata.entryFile !== undefined) snapshot.project.entryFile = metadata.entryFile;
  if (projectRow.customInstructions !== undefined) snapshot.project.customInstructions = projectRow.customInstructions;
  if (projectRow.pendingPrompt !== undefined) snapshot.project.pendingPrompt = projectRow.pendingPrompt;
  for (const digest of previous?.project.contentRefs ?? []) {
    const resource = previousResources.find(item => item.digest === digest)!;
    if (adjunct || resource.locations.some(location => location.purpose === 'legacy-history')) snapshot.project.contentRefs.push(await retain(digest, repo));
  }
  for (const [purpose, contentId] of [['skill', projectRow.skillId], ['design-system', projectRow.designSystemId]] as const) {
    if (typeof contentId === 'string' && contentId) snapshot.project.contentRefs.push(await contentResource(purpose, contentId, repo));
  }
  for (const plugin of metadata.contextPlugins ?? []) snapshot.project.contentRefs.push(await contentResource('plugin', plugin.id, repo));
  if (projectRow.appliedPluginSnapshotId) {
    const plugin = getSnapshot(db, projectRow.appliedPluginSnapshotId);
    snapshot.project.contentRefs.push(await contentResource('plugin', projectRow.appliedPluginSnapshotId, repo, plugin));
  }
  if (metadata.scenarioBinding) snapshot.project.contentRefs.push(await contentResource('scenario', metadata.scenarioBinding.pluginId, repo,
    getSnapshot(db, metadata.scenarioBinding.snapshotId)));
  const conversations = db.prepare('SELECT id, title, session_mode AS mode, created_at AS createdAt FROM conversations WHERE project_id = ? ORDER BY id')
    .all(projectId) as { id: string; title: string | null; mode: 'design' | 'chat' | 'plan'; createdAt: number }[];
  // Model/agent selection is a preference. Never select native session handles or cwd.
  const preferences = new Map<string, PortableExecutionPreferences>();
  const preferenceRows = db.prepare(`SELECT s.conversation_id AS conversationId, s.agent_id AS agentId, s.model
    FROM agent_sessions s JOIN conversations c ON c.id = s.conversation_id
    WHERE c.project_id = ? ORDER BY s.updated_at DESC, s.agent_id`).all(projectId) as {
      conversationId: string; agentId: string; model: string | null;
    }[];
  for (const row of preferenceRows) if (!preferences.has(row.conversationId)) {
    preferences.set(row.conversationId, { agentId: row.agentId, ...(row.model === null ? {} : { model: row.model }) });
  }
  for (const conversation of conversations) {
    const messages = listMessages(db, conversation.id);
    // Empty reserved conversations are local FK scaffolding, not historical chat.
    if (!messages.length && isProjectCommentAnchorConversationId(conversation.id)) continue;
    const conversationId = id('conversation', conversation.id);
    const oldConversation = previous?.conversations.find(item => item.id === conversationId);
    const portableConversation = { schemaVersion: 1 as const, id: conversationId, title: conversation.title ?? '',
      mode: conversation.mode, createdAt: conversation.createdAt,
      ...((preferences.get(conversation.id) ?? oldConversation?.preferences)
        ? { preferences: preferences.get(conversation.id) ?? oldConversation!.preferences! } : {}) };
    snapshot.conversations.push(portableConversation);
    const logicalTurns = strategyTaskTurnsForRunIds(db, messages.flatMap(message => typeof message.runId === 'string' ? [message.runId] : []));
    let predecessorId: string | null = null; let currentTurn: string | null = null;
    const lineageTurns = new Map<string, string>();
    for (const row of messages) {
      const messageId = id('message', row.id);
      const old = previous?.messages.find(item => item.id === messageId);
      const logical = row.runId ? logicalTurns.get(row.runId)?.taskExecutionId : undefined;
      const lineage = logical ?? (typeof row.taskAnalytics?.taskExecutionId === 'string' ? row.taskAnalytics.taskExecutionId : undefined);
      if (old) currentTurn = old.turnId;
      else if (lineage) {
        const predecessor = snapshot.messages.at(-1);
        currentTurn = lineageTurns.get(lineage)
          ?? (predecessor?.conversationId === conversationId && predecessor.role === 'user' ? predecessor.turnId : null)
          ?? id('turn', `logical:${conversation.id}:${lineage}`);
      }
      else if (row.role === 'user' || currentTurn === null) currentTurn = id('turn', `message:${row.id}`);
      if (lineage) {
        lineageTurns.set(lineage, currentTurn!);
        const predecessor = snapshot.messages.at(-1);
        if (predecessor?.conversationId === conversationId && predecessor.role === 'user') predecessor.turnId = currentTurn!;
      }
      const imported = adjunct?.messages.find(item => item.id === messageId);
      const terminal: PortableMessage['terminal'] = row.runStatus === 'succeeded' || row.runStatus === 'failed'
        ? row.runStatus : row.runStatus === 'canceled' ? 'cancelled' : 'historical';
      const context: PortableMessageContext = imported ? structuredClone(imported.context) : {};
      for (const key of ['agentId', 'agentName', 'sessionMode', 'resultDeliveryState'] as const) {
        if (row[key] !== undefined) context[key] = row[key]; else delete context[key];
      }
      if (['succeeded', 'failed', 'canceled'].includes(row.runStatus)) context.runStatus = row.runStatus;
      else delete context.runStatus;
      if (row.feedback) {
        context.feedback = { rating: row.feedback.rating, createdAt: row.feedback.createdAt };
        for (const key of ['reasonCodes', 'customReason', 'reasonsSubmittedAt', 'updatedAt'] as const) {
          if (row.feedback[key] !== undefined) context.feedback[key] = row.feedback[key];
        }
      } else delete context.feedback;
      const resourceRefs: string[] = [];
      if (imported) {
        const indirect = new Set(displayResourceRefs(imported.context, imported.displayEvents));
        resourceRefs.push(...imported.resourceRefs.filter(digest => !indirect.has(digest)));
      }
      const replacements = new Map<string, string>();
      const displayEvents: PortableDisplayEvent[] = imported ? structuredClone(imported.displayEvents) : [];
      if (Array.isArray(row.attachments)) {
        context.attachments = [];
        for (const [index, attachment] of row.attachments.entries()) {
          const digest = await fileResource(attachment.path, 'attachment', messageId, attachment.name,
            `attachment:${projectId}:${row.id}:${index}`);
          resourceRefs.push(digest);
          replacements.set(attachment.path, (resources.get(digest)!.locations.find(location => location.purpose === 'attachment')
            ?? resources.get(digest)!.locations[0]).path);
          const descriptor: NonNullable<PortableMessageContext['attachments']>[number] = {
            resourceRef: digest, name: attachment.name, kind: attachment.kind,
          };
          if (attachment.size !== undefined) descriptor.size = attachment.size;
          if (attachment.order !== undefined) descriptor.order = attachment.order;
          context.attachments.push(descriptor);
        }
      } else delete context.attachments;
      if (Array.isArray(row.commentAttachments)) {
        context.commentAttachments = [];
        for (const [index, comment] of (row.commentAttachments as ChatCommentAttachment[]).entries()) {
          const descriptor = commentDisplay(comment, projectId);
          if (comment.screenshotPath) {
            descriptor.screenshotResourceRef = await fileResource(comment.screenshotPath, 'attachment', messageId, 'Comment screenshot',
              `comment-screenshot:${projectId}:${row.id}:${index}`);
            resourceRefs.push(descriptor.screenshotResourceRef);
          }
          if (comment.imageAttachments) {
            descriptor.imageAttachments = [];
            for (const [imageIndex, attachment] of comment.imageAttachments.entries()) {
              const resourceRef = await fileResource(attachment.path, 'attachment', messageId, attachment.name,
                `comment-image:${projectId}:${row.id}:${index}:${imageIndex}`);
              resourceRefs.push(resourceRef); descriptor.imageAttachments.push({ resourceRef, name: attachment.name });
            }
          }
          context.commentAttachments.push(descriptor);
        }
      }
      if (row.runContext || row.appliedPluginSnapshot) {
        context.contentItems = [];
        for (const [kind, contentIds] of [['skill', row.runContext?.skillIds], ['plugin', row.runContext?.pluginIds]] as const) {
          for (const contentId of contentIds ?? []) {
            const digest = await contentResource(kind, contentId, messageId);
            resourceRefs.push(digest); context.contentItems.push({ kind, label: contentId, resourceRef: digest });
          }
        }
        if (row.appliedPluginSnapshot) {
          const plugin = row.appliedPluginSnapshot;
          const digest = await contentResource('plugin', plugin.pluginId, messageId, plugin);
          resourceRefs.push(digest); context.contentItems.push({ kind: 'plugin', label: plugin.pluginTitle ?? plugin.pluginId, resourceRef: digest });
        }
        for (const item of row.runContext?.workspaceItems ?? []) context.contentItems.push({ kind: 'workspace', label: item.label, unavailable: true });
      }
      if (row.producedFiles) for (const [index, file] of row.producedFiles.entries()) {
        const reference = file.path ?? file.name;
        const digest = await fileResource(reference, 'artifact', messageId, file.name, `artifact:${projectId}:${row.id}:${index}`);
        resourceRefs.push(digest); replacements.set(reference, (resources.get(digest)!.locations.find(location => location.purpose === 'artifact')
          ?? resources.get(digest)!.locations[0]).path);
        displayEvents.push({ kind: 'result', text: file.name, resourceRefs: [digest] });
      }
      if (!imported && emittedRenderableQuestionForm(row.content)) {
        displayEvents.push({ kind: 'history-form', title: 'Historical questions', summary: row.content, status: 'historical' });
      }
      for (const event of row.events ?? []) {
        if (event.kind === 'text' || event.kind === 'thinking') displayEvents.push({ kind: event.kind, text: event.text });
        else if (event.kind === 'conversation_title') displayEvents.push({ kind: 'conversation_title', title: event.title });
        else if (event.kind === 'status') displayEvents.push({ kind: 'status', text: [event.label, event.detail].filter(Boolean).join(': ') });
        else if (event.kind === 'tool_use') displayEvents.push({ kind: 'tool_summary', label: event.name, status: 'historical' });
        else if (event.kind === 'tool_result') displayEvents.push({ kind: 'result', text: event.content });
        else if (event.kind === 'diagnostic') displayEvents.push({ kind: 'thinking', text: 'Diagnostic content unavailable', unavailable: true });
        else if (event.kind === 'plugin_candidate') displayEvents.push({ kind: 'status', text: [event.title, event.description].filter(Boolean).join(': ') });
        else if (event.kind === 'live_artifact' || event.kind === 'live_artifact_refresh') displayEvents.push({ kind: 'result', text: event.title ?? 'Historical live artifact', unavailable: true });
        else if (event.kind !== 'usage' && event.kind !== 'raw') throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Persisted display event has no portable projection');
      }
      const replaceLinks = (text: string) => [...replacements].reduce((current, [reference, replacement]) => current.split(reference).join(replacement), text);
      for (const [eventIndex, event] of displayEvents.entries()) {
        if ('text' in event && event.text !== undefined) {
          event.text = replaceLinks(event.text);
          // Only recognizable machine links are resolved. Public web references remain references;
          // arbitrary absolute paths never become filesystem authority from historical prose.
          const links = [...new Set(event.text.match(/(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/[^\s<>"'`)]+|\/api\/projects\/[^\s<>"'`)]+|file:\/\/[^\s<>"'`)]+)/gi) ?? [])];
          for (const [linkIndex, reference] of links.entries()) {
            let replacement = '[Local content unavailable]';
            if (projectRelative(reference, projectId)) {
              try {
                const digest = await fileResource(reference, 'artifact', messageId, 'Historical event file',
                  `event-file:${projectId}:${row.id}:${eventIndex}:${linkIndex}`);
                resourceRefs.push(digest);
                replacement = resources.get(digest)!.locations[0].path;
              } catch (error) {
                if (!(error instanceof GitDomainError) || error.code !== 'PORTABLE_RESOURCE_MISSING') throw error;
              }
            }
            if (replacement === '[Local content unavailable]' && (event.kind === 'thinking' || event.kind === 'result')) event.unavailable = true;
            replacements.set(reference, replacement);
            event.text = event.text.split(reference).join(replacement);
          }
        }
        if (event.kind === 'history-form' && event.summary !== undefined) event.summary = replaceLinks(event.summary);
      }
      const referenced = new Set([...resourceRefs, ...displayResourceRefs(context, displayEvents)]);
      for (const digest of referenced) if (!resources.has(digest)) await retain(digest, messageId);
      else { const references = resources.get(digest)!.references; if (!references.includes(messageId)) references.push(messageId); }
      snapshot.messages.push({ schemaVersion: 1, id: messageId, conversationId, role: row.role,
        content: replaceLinks(row.content as string), createdAt: row.createdAt ?? conversation.createdAt, predecessorId,
        turnId: currentTurn!, terminal, resourceRefs: [...referenced].sort(), displayEvents, context });
      predecessorId = messageId;
    }
  }
  const legacy = async (relative: string) => {
    let children;
    try {
      if (!(await lstat(path.join(legacyRoot, relative))).isDirectory()) throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Legacy directory is unavailable', { paths: [relative] });
      children = await readdir(path.join(legacyRoot, relative), { withFileTypes: true });
    }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return; throw error; }
    for (const child of children.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const file = `${relative}/${child.name}`;
      if (child.isDirectory()) await legacy(file);
      else {
        const bytes = child.isFile() ? await readPortableResource(legacyRoot, file) : null;
        if (!bytes) throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Required legacy content is unavailable', { paths: [file] });
        if (child.name === 'manifest.json') for (const member of legacyMemberPaths(file, bytes)) {
          if (await readPortableResource(legacyRoot, member)) continue;
          const archived = member.replace(/^\.file-versions\//, '.open-design/legacy-file-history/');
          const retained = previousResources.find(resource => resource.locations.some(location => location.path === archived && location.purpose === 'legacy-history'));
          if (retained) snapshot.project.contentRefs.push(await retain(retained.digest, repo));
          else throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Required legacy version content is missing', { paths: [member] });
        }
        const digest = add(bytes, 'legacy-history', repo, file, file.replace(/^\.file-versions\//, '.open-design/legacy-file-history/'));
        snapshot.project.contentRefs.push(digest);
      }
    }
  };
  // A valid portable snapshot establishes the once-only archive, including an
  // empty archive after import/restore. Later native history is not its source.
  // Task 11 owns the durable first-enable completion marker around publication.
  if (!previous) await legacy('.file-versions');
  snapshot.project.contentRefs = [...new Set(snapshot.project.contentRefs)].sort();
  snapshot.manifest.resources = [...resources.values()].sort((a, b) => a.digest < b.digest ? -1 : 1);
  for (const resource of snapshot.manifest.resources) {
    resource.references.sort();
    resource.locations.sort((a, b) => canonicalJson(a as JsonValue) < canonicalJson(b as JsonValue) ? -1 : 1);
  }
  snapshot.conversations.sort((a, b) => a.id < b.id ? -1 : 1); snapshot.messages.sort((a, b) => a.id < b.id ? -1 : 1);
  const valid = parsePortableSnapshot(snapshot);
  const entries = metadataEntries(valid);
  const collected = await collectReferencedResources({ snapshot: valid, root, readOwnedResource: async reference => bytesByPath.get(reference) ?? null });
  for (const [file, bytes] of collected) entries.set(file, bytes);
  return { snapshot: valid, entries };
}
