/**
 * rate-state route — unit tests (WI-253 / findings-EN-4.md "EN-1 GUI snapshot surface").
 * Drives `runGetRateState` with injected deps so booted/unbooted + capped/uncapped are
 * tested without a real boot substrate or PG.
 *
 * TEETH: no registered limiter ⇒ `booted:false, rows:[]` (never throws, never fabricates
 * data); a registered limiter's `snapshot()` output passes through with the live policy's
 * `rate` caps fed in — removing the `caps` wiring would flip a capped row's `cap` to null.
 */
import { describe, it, expect, vi } from 'vitest';
import { runGetRateState } from './rate-state';
import type { MemberRateLimiter, RateStateRow } from '../../../sync/hyperbee/rate-limiter';
import type { ResolvedHivePolicy } from '../../../hive-policy-store';

const WS = 'ws';
const HOME = 'home';

function fakeLimiter(rows: RateStateRow[]): MemberRateLimiter {
  return { snapshot: vi.fn(() => rows) } as unknown as MemberRateLimiter;
}

function resolvedPolicy(rate: ResolvedHivePolicy['policy']['rate']): ResolvedHivePolicy {
  return {
    workspaceId: WS,
    potHomeSlug: HOME,
    policy: { membership: 'open', rate },
    policyVersion: 1,
    ownerPubkey: 'pk',
    signature: 'sig',
    policyJson: '{}',
    fedHlc: 'h',
    updatedAt: 1,
  };
}

describe('runGetRateState', () => {
  it('not booted on this machine ⇒ booted:false, rows:[] (never throws)', async () => {
    const res = await runGetRateState(WS, HOME, {
      getRateLimiter: () => undefined,
      getHivePolicy: vi.fn(async () => null),
    });
    expect(res).toEqual({ ok: true, booted: false, rows: [] });
  });

  it('booted + a policy with caps ⇒ passes the live caps into snapshot()', async () => {
    const row: RateStateRow = {
      authorId: 42,
      cls: 'ops',
      count: 3,
      cap: null, // the fake limiter ignores the arg; asserted via the spy call below
      throttled: false,
      windowMs: 60_000,
      windowStartMs: 0,
      hwmWindow: 0,
      skewWindows: 0,
      suspectedTimestampSkew: false,
    };
    const limiter = fakeLimiter([row]);
    const getHivePolicy = vi.fn(async () => resolvedPolicy({ opsPerMin: 10 }));
    const res = await runGetRateState(WS, HOME, { getRateLimiter: () => limiter, getHivePolicy });
    expect(res).toEqual({ ok: true, booted: true, rows: [row] });
    expect(limiter.snapshot).toHaveBeenCalledWith({ opsPerMin: 10 });
  });

  it('booted + NO policy row ⇒ snapshot() called with null caps (uncapped default)', async () => {
    const limiter = fakeLimiter([]);
    const res = await runGetRateState(WS, HOME, {
      getRateLimiter: () => limiter,
      getHivePolicy: vi.fn(async () => null),
    });
    expect(res.booted).toBe(true);
    expect(limiter.snapshot).toHaveBeenCalledWith(null);
  });

  it('a "relation does not exist" policy-read error is swallowed (treated as uncapped), not thrown', async () => {
    const limiter = fakeLimiter([]);
    const getHivePolicy = vi.fn(async () => {
      throw new Error('relation "harness_shared.hive_policy" does not exist');
    });
    const res = await runGetRateState(WS, HOME, { getRateLimiter: () => limiter, getHivePolicy });
    expect(res.booted).toBe(true);
    expect(limiter.snapshot).toHaveBeenCalledWith(null);
  });

  it('TEETH: a genuine (non-missing-table) policy-read error propagates', async () => {
    const limiter = fakeLimiter([]);
    const getHivePolicy = vi.fn(async () => {
      throw new Error('connection reset');
    });
    await expect(
      runGetRateState(WS, HOME, { getRateLimiter: () => limiter, getHivePolicy }),
    ).rejects.toThrow('connection reset');
  });
});
