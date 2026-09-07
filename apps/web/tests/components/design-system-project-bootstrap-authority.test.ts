// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareCreatedDesignSystemProject } from '../../src/components/DesignSystemFlow';

const registryMocks = vi.hoisted(() => ({
  writeProjectTextFile: vi.fn(async () => true),
}));

vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return {
    ...actual,
    writeProjectTextFile: registryMocks.writeProjectTextFile,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe('design-system post-create project bootstrap authority', () => {
  it('loads fresh authority and patches the generated prompt with the exact revision', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/projects/design-system-new/git') {
        return new Response(JSON.stringify({
          enabled: true,
          phase: 'synced',
          localHead: 'c'.repeat(40),
          observedRemoteHead: 'c'.repeat(40),
          confirmedRemoteHead: 'c'.repeat(40),
          projectRevision: 53,
          contentRevision: 53,
          bindingGeneration: 3,
          dirty: false,
          pendingPush: false,
          autoSync: true,
          operationId: null,
          error: null,
          binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' },
          dependencies: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/projects/design-system-new' && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ project: {
          id: 'design-system-new',
          name: 'Design system project',
          skillId: null,
          designSystemId: 'user:design-system',
          createdAt: 1,
          updatedAt: 2,
          status: { value: 'not_started' },
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    const onProjectPrepared = vi.fn();

    await prepareCreatedDesignSystemProject({
      project: {
        id: 'design-system-new',
        name: 'Design system project',
        skillId: null,
        designSystemId: 'user:design-system',
        createdAt: 1,
        updatedAt: 1,
        status: { value: 'not_started' },
      },
      state: {
        company: 'Acme',
        designMd: '# Acme',
        sourceUrl: '',
        sourceUrls: [],
        figmaUrl: '',
        figmaUrls: [],
        codeFiles: [],
        codeFolders: [],
        codeFileObjects: [],
        figFiles: [],
        figFileObjects: [],
        assetFiles: [],
        assetFileObjects: [],
        notes: '',
      },
      composioConfigured: false,
      githubConnector: null,
      onProjectPrepared,
      analyticsTrack: vi.fn(),
      ingestEntryFrom: 'design_systems_page',
      designSystemId: 'user:design-system',
    });

    expect(registryMocks.writeProjectTextFile).toHaveBeenCalledOnce();
    const patch = requests.find((request) => (
      request.url === '/api/projects/design-system-new' && request.init?.method === 'PATCH'
    ));
    expect(patch?.init?.headers).toMatchObject({ 'X-OD-Project-Revision': '53' });
    expect(onProjectPrepared).toHaveBeenCalledOnce();
  });
});
