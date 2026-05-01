/**
 * Unit tests for the snapshot retract proxy endpoint.
 *
 * The route validates input then forwards to the marketplace's M6 surface
 * (deprecate/withdraw/yank). Tests focus on:
 *   1. Input validation — every reject path returns the right status.
 *   2. URL routing — yank vs other actions go to different endpoints.
 *   3. Pass-through — body fields and auth header reach the marketplace.
 *
 * fetch + findSnapshot are mocked so the test is hermetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/snapshot-discovery', () => ({
  findSnapshot: vi.fn(),
}));
vi.mock('node:fs', () => {
  const promises = {
    readFile: vi.fn(async () => ''),
  };
  return {
    promises,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    default: { promises, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => '') },
  };
});

import { POST } from './route';
import * as discovery from '@/lib/snapshot-discovery';

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
});

afterEach(() => {
  global.fetch = originalFetch;
});

import { afterEach } from 'vitest';

function makeReq(body: unknown): Request {
  return new Request('http://test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/snapshots/:id/retract', () => {
  it('returns 404 when the snapshot does not exist locally', async () => {
    vi.mocked(discovery.findSnapshot).mockResolvedValue(null);
    const res = await POST(makeReq({ marketplaceSlug: 'foo' }), params('snap_missing'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when marketplaceSlug is missing', async () => {
    const res = await POST(makeReq({}), params('snap_test'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/marketplaceSlug required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when marketplaceSlug fails the regex', async () => {
    const res = await POST(
      makeReq({ marketplaceSlug: 'has spaces and $ chars' }),
      params('snap_test'),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when action is unknown', async () => {
    const res = await POST(
      makeReq({ marketplaceSlug: 'foo', action: 'detonate' }),
      params('snap_test'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid action.*deprecate.*yank/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when yank is requested without a version', async () => {
    const res = await POST(
      makeReq({ marketplaceSlug: 'foo', action: 'yank' }),
      params('snap_test'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/version required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes deprecate to /v1/packages/<slug>/deprecate', async () => {
    await POST(
      makeReq({ marketplaceSlug: 'sheets-snapshot-x', action: 'deprecate', reason: 'test' }),
      params('snap_test'),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/v1\/packages\/sheets-snapshot-x\/deprecate$/);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.reason).toBe('test');
    expect(body.actor).toBe('operator-ui');
  });

  it('routes yank to /v1/packages/<slug>/versions/<version>/yank', async () => {
    await POST(
      makeReq({ marketplaceSlug: 'foo', action: 'yank', version: '1.0.0-ts1234' }),
      params('snap_test'),
    );
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/v1\/packages\/foo\/versions\/1\.0\.0-ts1234\/yank$/);
  });

  it('routes withdraw / undeprecate / unwithdraw correctly', async () => {
    for (const action of ['withdraw', 'undeprecate', 'unwithdraw']) {
      fetchMock.mockClear();
      await POST(
        makeReq({ marketplaceSlug: 'foo', action }),
        params('snap_test'),
      );
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toMatch(new RegExp(`/v1/packages/foo/${action}$`));
    }
  });

  it('defaults action to "deprecate" when omitted', async () => {
    await POST(
      makeReq({ marketplaceSlug: 'foo' }),
      params('snap_test'),
    );
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/deprecate$/);
  });

  it('truncates reason to 1000 chars', async () => {
    const longReason = 'a'.repeat(2000);
    await POST(
      makeReq({ marketplaceSlug: 'foo', reason: longReason }),
      params('snap_test'),
    );
    const [, opts] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(opts.body as string);
    expect(body.reason).toHaveLength(1000);
  });

  it('returns 502 when the marketplace is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await POST(
      makeReq({ marketplaceSlug: 'foo' }),
      params('snap_test'),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/marketplace unreachable/);
  });

  it('returns 502 when the marketplace returns a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await POST(
      makeReq({ marketplaceSlug: 'foo' }),
      params('snap_test'),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/marketplace rejected/);
    expect(body.status).toBe(403);
    expect(body.detail.error).toBe('forbidden');
  });

  it('passes the success response through verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, slug: 'foo', custom: 'field' }), {
        status: 200,
      }),
    );
    const res = await POST(
      makeReq({ marketplaceSlug: 'foo', action: 'deprecate', reason: 'r' }),
      params('snap_test'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.slug).toBe('foo');
    expect(body.action).toBe('deprecate');
    expect(body.reason).toBe('r');
    expect(body.response.custom).toBe('field');
  });

  it('rejects fetch absence of body without crashing (non-JSON response)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('plain text body', { status: 500 }),
    );
    const res = await POST(
      makeReq({ marketplaceSlug: 'foo' }),
      params('snap_test'),
    );
    expect(res.status).toBe(502);
  });
});
