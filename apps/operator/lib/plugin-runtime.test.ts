/**
 * P-028 (production-readiness-test-coverage) — plugin-runtime: the
 * componentId→component resolver + the contributions fetcher. The lazy loader's
 * import/error paths fire only at React render time (covered by integration/e2e,
 * not here); this unit covers the non-render surfaces: fetchContributions URL
 * shaping + error handling, and resolveComponent's per-ref caching.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchContributions,
  resolveComponent,
  _resetCacheForTests,
  type ContributionsResponse,
} from './plugin-runtime';

const RESP: ContributionsResponse = {
  project: { slug: 'papercup', path: '/p' },
  dashboardTabs: [],
  sidebarItems: [],
  routes: [],
};

describe('fetchContributions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds the encoded contributions URL with no-store cache and parses the body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RESP), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchContributions('a/b', 'http://host:3070');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://host:3070/api/plugins/a%2Fb/contributions'); // slug encoded
    expect(init).toEqual({ cache: 'no-store' });
    expect(out).toEqual(RESP);
  });

  it('defaults to a relative URL when no baseUrl is given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RESP), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchContributions('papercup');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/plugins/papercup/contributions');
  });

  it('throws with the status when the response is not ok', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchContributions('ghost')).rejects.toThrow(/ghost.*404/);
  });
});

describe('resolveComponent — caching', () => {
  beforeEach(() => _resetCacheForTests());
  afterEach(() => _resetCacheForTests());

  const ref = { componentRoot: '@papercusp/papercusp-shared', componentId: 'DirectivesView' };

  it('returns a (lazy) component for a ref', () => {
    const C = resolveComponent(ref);
    expect(C).toBeTruthy();
  });

  it('returns the SAME instance for the same (root, id) — no double import', () => {
    expect(resolveComponent(ref)).toBe(resolveComponent({ ...ref }));
  });

  it('returns DIFFERENT instances for different ids or roots', () => {
    const a = resolveComponent(ref);
    const b = resolveComponent({ ...ref, componentId: 'OtherView' });
    const c = resolveComponent({ ...ref, componentRoot: '@papercusp/other' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('_resetCacheForTests evicts so a later resolve is a fresh instance', () => {
    const before = resolveComponent(ref);
    _resetCacheForTests();
    expect(resolveComponent(ref)).not.toBe(before);
  });
});
