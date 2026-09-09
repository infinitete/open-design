import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  artifactOriginForRun,
  snapshotAiHtmlVersionsForRun,
} from '../src/run-html-version-snapshots.js';
import { listProjectFileVersions } from '../src/project-file-versions.js';
import { decodeDurablePluginWorkflowProvenance, validatePluginWorkflowProvenance } from '../src/mcp-observability.js';

describe('AI HTML version snapshots', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('derives bounded Artifact origin only from a validated Plugin run context', () => {
    const provenance = validatePluginWorkflowProvenance({
      pluginWorkflowId: '018f6f2e-2222-7222-8222-222222222222',
      externalPluginContext: {
        id: 'open-design', version: '0.5.0',
        distributionMechanism: 'git_marketplace', publisherClass: 'open_design_first_party',
      },
      logicalRequestDigest: 'a'.repeat(64), logicalRequestDigestVersion: 1,
    });
    expect(artifactOriginForRun({
      runId: 'run-1', pluginWorkflowProvenance: provenance,
    })).toEqual({
      entrySurface: 'external_mcp', externalPluginId: 'open-design',
      pluginWorkflowId: provenance.pluginWorkflowId, runId: 'run-1',
    });
    // Unrelated UI runs have no external plugin binding.
    expect(artifactOriginForRun({ runId: 'run-2' })).toBeUndefined();
    // Old durable records must not turn retired/unknown identities or UI
    // attribution into a product origin when migrated to provenance.
    for (const [externalPluginId, entrySurface] of [
      ['open-design-cloud', 'external_mcp'],
      ['open-design', 'open_design_ui'],
      ['unknown-plugin', 'external_mcp'],
    ]) {
      const decoded = decodeDurablePluginWorkflowProvenance({
        externalPluginAnalytics: {
          externalPluginId, entrySurface,
          externalPluginVersion: provenance.externalPluginContext.version,
          distributionMechanism: provenance.externalPluginContext.distributionMechanism,
          publisherClass: provenance.externalPluginContext.publisherClass,
          pluginWorkflowId: provenance.pluginWorkflowId,
          logicalRequestDigest: provenance.logicalRequestDigest,
          logicalRequestDigestVersion: 1,
        },
      });
      expect(decoded).toBeNull();
      expect(artifactOriginForRun({ runId: 'run-invalid', pluginWorkflowProvenance: decoded })).toBeUndefined();
    }
  });

  async function makeProject(): Promise<{ root: string; projectsRoot: string; projectId: string; projectRoot: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-html-version-snapshots-'));
    roots.push(root);
    const projectsRoot = path.join(root, 'projects');
    const projectId = 'project-1';
    const projectRoot = path.join(projectsRoot, projectId);
    await fs.mkdir(projectRoot, { recursive: true });
    return { root, projectsRoot, projectId, projectRoot };
  }

  it('throws an aggregate error when a touched HTML version cannot be persisted', async () => {
    const { projectsRoot, projectId, projectRoot } = await makeProject();
    const htmlPath = path.join(projectRoot, 'index.html');
    await fs.writeFile(htmlPath, '<html><body>draft</body></html>');
    await fs.writeFile(path.join(projectRoot, '.file-versions'), 'blocked');

    await expect(snapshotAiHtmlVersionsForRun({
      projectsRoot,
      projectId,
      projectRoot,
      diff: { touchedPaths: [htmlPath] },
      prompt: 'Make a page',
      promptSource: 'message',
    })).rejects.toMatchObject({
      code: 'HTML_VERSION_SNAPSHOT_FAILED',
      failures: [{ fileName: 'index.html' }],
    });
  });

  it('delegates managed history to terminal convergence without touching legacy archives', async () => {
    const { projectsRoot, projectId, projectRoot } = await makeProject();
    const htmlPath = path.join(projectRoot, 'index.html');
    await fs.writeFile(htmlPath, 'managed result');
    await fs.writeFile(path.join(projectRoot, '.file-versions'), 'preserved legacy evidence');
    expect(await snapshotAiHtmlVersionsForRun({ projectsRoot, projectId, projectRoot,
      diff: { touchedPaths: [htmlPath] }, prompt: 'Make a page', managed: true })).toEqual({ snapshots: [] });
    expect(await fs.readFile(path.join(projectRoot, '.file-versions'), 'utf8')).toBe('preserved legacy evidence');
  });

  it('persists the validated run origin on each touched HTML snapshot', async () => {
    const { projectsRoot, projectId, projectRoot } = await makeProject();
    const htmlPath = path.join(projectRoot, 'index.html');
    await fs.writeFile(htmlPath, '<html><body>plugin artifact</body></html>');

    const result = await snapshotAiHtmlVersionsForRun({
      projectsRoot,
      projectId,
      projectRoot,
      diff: { touchedPaths: [htmlPath] },
      prompt: 'Make a page',
      promptSource: 'message',
      origin: {
        entrySurface: 'external_mcp',
        externalPluginId: 'open-design',
        pluginWorkflowId: 'workflow-1',
        runId: 'run-1',
      },
    });

    const versions = await listProjectFileVersions(projectsRoot, projectId, 'index.html');
    expect(result.snapshots).toEqual([
      {
        fileName: 'index.html',
        version: expect.objectContaining({
          id: versions[0]?.id,
          current: true,
          origin: expect.objectContaining({ runId: 'run-1' }),
        }),
      },
    ]);
    expect(versions).toMatchObject([
      {
        current: true,
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        origin: {
          entrySurface: 'external_mcp',
          externalPluginId: 'open-design',
          pluginWorkflowId: 'workflow-1',
          runId: 'run-1',
        },
      },
    ]);
  });

  it('creates a new version when identical HTML is produced by a different Plugin run', async () => {
    const { projectsRoot, projectId, projectRoot } = await makeProject();
    const htmlPath = path.join(projectRoot, 'index.html');
    await fs.writeFile(htmlPath, '<html><body>same artifact</body></html>');

    for (const run of ['run-1', 'run-2']) {
      await snapshotAiHtmlVersionsForRun({
        projectsRoot,
        projectId,
        projectRoot,
        diff: { touchedPaths: [htmlPath] },
        prompt: 'Make a page',
        promptSource: 'message',
        origin: {
          entrySurface: 'external_mcp',
          externalPluginId: 'open-design',
          pluginWorkflowId: `workflow-${run}`,
          runId: run,
        },
      });
    }

    const versions = await listProjectFileVersions(
      projectsRoot,
      projectId,
      'index.html',
    );
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      current: false,
      origin: { runId: 'run-1' },
    });
    expect(versions[1]).toMatchObject({
      current: true,
      origin: { runId: 'run-2' },
    });
  });
});
