/**
 * Tests for /api/security-advisories/check.
 *
 * Mocks `fetch` to drive the marketplace catalog client through clean,
 * flagged, and unreachable scenarios.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FETCH_KEY = 'fetch' as const;
const realFetch = globalThis[FETCH_KEY];

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  globalThis[FETCH_KEY] = realFetch;
  vi.restoreAllMocks();
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

describe('POST /api/security-advisories/check', () => {
  it('returns 400 on missing fields', async () => {
    const { POST } = await import('./route');
    const r = await POST(
      new Request('http://x/api/security-advisories/check', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(r.status).toBe(400);
  });

  it('returns clean for a plugin with no advisories', async () => {
    mockFetch({
      '/api/catalog/clean-plugin/1.0.0': () => ({
        status: 200,
        body: { pluginSlug: 'clean-plugin', version: '1.0.0', publisher: 'pub' },
      }),
    });
    const { POST } = await import('./route');
    const r = await POST(
      new Request('http://x/api/security-advisories/check', {
        method: 'POST',
        body: JSON.stringify({ plugin: 'clean-plugin', version: '1.0.0' }),
      }),
    );
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
    const { POST } = await import('./route');
    const r = await POST(
      new Request('http://x/api/security-advisories/check', {
        method: 'POST',
        body: JSON.stringify({ plugin: 'vuln-plugin', version: '1.0.0' }),
      }),
    );
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
    const { POST } = await import('./route');
    const r = await POST(
      new Request('http://x/api/security-advisories/check', {
        method: 'POST',
        body: JSON.stringify({ plugin: 'p', version: '1.0.0' }),
      }),
    );
    const body = await r.json();
    expect(body.result.state).toBe('unknown');
    expect(body.result.reason).toContain('ECONNREFUSED');
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
    const { POST } = await import('./route');
    const r = await POST(
      new Request('http://x/api/security-advisories/check', {
        method: 'POST',
        body: JSON.stringify({ plugin: 'p', version: '1.0.0', minSeverity: 'high' }),
      }),
    );
    const body = await r.json();
    expect(body.result.state).toBe('clean'); // moderate < high threshold
  });
});
