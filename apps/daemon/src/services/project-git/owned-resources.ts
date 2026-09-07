import type Database from 'better-sqlite3';
import type { JsonValue } from '@open-design/contracts';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { getProject } from '../../db.js';
import { getSnapshot } from '../../plugins/snapshots.js';
import { canonicalJson } from './portable.js';
import { readPortableResource } from './resources.js';
import { isPrivateProjectGitPath } from './checkpoint.js';

function relativeAsset(value: string): string | null {
  const path = value.startsWith('./') ? value.slice(2) : value;
  return path && !isPrivateProjectGitPath(path) && !path.split('/').includes('.git')
    && !isAbsolute(path) && !/^[a-z]:/iu.test(path) && !/[\\\0]/u.test(path)
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..') ? path : null;
}

/** Native snapshots are local authority; imported resource blobs never enter this lookup. */
export function createProjectGitOwnedResourceReader({ db }: { db: Database.Database }) {
  return async (projectId: string, reference: string): Promise<Uint8Array | null> => {
    const project = getProject(db, projectId);
    if (!project) return null;
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
