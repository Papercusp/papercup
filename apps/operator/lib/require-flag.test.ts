/**
 * Coverage for the server-side feature-flag gates: requireFlag (page server
 * components → notFound() when off) and gateApiRoute (route handlers → 404
 * NextResponse when off, null when on). next/navigation + next/server + the
 * flag server are mocked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const notFound = vi.fn();
vi.mock('next/navigation', () => ({ notFound: () => notFound() }));
vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status }) },
}));
const getFlag = vi.fn();
vi.mock('@papercusp/flags/server', () => ({ getFlag: (...a: unknown[]) => getFlag(...a) }));
vi.mock('./flag-distinct-id', () => ({ resolveDistinctId: () => 'did' }));
vi.mock('@/lib/flag-bus', () => ({}));

import { requireFlag, gateApiRoute } from './require-flag';

const KEY = 'snapshots' as never;
afterEach(() => vi.clearAllMocks());

describe('requireFlag', () => {
  it('no-ops when the flag is on', async () => {
    getFlag.mockResolvedValue(true);
    await requireFlag(KEY);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('calls notFound() when the flag is off', async () => {
    getFlag.mockResolvedValue(false);
    await requireFlag(KEY);
    expect(notFound).toHaveBeenCalledOnce();
  });
});

describe('gateApiRoute', () => {
  const req = new Request('http://localhost/api/x');

  it('returns null (continue) when the flag is on', async () => {
    getFlag.mockResolvedValue(true);
    expect(await gateApiRoute(req, KEY)).toBeNull();
  });

  it('returns a 404 feature-disabled response when the flag is off', async () => {
    getFlag.mockResolvedValue(false);
    const res = await gateApiRoute(req, KEY);
    expect(res).toEqual({
      body: { ok: false, reason: 'feature-disabled', flag: KEY },
      status: 404,
    });
  });
});
