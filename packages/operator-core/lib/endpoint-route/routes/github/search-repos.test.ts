/**
 * search-repos.test.ts — GET /api/github/search-repos (comb-hive-native-
 * sharing P-008, D-002): the server-side GitHub repo-search proxy.
 *
 * Verifies: the loopback tier, the 400 on a missing q, the authed call
 * (token in the Authorization header, never in the response), the unauthed
 * fallback (`authed:false` — the UI's sign-in nudge, D-005/O-3), the 60s
 * response cache (one upstream fetch per query+page within TTL; rate budget
 * protection), HONEST rate-limit surfacing (403/429 → 429 + retryAfterSec
 * from retry-after / x-ratelimit-reset), the 422 → 400 invalid-query map,
 * and the 502 on upstream failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import searchReposRoute, { __resetGithubSearchCacheForTest } from './search-repos';

let tokenResult: { kind: 'ok'; token: string } | { kind: 'error'; error: { kind: string } } = {
  kind: 'ok',
  token: 'gho_test',
};

vi.mock('../../../identity/gh-token', () => ({
  getGhAuthToken: vi.fn(async () => tokenResult),
}));

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

function ghItem(over: Record<string, unknown> = {}) {
  return {
    id: 11,
    full_name: 'acme/web',
    description: 'the acme web app',
    stargazers_count: 42,
    language: 'TypeScript',
    pushed_at: '2026-06-01T00:00:00Z',
    html_url: 'https://github.com/acme/web',
    private: false,
    fork: false,
    default_branch: 'main',
    ...over,
  };
}

function ghOk(items: unknown[] = [ghItem()], total = items.length) {
  return new Response(JSON.stringify({ total_count: total, incomplete_results: false, items }), {
    status: 200,
  });
}

async function get(qs: string) {
  const req = new Request(`http://127.0.0.1/api/github/search-repos${qs}`);
  const res = (await searchReposRoute.handler(req as never, {} as never)) as Response;
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  __resetGithubSearchCacheForTest();
  tokenResult = { kind: 'ok', token: 'gho_test' };
});

describe('GET /api/github/search-repos (P-008)', () => {
  it('declares the loopback auth tier (auth-tier Wave 1)', () => {
    expect((searchReposRoute as { auth?: unknown }).auth).toBe('loopback');
  });

  it('400s a missing q without touching GitHub', async () => {
    const { status, body } = await get('');
    expect(status).toBe(400);
    expect(body?.code).toBe('invalid_args');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('proxies an authed search — token in the header, projection in the body, never the token', async () => {
    mockFetch.mockResolvedValueOnce(ghOk());
    const { status, body } = await get('?q=acme');
    expect(status).toBe(200);
    const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain('https://api.github.com/search/repositories?');
    expect(calledUrl).toContain('q=acme');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gho_test');
    expect(body).toMatchObject({
      ok: true,
      authed: true,
      totalCount: 1,
      page: 1,
      perPage: 20,
      items: [
        {
          repoId: 11,
          fullName: 'acme/web',
          description: 'the acme web app',
          stars: 42,
          language: 'TypeScript',
          updatedAt: '2026-06-01T00:00:00Z',
          private: false,
          fork: false,
          defaultBranch: 'main',
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('gho_test');
  });

  it('falls back to an UNAUTHED search when gh login is absent — authed:false, no Authorization (D-005/O-3)', async () => {
    tokenResult = { kind: 'error', error: { kind: 'not_authenticated' } };
    mockFetch.mockResolvedValueOnce(ghOk());
    const { status, body } = await get('?q=acme');
    expect(status).toBe(200);
    expect(body?.authed).toBe(false);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('serves a repeat query+page from the 60s cache — ONE upstream fetch (rate-budget protection)', async () => {
    mockFetch.mockResolvedValue(ghOk());
    await get('?q=acme');
    const second = await get('?q=acme');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(second.body?.cached).toBe(true);
    // A different page is a different cache entry.
    await get('?q=acme&page=2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces a rate limit HONESTLY: 403 + retry-after → 429 retryAfterSec (D-002)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: { 'retry-after': '37' },
      }),
    );
    const { status, body } = await get('?q=acme');
    expect(status).toBe(429);
    expect(body).toMatchObject({ error: 'github_rate_limited', retryAfterSec: 37, authed: true });
  });

  it('derives retryAfterSec from x-ratelimit-reset when retry-after is absent', async () => {
    const resetEpochSec = Math.floor(Date.now() / 1000) + 25;
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 429,
        headers: { 'x-ratelimit-reset': String(resetEpochSec) },
      }),
    );
    const { status, body } = await get('?q=acme');
    expect(status).toBe(429);
    const retry = body?.retryAfterSec as number;
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(26);
  });

  it('rate-limited responses are NOT cached — the next call retries upstream', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('{}', { status: 429, headers: { 'retry-after': '1' } }),
    );
    await get('?q=acme');
    mockFetch.mockResolvedValueOnce(ghOk());
    const { status } = await get('?q=acme');
    expect(status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('maps a 422 (unprocessable query) to a 400 with the upstream message', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 }),
    );
    const { status, body } = await get('?q=%22unbalanced');
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_query', detail: 'Validation Failed' });
  });

  it('502s on an upstream network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.github.com'));
    const { status, body } = await get('?q=acme');
    expect(status).toBe(502);
    expect(body?.error).toBe('github_unreachable');
  });

  it('502s on an off-shape upstream body', async () => {
    mockFetch.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const { status, body } = await get('?q=acme');
    expect(status).toBe(502);
    expect(body?.error).toBe('github_error');
  });

  it('clamps the page param into [1, 50]', async () => {
    mockFetch.mockResolvedValue(ghOk());
    await get('?q=acme&page=999');
    expect(String(mockFetch.mock.calls[0][0])).toContain('page=50');
    await get('?q=acme&page=-3');
    expect(String(mockFetch.mock.calls[1][0])).toContain('page=1');
  });
});
