import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ownedOdNextDeviceFramePaths } from '../../od-next-device-frame-ownership.js';
import { GitDomainError } from './errors.js';

export const isCanonicalRootIdentity = (value: unknown): value is string => typeof value === 'string'
  && !value.includes('\0') && isAbsolute(value) && resolve(value) === value;

/** Trusted local identity only; an absent native store is allowed, linked ancestors are not. */
export async function nativeHistoryRoot(root: string, injected?: string, expected?: string): Promise<string> {
  const value = injected ?? root;
  if (!isCanonicalRootIdentity(value) || expected !== undefined && value !== expected) {
    throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The trusted native history root changed.');
  }
  let ancestor = value;
  for (;;) {
    try {
      if (!(await lstat(ancestor)).isDirectory() || await realpath(ancestor) !== ancestor) throw new GitDomainError('VALIDATION_FAILED', 400, 'Native history root must be canonical.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
}

/** Native single-file history is local evidence, not newly discovered project content. */
export const isNativeProjectHistoryPath = (path: string): boolean => path.split('/').some(part => part.normalize('NFC').toLowerCase() === '.file-versions');

/** Daemon-owned root artifacts are excluded only while untracked. Tracked copies remain project content. */
export const isUntrackedDaemonRuntimeProjectPath = (path: string): boolean => {
  const normalized = path.normalize('NFC').toLowerCase();
  if (normalized === '.mcp.json'
    || normalized === '.transcript.jsonl'
    || normalized === '.transcript.lock'
    || normalized === '.finalize.lock'
    || /^\.transcript\.jsonl\.tmp\.\d+\.[a-f0-9]+$/u.test(normalized)
    || /^design\.md\.tmp\.\d+\.[a-f0-9]+$/u.test(normalized)) return true;
  const parts = normalized.split('/');
  return parts.length > 1 && ['.od-skills', '.pi'].includes(parts[0]!);
};

/** Existing tracked history stays tracked; only untracked native archives are excluded. */
export function projectGitPaths(tracked: readonly string[], untracked: readonly string[]): string[] {
  return [...new Set([...tracked, ...untracked.filter(path =>
    !isNativeProjectHistoryPath(path) && !isUntrackedDaemonRuntimeProjectPath(path))])].sort();
}

/** Root-aware filtering for local inventories; tracked content is never excluded. */
export async function projectGitPathsAtRoot(
  root: string,
  tracked: readonly string[],
  untracked: readonly string[],
): Promise<string[]> {
  const ownedFrames = untracked.some(path => path.startsWith('.od-frames/'))
    ? await ownedOdNextDeviceFramePaths(root)
    : new Set<string>();
  return [...new Set([
    ...tracked,
    ...projectGitPaths([], untracked).filter(path => !ownedFrames.has(path)),
  ])].sort();
}
