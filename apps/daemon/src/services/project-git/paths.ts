import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
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

/** Existing tracked history stays tracked; only untracked native archives are excluded. */
export function projectGitPaths(tracked: readonly string[], untracked: readonly string[]): string[] {
  return [...new Set([...tracked, ...untracked.filter(path => !isNativeProjectHistoryPath(path))])].sort();
}
