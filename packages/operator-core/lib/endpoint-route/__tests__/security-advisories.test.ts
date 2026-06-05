/**
 * Tests for POST /api/security-advisories/check.
 *
 * Ported from app/api/security-advisories/check/route.test.ts — the
 * route is now routes/misc/security-advisories-check.ts. The handler is
 * called directly (it reads its own JSON body); `fetch` is mocked to
 * drive the marketplace catalog client through clean / flagged /
 * unreachable scenarios.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import securityCheck from '../routes/misc/security-advisories-check';
import type { RouteContext } from '../define-route';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};
const POST = (req: Request) => Promise.resolve(securityCheck.handler(req, CTX));

const FETCH_KEY = 'fetch' as const;
const realFetch = globalThis[FETCH_KEY];

const ORIGINAL_MKT = process.env.PAPERCUSP_MARKETPLACE_URL;
beforeEach(() => {
  vi.resetModules();
  // The :3057 default is retired (D-004): the route only hits an advisory source
  // when PAPERCUSP_MARKETPLACE_URL is explicitly set. Configure one so the
  // http-path cases below exercise the (mocked) fetch.
  process.env.PAPERCUSP_MARKETPLACE_URL = 'https://advisories.test';
});

afterEach(() => {
  globalThis[FETCH_KEY] = realFetch;
  vi.restoreAllMocks();
  if (ORIGINAL_MKT !== undefined) process.env.PAPERCUSP_MARKETPLACE_URL = ORIGINAL_MKT;
  else delete process.env.PAPERCUSP_MARKETPLACE_URL;
});

function mockFetch(handlers: Record<string, () => { status: number; body: unknown }>) {
  globalThis[FETCH_KEY] = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    for (const [key, handler] of Object.entries(handlers)) {
      if (u.includes(key)) {
        const { status, body } = handler();
        return new Response(JSON.stringify(body), { status });
      }
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

function req(body: unknown): Request {
  return new Request('http://x/api/security-advisories/check', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/security-advisories/check', () => {
  it('returns 400 on missing fields', async () => {
    const r = await POST(req({}));
    expect(r.status).toBe(400);
  });

  it('returns clean for a plugin with no advisories', async () => {
    mockFetch({
      '/api/catalog/clean-plugin/1.0.0': () => ({
        status: 200,
        body: { pluginSlug: 'clean-plugin', version: '1.0.0', publisher: 'pub' },
      }),
    });
    const r = await POST(req({ plugin: 'clean-plugin', version: '1.0.0' }));
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.result.state).toBe('clean');
  });

  it('flags advisories at or above moderate', async () => {
    mockFetch({
      '/api/catalog/vuln-plugin/1.0.0': () => ({
        status: 200,
        body: {
          pluginSlug: 'vuln-plugin',
          version: '1.0.0',
          publisher: 'pub',
          securityAdvisories: [
            { severity: 'high', summary: 'RCE', cve: 'CVE-2026-99999', fixedIn: '1.0.1' },
            { severity: 'low', summary: 'minor' },
          ],
        },
      }),
      '/api/catalog/vuln-plugin/latest-safe': () => ({
        status: 200,
        body: { version: '1.0.1' },
      }),
    });
    const r = await POST(req({ plugin: 'vuln-plugin', version: '1.0.0' }));
    const body = await r.json();
    expect(body.result.state).toBe('flagged');
    expect(body.result.advisories).toHaveLength(1);
    expect(body.result.advisories[0].severity).toBe('high');
    expect(body.result.latestSafeVersion).toBe('1.0.1');
  });

  it('returns unknown when marketplace is unreachable', async () => {
    globalThis[FETCH_KEY] = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const r = await POST(req({ plugin: 'p', version: '1.0.0' }));
    const body = await r.json();
    expect(body.result.state).toBe('unknown');
    expect(body.result.reason).toContain('ECONNREFUSED');
  });

  it('returns clean WITHOUT fetching when no advisory source is configured (:3057 retired)', async () => {
    delete process.env.PAPERCUSP_MARKETPLACE_URL;
    const fetchSpy = vi.fn();
    globalThis[FETCH_KEY] = fetchSpy as unknown as typeof fetch;
    const r = await POST(req({ plugin: 'p', version: '1.0.0' }));
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.result.state).toBe('clean');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('respects minSeverity override', async () => {
    mockFetch({
      '/api/catalog/p/1.0.0': () => ({
        status: 200,
        body: {
          pluginSlug: 'p',
          version: '1.0.0',
          publisher: 'pub',
          securityAdvisories: [{ severity: 'moderate', summary: 'mid' }],
        },
      }),
    });
    const r = await POST(req({ plugin: 'p', version: '1.0.0', minSeverity: 'high' }));
    const body = await r.json();
    expect(body.result.state).toBe('clean'); // moderate < high threshold
  });
});
