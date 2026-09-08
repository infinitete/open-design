import type Database from 'better-sqlite3';
import type { JsonValue } from '@open-design/contracts';
import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { getProject } from '../../db.js';
import { getSnapshot } from '../../plugins/snapshots.js';
import { canonicalJson } from './portable.js';
import { readPortableResource } from './resources.js';
import { isPrivateProjectGitPath } from './checkpoint.js';
import { stripPrefixAndValidateId } from '../../design-systems/index.js';

async function packageContent(root: string, id: string, kind: 'skill' | 'design-system'): Promise<Uint8Array | null> {
  try { if (await realpath(root) !== root) return null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const assets: Array<{ path: string; encoding: 'base64'; content: string; sha256: string }> = [];
  async function collect(directory: string): Promise<boolean> {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      // Match the design-system shareable tree, excluding registry state.
      // Design token files are public content, unlike authentication tokens.
      const designTokens = kind === 'design-system' && /^tokens(?:\.[a-z0-9-]+)*\.(?:css|json)$/iu.test(entry.name);
      if (entry.name.startsWith('.') || (!directory && ['metadata.json', 'revisions'].includes(entry.name))
        || isPrivateProjectGitPath(directory) || (!designTokens && isPrivateProjectGitPath(entry.name))) continue;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) { if (!await collect(path)) return false; continue; }
      const bytes = await readPortableResource(root, path);
      if (!bytes) return false;
      assets.push({ path, encoding: 'base64', content: Buffer.from(bytes).toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return true;
  }
  if (!await collect('') || !assets.length) return null;
  assets.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return Buffer.from(canonicalJson({ schemaVersion: 1, kind, id, assets }));
}

function relativeAsset(value: string): string | null {
  const path = value.startsWith('./') ? value.slice(2) : value;
  return path && !isPrivateProjectGitPath(path) && !path.split('/').includes('.git')
    && !isAbsolute(path) && !/^[a-z]:/iu.test(path) && !/[\\\0]/u.test(path)
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..') ? path : null;
}

/** Native snapshots are local authority; imported resource blobs never enter this lookup. */
export function createProjectGitOwnedResourceReader({ db, designSystemRoots, skillRoots }: {
  db: Database.Database; designSystemRoots?: { builtIn: string; user: string }; skillRoots?: { builtIn: string; user: string };
}) {
  return async (projectId: string, reference: string): Promise<Uint8Array | null> => {
    const project = getProject(db, projectId);
    if (!project) return null;
    if (designSystemRoots && project.designSystemId && reference === `design-system:${projectId}:${project.designSystemId}`) {
      const id = project.designSystemId;
      const user = id.startsWith('user:');
      const directoryId = stripPrefixAndValidateId(id, user ? 'user:' : '');
      if (!directoryId) return null;
      return packageContent(resolve(user ? designSystemRoots.user : designSystemRoots.builtIn, directoryId), id, 'design-system');
    }
    const skillPrefix = `skill:${projectId}:`;
    if (skillRoots && reference.startsWith(skillPrefix)) {
      const id = reference.slice(skillPrefix.length);
      const user = id.startsWith('user:');
      const directoryId = stripPrefixAndValidateId(id, user ? 'user:' : '');
      if (!directoryId) return null;
      const referenced = project.skillId === id || db.prepare(`SELECT 1 FROM messages m
        JOIN conversations c ON c.id = m.conversation_id, json_each(m.run_context_json, '$.skillIds') skill
        WHERE c.project_id = ? AND skill.value = ? LIMIT 1`).get(projectId, id);
      if (!referenced) return null;
      if (user) return packageContent(resolve(skillRoots.user, directoryId), id, 'skill');
      return await packageContent(resolve(skillRoots.builtIn, directoryId), id, 'skill')
        ?? packageContent(resolve(skillRoots.user, directoryId), id, 'skill');
    }
    const candidates = [
      ...(project.appliedPluginSnapshotId ? [{ reference: `plugin:${projectId}:${project.appliedPluginSnapshotId}`, snapshotId: project.appliedPluginSnapshotId }] : []),
      ...(project.metadata?.scenarioBinding ? [{ reference: `scenario:${projectId}:${project.metadata.scenarioBinding.pluginId}`, snapshotId: project.metadata.scenarioBinding.snapshotId }] : []),
    ];
    const selected = candidates.find(candidate => candidate.reference === reference);
    if (!selected || !db.prepare('SELECT 1 FROM applied_plugin_snapshots WHERE id = ? AND project_id = ?').get(selected.snapshotId, projectId)) return null;
    const snapshot = getSnapshot(db, selected.snapshotId);
    if (!snapshot) return null;
    const declarations: Array<{ path: string; source: string }> = [
      ...snapshot.resolvedContext.items.flatMap(item => item.kind === 'asset' ? [{ path: item.path, source: item.path }] : []),
      ...snapshot.assetsStaged.map(asset => ({ path: asset.path, source: asset.src ?? asset.path })),
    ];
    if (!declarations.length) return null;
    const source = snapshot.resolvedSource;
    if (!source || !isAbsolute(source)) return null;
    const root = resolve(source);
    try { if (await realpath(root) !== root) return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const assets = new Map<string, { path: string; encoding: 'base64'; content: string; sha256: string }>();
    for (const declaration of declarations) {
      const path = relativeAsset(declaration.path); const sourcePath = relativeAsset(declaration.source);
      if (!path || !sourcePath) return null;
      const bytes = await readPortableResource(root, sourcePath);
      if (!bytes) return null;
      const asset = { path, encoding: 'base64' as const, content: Buffer.from(bytes).toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
      if (assets.has(path) && assets.get(path)!.sha256 !== asset.sha256) return null;
      assets.set(path, asset);
    }
    const fragments = snapshot.resolvedContext.promptFragments ?? {};
    if (Object.values(fragments).some(value => typeof value !== 'string')) return null;
    const content: Record<string, JsonValue> = { schemaVersion: 1, pluginId: snapshot.pluginId, pluginVersion: snapshot.pluginVersion,
      promptFragments: fragments, assets: [...assets.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    if (snapshot.pluginTitle !== undefined) content.pluginTitle = snapshot.pluginTitle;
    if (snapshot.pluginDescription !== undefined) content.pluginDescription = snapshot.pluginDescription;
    return Buffer.from(canonicalJson(content));
  };
}
