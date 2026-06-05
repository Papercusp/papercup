/**
 * Coverage for gateApiRoute — the server-side feature-flag gate for Hono
 * route handlers (lib/endpoint-route/routes/**). Returns a 404 Web `Response`
 * when the flag is off, or `null` (continue) when on.
 *
 * The former page-side `requireFlag()` (a Next Server-Component gate using
 * `next/navigation`'s `notFound()`) was removed with the Next→Vite migration;
 * its SPA replacement + tests now live in
 * `apps/operator-vite/src/lib/require-flag.ts(.test.ts)`. See plan
 * `finish-next-removal-2026-06-01`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const getFlag = vi.fn();
vi.mock('@papercusp/flags/server', () => ({ getFlag: (...a: unknown[]) => getFlag(...a) }));
vi.mock('./flag-distinct-id', () => ({ resolveDistinctId: () => 'did' }));
vi.mock('./flag-bus', () => ({}));

import { gateApiRoute } from './require-flag';

const KEY = 'snapshots' as never;
afterEach(() => vi.clearAllMocks());

describe('gateApiRoute', () => {
  const req = new Request('http://localhost/api/x');

  it('returns null (continue) when the flag is on', async () => {
    getFlag.mockResolvedValue(true);
    expect(await gateApiRoute(req, KEY)).toBeNull();
  });

  it('returns a 404 feature-disabled Response when the flag is off', async () => {
    getFlag.mockResolvedValue(false);
    const res = await gateApiRoute(req, KEY);
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(404);
    expect(res!.headers.get('content-type')).toBe('application/json');
    expect(await res!.json()).toEqual({ ok: false, reason: 'feature-disabled', flag: KEY });
  });
});
