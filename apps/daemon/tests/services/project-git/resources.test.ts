import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortableSnapshot } from '@open-design/contracts';
import { collectReferencedResources } from '../../../src/services/project-git/resources.js';

const bytes = Buffer.from('owned attachment');
const digest = createHash('sha256').update(bytes).digest('hex');
const resourcePath = `.open-design/resources/${digest}/content`;
function snapshot(): PortableSnapshot {
  return { manifest: { schemaVersion: 1, repositoryProjectId: 'project', resources: [
    { digest, locations: [{ path: resourcePath, purpose: 'attachment' }], references: ['project'] },
  ] }, project: { schemaVersion: 1, name: 'Project', createdAt: 1, kind: 'prototype',
    preferences: {}, contentRefs: [digest], linkedFolderRequirements: [] }, conversations: [], messages: [] };
}
describe('referenced portable resources', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  async function root() { const value = await mkdtemp(join(tmpdir(), 'od-portable-resources-')); roots.push(value); return value; }
  it('retains deleted workspace attachments from the digest copy', async () => {
    const dir = await root();
    await mkdir(join(dir, '.open-design/resources', digest), { recursive: true });
    await writeFile(join(dir, resourcePath), bytes);
    const result = await collectReferencedResources({ snapshot: snapshot(), root: dir,
      readOwnedResource: async () => { throw new Error('must use retained bytes'); } });
    expect(Buffer.from(result.get(resourcePath)!)).toEqual(bytes);
  });
  it('reads only the declared resource through the injected reader', async () => {
    const requests: string[] = [];
    const result = await collectReferencedResources({ snapshot: snapshot(), root: await root(),
      readOwnedResource: async reference => { requests.push(reference); return bytes; } });
    expect(requests).toEqual([resourcePath]);
    expect(Buffer.from(result.get(resourcePath)!)).toEqual(bytes);
  });
  it('reports missing or corrupt mandatory bytes with safe paths', async () => {
    const dir = await root();
    for (const value of [null, Buffer.from('wrong content')]) {
      await expect(collectReferencedResources({ snapshot: snapshot(), root: dir,
        readOwnedResource: async () => value })).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_MISSING',
        details: { paths: [resourcePath] } });
    }
  });
  it('never follows a project resource symlink outside the supplied root', async () => {
    const dir = await root(); const outside = await root();
    await mkdir(join(outside, digest), { recursive: true });
    await writeFile(join(outside, digest, 'content'), bytes);
    await mkdir(join(dir, '.open-design'));
    await symlink(outside, join(dir, '.open-design/resources'));
    await expect(collectReferencedResources({ snapshot: snapshot(), root: dir,
      readOwnedResource: async () => null })).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_MISSING' });
  });
  it('preserves legacy manifest and HTML bytes without claiming a complete historical project', async () => {
    const legacy = snapshot();
    const files = new Map([
      ['.open-design/legacy-file-history/old/manifest.json', Buffer.from('{ "entries": [] }\r\n')],
      ['.open-design/legacy-file-history/old/v1.html', Buffer.from([0xef, 0xbb, 0xbf, 60, 104, 49, 62, 13, 10])],
    ]);
    legacy.manifest.resources = [...files].map(([file, content]) => ({
      digest: createHash('sha256').update(content).digest('hex'), locations: [{ path: file,
        purpose: 'legacy-history' }], references: ['project'],
    }));
    legacy.project.contentRefs = legacy.manifest.resources.map(resource => resource.digest);
    const result = await collectReferencedResources({ snapshot: legacy, root: await root(),
      readOwnedResource: async reference => files.get(reference) ?? null });
    expect([...result].map(([file, content]) => [file, Buffer.from(content)])).toEqual([...files]);
  });
  it('regenerates missing physical aliases from one retained digest copy', async () => {
    const value = snapshot(); const alias = '.open-design/legacy-file-history/old/one.html';
    value.manifest.resources[0]!.locations.push({ path: alias, purpose: 'legacy-history' });
    const dir = await root(); await mkdir(join(dir, '.open-design/resources', digest), { recursive: true });
    await writeFile(join(dir, resourcePath), bytes);
    const result = await collectReferencedResources({ snapshot: value, root: dir, readOwnedResource: async () => null });
    expect(Buffer.from(result.get(resourcePath)!)).toEqual(bytes);
    expect(Buffer.from(result.get(alias)!)).toEqual(bytes);
  });
});
