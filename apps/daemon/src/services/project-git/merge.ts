import { createHash } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { parsePortableSnapshot, type JsonValue, type PortableSnapshot, type ProjectGitConflict,
  type ProjectGitConflictContent, type PortableConversation, type PortableMessage, type PortableResource,
  type PortableResourceLocation, type ProjectGitResolution } from '@open-design/contracts';
import { canonicalJson, isPortableMetadataPath, parsePortableEntries, parsePortableMetadataEntries, serializePortableMetadata } from './portable.js';
import { GitDomainError } from './errors.js';
import { mergeGitText, runGit } from './git-process.js';
import { discoverRepository, resolveCommit, validateTreeEntries } from './repository.js';

type ValueResult<T extends JsonValue> = { kind: 'merged'; value: T | undefined }
  | { kind: 'conflict'; base: T | undefined; local: T | undefined; remote: T | undefined };

/** Undefined is deletion; arrays retain their semantic order. */
export function mergeValue<T extends JsonValue>(base: T | undefined, local: T | undefined, remote: T | undefined): ValueResult<T> {
  // Validate all three values, even when an equality shortcut would skip one.
  const keys = [base, local, remote].map(value => value === undefined ? undefined : canonicalJson(value));
  if (keys[1] === keys[2]) return { kind: 'merged', value: local };
  if (keys[1] === keys[0]) return { kind: 'merged', value: remote };
  if (keys[2] === keys[0]) return { kind: 'merged', value: local };
  return { kind: 'conflict', base, local, remote };
}

function view(value: JsonValue | undefined): ProjectGitConflictContent {
  return value === undefined ? { kind: 'missing' } : { kind: 'json', value };
}
function conflict(kind: ProjectGitConflict['kind'], location: { path: string } | { recordId: string },
  base: JsonValue | undefined, local: JsonValue | undefined, remote: JsonValue | undefined): ProjectGitConflict {
  return { id: createHash('sha256').update(canonicalJson({ kind, ...location })).digest('hex'), kind, ...location,
    base: view(base), local: view(local), remote: view(remote) };
}

interface ResolutionState {
  decisions: Map<string, ProjectGitResolution>;
  seen: Set<string>;
}

function resolutionError(message: string): GitDomainError {
  return new GitDomainError('VALIDATION_FAILED', 400, message);
}

function requireDecision(item: ProjectGitConflict, state: ResolutionState): ProjectGitResolution {
  const decision = state.decisions.get(item.id);
  if (!decision) throw new GitDomainError('PREVIEW_STALE', 409, 'Conflict decisions do not match the current conflict set.');
  state.seen.add(item.id);
  return decision;
}

function jsonSide(item: ProjectGitConflict, side: 'base' | 'local' | 'remote'): JsonValue | undefined {
  const content = item[side];
  if (content.kind === 'missing') return undefined;
  if (content.kind !== 'json') throw resolutionError('The selected conflict side is not structured JSON.');
  return content.value;
}

function resolveJsonConflict(item: ProjectGitConflict, state: ResolutionState): JsonValue | undefined {
  const decision = requireDecision(item, state);
  if (decision.kind === 'select') return jsonSide(item, decision.selectedSide);
  if (decision.kind === 'edit' && 'value' in decision) return decision.value;
  if (decision.kind === 'delete') return undefined;
  throw resolutionError('This structured conflict requires a JSON selection, edit, or deletion.');
}

function resolveResourceConflict(
  item: ProjectGitConflict,
  values: Array<PortableResource | undefined>,
  snapshots: PortableSnapshot[],
  state: ResolutionState,
): PortableResource | undefined {
  const decision = requireDecision(item, state);
  if (decision.kind === 'delete') return undefined;
  if (decision.kind === 'select') {
    const index = decision.selectedSide === 'base' ? 0 : decision.selectedSide === 'local' ? 1 : 2;
    return values[index];
  }
  if (decision.kind === 'edit' && 'resourceRef' in decision) {
    return snapshots.flatMap(snapshot => snapshot.manifest.resources).find(resource => resource.digest === decision.resourceRef);
  }
  throw resolutionError('A resource conflict requires a retained resource selection, reference, or deletion.');
}
function withDerivedResourceReferences(
  resource: PortableResource,
  project: PortableSnapshot['project'],
  messages: PortableMessage[],
  repositoryProjectId: string,
): PortableResource {
  return { ...resource, references: [
    ...(project.contentRefs.includes(resource.digest) ? [repositoryProjectId] : []),
    ...messages.filter(message => message.resourceRefs.includes(resource.digest)).map(message => message.id),
  ].sort() };
}
function object(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const keysOf = (...values: Array<Record<string, unknown> | undefined>) => [...new Set(values.flatMap(value => Object.keys(value ?? {})))].sort();
const pointer = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
// Only strictly parsed portable records reach this encoder. Their optional
// TypeScript properties include undefined; JSON represents these by absence.
function portableJson(value: PortableSnapshot | PortableSnapshot['project'] | PortableConversation | PortableMessage | PortableResource | PortableResourceLocation): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function fields(base: JsonValue | undefined, local: JsonValue | undefined, remote: JsonValue | undefined,
  path: string, conflicts: ProjectGitConflict[], resolutions?: ResolutionState): JsonValue | undefined {
  const result = mergeValue(base, local, remote);
  if (result.kind === 'merged') return result.value;
  if (object(local) && object(remote) && (base === undefined || object(base))) {
    const merged: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    const own = (value: Record<string, JsonValue> | undefined, key: string) => value && Object.hasOwn(value, key) ? value[key] : undefined;
    for (const key of keysOf(base, local, remote)) {
      const value = fields(own(base, key), own(local, key), own(remote, key), `${path}/${pointer(key)}`, conflicts, resolutions);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  const item = conflict('field', { path }, base, local, remote);
  if (resolutions) return resolveJsonConflict(item, resolutions);
  conflicts.push(item); return undefined;
}

function records<T extends PortableConversation | PortableMessage>(base: T[], local: T[], remote: T[],
  kind: 'message' | 'field', conflicts: ProjectGitConflict[], resolutions?: ResolutionState): T[] {
  const maps = [base, local, remote].map(values => new Map(values.map(value => [value.id, value])));
  const merged: T[] = [];
  for (const id of [...new Set([...base, ...local, ...remote].map(record => record.id))].sort()) {
    const [b, l, r] = maps.map(map => map.get(id));
    const result = mergeValue(b && portableJson(b), l && portableJson(l), r && portableJson(r));
    if (result.kind === 'merged') { if (result.value) merged.push(result.value as T); }
    else if (kind === 'field' && b && l && r) {
      const value = fields(portableJson(b), portableJson(l), portableJson(r), `conversations/${pointer(id)}`, conflicts, resolutions);
      if (value !== undefined) merged.push(value as T);
    } else {
      const item = conflict(kind, { recordId: id }, b && portableJson(b), l && portableJson(l), r && portableJson(r));
      if (resolutions) {
        const value = resolveJsonConflict(item, resolutions); if (value !== undefined) merged.push(value as T);
      } else conflicts.push(item);
    }
  }
  return merged;
}

function resolveConversationOrder(
  conversationId: string,
  messages: PortableMessage[],
  item: ProjectGitConflict,
  resolutions: ResolutionState,
): void {
  const decision = requireDecision(item, resolutions);
  if (decision.kind !== 'order') throw resolutionError('A conversation-order conflict requires an explicit turn order.');
  const members = messages.filter(message => message.conversationId === conversationId);
  const turns = new Map<string, PortableMessage[]>();
  for (const message of members) {
    const group = turns.get(message.turnId) ?? [];
    group.push(message); turns.set(message.turnId, group);
  }
  if (new Set(decision.orderedTurnIds).size !== decision.orderedTurnIds.length
    || decision.orderedTurnIds.length !== turns.size
    || decision.orderedTurnIds.some(id => !turns.has(id))) {
    throw resolutionError('The ordered turn IDs must name every current turn exactly once.');
  }
  const ordered: PortableMessage[] = [];
  for (const turnId of decision.orderedTurnIds) {
    const pending = [...turns.get(turnId)!];
    const selected: PortableMessage[] = [];
    while (pending.length) {
      const next = pending.find(message => message.predecessorId === null
        || selected.some(candidate => candidate.id === message.predecessorId)
        || !pending.some(candidate => candidate.id === message.predecessorId))
        ?? [...pending].sort((a, b) => a.id.localeCompare(b.id))[0]!;
      selected.push(next); pending.splice(pending.indexOf(next), 1);
    }
    ordered.push(...selected);
  }
  let predecessor: string | null = null;
  for (const message of ordered) { message.predecessorId = predecessor; predecessor = message.id; }
  const first = messages.findIndex(message => message.conversationId === conversationId);
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.conversationId === conversationId) messages.splice(index, 1);
  }
  messages.splice(first < 0 ? messages.length : first, 0, ...ordered);
}

/** Pure structured merge. Resource bytes are verified later by parsePortableEntries. */
export function mergePortableSnapshots(base: PortableSnapshot, local: PortableSnapshot, remote: PortableSnapshot,
  resolutionInputs?: readonly ProjectGitResolution[]): {
  snapshot: PortableSnapshot | null; conflicts: ProjectGitConflict[];
} {
  if (new Set([base, local, remote].map(value => value.manifest.repositoryProjectId)).size !== 1) {
    throw new GitDomainError('CONFLICT', 409, 'Cannot merge a different repository project.');
  }
  const inputs = [base, local, remote].map(value => parsePortableSnapshot(value));
  [base, local, remote] = inputs as [PortableSnapshot, PortableSnapshot, PortableSnapshot];
  const conflicts: ProjectGitConflict[] = [];
  let resolutions: ResolutionState | undefined;
  if (resolutionInputs) {
    const decisions = new Map(resolutionInputs.map(item => [item.conflictId, item]));
    if (decisions.size !== resolutionInputs.length) throw resolutionError('Every conflict must have one unique decision.');
    resolutions = { decisions, seen: new Set() };
  }
  const project = fields(portableJson(base.project), portableJson(local.project), portableJson(remote.project), 'project', conflicts, resolutions) as PortableSnapshot['project'];
  const conversations = records(base.conversations, local.conversations, remote.conversations, 'field', conflicts, resolutions);
  const messages = records(base.messages, local.messages, remote.messages, 'message', conflicts, resolutions);
  if (conflicts.length) return { snapshot: null, conflicts };
  const resources: PortableSnapshot['manifest']['resources'] = [];
  const resourceMaps = inputs.map(value => new Map(value.manifest.resources.map(resource => [resource.digest, resource])));
  for (const digest of [...new Set(inputs.flatMap(value => value.manifest.resources.map(resource => resource.digest)))].sort()) {
    // The reverse index is derived from the selected message/project values, never independently merged.
    const values = resourceMaps.map(map => map.get(digest));
    const locations = values.map(resource => resource && Object.fromEntries(resource.locations.map(location => [canonicalJson(portableJson(location)), portableJson(location)])));
    const presence = mergeValue(locations[0], locations[1], locations[2]);
    if (!values[1] || !values[2]) {
      if (presence.kind === 'conflict') {
        const item = conflict('resource', { recordId: digest },
          values[0] && portableJson(values[0]), values[1] && portableJson(values[1]), values[2] && portableJson(values[2]));
        if (!resolutions) { conflicts.push(item); continue; }
        const selected = resolveResourceConflict(item, values, inputs, resolutions);
        if (!selected) continue;
        resources.push(withDerivedResourceReferences(selected, project, messages, base.manifest.repositoryProjectId));
        continue;
      }
      if (presence.value === undefined) continue;
    }
    const mergedLocations: PortableResourceLocation[] = [];
    for (const key of keysOf(...locations)) {
      const result = mergeValue(locations[0]?.[key], locations[1]?.[key], locations[2]?.[key]);
      if (result.kind === 'merged' && result.value) mergedLocations.push(result.value as PortableResourceLocation);
    }
    if (!mergedLocations[0]) {
      const item = conflict('resource', { recordId: digest }, values[0] && portableJson(values[0]), values[1] && portableJson(values[1]), values[2] && portableJson(values[2]));
      if (resolutions) {
        const selected = resolveResourceConflict(item, values, inputs, resolutions);
        if (selected) resources.push(withDerivedResourceReferences(selected, project, messages, base.manifest.repositoryProjectId));
      } else conflicts.push(item);
      continue;
    }
    resources.push(withDerivedResourceReferences(
      { digest, locations: [mergedLocations[0], ...mergedLocations.slice(1)], references: [] },
      project,
      messages,
      base.manifest.repositoryProjectId,
    ));
  }
  const candidate = { manifest: { ...base.manifest, resources }, project, conversations, messages };
  if (conflicts.length) return { snapshot: null, conflicts };

  const orderConflicts = new Set<string>();
  const resourceConflicts = new Set<string>();
  try { parsePortableSnapshot(candidate); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('issues' in error) || !Array.isArray(error.issues)) throw error;
    for (const issue of error.issues as Array<{ path: Array<string | number>; message: string }>) {
      const [section, index] = issue.path;
      if (section === 'manifest' || issue.path.includes('resourceRefs') || issue.path.includes('contentRefs')
        || issue.path.includes('context') || issue.path.includes('displayEvents')) {
        resourceConflicts.add('manifest/resources');
      } else if (section === 'messages') orderConflicts.add(messages[Number(index)]!.conversationId);
      else if (section === 'conversations') orderConflicts.add(conversations[Number(index)]!.id);
      else conflicts.push(conflict('field', { path: issue.path.join('/') }, portableJson(base.project), portableJson(local.project), portableJson(remote.project)));
    }
  }
  // A valid predecessor graph alone can still split a user/reply turn. Preserve
  // all members of a retained turn and keep each turn contiguous in the chain.
  const candidateById = new Map(messages.map(message => [message.id, message]));
  const turns = new Map<string, Set<string>>();
  for (const message of inputs.flatMap(value => value.messages)) {
    const key = canonicalJson([message.conversationId, message.turnId]);
    const members = turns.get(key) ?? new Set<string>(); members.add(message.id); turns.set(key, members);
  }
  for (const members of turns.values()) {
    const retained = [...members].filter(id => candidateById.has(id));
    if (retained.length && retained.length !== members.size) orderConflicts.add(candidateById.get(retained[0]!)!.conversationId);
    const groups = new Set(retained.map(id => { const message = candidateById.get(id)!; return canonicalJson([message.conversationId, message.turnId]); }));
    if (groups.size > 1) for (const id of retained) orderConflicts.add(candidateById.get(id)!.conversationId);
  }
  for (const conversation of conversations) {
    const members = messages.filter(message => message.conversationId === conversation.id);
    const successors = new Map(members.map(message => [message.predecessorId, message]));
    const seen = new Set<string>(); const closedTurns = new Set<string>(); let lastTurn: string | undefined;
    let cursor = successors.get(null);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (cursor.turnId !== lastTurn) {
        if (closedTurns.has(cursor.turnId)) orderConflicts.add(conversation.id);
        if (lastTurn !== undefined) closedTurns.add(lastTurn);
        lastTurn = cursor.turnId;
      }
      cursor = successors.get(cursor.id);
    }
  }
  for (const id of [...orderConflicts].sort()) {
    const item = conflict('conversation_order', { recordId: id },
      ...inputs.map(value => value.messages.filter(message => message.conversationId === id).map(portableJson)) as [JsonValue, JsonValue, JsonValue]);
    if (resolutions) resolveConversationOrder(id, messages, item, resolutions);
    else conflicts.push(item);
  }
  for (const path of resourceConflicts) {
    const item = conflict('resource', { path },
      base.manifest.resources.map(portableJson), local.manifest.resources.map(portableJson), remote.manifest.resources.map(portableJson));
    if (!resolutions) { conflicts.push(item); continue; }
    const decision = requireDecision(item, resolutions);
    let selected: PortableResource[];
    if (decision.kind === 'select') {
      const index = decision.selectedSide === 'base' ? 0 : decision.selectedSide === 'local' ? 1 : 2;
      selected = inputs[index]!.manifest.resources;
    } else if (decision.kind === 'edit' && 'resourceRef' in decision) {
      const resource = inputs.flatMap(snapshot => snapshot.manifest.resources)
        .find(candidateResource => candidateResource.digest === decision.resourceRef);
      if (!resource) throw resolutionError('The selected resource reference is unavailable in the conflict inputs.');
      selected = [...resources.filter(candidateResource => candidateResource.digest !== resource.digest), resource];
    } else if (decision.kind === 'delete') selected = [];
    else throw resolutionError('A resource-set conflict requires a retained resource selection, reference, or deletion.');
    resources.splice(0, resources.length, ...selected.map(resource => withDerivedResourceReferences(
      resource, project, messages, base.manifest.repositoryProjectId,
    )));
    candidate.manifest.resources = resources;
  }
  if (resolutions && (resolutions.seen.size !== resolutions.decisions.size
    || [...resolutions.decisions.keys()].some(id => !resolutions.seen.has(id)))) {
    throw new GitDomainError('PREVIEW_STALE', 409, 'Conflict decisions do not match the current conflict set.');
  }
  return conflicts.length ? { snapshot: null, conflicts } : { snapshot: parsePortableSnapshot(candidate), conflicts };
}

type FileObject = { oid: string; mode: string; bytes: Buffer };
type FileTree = Map<string, FileObject>;

async function readFileTree(root: string, oid: string): Promise<FileTree> {
  await resolveCommit(root, oid);
  const output = await runGit({ cwd: root, args: ['ls-tree', '-r', '-z', '--full-tree', oid] });
  let listing: string;
  try { listing = new TextDecoder('utf-8', { fatal: true }).decode(output.stdout); }
  catch { throw new GitDomainError('VALIDATION_FAILED', 400, 'Git paths must be valid UTF-8.'); }
  const entries = listing.split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t(.+)$/su.exec(line);
    if (!match) throw new GitDomainError('VALIDATION_FAILED', 400, 'Invalid Git tree record.');
    return { mode: match[1]!, oid: match[3]!, path: match[4]! };
  });
  validateTreeEntries(entries);
  const result: FileTree = new Map();
  for (const entry of entries) {
    const bytes = (await runGit({ cwd: root, args: ['cat-file', 'blob', entry.oid] })).stdout;
    result.set(entry.path, { oid: entry.oid, mode: entry.mode, bytes });
  }
  return result;
}
function fileView(file: FileObject | undefined): ProjectGitConflictContent {
  return file ? { kind: 'file', file: { encoding: 'base64', content: file.bytes.toString('base64'), mediaType: 'application/octet-stream' } } : { kind: 'missing' };
}
function fileConflict(path: string, trees: FileTree[], kind: 'file' | 'resource' = 'file'): ProjectGitConflict {
  return { ...conflict(kind, { path }, undefined, undefined, undefined),
    base: fileView(trees[0]!.get(path)), local: fileView(trees[1]!.get(path)), remote: fileView(trees[2]!.get(path)) };
}
function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}
function ordinary(path: string): boolean { return !path.startsWith('.open-design/'); }
function renameConflicts(base: FileTree, local: FileTree, remote: FileTree): Set<string> {
  const changes = (side: FileTree) => ({
    removed: new Set([...base.keys()].filter(path => ordinary(path) && !side.has(path))),
    added: new Set([...side.keys()].filter(path => ordinary(path) && !base.has(path))),
  });
  const l = changes(local); const r = changes(remote); const conflicts = new Set<string>();
  if (!l.removed.size || !r.removed.size || !l.added.size || !r.added.size) return conflicts;
  const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(path => b.has(path));
  // Git paths have no stable identity after an edited rename. Shared sources
  // with competing destinations (or vice versa) require an explicit decision,
  // even when the destination bytes happen to be equal.
  const collision = ([...l.removed].some(path => r.removed.has(path)) && !same(l.added, r.added))
    || ([...l.added].some(path => r.added.has(path)) && !same(l.removed, r.removed));
  if (collision) for (const path of [...l.removed, ...r.removed, ...l.added, ...r.added]) conflicts.add(path);
  return conflicts;
}

/** Build retained objects using a private index, never materialize into the project.
 * Caller owns stagingDir and all generated scratch/index files until operation cleanup.
 * A plain input requires the caller's preview-approved portable head as metadataSource.
 * This kernel validates composition, not the preview's revision/authorization basis.
 */
export async function mergeFileTrees(input: {
  root: string; base: string; local: string; remote: string; stagingDir: string;
  metadataSource?: 'local' | 'remote';
  resolutions?: readonly ProjectGitResolution[];
}): Promise<{
  tree: string | null; conflicts: ProjectGitConflict[];
}> {
  if (!isAbsolute(input.root) || !isAbsolute(input.stagingDir)) throw new GitDomainError('VALIDATION_FAILED', 400, 'Merge paths must be absolute.');
  const root = await realpath(input.root); const stagingDir = await realpath(input.stagingDir);
  const repository = await discoverRepository(root);
  const within = (parent: string, child: string) => { const rest = relative(parent, child); return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest); };
  if (within(root, stagingDir) || within(repository.commonDir, stagingDir)) throw new GitDomainError('VALIDATION_FAILED', 400, 'Merge preparation must be outside the project and Git directory.');
  const trees: FileTree[] = []; const snapshots: Array<PortableSnapshot | null> = [];
  const invalidResourcePaths = new Set<string>();
  for (const oid of [input.base, input.local, input.remote]) {
    const files = await readFileTree(root, oid); trees.push(files);
    try {
      // Only genuine namespace absence is plain. Partial or case-variant layouts
      // must enter the strict parser and can never be selected away as ordinary files.
      const hasMetadata = [...files.keys()].some(path => path.split('/')[0]!.normalize('NFC').toLowerCase() === '.open-design');
      snapshots.push(hasMetadata ? parsePortableEntries(new Map([...files].map(([path, file]) => [path, file.bytes]))) : null);
    } catch (error) {
      if (!(error instanceof GitDomainError) || error.code !== 'PORTABLE_RESOURCE_MISSING') throw error;
      const paths = Array.isArray(error.details?.paths) ? error.details.paths.filter((value): value is string => typeof value === 'string')
        : [typeof error.details?.path === 'string' ? error.details.path : '.open-design/resources'];
      for (const path of paths) invalidResourcePaths.add(path);
      snapshots.push(parsePortableMetadataEntries(
        new Map([...files].filter(([path]) => isPortableMetadataPath(path)).map(([path, file]) => [path, file.bytes])),
        new Set(files.keys()),
        { allowMissingResources: true },
      ));
    }
  }
  if (new Set(snapshots.flatMap(snapshot => snapshot ? [snapshot.manifest.repositoryProjectId] : [])).size > 1) {
    throw new GitDomainError('CONFLICT', 409, 'Cannot merge a different repository project.');
  }
  let merged: ReturnType<typeof mergePortableSnapshots>; let resourceTrees = trees;
  const encountered: ProjectGitConflict[] = [];
  const resolvedIds = new Set<string>();
  if (snapshots.every(snapshot => snapshot !== null)) {
    if (input.metadataSource !== undefined) throw new GitDomainError('VALIDATION_FAILED', 400,
      'Metadata source selection requires a plain Git input.', { reason: 'metadata_source_not_applicable' });
    const preview = mergePortableSnapshots(snapshots[0]!, snapshots[1]!, snapshots[2]!);
    encountered.push(...preview.conflicts);
    if (input.resolutions && preview.conflicts.length) {
      const ids = new Set(preview.conflicts.map(item => item.id));
      const structured = input.resolutions.filter(item => ids.has(item.conflictId));
      merged = mergePortableSnapshots(snapshots[0]!, snapshots[1]!, snapshots[2]!, structured);
      for (const item of preview.conflicts) resolvedIds.add(item.id);
    } else merged = preview;
  } else {
    if (input.metadataSource === undefined) throw new GitDomainError('VALIDATION_FAILED', 400,
      'Plain Git inputs require an explicit portable metadata source.', { reason: 'metadata_source_required' });
    if (input.metadataSource !== 'local' && input.metadataSource !== 'remote') throw new GitDomainError('VALIDATION_FAILED', 400,
      'Metadata source must be a local or remote head.', { reason: 'metadata_source_invalid' });
    const sourceIndex = input.metadataSource === 'local' ? 1 : 2;
    const source = snapshots[sourceIndex];
    if (!source) throw new GitDomainError('VALIDATION_FAILED', 400,
      'The selected head has no portable metadata.', { reason: 'metadata_source_not_portable' });
    if (snapshots[1] && snapshots[2] && canonicalJson(portableJson(snapshots[1])) !== canonicalJson(portableJson(snapshots[2]))) {
      throw new GitDomainError('CONFLICT', 409, 'Different portable metadata histories have no common metadata baseline.', { reason: 'metadata_baseline_missing' });
    }
    merged = { snapshot: source, conflicts: [] };
    resourceTrees = [trees[sourceIndex]!];
  }
  const conflicts = [...merged.conflicts]; const candidate: FileTree = new Map();
  for (const path of [...invalidResourcePaths].sort()) {
    const item = conflict('resource', { path },
      { oid: input.base, path }, { oid: input.local, path }, { oid: input.remote, path });
    conflicts.push(item); encountered.push(item);
  }
  const renamePaths = renameConflicts(trees[0]!, trees[1]!, trees[2]!);
  for (const path of [...renamePaths].sort()) {
    const item = fileConflict(path, trees); conflicts.push(item); encountered.push(item);
  }
  const scratch = await mkdtemp(join(stagingDir, 'git-merge-'));
  for (const path of [...new Set(trees.flatMap(tree => [...tree.keys()]))].filter(ordinary).sort()) {
    if (renamePaths.has(path)) continue;
    const [b, l, r] = trees.map(tree => tree.get(path));
    const key = (file: FileObject | undefined) => file && { oid: file.oid, mode: file.mode };
    const value = mergeValue(key(b), key(l), key(r));
    if (value.kind === 'merged') {
      if (value.value) candidate.set(path, [l, r, b].find(file => file?.oid === value.value!.oid && file?.mode === value.value!.mode)!);
      continue;
    }
    if (!b || !l || !r) { const item = fileConflict(path, trees); conflicts.push(item); encountered.push(item); continue; }
    const mode = mergeValue(b.mode, l.mode, r.mode);
    const content = mergeValue(b.oid, l.oid, r.oid);
    if (mode.kind === 'conflict') { const item = fileConflict(path, trees); conflicts.push(item); encountered.push(item); continue; }
    let bytes: Buffer;
    if (content.kind === 'merged') bytes = [l, r, b].find(file => file.oid === content.value)!.bytes;
    else {
      if (![b, l, r].every(file => isText(file.bytes))) { const item = fileConflict(path, trees); conflicts.push(item); encountered.push(item); continue; }
      const text = await mergeGitText({ stagingDir: scratch, base: b.bytes, local: l.bytes, remote: r.bytes });
      if (text.kind === 'conflict') { const item = fileConflict(path, trees); conflicts.push(item); encountered.push(item); continue; }
      bytes = text.content;
    }
    candidate.set(path, { oid: '', mode: mode.value!, bytes });
  }
  if (!merged.snapshot) return { tree: null, conflicts };
  for (const [path, bytes] of serializePortableMetadata(merged.snapshot)) candidate.set(path, { oid: '', mode: '100644', bytes: Buffer.from(bytes) });
  for (const resource of merged.snapshot.manifest.resources) for (const location of resource.locations) {
    const file = resourceTrees.map(tree => tree.get(location.path)).find(file => file && createHash('sha256').update(file.bytes).digest('hex') === resource.digest);
    if (!file) {
      const item = conflict('resource', { path: location.path },
        ...trees.map(tree => tree.has(location.path) ? resource.digest : undefined) as [JsonValue | undefined, JsonValue | undefined, JsonValue | undefined]);
      if (!conflicts.some(existing => existing.id === item.id)) {
        conflicts.push(item); encountered.push(item);
      }
    } else candidate.set(location.path, file);
  }
  try { validateTreeEntries([...candidate].map(([path, file]) => ({ path, mode: file.mode }))); }
  catch (error) {
    if (!(error instanceof GitDomainError)) throw error;
    const paths = new Set(merged.snapshot.manifest.resources.flatMap(resource => resource.locations.map(location => location.path)));
    for (const path of [...candidate.keys()].filter(path => ordinary(path) || paths.has(path)).sort()) {
      const item = fileConflict(path, trees, ordinary(path) ? 'file' : 'resource');
      if (!conflicts.some(existing => existing.id === item.id)) {
        conflicts.push(item); encountered.push(item);
      }
    }
  }
  if (conflicts.length && input.resolutions) {
    const decisions = new Map(input.resolutions.map(item => [item.conflictId, item]));
    if (decisions.size !== input.resolutions.length || conflicts.some(item => !decisions.has(item.id))) {
      throw new GitDomainError('PREVIEW_STALE', 409, 'Conflict decisions do not match the current conflict set.');
    }
    for (const item of conflicts) {
      const decision = decisions.get(item.id)!;
      resolvedIds.add(item.id);
      if (!('path' in item) || !item.path || !['file', 'resource'].includes(item.kind)) {
        throw new GitDomainError('VALIDATION_FAILED', 400, 'Structured conflict resolution requires an explicit structured merge decision.');
      }
      if (decision.kind === 'delete') {
        candidate.delete(item.path);
        if (item.kind === 'resource') {
          for (let index = merged.snapshot.manifest.resources.length - 1; index >= 0; index--) {
            const resource = merged.snapshot.manifest.resources[index]!;
            const retained = resource.locations.filter(location => location.path !== item.path);
            if (retained.length) resource.locations = [retained[0]!, ...retained.slice(1)];
            else if (!resource.references.length) merged.snapshot.manifest.resources.splice(index, 1);
            else throw resolutionError('A referenced resource must retain at least one content location.');
          }
        }
        continue;
      }
      if (decision.kind === 'edit' && 'file' in decision) {
        let bytes: Buffer;
        try { bytes = Buffer.from(decision.file.content, 'base64'); }
        catch { throw new GitDomainError('VALIDATION_FAILED', 400, 'Invalid resolved file content.'); }
        if (bytes.toString('base64') !== decision.file.content) throw new GitDomainError('VALIDATION_FAILED', 400, 'Invalid resolved file content.');
        candidate.set(item.path, { oid: '', mode: trees[1]!.get(item.path)?.mode ?? trees[2]!.get(item.path)?.mode ?? '100644', bytes });
        continue;
      }
      if (decision.kind === 'edit' && 'resourceRef' in decision) {
        const resource = merged.snapshot.manifest.resources.find(value => value.digest === decision.resourceRef);
        const selected = resource?.locations.flatMap(location => resourceTrees.map(tree => tree.get(location.path)))
          .find(file => file && createHash('sha256').update(file.bytes).digest('hex') === decision.resourceRef);
        if (!selected) throw resolutionError('The selected retained resource content is unavailable.');
        candidate.set(item.path, {
          ...selected,
          mode: trees[1]!.get(item.path)?.mode ?? trees[2]!.get(item.path)?.mode ?? selected.mode,
        });
        continue;
      }
      if (decision.kind !== 'select') throw new GitDomainError('VALIDATION_FAILED', 400, 'This conflict requires a file selection or edit.');
      const index = decision.selectedSide === 'base' ? 0 : decision.selectedSide === 'local' ? 1 : 2;
      const selected = trees[index]!.get(item.path);
      if (selected) candidate.set(item.path, selected); else candidate.delete(item.path);
    }
    conflicts.length = 0;
    for (const [path, bytes] of serializePortableMetadata(merged.snapshot)) {
      candidate.set(path, { oid: '', mode: '100644', bytes: Buffer.from(bytes) });
    }
  }
  if (input.resolutions) {
    const currentIds = new Set(encountered.map(item => item.id));
    if (currentIds.size !== encountered.length || currentIds.size !== input.resolutions.length
      || input.resolutions.some(item => !currentIds.has(item.conflictId))
      || [...currentIds].some(id => !resolvedIds.has(id))) {
      throw new GitDomainError('PREVIEW_STALE', 409, 'Conflict decisions do not match the current conflict set.');
    }
  }
  if (conflicts.length) return { tree: null, conflicts };
  validateTreeEntries([...candidate].map(([path, file]) => ({ path, mode: file.mode })));
  // This checks the exact candidate metadata paths, every alias digest and legacy archive closure.
  parsePortableEntries(new Map([...candidate].map(([path, file]) => [path, file.bytes])));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  await runGit({ cwd: root, args: ['read-tree', '--empty'], env });
  for (const [path, file] of candidate) {
    const oid = file.oid || (await runGit({ cwd: root, args: ['hash-object', '-w', '--stdin'], stdin: file.bytes })).stdout.toString().trim();
    await runGit({ cwd: root, args: ['update-index', '--add', '--cacheinfo', file.mode, oid, path], env });
  }
  const tree = (await runGit({ cwd: root, args: ['write-tree'], env })).stdout.toString().trim();
  return { tree, conflicts: [] };
}
