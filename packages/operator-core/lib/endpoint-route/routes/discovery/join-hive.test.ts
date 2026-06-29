/**
 * join-hive.test.ts — POST /api/discovery/join-hive (hive-from-repo-hardening
 * P-007 / D-007), the directory panel's "Join the HIVE" action. This is the
 * side-effecting discovery route (N member joins = N read-only clones +
 * admission/federation), so the test pins that a malformed body 400s BEFORE
 * joinHiveAsView runs, the invalid_member_links→400 vs else→502 map, and the
 * exact forwarded shape.
 *
 * Gap 9 — discovery routes zero tests; join-hive prioritized for its side effects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const joinHiveAsView = vi.fn();
const bustProjectsLiteCache = vi.fn();
vi.mock('../../../harness/join-hive', () => ({
  joinHiveAsView: (...a: unknown[]) => joinHiveAsView(...a),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../harness/projects-lite', () => ({
  bustProjectsLiteCache: (...a: unknown[]) => bustProjectsLiteCache(...a),
  buildProjectsLitePayload: vi.fn(async () => ({ projects: [] })),
}));

import joinHiveRoute from './join-hive';

const LINK = 'papercusp://harness?topic=' + 'a'.repeat(64);

async function post(body: unknown, { raw }: { raw?: string } = {}) {
  const req = new Request('http://127.0.0.1/api/discovery/join-hive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  const res = (await joinHiveRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeEach(() => {
  joinHiveAsView.mockReset();
  bustProjectsLiteCache.mockReset();
  joinHiveAsView.mockResolvedValue({ ok: true, members: [{ slug: 'm', ok: true }], viewSlug: 'acme' });
});

describe('POST /api/discovery/join-hive (Gap 9)', () => {
  it('declares the loopback auth tier (auth-tier Wave 1)', () => {
    expect((joinHiveRoute as { auth?: unknown }).auth).toBe('loopback');
  });

  it.each([
    ['missing both', {}],
    ['empty hiveId', { hiveId: '', memberLinks: [LINK] }],
    ['no member links', { hiveId: 'acme', memberLinks: [] }],
    ['memberLinks not an array', { hiveId: 'acme', memberLinks: LINK }],
    ['member links all non-string', { hiveId: 'acme', memberLinks: [1, 2, null] }],
    ['member links all empty strings', { hiveId: 'acme', memberLinks: ['', ''] }],
  ])('400s invalid_args (%s) WITHOUT touching joinHiveAsView', async (_l, body) => {
    const { status, body: out } = await post(body);
    expect(status).toBe(400);
    expect(out).toMatchObject({ code: 'invalid_args' });
    expect(joinHiveAsView).not.toHaveBeenCalled();
  });

  it('400s a malformed (non-JSON) body without touching joinHiveAsView', async () => {
    const { status, body } = await post(undefined, { raw: 'oops{' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_args' });
    expect(joinHiveAsView).not.toHaveBeenCalled();
  });

  it('400s when more than 64 member links are supplied (no clone storm)', async () => {
    const { status, body } = await post({ hiveId: 'acme', memberLinks: Array(65).fill(LINK) });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_args' });
    expect(joinHiveAsView).not.toHaveBeenCalled();
  });

  it('filters non-string / empty member links before forwarding', async () => {
    await post({ hiveId: 'acme', memberLinks: [LINK, '', 3, null, LINK] });
    expect(joinHiveAsView).toHaveBeenCalledTimes(1);
    expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({ hiveId: 'acme', memberLinks: [LINK, LINK] });
  });

  it('400s invalid_member_links from the composition', async () => {
    joinHiveAsView.mockResolvedValue({ ok: false, members: [], error: 'invalid_member_links' });
    const { status, body } = await post({ hiveId: 'acme', memberLinks: [LINK] });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_member_links' });
    expect(bustProjectsLiteCache).not.toHaveBeenCalled();
  });

  it.each(['view_slug_exhausted', 'no_member_joined', 'anything_else'])(
    'maps a non-invalid_member_links failure (%s) → 502',
    async (error) => {
      joinHiveAsView.mockResolvedValue({ ok: false, members: [], error });
      const { status, body } = await post({ hiveId: 'acme', memberLinks: [LINK] });
      expect(status).toBe(502);
      expect(body).toMatchObject({ code: error });
    },
  );

  it('forwards an optional title and busts the lite cache on success', async () => {
    const { status, body } = await post({ hiveId: 'acme', title: 'Acme Hive', memberLinks: [LINK] });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({ hiveId: 'acme', title: 'Acme Hive', workspaceId: 'ws-test' });
    expect(bustProjectsLiteCache).toHaveBeenCalledTimes(1);
  });

  it('forwards an optional hivePubkey so stale discovery caches do not block re-keying', async () => {
    await post({ hiveId: 'acme', hivePubkey: '  pubkey==  ', memberLinks: [LINK] });
    expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({ hivePubkey: 'pubkey==' });
  });

  it('accepts the WI-931 offer shape — { hiveId, memberLinks, hivePubkey } a fresh hive now yields — and forwards it (no 400)', async () => {
    // The memberLinks + hivePubkey the from-repo `created` response now surfaces
    // (hive-publish-from-repo PublishCreatedHiveOutcome) are exactly this route's
    // accepted body — proving a freshly-created hive's offer is directly joinable.
    const { status, body } = await post({
      hiveId: 'shop-hive',
      memberLinks: [LINK],
      hivePubkey: 'HIVEPUB==',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({
      hiveId: 'shop-hive',
      memberLinks: [LINK],
      hivePubkey: 'HIVEPUB==',
    });
  });

  it('omits a blank title (defaults downstream)', async () => {
    await post({ hiveId: 'acme', title: '   ', memberLinks: [LINK] });
    expect(joinHiveAsView.mock.calls[0][0]).not.toHaveProperty('title');
  });
});
