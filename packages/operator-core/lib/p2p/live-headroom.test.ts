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
import { ENGINE_CAPACITY_FRESH_FOR_MS, type LocalBackendCandidate } from '../inference-gateway/local-backend-pool';

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

/**
 * A pool candidate.
 *
 * `engineFree` is the MEASURED engine reading (llama-server `/props`), which is what `freeSlots()`
 * — and therefore `localLiveHeadroom` — has counted since a525f934f0. Registry `maxConcurrent` is
 * policy/diagnostic metadata and is deliberately NOT a physical ceiling, so it is set here only to
 * prove it does not leak into the count. Pass `null` to model a backend with no fresh engine
 * evidence: headroom must fail CLOSED and count it as 0, even though routing treats an unknown
 * reading as unbounded.
 */
const candidate = (
  over: Partial<LocalBackendCandidate['backend']> = {},
  rest: Partial<LocalBackendCandidate> = {},
  engineFree: number | null = 0,
): LocalBackendCandidate => ({
  backend: { id: 'a', kind: 'llama-server', baseUrl: 'http://127.0.0.1:9001', models: ['m'], maxConcurrent: 4, enabled: true, ...over },
  inFlight: 0,
  healthy: true,
  engineCapacity:
    engineFree === null
      ? null
      : { freeSlots: engineFree, totalSlots: null, contextTokens: null, observedAtMs: Date.now(), source: 'test' },
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
    // Exactly 100_000, NOT 99_999: `1 - 0.9` carries binary-float residue, which the model rounds
    // away rather than leaking into a usd-micros figure a human will later read on a receipt.
    expect(remoteLiveHeadroom(healthy({ utilization: 0.9 }), CAP).headroom).toBe(100_000);
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

  it('sums MEASURED engine free slots across eligible backends', () => {
    const r = localLiveHeadroom(pool([candidate({ id: 'a', maxConcurrent: 4 }, { inFlight: 1 }, 3), candidate({ id: 'b', maxConcurrent: 2 }, { inFlight: 0 }, 2)]));
    expect(r.headroom).toBe(5); // 3 + 2, from the engine readings — NOT maxConcurrent − inFlight
    expect(r.reason).toBe('free_slots');
  });

  it('excludes disabled and unhealthy backends — capacity selection would refuse is not offerable', () => {
    const r = localLiveHeadroom(
      pool([
        candidate({ id: 'a', maxConcurrent: 4, enabled: false }, {}, 4),
        candidate({ id: 'b', maxConcurrent: 4 }, { healthy: false }, 4),
        candidate({ id: 'c', maxConcurrent: 1 }, {}, 1),
      ]),
    );
    // a and b each report 4 free slots and are still excluded: ineligible capacity is not offerable.
    expect(r.headroom).toBe(1);
  });

  it('is 0 when every eligible backend is saturated (and never negative on an over-count)', () => {
    const r = localLiveHeadroom(pool([candidate({ id: 'a', maxConcurrent: 2 }, { inFlight: 2 }, 0), candidate({ id: 'b', maxConcurrent: 1 }, { inFlight: 5 }, 0)]));
    expect(r.headroom).toBe(0);
  });

  // a525f934f0 made the engine reading the ONLY source of free slots and demoted registry
  // `maxConcurrent` to policy/diagnostic metadata. These two pin the fail-closed half of that
  // change at the localLiveHeadroom level: an unknown or stale reading may never be counted as
  // capacity, because this number gates FOREIGN CODE EXECUTION.
  it('counts a backend with NO fresh engine reading as 0 — headroom fails closed where routing treats it as unbounded', () => {
    const r = localLiveHeadroom(pool([candidate({ id: 'a', maxConcurrent: 4 }, { inFlight: 0 }, null), candidate({ id: 'b', maxConcurrent: 2 }, {}, 2)]));
    expect(r.headroom).toBe(2); // only b's measured reading counts; a contributes 0, never its maxConcurrent of 4
    expect(r.reason).toBe('free_slots');
  });

  it('counts a STALE engine reading as 0 (older than ENGINE_CAPACITY_FRESH_FOR_MS)', () => {
    const stale = candidate(
      { id: 'a', maxConcurrent: 4 },
      { engineCapacity: { freeSlots: 4, totalSlots: 4, contextTokens: null, observedAtMs: Date.now() - 10 * ENGINE_CAPACITY_FRESH_FOR_MS, source: 'test' } },
    );
    expect(localLiveHeadroom(pool([stale])).headroom).toBe(0);
  });
});
