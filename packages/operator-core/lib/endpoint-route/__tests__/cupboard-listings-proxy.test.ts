/**
 * GET /cupboard/listings proxy — pre-migration kind degradation
 * (tool-distribution-granularity-2026-06-05 P-006).
 *
 * A Cupboard worker predating a listing kind (e.g. 'pack' before worker
 * migration 006) rejects `?kind=<new>` with `{error:'invalid_field',
 * field:'kind'}`. The proxy translates that to an empty listings page — the
 * storefront's kind tab shows its empty state instead of "Error: HTTP 400" —
 * matching fetchCupboardUnits' degradation in the pack catalog. Any other
 * 400 still surfaces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../identity/gh-token', () => ({ getGhAuthToken: vi.fn() }));
vi.mock('../../cupboard/base-url', () => ({
  resolveCupboardBaseUrl: () => 'https://cupboard.test',
}));
vi.mock('../../cupboard/pack-catalog', () => ({
  derivePackCatalog: vi.fn(),
}));
vi.mock('../../plugin-host-runtime', () => ({
  getPluginHost: vi.fn(async () => ({})),
}));

import routes from '../routes/cupboard';
import { getGhAuthToken } from '../../identity/gh-token';

type Handler = (req: Request, ctx: { params: Record<string, unknown> }) => Promise<Response>;
const listRoute = (routes as Array<{ method: string; path: string; handler: Handler }>).find(
  (r) => r.method === 'GET' && r.path === '/cupboard/listings',
)!;

const originalFetch = global.fetch;
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function get(qs: string): Promise<Response> {
  return listRoute.handler(new Request(`http://localhost/cupboard/listings${qs}`), { params: {} });
}

describe('GET /cupboard/listings — unknown-kind degradation', () => {
  it("a pre-006 worker's invalid_field:kind 400 on ?kind=pack degrades to an empty page", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_field', field: 'kind' }), { status: 400 }),
    );
    const res = await get('?kind=pack');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listings: [] });
  });

  it('any other 400 still surfaces as an error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_field', field: 'q' }), { status: 400 }),
    );
    const res = await get('?kind=pack&q=%00');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('HTTP 400');
  });

  it('a normal worker page passes through', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: 'a', listing_kind: 'pack' }] }), { status: 200 }),
    );
    const res = await get('?kind=pack');
    expect(res.status).toBe(200);
    expect((await res.json() as { listings: unknown[] }).listings).toHaveLength(1);
  });
});

// ─── POST /cupboard/listings/:id/claim (comb-hive-native-sharing P-003) ─────
// The proxy adds the operator's gh token server-side and passes the worker's
// verdict through honestly — the worker is the maintain/admin enforcement
// point (O-1 per D-005), never the proxy.

const claimRoute = (routes as Array<{ method: string; path: string; auth?: string; handler: Handler }>).find(
  (r) => r.method === 'POST' && r.path === '/cupboard/listings/:id/claim',
)!;

function postClaim(id: string): Promise<Response> {
  return claimRoute.handler(
    new Request(`http://localhost/cupboard/listings/${id}/claim`, { method: 'POST' }),
    { params: { id } },
  );
}

describe('POST /cupboard/listings/:id/claim — authed claim proxy', () => {
  it('is loopback-gated (the desktop webview perimeter)', () => {
    expect(claimRoute.auth).toBe('loopback');
  });

  it('forwards to the worker claim endpoint with the gh bearer and passes ok through', async () => {
    vi.mocked(getGhAuthToken).mockResolvedValueOnce({ kind: 'ok', token: 'gh-tok' } as never);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, listing: { id: 42, claim_status: 'claimed' } }), { status: 200 }),
    );
    const res = await postClaim('42');
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cupboard.test/listings/42/claim');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gh-tok');
    expect(init.method).toBe('POST');
  });

  it('returns 401 gh_auth_required when no gh login exists on this box', async () => {
    vi.mocked(getGhAuthToken).mockResolvedValueOnce({
      kind: 'error',
      error: { kind: 'not_authenticated' },
    } as never);
    const res = await postClaim('42');
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('gh_auth_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the worker's insufficient_permission verdict through with its status", async () => {
    vi.mocked(getGhAuthToken).mockResolvedValueOnce({ kind: 'ok', token: 'gh-tok' } as never);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'insufficient_permission', required: 'maintain' }), { status: 403 }),
    );
    const res = await postClaim('42');
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('insufficient_permission');
  });

  it("passes the worker's already_claimed conflict through", async () => {
    vi.mocked(getGhAuthToken).mockResolvedValueOnce({ kind: 'ok', token: 'gh-tok' } as never);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'already_claimed', claimant_github_user_id: 7 }), { status: 409 }),
    );
    const res = await postClaim('42');
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('already_claimed');
  });
});
