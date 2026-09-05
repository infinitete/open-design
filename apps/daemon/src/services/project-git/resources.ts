import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { parsePortableSnapshot, type PortableSnapshot } from '@open-design/contracts';
import { GitDomainError } from './errors.js';

/** Read a regular project-owned file without granting authority through a symlink. */
export async function readPortableResource(root: string, relative: string): Promise<Uint8Array | null> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')
    || relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null;
  let current = path.resolve(root);
  try {
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) return null;
    }
    const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return (await handle.stat()).isFile() ? await handle.readFile() : null; }
    finally { await handle.close(); }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error
      && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) return null;
    throw error;
  }
}

export async function collectReferencedResources(input: {
  snapshot: PortableSnapshot;
  root: string;
  readOwnedResource: (reference: string) => Promise<Uint8Array | null>;
}): Promise<Map<string, Uint8Array>> {
  const snapshot = parsePortableSnapshot(input.snapshot);
  const result = new Map<string, Uint8Array>();
  const missing: string[] = [];
  for (const resource of snapshot.manifest.resources) {
    const paths = [...new Set(resource.locations.map(location => location.path))].sort();
    let bytes: Uint8Array | null = null;
    for (const file of paths) {
      const candidate = await readPortableResource(input.root, file) ?? await input.readOwnedResource(file);
      if (candidate && createHash('sha256').update(candidate).digest('hex') === resource.digest) { bytes = candidate; break; }
    }
    if (!bytes) missing.push(...paths);
    else for (const file of paths) result.set(file, bytes);
  }
  if (missing.length) throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409,
    'Required portable resource content is missing or corrupt', { paths: missing });
  return new Map([...result].sort(([a], [b]) => a < b ? -1 : 1));
}
