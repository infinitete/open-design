import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { workspaceTeamPluginBindingResourceId } from '../src/plugins/registry.js';
import { registerPluginRoutes } from '../src/routes/plugins/index.js';

const servers: Array<ReturnType<express.Express['listen']>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })),
  );
});

const workspaceId = 'workspace-team';
const pluginId = 'shared-plugin';
const teamBindingId = workspaceTeamPluginBindingResourceId(workspaceId, pluginId);

function registerMutationFixture(options: { resolvesTeamMirror: boolean }) {
  const app = express();
  app.use(express.json());
  const installOrUpgradePlugin = vi.fn(async (_req, res: express.Response) => {
    res.status(200).json({ ok: true });
  });
  const handleShareProject = vi.fn(async (_req, res: express.Response) => {
    res.status(200).json({ ok: true });
  });
  const middleware: express.RequestHandler = (_req, _res, next) => next();

  registerPluginRoutes(app, {
    db: {
      prepare: () => ({ all: () => [], get: () => null, run: () => undefined }),
      transaction: (run: () => unknown) => () => run(),
    },
    paths: { PROJECTS_DIR: '', PLUGIN_REGISTRY_ROOTS: [], PLUGIN_LOCKFILE_PATH: '' },
    ids: { randomId: () => 'unused' },
    projectStore: {},
    conversations: {},
    workspaceResources: {
      // A live Team binding row on its own no longer denies a mutation: the
      // route resolves authority locally (headerless), so the rejection is
      // driven by the resolved plugin record itself (a `team:plugin:` source).
      getWorkspaceResource: (
        _db: unknown,
        resourceType: string,
        requestedWorkspaceId: string,
        resourceId: string,
      ) =>
        resourceType === 'plugin'
          && requestedWorkspaceId === workspaceId
          && resourceId === teamBindingId
          ? { visibility: 'team', resourceState: 'active' }
          : null,
      getWorkspaceResourceByResourceId: () => null,
    },
    plugins: {
      getInstalledPlugin: () => (options.resolvesTeamMirror
        ? { id: pluginId, source: `team:plugin:${teamBindingId}`, fsPath: `/team/${pluginId}` }
        : null),
      // Models the production resolver: it returns the team-sourced mirror when
      // one is materialized for the caller, and otherwise falls back to the
      // same-id Personal plugin.
      getWorkspacePlugin: async () => (options.resolvesTeamMirror
        ? { id: pluginId, source: `team:plugin:${teamBindingId}`, fsPath: `/team/${pluginId}` }
        : { id: pluginId, source: '/personal/shared-plugin', fsPath: '/personal/shared-plugin' }),
      listInstalledPlugins: () => [],
    },
    helpers: {
      requireLocalDaemonRequest: middleware,
      pluginUpload: {
        single: () => middleware,
        array: () => middleware,
      },
      installOrUpgradePlugin,
      handleShareProject,
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
    },
  } as unknown as Parameters<typeof registerPluginRoutes>[1]);

  return { app, installOrUpgradePlugin, handleShareProject };
}

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function requestHeaders() {
  return {
    'content-type': 'application/json',
    'x-od-workspace-id': workspaceId,
    'x-od-workspace-type': 'team',
    'x-od-workspace-member-id': 'member-owner',
    'x-od-workspace-role': 'owner',
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-member-status': 'active',
  };
}

describe('Team plugin mutation targets', () => {
  it('rejects upgrade when the resolver returns the team-sourced mirror', async () => {
    const fixture = registerMutationFixture({ resolvesTeamMirror: true });
    const baseUrl = await listen(fixture.app);

    const response = await fetch(`${baseUrl}/api/plugins/${pluginId}/upgrade`, {
      method: 'POST',
      headers: requestHeaders(),
      body: '{}',
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'WORKSPACE_RESOURCE_MANAGE_DENIED',
    });
    expect(fixture.installOrUpgradePlugin).not.toHaveBeenCalled();
  });

  it('rejects share-project when the resolver returns the team-sourced mirror', async () => {
    const fixture = registerMutationFixture({ resolvesTeamMirror: true });
    const baseUrl = await listen(fixture.app);

    const response = await fetch(`${baseUrl}/api/plugins/${pluginId}/share-project`, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({ action: 'publish-github' }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'WORKSPACE_RESOURCE_MANAGE_DENIED',
    });
    expect(fixture.handleShareProject).not.toHaveBeenCalled();
  });

  it('targets the same-id Personal plugin for upgrade when no team-sourced mirror resolves', async () => {
    const fixture = registerMutationFixture({ resolvesTeamMirror: false });
    const baseUrl = await listen(fixture.app);

    const response = await fetch(`${baseUrl}/api/plugins/${pluginId}/upgrade`, {
      method: 'POST',
      headers: requestHeaders(),
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(fixture.installOrUpgradePlugin).toHaveBeenCalledTimes(1);
  });

  it('targets the same-id Personal plugin for share-project when no team-sourced mirror resolves', async () => {
    const fixture = registerMutationFixture({ resolvesTeamMirror: false });
    const baseUrl = await listen(fixture.app);

    const response = await fetch(`${baseUrl}/api/plugins/${pluginId}/share-project`, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({ action: 'publish-github' }),
    });

    expect(response.status).toBe(200);
    expect(fixture.handleShareProject).toHaveBeenCalledTimes(1);
  });
});
