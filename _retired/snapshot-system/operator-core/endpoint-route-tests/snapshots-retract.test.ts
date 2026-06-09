/**
 * POST /api/snapshots/:id/retract — unlist from the Cupboard
 * (revive-cupboard-distribution P1 / D-004; replaced the dead :3057 yank proxy).
 * Retract = DELETE the snapshot's Cupboard listing(s); ids come from the
 * `.published.json` sidecar (or an explicit override). Auth = publisher gh-token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../snapshot-discovery', () => ({
  findSnapshot: vi.fn(),
}));
vi.mock('../../snapshot-index', () => ({
  readPublishesSidecar: vi.fn(async () => []),
  reconcileTarballIntoIndex: vi.fn(async () => null),
}));
vi.mock('../../identity/gh-token', () => ({
  getGhAuthToken: vi.fn(async () => ({ kind: 'ok', token: 'gh-test-token' })),
}));
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));
vi.mock('../../require-flag', () => ({
  gateApiRoute: vi.fn(async () => null),
}));

import { Hono } from 'hono';
import * as discovery from '../../snapshot-discovery';
import * as snapIndex from '../../snapshot-index';
import * as ghToken from '../../identity/gh-token';
import { registerAllRoutes } from '../register';

const fixtureSnapshot = {
  id: 'snap_test',
  harnessSlug: 'sheets',
  tarballPath: '/tmp/does-not-exist-snap_test.tar.gz',
  bytes: 1,
  createdAtMs: 0,
  manifest: {} as any,
  publishes: [],
};

const originalFetch = global.fetch;
const originalCupboardEnv = process.env.PAPERCUSP_CUPBOARD_URL;
const fetchMock = vi.fn();
let app: Hono;

beforeEach(() => {
  process.env.PAPERCUSP_CUPBOARD_URL = 'https://cupboard.test';
  vi.mocked(discovery.findSnapshot).mockResolvedValue(fixtureSnapshot as any);
  vi.mocked(snapIndex.readPublishesSidecar).mockResolvedValue([
    { slug: 'snap_test', version: 'listing-123', browseUrl: 'papercusp://cupboard/listing-123', publishedAtMs: 0 },
  ] as any);
  vi.mocked(ghToken.getGhAuthToken).mockResolvedValue({ kind: 'ok', token: 'gh-test-token' } as any);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
  app = new Hono().basePath('/api');
  registerAllRoutes(app);
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalCupboardEnv !== undefined) process.env.PAPERCUSP_CUPBOARD_URL = originalCupboardEnv;
  else delete process.env.PAPERCUSP_CUPBOARD_URL;
});

function post(id: string, body: unknown) {
  return app.request(`/api/snapshots/${id}/retract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/snapshots/:id/retract (Cupboard unlist)', () => {
  it('returns 404 when the snapshot does not exist locally', async () => {
    vi.mocked(discovery.findSnapshot).mockResolvedValue(null);
    const res = await post('snap_missing', {});
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when no listing id is recorded or provided', async () => {
    vi.mocked(snapIndex.readPublishesSidecar).mockResolvedValue([] as any);
    const res = await post('snap_test', {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/nothing to retract/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 401 when gh auth is unavailable', async () => {
    vi.mocked(ghToken.getGhAuthToken).mockResolvedValue({ kind: 'gh_auth_required', error: { kind: 'no_token' } } as any);
    const res = await post('snap_test', {});
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/gh_auth_required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DELETEs the recorded listing from the Cupboard', async () => {
    const res = await post('snap_test', {});
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://cupboard.test/listings/listing-123');
    expect(opts.method).toBe('DELETE');
    expect(opts.headers.Authorization).toBe('Bearer gh-test-token');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.retracted[0]).toMatchObject({ listingId: 'listing-123', ok: true });
  });

  it('honors an explicit listingId override', async () => {
    await post('snap_test', { listingId: 'override-999' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://cupboard.test/listings/override-999');
  });

  it('returns 502 when the Cupboard rejects the unlist', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const res = await post('snap_test', {});
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.retracted[0]).toMatchObject({ listingId: 'listing-123', ok: false, status: 403 });
  });
});
