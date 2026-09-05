import { ProjectGitBindingPreviewSchema, ProjectGitDependencySchema, ProjectGitPreviewSchema } from '@open-design/contracts';
import type { ProjectGitBasis, ProjectGitBindingPreview, ProjectGitChangeSummary, ProjectGitDependency } from '@open-design/contracts';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectGitJournalRecord } from '../../storage/project-git.js';
import { isPrivateProjectGitPath } from './checkpoint.js';
import { GitDomainError } from './errors.js';
import { readBytes, sha256, within } from './recovery.js';
import { validateTreeEntries } from './repository.js';
import { isCanonicalRootIdentity } from './paths.js';

export interface BindingCapture {
  nativeLegacyRoot?: string;
  root: string; localBranch: string; repositoryProjectId: string; cloneId: string; basis: ProjectGitBasis;
  git: { root: string; commonDir: string; gitDir: string; branch: string | null; head: string | null } | null;
  entries: [string, string][]; sourceDigests: Record<string, string>; sourceModes: Record<string, string>;
  inventory: [string, 'symlink' | 'directory' | 'file' | 'unsupported', number][];
  digest: string; changes: ProjectGitChangeSummary; dependencies: ProjectGitDependency[]; availabilityDependencies?: ProjectGitDependency[];
  bindingTarget?: { url: string; branch: string; remoteHead: string | null; preview: ProjectGitBindingPreview;
    changes?: ProjectGitChangeSummary; candidate?: { candidateOid: string; publicationMode: 'commit' | 'fast_forward' } | null };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const shape = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => object(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string');
const oid = (value: unknown) => value === null || typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
function validCapture(value: unknown): value is BindingCapture {
  if (!shape(value, ['root', 'localBranch', 'repositoryProjectId', 'cloneId', 'basis', 'git', 'entries', 'sourceDigests', 'sourceModes',
    'inventory', 'digest', 'changes', 'dependencies'], ['availabilityDependencies', 'bindingTarget', 'nativeLegacyRoot'])
    || value.nativeLegacyRoot !== undefined && !isCanonicalRootIdentity(value.nativeLegacyRoot)
    || !strings(value, ['root', 'localBranch', 'repositoryProjectId', 'cloneId', 'digest'])
    || !/^[a-f0-9]{64}$/u.test(value.digest as string) || !ProjectGitPreviewSchema.shape.basis.safeParse(value.basis).success
    || !ProjectGitPreviewSchema.shape.changes.safeParse(value.changes).success
    || !Array.isArray(value.dependencies) || !value.dependencies.every(item => ProjectGitDependencySchema.safeParse(item).success)
    || value.availabilityDependencies !== undefined && (!Array.isArray(value.availabilityDependencies)
      || !value.availabilityDependencies.every(item => ProjectGitDependencySchema.safeParse(item).success))) return false;
  if (value.git !== null && (!shape(value.git, ['root', 'commonDir', 'gitDir', 'branch', 'head'])
    || !strings(value.git, ['root', 'commonDir', 'gitDir']) || !(value.git.branch === null || typeof value.git.branch === 'string') || !oid(value.git.head))) return false;
  if (!Array.isArray(value.entries) || !value.entries.every(item => Array.isArray(item) && item.length === 2 && item.every(part => typeof part === 'string'))
    || !Array.isArray(value.inventory) || !value.inventory.every(item => Array.isArray(item) && item.length === 3 && typeof item[0] === 'string'
      && ['symlink', 'directory', 'file', 'unsupported'].includes(item[1]) && Number.isInteger(item[2]))
    || !object(value.sourceDigests) || !Object.values(value.sourceDigests).every(item => typeof item === 'string' && /^(?:missing|[a-f0-9]{64})$/u.test(item))
    || !object(value.sourceModes) || !Object.values(value.sourceModes).every(item => ['0', '100644', '100755'].includes(item as string))
    || Object.keys(value.sourceDigests).sort().join('\0') !== Object.keys(value.sourceModes).sort().join('\0')) return false;
  const target = value.bindingTarget;
  if (target !== undefined) {
    if (!shape(target, ['url', 'branch', 'remoteHead', 'preview'], ['changes', 'candidate']) || !strings(target, ['url', 'branch'])
      || !oid(target.remoteHead) || !ProjectGitBindingPreviewSchema.safeParse(target.preview).success
      || target.changes !== undefined && !ProjectGitPreviewSchema.shape.changes.safeParse(target.changes).success) return false;
    if (target.candidate !== undefined && target.candidate !== null && (!shape(target.candidate, ['candidateOid', 'publicationMode'])
      || typeof target.candidate.candidateOid !== 'string' || !oid(target.candidate.candidateOid)
      || !['commit', 'fast_forward'].includes(target.candidate.publicationMode as string))) return false;
  }
  return true;
}

export async function readBindingEvidence(operationRoot: string, operation: ProjectGitJournalRecord): Promise<BindingCapture> {
  const payload = operation.payload as { evidencePath?: unknown; evidenceDigest?: unknown };
  const fail = () => new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The original project preview changed.');
  if (!payload || typeof payload.evidencePath !== 'string' || !/^binding-[a-zA-Z0-9-]+\.json$/u.test(payload.evidencePath)
    || typeof payload.evidenceDigest !== 'string' || operationRoot !== await realpath(operationRoot)) throw fail();
  const path = join(operationRoot, payload.evidencePath);
  if (!within(operationRoot, path) || await realpath(path) !== path || (await lstat(path)).isSymbolicLink()) throw fail();
  const bytes = await readBytes(path); if (!bytes || sha256(bytes) !== payload.evidenceDigest) throw fail();
  const parsed: unknown = JSON.parse(bytes.toString('utf8')); if (!validCapture(parsed)) throw fail(); return parsed;
}

export async function rootInventory(root: string): Promise<BindingCapture['inventory']> {
  const result: BindingCapture['inventory'] = [];
  async function visit(directory: string) {
    for (const name of (await readdir(join(root, directory))).sort()) {
      if (!directory && name === '.git') continue;
      const path = directory ? `${directory}/${name}` : name; validateTreeEntries([{ path, mode: '100644' }]);
      const info = await lstat(join(root, path));
      const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unsupported';
      result.push([path, kind, info.mode]);
      if (result.length > 100_000) throw new GitDomainError('VALIDATION_FAILED', 400, 'Project inventory exceeds its supported size.');
      if (kind === 'directory' && !isPrivateProjectGitPath(path)) await visit(path);
    }
  }
  await visit(''); return result;
}
