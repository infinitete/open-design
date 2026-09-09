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

describe('design-system post-create project bootstrap', () => {
  it('refetches the generated project and patches the generated prompt onto it', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/projects/design-system-new' && !init?.method) {
        return new Response(JSON.stringify({ project: {
          id: 'design-system-new',
          name: 'Design system project',
          skillId: null,
          designSystemId: 'user:design-system',
          createdAt: 1,
          updatedAt: 1,
          status: { value: 'not_started' },
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
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
      designSystemId: 'user:design-system',
    });

    expect(registryMocks.writeProjectTextFile).toHaveBeenCalledOnce();
    const freshRead = requests.findIndex((request) => (
      request.url === '/api/projects/design-system-new' && !request.init?.method
    ));
    const patchIndex = requests.findIndex((request) => (
      request.url === '/api/projects/design-system-new' && request.init?.method === 'PATCH'
    ));
    expect(freshRead).toBeGreaterThanOrEqual(0);
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    // The prompt patch must land on a freshly-read project row, never a stale one.
    expect(freshRead).toBeLessThan(patchIndex);
    expect(JSON.parse(String(requests[patchIndex]?.init?.body))).toMatchObject({
      pendingPrompt: expect.any(String),
    });
    expect(onProjectPrepared).toHaveBeenCalledOnce();
  });
});
