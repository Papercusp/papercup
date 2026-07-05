/**
 * set-hive.test.ts — POST /api/discovery/set-pot (hive-from-github-url P-015),
 * the hive header strip's create/edit/visibility-flip. Following the
 * join-invite.test.ts template: assert the loopback tier, the body validation
 * 400s (each fired WITHOUT touching the side-effecting setHiveListing), and the
 * happy path that forwards the EXACT shape into the composition.
 *
 * Gap 9 — discovery routes zero tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setHiveListing = vi.fn();
vi.mock('../../../hive-set-listing', () => ({
  setHiveListing: (...a: unknown[]) => setHiveListing(...a),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import setHiveRoute from './set-hive';

async function post(body: unknown, { raw }: { raw?: string } = {}) {
  const req = new Request('http://127.0.0.1/api/discovery/set-pot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  const res = (await setHiveRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeEach(() => {
  setHiveListing.mockReset();
  setHiveListing.mockResolvedValue({ ok: true, hiveId: 'h', visibility: 'public', saved: true, announced: true });
});

describe('POST /api/discovery/set-pot (Gap 9)', () => {
  it('declares the loopback auth tier (auth-tier Wave 1)', () => {
    expect((setHiveRoute as { auth?: unknown }).auth).toBe('loopback');
  });

  it.each([
    ['missing hiveId', { visibility: 'public' }],
    ['empty hiveId', { hiveId: '', visibility: 'public' }],
    ['whitespace hiveId', { hiveId: '   ', visibility: 'public' }],
  ])('400s invalid_args (%s) WITHOUT touching setHiveListing', async (_l, body) => {
    const { status, body: out } = await post(body);
    expect(status).toBe(400);
    expect(out).toMatchObject({ code: 'invalid_args' });
    expect(setHiveListing).not.toHaveBeenCalled();
  });

  it.each([
    ['missing visibility', { hiveId: 'h' }],
    ['bogus visibility', { hiveId: 'h', visibility: 'bogus' }],
  ])('400s an invalid visibility (%s) without touching setHiveListing', async (_l, body) => {
    const { status, body: out } = await post(body);
    expect(status).toBe(400);
    expect(out).toMatchObject({ code: 'invalid_args' });
    expect(setHiveListing).not.toHaveBeenCalled();
  });

  it('400s invite visibility with no inviteSecret without touching setHiveListing', async () => {
    const { status, body } = await post({ hiveId: 'h', visibility: 'invite' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_args' });
    expect(setHiveListing).not.toHaveBeenCalled();
  });

  it('400s a malformed (non-JSON) body without touching setHiveListing', async () => {
    const { status, body } = await post(undefined, { raw: 'nope{' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_args' });
    expect(setHiveListing).not.toHaveBeenCalled();
  });

  it('forwards a public listing into setHiveListing with the active workspace', async () => {
    const { status, body } = await post({ hiveId: 'acme', title: 'Acme', description: 'd', visibility: 'public' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(setHiveListing).toHaveBeenCalledTimes(1);
    expect(setHiveListing.mock.calls[0][0]).toMatchObject({
      hiveId: 'acme',
      title: 'Acme',
      description: 'd',
      visibility: 'public',
    });
    expect(setHiveListing.mock.calls[0][1]).toBe('ws-test');
  });

  it('defaults title to hiveId when omitted', async () => {
    await post({ hiveId: 'acme', visibility: 'public' });
    expect(setHiveListing.mock.calls[0][0]).toMatchObject({ title: 'acme' });
  });

  it('forwards inviteSecret for an invite listing', async () => {
    await post({ hiveId: 'acme', visibility: 'invite', inviteSecret: 'sekret' });
    expect(setHiveListing.mock.calls[0][0]).toMatchObject({ visibility: 'invite', inviteSecret: 'sekret' });
  });

  it('returns the composition result verbatim (private withdraw)', async () => {
    setHiveListing.mockResolvedValue({ ok: true, hiveId: 'acme', visibility: 'private', saved: true, announced: false, withdrawn: true });
    const { status, body } = await post({ hiveId: 'acme', visibility: 'private' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ visibility: 'private', withdrawn: true });
  });
});
