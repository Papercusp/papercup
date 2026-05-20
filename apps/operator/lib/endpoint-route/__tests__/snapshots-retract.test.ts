/**
 * POST /api/snapshots/:id/retract — validation + URL routing + pass-through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/snapshot-discovery', () => ({
  findSnapshot: vi.fn(),
}));
vi.mock('@/lib/marketplace-token', () => ({
  readFirstServiceToken: vi.fn(async () => null),
}));
vi.mock('@/lib/endpoint-route/telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));
vi.mock('@/lib/require-flag', () => ({
  gateApiRoute: vi.fn(async () => null),
}));

import { Hono } from 'hono';
import * as discovery from '@/lib/snapshot-discovery';
import { registerAllRoutes } from '../register';

const fixtureSnapshot = {
  id: 'snap_test',
  harnessSlug: 'sheets',
  tarballPath: '/tmp/snap_test.tar.gz',
  bytes: 1,
  createdAtMs: 0,
  manifest: {} as any,
  publishes: [],
};

const originalFetch = global.fetch;
const fetchMock = vi.fn();
let app: Hono;

beforeEach(() => {
  vi.mocked(discovery.findSnapshot).mockResolvedValue(fixtureSnapshot as any);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true, slug: 'foo', action: 'deprecate' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  app = new Hono().basePath('/api');
  registerAllRoutes(app);
});

afterEach(() => {
  global.fetch = originalFetch;
});

function post(id: string, body: unknown) {
  return app.request(`/api/snapshots/${id}/retract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/snapshots/:id/retract', () => {
  it('returns 404 when the snapshot does not exist locally', async () => {
    vi.mocked(discovery.findSnapshot).mockResolvedValue(null);
    const res = await post('snap_missing', { marketplaceSlug: 'foo' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when marketplaceSlug is missing', async () => {
    const res = await post('snap_test', {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/marketplaceSlug required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when marketplaceSlug fails the regex', async () => {
    const res = await post('snap_test', { marketplaceSlug: 'has spaces and $ chars' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when action is unknown', async () => {
    const res = await post('snap_test', { marketplaceSlug: 'foo', action: 'detonate' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid action.*deprecate.*yank/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when yank is requested without a version', async () => {
    const res = await post('snap_test', { marketplaceSlug: 'foo', action: 'yank' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/version required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes deprecate to /v1/packages/<slug>/deprecate', async () => {
    await post('snap_test', { marketplaceSlug: 'sheets-snapshot-x', action: 'deprecate', reason: 'test' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/v1\/packages\/sheets-snapshot-x\/deprecate$/);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.reason).toBe('test');
    expect(body.actor).toBe('operator-ui');
  });

  it('routes yank to /v1/packages/<slug>/versions/<version>/yank', async () => {
    await post('snap_test', { marketplaceSlug: 'foo', action: 'yank', version: '1.0.0-ts1234' });
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/v1\/packages\/foo\/versions\/1\.0\.0-ts1234\/yank$/);
  });

  it('routes withdraw / undeprecate / unwithdraw correctly', async () => {
    for (const action of ['withdraw', 'undeprecate', 'unwithdraw']) {
      fetchMock.mockClear();
      await post('snap_test', { marketplaceSlug: 'foo', action });
      expect(fetchMock.mock.calls[0]![0]).toMatch(new RegExp(`/v1/packages/foo/${action}$`));
    }
  });

  it('defaults action to "deprecate" when omitted', async () => {
    await post('snap_test', { marketplaceSlug: 'foo' });
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/deprecate$/);
  });

  it('truncates reason to 1000 chars', async () => {
    await post('snap_test', { marketplaceSlug: 'foo', reason: 'a'.repeat(2000) });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.reason).toHaveLength(1000);
  });

  it('returns 502 when the marketplace is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await post('snap_test', { marketplaceSlug: 'foo' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/marketplace unreachable/);
  });

  it('returns 502 when the marketplace returns a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await post('snap_test', { marketplaceSlug: 'foo' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/marketplace rejected/);
    expect(body.status).toBe(403);
    expect(body.detail.error).toBe('forbidden');
  });

  it('passes the success response through verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, slug: 'foo', custom: 'field' }), { status: 200 }),
    );
    const res = await post('snap_test', { marketplaceSlug: 'foo', action: 'deprecate', reason: 'r' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe('foo');
    expect(body.action).toBe('deprecate');
    expect(body.reason).toBe('r');
    expect(body.response.custom).toBe('field');
  });

  it('handles non-JSON marketplace response without crashing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('plain text body', { status: 500 }));
    const res = await post('snap_test', { marketplaceSlug: 'foo' });
    expect(res.status).toBe(502);
  });
});
