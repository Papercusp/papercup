/**
 * publishListingToCupboard — publish-SIDE edges the positive test
 * (`publish-listing.test.ts`) doesn't reach (revive-cupboard-distribution-2026-06-04
 * P1/P2). The settled positive test covers the harness 404→/harnesses fallback +
 * the happy POST; this NEW file hardens the branches around it:
 *
 *   - a NON-harness kind (pack) that 404s surfaces the 404 and makes
 *     EXACTLY ONE fetch — it must NOT fall back to /harnesses (the old worker
 *     can't store a non-harness kind, so a silent /harnesses retry would mint a
 *     wrong-shaped row). This is the security/correctness edge of the
 *     "fallback is harness-only" comment in the source.
 *   - the `cupboard_bad_response` branch: upstream 200 but a non-JSON body
 *     (a proxy error page / truncated stream) must become a 502 bad_response,
 *     not a thrown JSON.parse that the route swallows as a generic 500.
 *
 * gh-token + attestation + resolveCupboardBaseUrl mocked; fetch mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../identity/gh-token', () => ({
  getGhAuthToken: vi.fn(async () => ({ kind: 'ok', token: 'gh-test' })),
}));
vi.mock('../endpoint-route/routes/harness/cupboard-publish', () => ({
  resolveCupboardBaseUrl: () => 'https://cupboard.test',
  resolvePublisherAttestation: vi.fn(async () => null),
}));

import { publishListingToCupboard } from './publish-listing';
import * as ghToken from '../identity/gh-token';
import * as cupboardPublish from '../endpoint-route/routes/harness/cupboard-publish';

const nonHarnessInput = {
  listing_kind: 'pack' as const,
  listing_ref: 'my-pack',
  github_repository_id: 7,
  github_owner: 'acme',
  github_name: 'widget',
  github_url: 'https://github.com/acme/widget',
  title: 'A tool pack',
  provides_tools: ['acme:do-thing'],
};

const originalFetch = global.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.mocked(ghToken.getGhAuthToken).mockResolvedValue({ kind: 'ok', token: 'gh-test' } as never);
  vi.mocked(cupboardPublish.resolvePublisherAttestation).mockResolvedValue(null as never);
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('publishListingToCupboard — non-harness kind 404 does NOT fall back to /harnesses', () => {
  it('surfaces the 404 as cupboard_error with a single fetch (no /harnesses retry)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no_route' }), { status: 404 }));

    const r = await publishListingToCupboard(nonHarnessInput);

    expect(r).toMatchObject({ ok: false, status: 404, error: 'cupboard_error' });
    // Exactly one call, and it is the /listings POST — never /harnesses.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://cupboard.test/listings');
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).not.toContain('https://cupboard.test/harnesses');
  });

  it('a plugin 404 likewise surfaces the 404 without a /harnesses fallback', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const r = await publishListingToCupboard({
      listing_kind: 'plugin',
      listing_ref: 'my-plugin',
      github_repository_id: 1,
      github_owner: 'acme',
      github_name: 'my-plugin',
      github_url: 'https://github.com/acme/my-plugin',
    });
    // 'not found' is not JSON → bad_response, but the key invariant is one fetch.
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://cupboard.test/listings');
  });
});

describe('publishListingToCupboard — cupboard_bad_response (200 but non-JSON body)', () => {
  it('maps a 200 with a non-JSON body to a 502 cupboard_bad_response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>proxy error</html>', { status: 200 }));

    const r = await publishListingToCupboard(nonHarnessInput);

    expect(r).toMatchObject({ ok: false, status: 502, error: 'cupboard_bad_response' });
    if (r.ok) return;
    expect(r.upstream_status).toBe(200);
    expect(String(r.detail)).toContain('proxy error');
  });

  it('maps an EMPTY 200 body to cupboard_bad_response (truncated stream)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const r = await publishListingToCupboard(nonHarnessInput);
    expect(r).toMatchObject({ ok: false, status: 502, error: 'cupboard_bad_response' });
    if (r.ok) return;
    expect(r.upstream_status).toBe(200);
  });

  it('a non-JSON body on a non-2xx is also bad_response (parse runs before the !ok check)', async () => {
    // The source parses the body BEFORE branching on upstream.ok, so a 400 with
    // an HTML body becomes bad_response (502), not cupboard_error (400). Pin it.
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway page</html>', { status: 400 }));
    const r = await publishListingToCupboard(nonHarnessInput);
    expect(r).toMatchObject({ ok: false, status: 502, error: 'cupboard_bad_response' });
    if (r.ok) return;
    expect(r.upstream_status).toBe(400);
  });
});
