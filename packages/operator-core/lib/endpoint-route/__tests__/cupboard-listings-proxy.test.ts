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
