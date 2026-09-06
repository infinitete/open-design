import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { OD_NEXT_DEVICE_FRAME_ROOT, OD_NEXT_MANAGED_RESOURCE_FILES } from '@open-design/contracts';

export const OD_NEXT_DEVICE_FRAME_MANIFEST = '.od-next-device-frames.json' as const;
export const OD_NEXT_DEVICE_FRAME_MANIFEST_SCHEMA = 'open-design.od-next-device-frames/v1' as const;
export const OD_NEXT_MANAGED_SHELL_FILES: ReadonlySet<string> = new Set(OD_NEXT_MANAGED_RESOURCE_FILES);

export interface OdNextDeviceFrameManifestV1 {
  schema: typeof OD_NEXT_DEVICE_FRAME_MANIFEST_SCHEMA;
  files: Record<string, string>;
}

export type OdNextDeviceFrameOwnership =
  | { kind: 'absent' }
  | { kind: 'ours'; files: Record<string, string> }
  | { kind: 'foreign' };

export function odNextDeviceFrameDigest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function readOdNextDeviceFrameOwnership(root: string): Promise<OdNextDeviceFrameOwnership> {
  const target = path.join(root, OD_NEXT_DEVICE_FRAME_MANIFEST);
  const info = await lstat(target).catch(() => null);
  if (!info) return { kind: 'absent' };
  if (info.isSymbolicLink() || !info.isFile()) return { kind: 'foreign' };
  let raw: string;
  try { raw = await readFile(target, 'utf8'); } catch { return { kind: 'foreign' }; }
  let parsed: Partial<OdNextDeviceFrameManifestV1> | null;
  try { parsed = JSON.parse(raw) as Partial<OdNextDeviceFrameManifestV1> | null; }
  catch { return { kind: 'foreign' }; }
  if (parsed?.schema !== OD_NEXT_DEVICE_FRAME_MANIFEST_SCHEMA
    || typeof parsed.files !== 'object' || !parsed.files || Array.isArray(parsed.files)) return { kind: 'foreign' };
  const files: Record<string, string> = {};
  for (const [name, digest] of Object.entries(parsed.files)) {
    if (!OD_NEXT_MANAGED_SHELL_FILES.has(name) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) {
      return { kind: 'foreign' };
    }
    files[name] = digest;
  }
  return { kind: 'ours', files };
}

/** Returns only untracked paths whose current bytes prove daemon ownership. */
export async function ownedOdNextDeviceFramePaths(projectRoot: string): Promise<ReadonlySet<string>> {
  const root = path.join(projectRoot, OD_NEXT_DEVICE_FRAME_ROOT);
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return new Set();
  const ownership = await readOdNextDeviceFrameOwnership(root);
  if (ownership.kind !== 'ours') return new Set();
  const owned = new Set<string>([`${OD_NEXT_DEVICE_FRAME_ROOT}/${OD_NEXT_DEVICE_FRAME_MANIFEST}`]);
  for (const [name, expectedDigest] of Object.entries(ownership.files)) {
    const target = path.join(root, name);
    const info = await lstat(target).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isFile()) continue;
    let bytes: Buffer;
    try { bytes = await readFile(target); } catch { continue; }
    if (odNextDeviceFrameDigest(bytes) === expectedDigest) owned.add(`${OD_NEXT_DEVICE_FRAME_ROOT}/${name}`);
  }
  return owned;
}
