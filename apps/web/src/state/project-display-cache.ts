import type { Project } from '../types';

export type ProjectDisplayView = 'all' | 'recent' | 'drafts' | 'team';

export interface ProjectDisplaySnapshotScope {
  view: ProjectDisplayView | undefined;
}

export interface ProjectDisplaySnapshot {
  projects: Project[];
  dirty: boolean;
}

interface StoredProjectDisplaySnapshot extends ProjectDisplaySnapshot {
  view: ProjectDisplayView | undefined;
}

export const MAX_PROJECT_DISPLAY_SNAPSHOTS = 24;

const snapshots = new Map<string, StoredProjectDisplaySnapshot>();

export function projectDisplaySnapshotKey(scope: ProjectDisplaySnapshotScope): string {
  return [
    'project-display',
    scope.view ?? 'recent',
  ].join(':');
}

export function readProjectDisplaySnapshot(key: string): ProjectDisplaySnapshot | null {
  const snapshot = snapshots.get(key);
  if (!snapshot) return null;
  // Map insertion order is the LRU order. Touch exact-key hits without ever
  // allowing one view key to answer another.
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  return {
    projects: snapshot.projects,
    dirty: snapshot.dirty,
  };
}

export function writeProjectDisplaySnapshot(
  scope: ProjectDisplaySnapshotScope,
  projects: Project[],
): void {
  const key = projectDisplaySnapshotKey(scope);
  const snapshot: StoredProjectDisplaySnapshot = {
    view: scope.view,
    projects,
    dirty: false,
  };
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > MAX_PROJECT_DISPLAY_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (!oldest) break;
    snapshots.delete(oldest);
  }
}

/**
 * A successful local mutation makes every projection stale. Keep the last-good
 * display value for SWR, but flag it dirty so the next render refetches.
 */
export function markProjectDisplaySnapshotsDirty(): void {
  for (const snapshot of snapshots.values()) {
    snapshot.dirty = true;
  }
}

export function patchProjectDisplaySnapshots(input: {
  patch: (projects: Project[], view: ProjectDisplayView | undefined) => Project[];
}): void {
  for (const snapshot of snapshots.values()) {
    snapshot.projects = input.patch(snapshot.projects, snapshot.view);
    snapshot.dirty = true;
  }
}

export function removeProjectFromDisplaySnapshots(input: {
  projectId: string;
}): void {
  patchProjectDisplaySnapshots({
    patch: (projects) => projects.filter((project) => project.id !== input.projectId),
  });
}

export function resetProjectDisplaySnapshots(): void {
  snapshots.clear();
}

export function projectDisplaySnapshotCount(): number {
  return snapshots.size;
}
