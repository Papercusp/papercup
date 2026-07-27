/**
 * WI-3590 unit tests for the D-007 PHYSICS layer (live-headroom.ts).
 *
 * The property that matters most here is the SAFETY one: PHYSICS may only ever LOWER what POLICY
 * already allowed. Every "unknown" input must resolve to 0 rather than to a guess, because this
 * gate admits FOREIGN CODE EXECUTION — a fail-open here is not a wrong number, it is an
 * unauthorized spawn.
 */
import { describe, expect, it } from 'vitest';
import { localLiveHeadroom, remoteLiveHeadroom } from './live-headroom';
import type { GatewayHeadroom, LocalBackendsSnapshot } from '../inference-gateway/observability';
import type { LocalBackendCandidate } from '../inference-gateway/local-backend-pool';

const CAP = 1_000_000; // $1 in usd-micros

/** A healthy, 0%-utilized gateway read — the "physics does not bind" baseline. */
const healthy = (over: Partial<GatewayHeadroom> = {}): GatewayHeadroom => ({
  reachable: true,
  window: '5h',
  utilization: 0,
  utilizationPct: 0,
  rejected: false,
  paused: false,
  healthyAccounts: 3,
  ...over,
});

const candidate = (over: Partial<LocalBackendCandidate['backend']> = {}, rest: Partial<LocalBackendCandidate> = {}): LocalBackendCandidate => ({
  backend: { id: 'a', kind: 'llama-server', baseUrl: 'http://127.0.0.1:9001', models: ['m'], maxConcurrent: 4, enabled: true, ...over },
  inFlight: 0,
  healthy: true,
  ...rest,
});

const pool = (candidates: LocalBackendCandidate[], over: Partial<LocalBackendsSnapshot> = {}): LocalBackendsSnapshot => ({
  reachable: true,
  configured: true,
  candidates,
  ...over,
});

describe('remoteLiveHeadroom — every unknown fails closed', () => {
  it('returns 0 when the gateway is unreachable (silence is not capacity)', () => {
    const r = remoteLiveHeadroom({ reachable: false, error: 'ECONNREFUSED' }, CAP);
    expect(r.headroom).toBe(0);
    expect(r.reason).toBe('gateway_unreachable');
  });

  it('returns 0 when the gateway is paused with no tier capacity', () => {
    const r = remoteLiveHeadroom(healthy({ paused: true, pausedUntil: 1_000 }), CAP);
    expect(r.headroom).toBe(0);
    expect(r.reason).toBe('gateway_paused');
  });

  it('returns 0 when the binding window is hard-rejected', () => {
    const r = remoteLiveHeadroom(healthy({ rejected: true, resetInSec: 42 }), CAP);
    expect(r.headroom).toBe(0);
    expect(r.reason).toBe('window_rejected');
  });

  it('returns 0 when the pool reports no serviceable accounts', () => {
    const r = remoteLiveHeadroom(healthy({ healthyAccounts: 0 }), CAP);
    expect(r.headroom).toBe(0);
    expect(r.reason).toBe('no_healthy_accounts');
  });

  it('returns 0 when utilization is UNKNOWN — no data is not the same as no load', () => {
    const r = remoteLiveHeadroom(healthy({ utilization: undefined }), CAP);
    expect(r.headroom).toBe(0);
    expect(r.reason).toBe('utilization_unknown');
  });

  it('does NOT zero a paused gateway that still has priority-tier capacity (the composite predicate decides, not the raw flag)', () => {
    const r = remoteLiveHeadroom(
      healthy({
        paused: true,
        pausedUntil: 1_000,
        priorityTiers: { healthyAccounts: 2, tier1Reserve: 1, tiers: [{ tier: 1, cap: 4, inFlight: 0, queued: 0 }] },
      }),
      CAP,
    );
    expect(r.headroom).toBe(CAP);
    expect(r.reason).toBe('derated_by_utilization');
  });
});

describe('remoteLiveHeadroom — the derating model', () => {
  it('does not bind at 0% utilization (POLICY governs)', () => {
    expect(remoteLiveHeadroom(healthy({ utilization: 0 }), CAP).headroom).toBe(CAP);
  });

  it('scales linearly with the binding window', () => {
    expect(remoteLiveHeadroom(healthy({ utilization: 0.25 }), CAP).headroom).toBe(750_000);
    // 99_999, not 100_000: `1 - 0.9` is 0.09999999999999998 in binary floating point and the
    // result is FLOORED. Pinned deliberately rather than smoothed away — the residue is one
    // micro-dollar and it always lands on the conservative side of the gate, which is the only
    // direction that is safe here.
    expect(remoteLiveHeadroom(healthy({ utilization: 0.9 }), CAP).headroom).toBe(99_999);
  });

  it('is 0 at (and beyond) the cap — a >1.0 utilization clamps, never goes negative', () => {
    expect(remoteLiveHeadroom(healthy({ utilization: 1 }), CAP).headroom).toBe(0);
    expect(remoteLiveHeadroom(healthy({ utilization: 1.4 }), CAP).headroom).toBe(0);
  });

  it('NEVER exceeds the policy cap it derates — the fail-closed invariant', () => {
    for (const u of [0, 0.1, 0.5, 0.99, 1, 2]) {
      for (const cap of [0, 1, 500, CAP]) {
        const h = remoteLiveHeadroom(healthy({ utilization: u }), cap).headroom;
        expect(h).toBeLessThanOrEqual(cap);
        expect(h).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('treats a negative allotmentRemaining as 0 rather than propagating it', () => {
    expect(remoteLiveHeadroom(healthy(), -50).headroom).toBe(0);
  });
});

describe('localLiveHeadroom', () => {
  it('returns 0 when the pool is unreadable', () => {
    const r = localLiveHeadroom(pool([], { reachable: false, error: 'gateway down' }));
    expect(r.headroom).toBe(0);
    expect(r.reason).toBe('pool_unreachable');
  });

  it('returns a known 0 when the gateway runs without a local pool', () => {
    const r = localLiveHeadroom(pool([], { configured: false }));
    expect(r.headroom).toBe(0);
    expect(r.reason).toBe('pool_not_configured');
  });

  it('sums free slots across eligible backends', () => {
    const r = localLiveHeadroom(pool([candidate({ id: 'a', maxConcurrent: 4 }, { inFlight: 1 }), candidate({ id: 'b', maxConcurrent: 2 }, { inFlight: 0 })]));
    expect(r.headroom).toBe(5); // (4-1) + (2-0)
    expect(r.reason).toBe('free_slots');
  });

  it('excludes disabled and unhealthy backends — capacity selection would refuse is not offerable', () => {
    const r = localLiveHeadroom(
      pool([
        candidate({ id: 'a', maxConcurrent: 4, enabled: false }),
        candidate({ id: 'b', maxConcurrent: 4 }, { healthy: false }),
        candidate({ id: 'c', maxConcurrent: 1 }),
      ]),
    );
    expect(r.headroom).toBe(1);
  });

  it('is 0 when every eligible backend is saturated (and never negative on an over-count)', () => {
    const r = localLiveHeadroom(pool([candidate({ id: 'a', maxConcurrent: 2 }, { inFlight: 2 }), candidate({ id: 'b', maxConcurrent: 1 }, { inFlight: 5 })]));
    expect(r.headroom).toBe(0);
  });
});
