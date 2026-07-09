/**
 * beacon-consent.test.ts — GET/POST /api/discovery/beacon-consent
 * (hive-network-surface-2026-06-11 P-005, B-07 / C-2), the hive header strip's
 * beacon toggle. Following the join-invite.test.ts template: assert the loopback
 * tier on both verbs, the body/query validation 400s (no accessor touched), the
 * default-OFF read, and the set error map (no Hive → 404 hive_not_found, else →
 * 502 set_failed).
 *
 * Gap 9 — discovery routes zero tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBeaconPublishConsent = vi.fn();
const setBeaconPublishConsent = vi.fn();
vi.mock('../../../beacon-consent', () => ({
  getBeaconPublishConsent: (...a: unknown[]) => getBeaconPublishConsent(...a),
  setBeaconPublishConsent: (...a: unknown[]) => setBeaconPublishConsent(...a),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import routes from './beacon-consent';

const getRoute = (routes as Array<{ method: string }>).find((r) => r.method === 'GET') as unknown as {
  auth?: string;
  handler: (req: Request, ctx: unknown) => Promise<Response>;
};
const setRoute = (routes as Array<{ method: string }>).find((r) => r.method === 'POST') as unknown as {
  auth?: string;
  handler: (req: Request, ctx: unknown) => Promise<Response>;
};

async function get(query: string) {
  const res = await getRoute.handler(new Request('http://127.0.0.1/api/discovery/beacon-consent' + query), {});
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
async function post(body: unknown, { raw }: { raw?: string } = {}) {
  const req = new Request('http://127.0.0.1/api/discovery/beacon-consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  const res = await setRoute.handler(req, {});
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeEach(() => {
  getBeaconPublishConsent.mockReset();
  setBeaconPublishConsent.mockReset();
});

describe('GET /api/discovery/beacon-consent (Gap 9)', () => {
  it('declares the loopback auth tier', () => {
    expect(getRoute.auth).toBe('loopback');
  });

  it('400s a missing potId WITHOUT touching the accessor', async () => {
    const { status, body } = await get('');
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_args' });
    expect(getBeaconPublishConsent).not.toHaveBeenCalled();
  });

  it('projects the stored consent for a present potId', async () => {
    getBeaconPublishConsent.mockResolvedValue(true);
    const { status, body } = await get('?potId=acme');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, potId: 'acme', consent: true });
    expect(getBeaconPublishConsent).toHaveBeenCalledWith('ws-test', 'acme');
  });

  it('reads consent:false when absent (default-OFF, D-002) — and degrades on accessor throw', async () => {
    getBeaconPublishConsent.mockRejectedValue(new Error('pg down'));
    const { status, body } = await get('?potId=acme');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, potId: 'acme', consent: false });
  });
});

describe('POST /api/discovery/beacon-consent (Gap 9)', () => {
  it('declares the loopback auth tier', () => {
    expect(setRoute.auth).toBe('loopback');
  });

  it.each([
    ['missing potId', { consent: true }],
    ['empty potId', { potId: '', consent: true }],
  ])('400s invalid_args (%s) WITHOUT touching the accessor', async (_l, body) => {
    const { status, body: out } = await post(body);
    expect(status).toBe(400);
    expect(out).toMatchObject({ code: 'invalid_args' });
    expect(setBeaconPublishConsent).not.toHaveBeenCalled();
  });

  it.each([
    ['non-boolean consent (string)', { potId: 'acme', consent: 'yes' }],
    ['missing consent', { potId: 'acme' }],
  ])('400s a non-boolean consent (%s) without touching the accessor', async (_l, body) => {
    const { status, body: out } = await post(body);
    expect(status).toBe(400);
    expect(out).toMatchObject({ code: 'invalid_args' });
    expect(setBeaconPublishConsent).not.toHaveBeenCalled();
  });

  it('400s a malformed (non-JSON) body without touching the accessor', async () => {
    const { status, body } = await post(undefined, { raw: 'x{' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_args' });
    expect(setBeaconPublishConsent).not.toHaveBeenCalled();
  });

  it('persists a valid consent and echoes it back', async () => {
    setBeaconPublishConsent.mockResolvedValue(undefined);
    const { status, body } = await post({ potId: 'acme', consent: true });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, potId: 'acme', consent: true });
    expect(setBeaconPublishConsent).toHaveBeenCalledWith('ws-test', 'acme', true);
  });

  it('persists consent:false (explicit opt-out)', async () => {
    setBeaconPublishConsent.mockResolvedValue(undefined);
    const { status, body } = await post({ potId: 'acme', consent: false });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, potId: 'acme', consent: false });
  });

  it('404s hive_not_found when the underlying store rejects with a "no Hive" message', async () => {
    setBeaconPublishConsent.mockRejectedValue(new Error('no Hive named acme in this workspace'));
    const { status, body } = await post({ potId: 'acme', consent: true });
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: 'hive_not_found' });
  });

  it('502s set_failed for any other store error', async () => {
    setBeaconPublishConsent.mockRejectedValue(new Error('connection reset'));
    const { status, body } = await post({ potId: 'acme', consent: true });
    expect(status).toBe(502);
    expect(body).toMatchObject({ code: 'set_failed' });
  });
});
