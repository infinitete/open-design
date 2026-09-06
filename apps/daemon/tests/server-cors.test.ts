import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireLocalDaemonRequest } from '../src/http/local-daemon-request.js';

// Replicate only the CORS middleware pattern from the raw file route so we can
// test the header logic without spinning up the full daemon (database, fs, etc.).
function makeTestApp() {
  const app = express();

  app.options('/api/projects/:id/raw/*splat', (req, res) => {
    if (req.headers.origin === 'null') {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET');
      res.header('Access-Control-Allow-Headers', 'Content-Type, X-OD-Project-Revision');
    }
    res.sendStatus(204);
  });

  app.get('/api/projects/:id/raw/*splat', (req, res) => {
    if (req.headers.origin === 'null') {
      res.header('Access-Control-Allow-Origin', '*');
    }
    res.type('html').send('<!doctype html><html><body><main><h1>Raw Preview Smoke</h1></main></body></html>');
  });

  return app;
}

describe('raw file endpoint CORS', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = makeTestApp().listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
  );

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('sets Access-Control-Allow-Origin: * for null origin (srcdoc iframe)', async () => {
    const res = await fetch(`${baseUrl}/api/projects/test-id/raw/components/login.jsx`, {
      headers: { Origin: 'null' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('does not set Access-Control-Allow-Origin for a real cross-origin site', async () => {
    const res = await fetch(`${baseUrl}/api/projects/test-id/raw/components/login.jsx`, {
      headers: { Origin: 'https://evil.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not set Access-Control-Allow-Origin for same-origin requests (no Origin header)', async () => {
    const res = await fetch(`${baseUrl}/api/projects/test-id/raw/components/login.jsx`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves nested raw HTML bodies for null-origin preview iframes', async () => {
    const res = await fetch(`${baseUrl}/api/projects/test-id/raw/screens/tablet/index.html`, {
      headers: { Origin: 'null' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toContain('text/html');
    await expect(res.text()).resolves.toContain('Raw Preview Smoke');
  });

  it('handles OPTIONS preflight for null origin', async () => {
    const res = await fetch(`${baseUrl}/api/projects/test-id/raw/components/login.jsx`, {
      method: 'OPTIONS',
      headers: { Origin: 'null' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET');
    expect(res.headers.get('access-control-allow-headers')).toContain('X-OD-Project-Revision');
  });

  it('rejects OPTIONS preflight from a real cross-origin site', async () => {
    const res = await fetch(`${baseUrl}/api/projects/test-id/raw/components/login.jsx`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.com' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('local daemon mutation revision CORS', () => {
  it('allows project Git PATCH and idempotency headers', () => {
    const headers = new Map<string, string>();
    let nextCalled = false;
    requireLocalDaemonRequest(
      {
        socket: { remoteAddress: '127.0.0.1' },
        get(name: string) {
          if (name === 'host') return '127.0.0.1:4173';
          if (name === 'origin') return 'http://127.0.0.1:4173';
          return undefined;
        },
      } as any,
      {
        setHeader(name: string, value: string) {
          headers.set(name.toLowerCase(), value);
        },
      } as any,
      () => { nextCalled = true; },
    );

    expect(nextCalled).toBe(true);
    expect(headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(headers.get('access-control-allow-headers')).toContain('X-OD-Project-Revision');
    expect(headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
  });
});
