import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  getProject,
  insertProject,
  openDatabase,
  retireVelaProjectMetadata,
} from '../src/db.js';

// Startup retirement of persisted model selections minted by the retired
// cloud provider. The one-time migration must drop only the two
// reserved-prefixed model fields from project metadata, leave every
// neighbouring field and the modification timestamp untouched, and settle
// into a no-op on every later startup.

describe('retireVelaProjectMetadata', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-retired-vela-metadata-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedLegacyProjects(): number {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, {
      id: 'proj-image-retired-provider',
      name: 'Image project',
      createdAt: now,
      updatedAt: now,
      metadata: { kind: 'image', imageModel: 'vela/image-pro', imageAspect: '16:9', keep: true },
    });
    insertProject(db, {
      id: 'proj-video-retired-provider',
      name: 'Video project',
      createdAt: now,
      updatedAt: now,
      metadata: { kind: 'video', videoModel: 'vela/video-pro', videoLength: 5, keep: true },
    });
    insertProject(db, {
      id: 'proj-image-live-provider',
      name: 'Live provider project',
      createdAt: now,
      updatedAt: now,
      metadata: { kind: 'image', imageModel: 'gpt-image-2', keep: true },
    });
    closeDatabase();
    return now;
  }

  it('drops retired-provider model fields at startup, keeps the rest, and settles', () => {
    const seededAt = seedLegacyProjects();

    const first = openDatabase(tempDir, { dataDir: tempDir });

    const image = getProject(first, 'proj-image-retired-provider');
    expect(image?.metadata).toEqual({ kind: 'image', imageAspect: '16:9', keep: true });
    const video = getProject(first, 'proj-video-retired-provider');
    expect(video?.metadata).toEqual({ kind: 'video', videoLength: 5, keep: true });
    const live = getProject(first, 'proj-image-live-provider');
    expect(live?.metadata).toEqual({ kind: 'image', imageModel: 'gpt-image-2', keep: true });

    // Retirement must not look like a user edit: updated_at is preserved.
    expect(image?.updatedAt).toBe(seededAt);
    expect(video?.updatedAt).toBe(seededAt);

    // Second open: nothing left to retire and the stored rows are stable.
    closeDatabase();
    const second = openDatabase(tempDir, { dataDir: tempDir });
    expect(retireVelaProjectMetadata(second)).toBe(0);
    expect(getProject(second, 'proj-image-retired-provider')?.metadata)
      .toEqual({ kind: 'image', imageAspect: '16:9', keep: true });
    expect(getProject(second, 'proj-video-retired-provider')?.metadata)
      .toEqual({ kind: 'video', videoLength: 5, keep: true });
    expect(getProject(second, 'proj-image-live-provider')?.metadata)
      .toEqual({ kind: 'image', imageModel: 'gpt-image-2', keep: true });
  });

  it('leaves malformed historical metadata untouched', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'proj-broken', name: 'Broken', createdAt: now, updatedAt: now, metadata: {} });
    insertProject(db, { id: 'proj-array', name: 'Array', createdAt: now, updatedAt: now, metadata: {} });
    db.prepare(`UPDATE projects SET metadata_json = ? WHERE id = ?`).run('{not json', 'proj-broken');
    db.prepare(`UPDATE projects SET metadata_json = ? WHERE id = ?`).run('[1,2]', 'proj-array');

    expect(retireVelaProjectMetadata(db)).toBe(0);

    const rawMetadata = (id: string): unknown =>
      (db.prepare(`SELECT metadata_json AS metadataJson FROM projects WHERE id = ?`).get(id) as
        | { metadataJson: unknown }
        | undefined)?.metadataJson;
    expect(rawMetadata('proj-broken')).toBe('{not json');
    expect(rawMetadata('proj-array')).toBe('[1,2]');
  });
});
