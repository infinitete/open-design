import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, insertConversation, insertProject, listMessages, openDatabase, upsertMessage } from '../../src/db.js';
import { createBrandDir } from '../../src/brands/store.js';
import { recoverLegacyBrandTranscriptsAtStartup } from '../../src/runtimes/legacy-brand-transcript-recovery.js';

describe('legacy brand transcript startup recovery', () => {
  let root: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-brand-transcript-recovery-'));
    db = openDatabase(root, { dataDir: root });
  });
  afterEach(async () => {
    closeDatabase();
    await rm(root, { recursive: true, force: true });
  });

  function seed(id: string, withMessage = false) {
    const projectId = `brand-${id}`;
    const conversationId = `conversation-${id}`;
    insertProject(db, {
      id: projectId, name: id, createdAt: 10, updatedAt: 10,
      metadata: { kind: 'brand', importedFrom: 'brand-extraction', brandId: id, brandSourceUrl: 'https://example.test' },
    });
    insertConversation(db, {
      id: conversationId, projectId, title: null, sessionMode: 'design', createdAt: 10, updatedAt: 10,
    });
    createBrandDir(path.join(root, 'brands'), id, {
      id, projectId, extractionConversationId: conversationId,
      sourceUrl: 'https://example.test', status: 'extracting', createdAt: 10, updatedAt: 10,
    } as never);
    if (withMessage) upsertMessage(db, conversationId, { id: `message-${id}`, role: 'user', content: 'existing' });
    return { projectId, conversationId };
  }

  it('repairs an exact empty candidate through startup coordination', async () => {
    const candidate = seed('acme');
    const repairIfNeeded = vi.fn(async (input: any) => {
      expect(await input.recheck()).toBe(true);
      return { mutated: true, value: await input.work() };
    });
    await expect(recoverLegacyBrandTranscriptsAtStartup({
      db,
      brandsRoot: path.join(root, 'brands'),
      projectsRoot: path.join(root, 'projects'),
      coordination: { repairIfNeeded },
      randomId: (() => { let id = 0; return () => `repair-${id += 1}`; })(),
    })).resolves.toMatchObject({ repaired: 1, failed: 0 });
    expect(repairIfNeeded).toHaveBeenCalledWith(expect.objectContaining({
      projectId: candidate.projectId,
      source: 'legacy-brand-transcript-recovery',
    }));
    expect(listMessages(db, candidate.conversationId).map(message => message.role))
      .toEqual(['user', 'assistant']);
  });

  it('skips non-empty conversations without entering mutation coordination', async () => {
    seed('existing', true);
    const repairIfNeeded = vi.fn();
    await expect(recoverLegacyBrandTranscriptsAtStartup({
      db,
      brandsRoot: path.join(root, 'brands'),
      projectsRoot: path.join(root, 'projects'),
      coordination: { repairIfNeeded },
      randomId: () => 'unused',
    })).resolves.toMatchObject({ repaired: 0, failed: 0 });
    expect(repairIfNeeded).not.toHaveBeenCalled();
  });

  it('isolates one project failure and repairs the next candidate', async () => {
    const failed = seed('failed');
    const healthy = seed('healthy');
    const repairIfNeeded = vi.fn(async (input: any) => {
      if (input.projectId === failed.projectId) throw new Error('repair failed');
      if (!await input.recheck()) return { mutated: false as const };
      return { mutated: true as const, value: await input.work() };
    });
    await expect(recoverLegacyBrandTranscriptsAtStartup({
      db,
      brandsRoot: path.join(root, 'brands'),
      projectsRoot: path.join(root, 'projects'),
      coordination: { repairIfNeeded },
      randomId: (() => { let id = 0; return () => `repair-${id += 1}`; })(),
      onError: vi.fn(),
    })).resolves.toMatchObject({ repaired: 1, failed: 1 });
    expect(listMessages(db, failed.conversationId)).toEqual([]);
    expect(listMessages(db, healthy.conversationId)).toHaveLength(2);
  });
});
