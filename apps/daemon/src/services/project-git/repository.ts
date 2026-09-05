import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GitDomainError } from './errors.js';
import { runGit } from './git-process.js';

function invalid(message: string): never {
  throw new GitDomainError('VALIDATION_FAILED', 400, message);
}

/** Input is a location, never a remote alias, shell fragment, or transport helper. */
export function validateRemote(raw: string): string {
  if (!raw || /[\s\x00-\x1f\x7f]/u.test(raw) || raw.startsWith('-')) invalid('Invalid Git remote.');
  if (raw.includes('://')) {
    let url: URL;
    try { url = new URL(raw); } catch { return invalid('Invalid Git remote.'); }
    if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.hostname.startsWith('-') || url.password
      || (url.protocol === 'https:' && url.username) || url.search || url.hash
      || url.pathname === '/' || /%00|%0a|%0d/iu.test(raw)) invalid('Use a credential-free HTTPS or SSH Git remote.');
    return raw;
  }
  if (!/^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*:[^/\s-][^\s]*$/u.test(raw)
    || raw.includes('::') || /^[a-zA-Z]:/u.test(raw) || /[?#\\]/u.test(raw)) invalid('Use a credential-free HTTPS or SSH Git remote.');
  return raw;
}

export function redactGitText(value: string): string {
  return value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/([?&](?:[^=&\s]*(?:token|password|secret|key)[^=&\s]*)=)[^&#\s]*/giu, '$1[redacted]')
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/giu, '$1[redacted]')
    .replace(/((?:password|passwd|token|secret|credential)\s*[=:]\s*)[^\s]+/giu, '$1[redacted]');
}

export async function validateBranch(value: string): Promise<string> {
  if (!value || value === 'HEAD' || value.startsWith('-') || /[\x00-\x20\x7f]/u.test(value) || value.includes('@{')) invalid('Invalid Git branch.');
  try {
    await runGit({ cwd: process.cwd(), args: ['check-ref-format', '--branch', value] });
  } catch { return invalid('Invalid Git branch.'); }
  return value;
}

export async function resolveCommit(root: string, oid: string): Promise<string> {
  if (!/^[a-fA-F0-9]{4,}$/u.test(oid)) invalid('Expected a Git commit object ID.');
  try {
    const type = await runGit({ cwd: root, args: ['cat-file', '-t', oid] });
    if (type.stdout.toString().trim() !== 'commit') invalid('Expected a Git commit object ID.');
    return (await runGit({ cwd: root, args: ['rev-parse', '--verify', '--end-of-options', oid] })).stdout.toString().trim();
  } catch (error) {
    if (error instanceof GitDomainError && error.code === 'GIT_UNAVAILABLE') throw error;
    return invalid('Git commit object is unavailable.');
  }
}

export async function discoverRepository(cwd: string): Promise<{
  root: string; commonDir: string; gitDir: string; branch: string | null; head: string | null;
}> {
  const read = async (...args: string[]) => (await runGit({ cwd, args })).stdout.toString().trim();
  const root = await realpath(await read('rev-parse', '--show-toplevel'));
  if (root !== await realpath(cwd)) invalid('The project directory must be the repository root.');
  const commonDir = await realpath(resolve(cwd, await read('rev-parse', '--git-common-dir')));
  const gitDir = await realpath(resolve(cwd, await read('rev-parse', '--git-dir')));
  let branch: string | null = null;
  let head: string | null = null;
  try { branch = await read('symbolic-ref', '--quiet', '--short', 'HEAD'); }
  catch (error) { if (!(error instanceof GitDomainError) || error.details?.exitCode !== 1) throw error; }
  try { head = await read('rev-parse', '--verify', '--quiet', 'HEAD'); }
  catch (error) { if (!(error instanceof GitDomainError) || error.details?.exitCode !== 1) throw error; }
  return { root, commonDir, gitDir, branch, head };
}

export async function discoverObjectStore(cwd: string): Promise<{ objectDirectory: string; objectFormat: 'sha1' | 'sha256' }> {
  const format = (await runGit({ cwd, args: ['rev-parse', '--show-object-format'] })).stdout.toString().trim();
  if (format !== 'sha1' && format !== 'sha256') {
    throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'The Git object format is unsupported.', { nextStep: 'Use a supported Git object format.' });
  }
  const common = (await runGit({ cwd, args: ['rev-parse', '--git-common-dir'] })).stdout.toString().trim();
  return { objectDirectory: await realpath(join(resolve(cwd, common), 'objects')), objectFormat: format };
}

/** Validate the whole tree before writing any files; symlink traversal is never materialized. */
export function validateTreeEntries(entries: readonly { path: string; mode: string }[]): void {
  const paths = new Map<string, string>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    if (!entry.path || /[\\\x00-\x1f\x7f:<>"|?*\p{Cf}]/u.test(entry.path) || parts.some(part => !part || part === '.' || part === '..'
      || /[. ]$/u.test(part) || /^(?:\.git|git~\d+)$/iu.test(part)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) invalid('The Git tree contains an unsafe file path.');
    if (!['100644', '100755', '040000', '40000'].includes(entry.mode)) {
      throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'The Git tree requires unsupported linked content.', { path: entry.path, nextStep: 'Resolve linked content before restoring.' });
    }
    const normalized = entry.path.normalize('NFC').toLowerCase();
    if (paths.has(normalized)) invalid('The Git tree contains colliding file paths.');
    paths.set(normalized, entry.mode);
  }
  for (const name of paths.keys()) {
    const parts = name.split('/');
    parts.pop();
    while (parts.length) {
      const mode = paths.get(parts.join('/'));
      if (mode && !['040000', '40000'].includes(mode)) invalid('The Git tree contains colliding file paths.');
      parts.pop();
    }
  }
}
