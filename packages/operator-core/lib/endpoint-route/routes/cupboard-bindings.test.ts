/**
 * cupboard-bindings.test.ts — GET /api/cupboard/bindings (comb-hive-native-
 * sharing P-011): the operator's loopback proxy to the worker's batch
 * repo→Hive lookup (the P-010 search-result badge source).
 *
 * Verifies: the public read tier, the empty-args short-circuit (no upstream
 * call), the forward to the worker /bindings, and the GRACEFUL degrade — a
 * worker that predates the route (404), any upstream failure, or an
 * unreachable Cupboard all return an empty list so the search panel stays
 * functional (badges are a silent enhancement, never gated on the worker
 * deploy landing).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cupboard/base-url', () => ({
  resolveCupboardBaseUrl: () => 'https://cupboard.example',
}));

import { getCupboardBindings } from './cupboard';

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

async function get(qs: string) {
  const req = new Request(`http://127.0.0.1/api/cupboard/bindings${qs}`);
  const res = (await getCupboardBindings.handler(req as never, {} as never)) as Response;
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

beforeEach(() => mockFetch.mockReset());

describe('GET /api/cupboard/bindings (P-011)', () => {
  it('is a public read proxy', () => {
    expect((getCupboardBindings as { auth?: unknown }).auth).toBe('public');
  });

  it('empty repo_ids → { bindings: [] } without touching the worker', async () => {
    const { body } = await get('');
    expect(body).toEqual({ bindings: [] });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('forwards repo_ids to the worker /bindings and returns the batch', async () => {
    const bindings = [
      { repo_id: 1, hive_pubkey: 'K'.repeat(43) + '=', hive_title: 'Demo', claim_status: 'claimed', listing_id: 'h1' },
      { repo_id: 2, hive_pubkey: null, hive_title: null, claim_status: 'unclaimed', listing_id: 'h2' },
    ];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ bindings }), { status: 200 }));
    const { body } = await get('?repo_ids=1,2');
    expect(body).toEqual({ bindings });
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toBe('https://cupboard.example/bindings?repo_ids=1%2C2');
  });

  it('a worker predating /bindings (404) degrades to an empty list', async () => {
    mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const { body } = await get('?repo_ids=1');
    expect(body).toEqual({ bindings: [], unavailable: true });
  });

  it('an unreachable Cupboard degrades to an empty list', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { body } = await get('?repo_ids=1');
    expect(body).toEqual({ bindings: [], unavailable: true });
  });

  it('tolerates a malformed worker response (non-array bindings → [])', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ bindings: 'nope' }), { status: 200 }));
    const { body } = await get('?repo_ids=1');
    expect(body).toEqual({ bindings: [] });
  });
});
