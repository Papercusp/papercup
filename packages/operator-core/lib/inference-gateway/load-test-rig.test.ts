/**
 * Regression rig for the bare-burst-429 storm (inference-gateway-stability-ownership P-001).
 *
 * Boots a real gateway against a MOCK upstream that enforces a per-account sub-minute BURST cap and
 * returns a BARE-burst 429 on overshoot, fires a fleet-concurrency burst, and measures BOTH the
 * bee-facing failures (final 503 / forwarded 429) AND the upstream-429 count (the storm magnitude the
 * absorb layer hides). The FIX (smoothRpm) is the one lever flipped between the OFF (storm) and ON
 * (smoothed) runs — this is what every later fix is measured against, and the substrate for the
 * mechanism verdict (P-002) and the second-driver probe (P-004).
 *
 * Real timers (the gateway's pacing/absorb use real setTimeout); each case sets a generous timeout.
 */
import { test, beforeEach, expect } from 'vitest';
import { resetGovernorRegistry, setGlobalConcurrencyCap } from '@papercusp/papercusp-shared/agent';
import { runGatewayBurstRig } from './load-test-rig';

beforeEach(() => {
  // The governor registry + fleet gate are process singletons — clear learned rpmFactor / windows and
  // disable the fleet-wide concurrency cap so each run starts clean and the gateway's OWN queue is the
  // concurrency authority under test.
  resetGovernorRegistry();
  setGlobalConcurrencyCap(undefined);
});

test('OFF (no smoothing) — a fleet-concurrency burst REPRODUCES the upstream bare-burst 429 storm', async () => {
  // 4 accounts, 12 requests (3/account) fired at once; the upstream 429s the 3rd+ within any 1s window
  // (burstCap 2). With no pacing the whole per-account allowance fires instantly → the burst trips.
  const r = await runGatewayBurstRig({ accounts: 4, n: 12, burstCap: 2, burstWindowMs: 1000, smoothRpm: false });
  // The storm is real at the upstream: at least one bare-burst 429 per account (the 3rd of 3 bursts).
  expect(r.upstream429).toBeGreaterThanOrEqual(4);
  // The gateway's own counter corroborates the mock tally (same upstream 429s observed).
  expect(r.gatewayUpstream429).toBeGreaterThanOrEqual(4);
  // The 429 clustered across accounts (rotation didn't outrun it) — the storm signature, not one bad account.
  expect(Object.keys(r.perAccount429).length).toBeGreaterThanOrEqual(2);
}, 45_000);

test('WI-673 — cross-account bare-burst cluster suppresses rotate-retry during ramp (no retry fan-out)', async () => {
  // Residual production storm: requests were far below the 45/min/account floor, but one bare-burst
  // rotated 400ms later onto a fresh account, making a rapid A→B→C cross-account cluster. The fix
  // treats a short-window cluster across distinct accounts as fleet-wide *before* half the pool is
  // already exhausted, so only the first ramp request may rotate; the rest wait/retry on their own
  // account instead of multiplying upstream calls across the pool.
  const r = await runGatewayBurstRig({
    accounts: 8,
    n: 16,
    burstCap: 1,
    burstWindowMs: 100,
    smoothRpm: false,
    concurrency: 16,
    maxQueueWaitMs: 2000,
    requestAbsorbMs: 1500,
    bare429FailoverBackoffMs: 250,
  });
  expect(r.ok).toBe(16);
  expect(r.upstream429).toBe(8);
  expect(r.failovers).toBeLessThanOrEqual(1);
  expect(r.bareBurstRotateSuppressed).toBeGreaterThanOrEqual(7);
  expect(r.upstreamCallsPerRequest).toBeLessThanOrEqual(1.5);
}, 15_000);


test('ON (smoothRpm) — smoothing ELIMINATES the sub-minute burst and is throughput-neutral', async () => {
  // Same burst, smoothing on: each account paces at 60_000/45 ≈ 1334ms > the 1s burst window, so at most
  // ONE request lands per window per account → zero bursts, and every request still completes (the count
  // gate caps the rate, smoothing only spreads it).
  const r = await runGatewayBurstRig({ accounts: 4, n: 12, burstCap: 2, burstWindowMs: 1000, smoothRpm: true, maxQueueWaitMs: 12_000 });
  expect(r.upstream429).toBe(0); // the burst-dodge fully prevents the sub-minute storm
  expect(r.ok).toBe(12); // throughput-neutral: all delivered
  expect(r.beeFacing429).toBe(0);
  expect(r.beeFacing503).toBe(0);
}, 45_000);

test('the rig surfaces BEE-FACING failures too — a harsh storm under a tight absorb budget leaks 503/429 to the bee', async () => {
  // burstCap 1 + a 2s window, but only a 250ms absorb budget: the gateway can't outlast the window by
  // retrying, so the storm leaks past absorb to the bee as a final 503 / forwarded 429 — the symptom the
  // upstream-429 count alone would hide. This is the rig measuring the OTHER layer P-001 asks for.
  const r = await runGatewayBurstRig({ accounts: 2, n: 10, burstCap: 1, burstWindowMs: 2000, smoothRpm: false, maxQueueWaitMs: 250, requestAbsorbMs: 250 });
  expect(r.upstream429).toBeGreaterThan(0); // storm at the upstream
  expect(r.beeFacing429 + r.beeFacing503).toBeGreaterThan(0); // and it reached the bee (absorb couldn't hide it)
}, 45_000);
