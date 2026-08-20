/**
 * join-pot.test.ts — POST /api/discovery/join-pot (hive-from-repo-hardening
 * P-007 / D-007), the directory panel's "Join the HIVE" action. This is the
 * side-effecting discovery route (N member joins = N read-only clones +
 * admission/federation), so the test pins that a malformed body 400s BEFORE
 * joinHiveAsView runs, the invalid_member_links→400 vs else→502 map, and the
 * exact forwarded shape.
 *
 * Gap 9 — discovery routes zero tests; join-pot prioritized for its side effects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const joinHiveAsView = vi.fn();
const bustProjectsLiteCache = vi.fn();
const ensureHiveDirectoryWired = vi.fn();
vi.mock('../../../harness/join-hive', () => ({
  joinHiveAsView: (...a: unknown[]) => joinHiveAsView(...a),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../harness/projects-lite', () => ({
  bustProjectsLiteCache: (...a: unknown[]) => bustProjectsLiteCache(...a),
  buildProjectsLitePayload: vi.fn(async () => ({ projects: [] })),
}));
vi.mock('../../../hive-directory-boot', () => ({
  ensureHiveDirectoryWired: (...a: unknown[]) => ensureHiveDirectoryWired(...a),
}));

import joinHiveRoute from './join-pot';

const LINK = 'papercusp://harness?topic=' + 'a'.repeat(64);

async function post(body: unknown, { raw }: { raw?: string } = {}) {
  const req = new Request('http://127.0.0.1/api/discovery/join-pot', {
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
  ensureHiveDirectoryWired.mockReset();
  joinHiveAsView.mockResolvedValue({ ok: true, members: [{ slug: 'm', ok: true }], viewSlug: 'acme' });
  ensureHiveDirectoryWired.mockResolvedValue({ joinInviteTopic: vi.fn() });
});

describe('POST /api/discovery/join-pot (Gap 9)', () => {
  it('declares the loopback auth tier (auth-tier Wave 1)', () => {
    expect((joinHiveRoute as { auth?: unknown }).auth).toBe('loopback');
  });

  it.each([
    ['missing both', {}],
    ['empty potId', { potId: '', memberLinks: [LINK] }],
    ['no member links', { potId: 'acme', memberLinks: [] }],
    ['memberLinks not an array', { potId: 'acme', memberLinks: LINK }],
    ['member links all non-string', { potId: 'acme', memberLinks: [1, 2, null] }],
    ['member links all empty strings', { potId: 'acme', memberLinks: ['', ''] }],
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
    const { status, body } = await post({ potId: 'acme', memberLinks: Array(65).fill(LINK) });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_args' });
    expect(joinHiveAsView).not.toHaveBeenCalled();
  });

  it('filters non-string / empty member links before forwarding', async () => {
    await post({ potId: 'acme', memberLinks: [LINK, '', 3, null, LINK] });
    expect(joinHiveAsView).toHaveBeenCalledTimes(1);
    expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({ potId: 'acme', memberLinks: [LINK, LINK] });
  });

  it('400s invalid_member_links from the composition', async () => {
    joinHiveAsView.mockResolvedValue({ ok: false, members: [], error: 'invalid_member_links' });
    const { status, body } = await post({ potId: 'acme', memberLinks: [LINK] });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_member_links' });
    expect(bustProjectsLiteCache).not.toHaveBeenCalled();
  });

  it.each(['view_slug_exhausted', 'no_member_joined', 'anything_else'])(
    'maps a non-invalid_member_links failure (%s) → 502',
    async (error) => {
      joinHiveAsView.mockResolvedValue({ ok: false, members: [], error });
      const { status, body } = await post({ potId: 'acme', memberLinks: [LINK] });
      expect(status).toBe(502);
      expect(body).toMatchObject({ code: error });
    },
  );

  it('forwards an optional title and busts the lite cache on success', async () => {
    const { status, body } = await post({ potId: 'acme', title: 'Acme Hive', memberLinks: [LINK] });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({ potId: 'acme', title: 'Acme Hive', workspaceId: 'ws-test' });
    expect(bustProjectsLiteCache).toHaveBeenCalledTimes(1);
  });

  it('forwards an optional hivePubkey so stale discovery caches do not block re-keying', async () => {
    await post({ potId: 'acme', hivePubkey: '  pubkey==  ', memberLinks: [LINK] });
    expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({ hivePubkey: 'pubkey==' });
  });

  // WI-38343: the owner-device binding is what the substrate's owner-bootstrap
  // admit resolves from (hive-membership-store leg 0 / Brief-3, the DETERMINISTIC
  // leg). This join-BY-ID route never forwarded one, and a join-by-id caller has
  // no other source: the observed gist-less owner path omitted the normally
  // link-carried binding (WI-38345), and the local-directory fallback was empty
  // on a fresh joiner. Live-reproduced on the
  // 2-machine gate rig — `owner-resolve → ownerDevice=<null>` on the joiner, the
  // owner's announce conclusively rejected `binding_invalid`, and since announces
  // are never re-delivered the A→B stall is PERMANENT (0 pot_members).
  describe('owner-device binding (WI-38343)', () => {
    it('forwards an optional ownerDevicePubkey so the joiner can stamp the binding without directory timing', async () => {
      await post({ potId: 'acme', ownerDevicePubkey: '  ownerdev==  ', memberLinks: [LINK] });
      expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({ ownerDevicePubkey: 'ownerdev==' });
    });

    it.each([
      ['blank', '   '],
      ['empty', ''],
      ['non-string', 42],
    ])('omits a %s ownerDevicePubkey rather than forwarding a junk binding', async (_l, v) => {
      await post({ potId: 'acme', ownerDevicePubkey: v, memberLinks: [LINK] });
      expect(joinHiveAsView.mock.calls[0][0]).not.toHaveProperty('ownerDevicePubkey');
    });

    it('forwards hivePubkey and ownerDevicePubkey together — the pair the owner-bootstrap admit needs', async () => {
      const { status } = await post({
        potId: 'shop-hive',
        hivePubkey: 'HIVEPUB==',
        ownerDevicePubkey: 'OWNERDEV==',
        memberLinks: [LINK],
      });
      expect(status).toBe(200);
      expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({
        potId: 'shop-hive',
        hivePubkey: 'HIVEPUB==',
        ownerDevicePubkey: 'OWNERDEV==',
      });
    });
  });

  it('accepts the WI-931 offer shape — { potId, memberLinks, hivePubkey } a fresh hive now yields — and forwards it (no 400)', async () => {
    // The memberLinks + hivePubkey the from-repo `created` response now surfaces
    // (hive-publish-from-repo PublishCreatedHiveOutcome) are exactly this route's
    // accepted body — proving a freshly-created hive's offer is directly joinable.
    const { status, body } = await post({
      potId: 'shop-hive',
      memberLinks: [LINK],
      hivePubkey: 'HIVEPUB==',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({
      potId: 'shop-hive',
      memberLinks: [LINK],
      hivePubkey: 'HIVEPUB==',
    });
  });

  it('omits a blank title (defaults downstream)', async () => {
    await post({ potId: 'acme', title: '   ', memberLinks: [LINK] });
    expect(joinHiveAsView.mock.calls[0][0]).not.toHaveProperty('title');
  });

  // WI-5672: this route (what the gate rig's rig_join_hive / discovery-panel
  // "Join" both drive) used to skip ensureHiveDirectoryWired entirely — unlike
  // papercusp-hive-join.ts's canonical dogfood-bootstrap join, which wires the
  // hive-directory topic BEFORE joining. Live-reproduced on the 2-machine gate
  // rig: the joiner's serve.log never emitted a single
  // `[topic-gossip:papercusp/hive-directory]` line. These pin the fix.
  describe('hive-directory wiring (WI-5672)', () => {
    it('wires the hive directory for the active workspace BEFORE joining', async () => {
      const order: string[] = [];
      ensureHiveDirectoryWired.mockImplementation(async () => {
        order.push('wired');
        return { joinInviteTopic: vi.fn() };
      });
      joinHiveAsView.mockImplementation(async () => {
        order.push('joined');
        return { ok: true, members: [{ slug: 'm', ok: true }], viewSlug: 'acme' };
      });
      const { status } = await post({ potId: 'acme', memberLinks: [LINK] });
      expect(status).toBe(200);
      expect(ensureHiveDirectoryWired).toHaveBeenCalledTimes(1);
      expect(ensureHiveDirectoryWired).toHaveBeenCalledWith('ws-test');
      expect(order).toEqual(['wired', 'joined']);
    });

    it('is best-effort: a directory-wiring failure never blocks the join', async () => {
      ensureHiveDirectoryWired.mockRejectedValue(new Error('directory wiring stalled'));
      const { status, body } = await post({ potId: 'acme', memberLinks: [LINK] });
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true });
      expect(joinHiveAsView).toHaveBeenCalledTimes(1);
    });

    it('still wires the directory even for an invalid_args request path it never reaches — i.e. wiring only runs past validation', async () => {
      await post({ potId: '', memberLinks: [] });
      expect(ensureHiveDirectoryWired).not.toHaveBeenCalled();
      expect(joinHiveAsView).not.toHaveBeenCalled();
    });
  });
});
