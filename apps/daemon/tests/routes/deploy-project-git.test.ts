import type { Express, Request, Response } from 'express';
import { expect, it, vi } from 'vitest';

import { registerDeployRoutes } from '../../src/routes/deploy.js';

function captureApp() {
  const handlers = new Map<string, (req: Request, res: Response) => unknown>();
  const register = (method: string) => (route: string, handler: (req: Request, res: Response) => unknown) => handlers.set(`${method} ${route}`, handler);
  return {
    app: { get: register('GET'), post: register('POST'), put: register('PUT') } as unknown as Express,
    handler(method: string, route: string) { return handlers.get(`${method} ${route}`)!; },
  };
}

function response() {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  (res.json as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

function request(body: Record<string, unknown>): Request {
  return { params: { id: 'project' }, body, query: {} } as unknown as Request;
}

function fixture() {
  const routes = captureApp();
  const order: string[] = [];
  const source = Buffer.from('captured');
  let finishCapture!: () => void;
  const capture = new Promise<void>(resolve => { finishCapture = resolve; });
  let finishNetwork!: () => void;
  const network = new Promise<void>(resolve => { finishNetwork = resolve; });
  const buildDeployFileSet = vi.fn(async () => {
    order.push('capture');
    await capture;
    return [{ file: 'index.html', data: source, contentType: 'text/html' }];
  });
  const deployToVercel = vi.fn(async (input: { files: Array<{ data: Buffer }> }) => {
    order.push('network');
    expect(Buffer.from(input.files[0]!.data).toString()).toBe('captured');
    await network;
    return { url: 'https://example.invalid', deploymentId: 'deployment', status: 'ready' };
  });
  const prepareDeployPreflight = vi.fn(async () => {
    order.push('preflight');
    return { files: [] };
  });
  const withProjectRead = vi.fn(async (_projectId: string, work: () => Promise<unknown>) => {
    order.push('read:enter');
    try { return await work(); } finally { order.push('read:release'); }
  });
  registerDeployRoutes(routes.app, {
    db: {} as never,
    http: { sendApiError: vi.fn() } as never,
    paths: { PROJECTS_DIR: '/projects' } as never,
    ids: { randomUUID: vi.fn(() => 'id') } as never,
    projectStore: { getProject: vi.fn(() => ({ id: 'project', name: 'Project', metadata: { baseDir: '/external' } })) } as never,
    projectGitCoordination: { withProjectRead, withProjectMutation: vi.fn(), recoveryReady: Promise.resolve(), runtime: {} as never },
    authorizeProjectRequest: vi.fn(async () => true),
    deploy: {
      VERCEL_PROVIDER_ID: 'vercel', CLOUDFLARE_PAGES_PROVIDER_ID: 'cloudflare',
      isDeployProviderId: vi.fn(() => true), publicDeployConfigForProvider: vi.fn(), readDeployConfig: vi.fn(async () => ({})),
      writeDeployConfig: vi.fn(), listCloudflarePagesZones: vi.fn(), DeployError: class extends Error {},
      listDeployments: vi.fn(() => []), publicDeployments: vi.fn(), getDeployment: vi.fn(() => null),
      buildDeployFileSet, cloudflarePagesProjectNameForDeploy: vi.fn(), deployToCloudflarePages: vi.fn(), deployToVercel,
      upsertDeployment: vi.fn(input => input), publicDeployment: vi.fn(input => input), cloudflarePagesDeploymentMetadata: vi.fn(),
      prepareDeployPreflight,
    } as never,
  } as never);
  return { routes, order, source, finishCapture, finishNetwork, buildDeployFileSet, deployToVercel, prepareDeployPreflight, withProjectRead };
}

it('captures immutable deployment bytes in one read scope and releases before slow network work', async () => {
  const test = fixture();
  const pending = test.routes.handler('POST', '/api/projects/:id/deploy')(request({ fileName: 'index.html' }), response());
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(test.order).toEqual(['read:enter', 'capture']);
  expect(test.deployToVercel).not.toHaveBeenCalled();

  test.finishCapture();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(test.order).toEqual(['read:enter', 'capture', 'read:release', 'network']);
  test.source.fill('x');
  test.finishNetwork();
  await pending;
  expect(test.withProjectRead).toHaveBeenCalledTimes(1);
});

it('runs deployment preflight capture and derived analysis in one read scope', async () => {
  const test = fixture();
  await test.routes.handler('POST', '/api/projects/:id/deploy/preflight')(
    request({ fileName: 'index.html' }),
    response(),
  );
  expect(test.order).toEqual(['read:enter', 'preflight', 'read:release']);
  expect(test.withProjectRead).toHaveBeenCalledTimes(1);
});
