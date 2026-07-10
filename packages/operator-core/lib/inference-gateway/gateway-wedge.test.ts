/**
 * Tests for the gateway wedge/throttle detector (B-GW-5, inference-gateway-robustness-audit P3).
 * Pure — the "alert on a simulated wedge" acceptance lives entirely here (no IO, injected clock).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  summarizeGatewayMetrics,
  detectGatewayWedge,
  sampleGateway,
  WEDGE_FREEZE_PRIOR_MAX_AGE_MS,
  type RawGatewayStats,
  type GatewayMetrics,
} from './gateway-wedge';

const NOW = 1_750_000_000_000;

/** A healthy post-AIMD /stats payload: draining normally, slots free, no throttle. */
const healthyStats = (over: Partial<RawGatewayStats> = {}): RawGatewayStats => ({
  totalRequests: 1000,
  admission: { running: 3, queued: 0, maxConcurrent: 24 },
  upstream429: 0,
  queued429: 0,
  shed429: 0,
  upstreamErrors: 0,
  failovers: 0,
  shedAllThrottled: 0,
  concurrencyCap: 24,
  unified: { utilization: 0.4 },
  aimd: { effective: 24, cap: 24, floor: 4, decreases: 0 },
  ...over,
});

// ── summarizeGatewayMetrics ─────────────────────────────────────────────────────────────────────

test('summarizeGatewayMetrics — projects the post-AIMD structured bag', () => {
  const m = summarizeGatewayMetrics(
    healthyStats({ totalRequests: 4321, admission: { running: 24, queued: 7, maxConcurrent: 12 }, shed429: 5, shedAllThrottled: 2, failovers: 1, unified: { utilization: 0.97 }, aimd: { effective: 12, cap: 24, floor: 4, decreases: 3 } }),
  );
  assert.equal(m.totalRequests, 4321);
  assert.equal(m.inFlight, 24);
  assert.equal(m.queueDepth, 7);
  assert.equal(m.maxConcurrent, 12); // LIVE effective cap (AIMD-adjusted), not the ceiling
  assert.equal(m.concurrencyCap, 24);
  assert.equal(m.shed429, 5);
  assert.equal(m.shedAllThrottled, 2);
  assert.equal(m.failovers, 1);
  assert.equal(m.utilizationPct, 97);
  assert.equal(m.aimdEffective, 12);
  assert.equal(m.aimdCap, 24);
  assert.equal(m.aimdDecreases, 3);
  assert.equal(m.slotReconcileMismatch, 0); // healthy default
});

// ── P-005/W3 slot-leak recurrence guard (D-001): the slotReconcileMismatch → slotLeak verdict path ──

test('summarizeGatewayMetrics — projects slotReconcileMismatch; deploy-skew (pre-P-005 gateway omits it) → 0', () => {
  assert.equal(summarizeGatewayMetrics(healthyStats({ slotReconcileMismatch: 3 })).slotReconcileMismatch, 3);
  // A pre-P-005 /stats payload has no field → read as 0 (never throws), exactly like the AIMD deploy-skew.
  const legacy: RawGatewayStats = { totalRequests: 10, admission: { running: 2, queued: 0, maxConcurrent: 24 } };
  assert.equal(summarizeGatewayMetrics(legacy).slotReconcileMismatch, 0);
});

test('detectGatewayWedge — slotReconcileMismatch > 0 → slotLeak verdict + a leak reason (a leaked slot the valve cannot reclaim)', () => {
  // NOT saturated / not throttling — a pure leak signal must surface on its own, no prior sample needed.
  const v = detectGatewayWedge(summarizeGatewayMetrics(healthyStats({ slotReconcileMismatch: 2 })), undefined, NOW);
  assert.equal(v.slotLeak, true);
  assert.equal(v.wedge, false);
  assert.equal(v.saturated, false);
  assert.ok(v.reasons.some((r) => r.includes('slot-leak')), 'a slot-leak reason must be surfaced');
});

test('detectGatewayWedge — slotReconcileMismatch === 0 → no slotLeak (healthy)', () => {
  const v = detectGatewayWedge(summarizeGatewayMetrics(healthyStats()), undefined, NOW);
  assert.equal(v.slotLeak, false);
  assert.ok(!v.reasons.some((r) => r.includes('slot-leak')));
});

test('summarizeGatewayMetrics — DEPLOY-SKEW: a pre-AIMD gateway (no aimd/shedAllThrottled/concurrencyCap) degrades to nulls/0, never throws', () => {
  // Exactly the legacy /stats contract — the live :8788 binary before B-GW-1 deploys.
  const legacy: RawGatewayStats = {
    totalRequests: 50,
    inFlight: 2,
    queueDepth: 0,
    admission: { running: 2, queued: 0, maxConcurrent: 24 },
    upstream429: 0,
    queued429: 0,
    shed429: 0,
    upstreamErrors: 0,
    failovers: 0,
  };
  const m = summarizeGatewayMetrics(legacy);
  assert.equal(m.inFlight, 2);
  assert.equal(m.maxConcurrent, 24);
  assert.equal(m.shedAllThrottled, 0); // absent → 0
  assert.equal(m.concurrencyCap, null); // absent → null
  assert.equal(m.aimdEffective, null);
  assert.equal(m.aimdCap, null);
  assert.equal(m.aimdDecreases, null);
  assert.equal(m.utilizationPct, null); // no unified window seen
});

test('summarizeGatewayMetrics — falls back to top-level inFlight/queueDepth when admission snapshot absent', () => {
  const m = summarizeGatewayMetrics({ totalRequests: 9, inFlight: 5, queueDepth: 3, concurrencyCap: 24 });
  assert.equal(m.inFlight, 5);
  assert.equal(m.queueDepth, 3);
  assert.equal(m.maxConcurrent, 24); // from concurrencyCap when no admission snapshot
});

// ── detectGatewayWedge — healthy + saturation ─────────────────────────────────────────────────

test('detectGatewayWedge — healthy: not saturated, no wedge, no throttle', () => {
  const v = detectGatewayWedge(summarizeGatewayMetrics(healthyStats()), undefined, NOW);
  assert.equal(v.saturated, false);
  assert.equal(v.wedge, false);
  assert.equal(v.sustainedThrottle, false);
});

test('detectGatewayWedge — saturated but NO prior: saturated warn, but NOT a confirmed wedge', () => {
  const stats = healthyStats({ admission: { running: 24, queued: 6, maxConcurrent: 24 } });
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), undefined, NOW);
  assert.equal(v.saturated, true);
  assert.equal(v.wedge, false, 'cannot confirm the freeze without a recent prior');
  assert.ok(v.reasons.some((r) => r.includes('slot ceiling')));
});

test('detectGatewayWedge — inFlight at ceiling but EMPTY queue is NOT saturated (fully busy ≠ wedged)', () => {
  const stats = healthyStats({ admission: { running: 24, queued: 0, maxConcurrent: 24 } });
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), undefined, NOW);
  assert.equal(v.saturated, false);
  assert.equal(v.wedge, false);
});

// ── detectGatewayWedge — the WEDGE acceptance ─────────────────────────────────────────────────

test('detectGatewayWedge — SIMULATED WEDGE: saturated + totalRequests frozen vs a recent prior → wedge:true', () => {
  // The exact wedge signature: every slot pinned, a growing queue, and the request counter NOT moving.
  const stats = healthyStats({ totalRequests: 5000, admission: { running: 24, queued: 30, maxConcurrent: 24 } });
  const prior = { totalRequests: 5000, shed429: 0, shedAllThrottled: 0, at: NOW - 90_000 }; // 90s ago, same count
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), prior, NOW);
  assert.equal(v.saturated, true);
  assert.equal(v.wedge, true, 'frozen-while-saturated is the wedge');
  assert.ok(v.reasons.some((r) => r.includes('frozen')));
});

test('detectGatewayWedge — saturated but totalRequests ADVANCING vs prior → NOT a wedge (still draining)', () => {
  const stats = healthyStats({ totalRequests: 5050, admission: { running: 24, queued: 30, maxConcurrent: 24 } });
  const prior = { totalRequests: 5000, shed429: 0, shedAllThrottled: 0, at: NOW - 90_000 }; // advanced 50
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), prior, NOW);
  assert.equal(v.saturated, true);
  assert.equal(v.wedge, false, 'requests are still flowing — paced/busy, not wedged');
});

test('detectGatewayWedge — frozen but a STALE prior (>5min) → NOT a wedge (a long-quiet gateway is legitimately flat)', () => {
  const stats = healthyStats({ totalRequests: 5000, admission: { running: 24, queued: 30, maxConcurrent: 24 } });
  const prior = { totalRequests: 5000, shed429: 0, shedAllThrottled: 0, at: NOW - (WEDGE_FREEZE_PRIOR_MAX_AGE_MS + 60_000) };
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), prior, NOW);
  assert.equal(v.saturated, true);
  assert.equal(v.wedge, false, 'a stale prior cannot confirm the freeze');
});

test('detectGatewayWedge — minFreezeMs gates the wedge: a freeze younger than the min is NOT yet a wedge', () => {
  const stats = healthyStats({ totalRequests: 5000, admission: { running: 24, queued: 30, maxConcurrent: 24 } });
  const m = summarizeGatewayMetrics(stats);
  // Anchor only 30s old, min-freeze 60s → saturated but not yet a confirmed wedge.
  const young = { totalRequests: 5000, shed429: 0, shedAllThrottled: 0, at: NOW - 30_000 };
  assert.equal(detectGatewayWedge(m, young, NOW, { minFreezeMs: 60_000 }).wedge, false);
  // Anchor 75s old, min-freeze 60s → the freeze has persisted → wedge.
  const old = { totalRequests: 5000, shed429: 0, shedAllThrottled: 0, at: NOW - 75_000 };
  assert.equal(detectGatewayWedge(m, old, NOW, { minFreezeMs: 60_000 }).wedge, true);
});

// ── detectGatewayWedge — sustained throttle ───────────────────────────────────────────────────

test('detectGatewayWedge — AIMD effective < cap → sustainedThrottle (the B-GW-1 adaptive-throttle signal)', () => {
  const stats = healthyStats({ aimd: { effective: 6, cap: 24, floor: 4, decreases: 5 } });
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), undefined, NOW);
  assert.equal(v.sustainedThrottle, true);
  assert.ok(v.reasons.some((r) => r.includes('AIMD throttled')));
});

test('detectGatewayWedge — fail-fast all-throttled shedding climbing vs prior → sustainedThrottle', () => {
  const stats = healthyStats({ shedAllThrottled: 12 });
  const prior = { totalRequests: 1000, shed429: 0, shedAllThrottled: 4, at: NOW - 30_000 };
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), prior, NOW);
  assert.equal(v.sustainedThrottle, true);
  assert.ok(v.reasons.some((r) => r.includes('all accounts throttled')));
});

test('detectGatewayWedge — admission backlog load-shed climbing vs prior → sustainedThrottle', () => {
  const stats = healthyStats({ shed429: 9 });
  const prior = { totalRequests: 1000, shed429: 2, shedAllThrottled: 0, at: NOW - 30_000 };
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), prior, NOW);
  assert.equal(v.sustainedThrottle, true);
  assert.ok(v.reasons.some((r) => r.includes('admission backlog full')));
});

test('detectGatewayWedge — transport-STALL storm (fault #5): upstreamErrors climbing past the delta vs prior → sustainedThrottle even with upstream429 FLAT + AIMD un-shrunk', () => {
  // The dominant gateway failure: every account TTFB-stalls, the gateway absorbs/rotates → upstream429
  // never moves and AIMD never shrinks, so triggers (a)-(c) all stay silent. Only the transport-stall
  // delta surfaces it.
  const stats = healthyStats({ upstreamErrors: 40, upstream429: 0, failovers: 18, aimd: { effective: 24, cap: 24, floor: 4, decreases: 0 } });
  const prior = { totalRequests: 1000, shed429: 0, shedAllThrottled: 0, upstreamErrors: 30, at: NOW - 30_000 };
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), prior, NOW);
  assert.equal(v.sustainedThrottle, true, 'a pure stall storm must surface even with upstream429 flat');
  assert.ok(v.reasons.some((r) => r.includes('transport-stall storm')), 'names the transport-stall storm');
});

test('detectGatewayWedge — a few stray stalls UNDER the delta do NOT trip the stall-storm throttle (normal proxy churn)', () => {
  const stats = healthyStats({ upstreamErrors: 32 }); // +2 vs prior, under STALL_STORM_DELTA (5)
  const prior = { totalRequests: 1000, shed429: 0, shedAllThrottled: 0, upstreamErrors: 30, at: NOW - 30_000 };
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), prior, NOW);
  assert.ok(!v.reasons.some((r) => r.includes('transport-stall storm')), 'a lone blip is not a storm');
});

test('detectGatewayWedge — DEPLOY-SKEW: a legacy prior WITHOUT upstreamErrors is skipped by the stall-storm trigger (no false fire)', () => {
  const stats = healthyStats({ upstreamErrors: 999 });
  const legacyPrior = { totalRequests: 1000, shed429: 0, shedAllThrottled: 0, at: NOW - 30_000 }; // no upstreamErrors field
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), legacyPrior, NOW);
  assert.ok(!v.reasons.some((r) => r.includes('transport-stall storm')), 'an absent prior.upstreamErrors cannot fire (d)');
});

test('detectGatewayWedge — DEPLOY-SKEW: a pre-AIMD gateway never trips the AIMD throttle branch', () => {
  const legacy: RawGatewayStats = { totalRequests: 10, admission: { running: 3, queued: 0, maxConcurrent: 24 }, shed429: 0 };
  const v = detectGatewayWedge(summarizeGatewayMetrics(legacy), undefined, NOW);
  assert.equal(v.sustainedThrottle, false);
  assert.equal(v.wedge, false);
  assert.equal(v.saturated, false);
});

// ── sampleGateway ─────────────────────────────────────────────────────────────────────────────

test('sampleGateway — captures the minimal rolling sample for the next tick', () => {
  const m: GatewayMetrics = summarizeGatewayMetrics(healthyStats({ totalRequests: 77, shed429: 3, shedAllThrottled: 1 }));
  const s = sampleGateway(m, NOW);
  assert.deepEqual(s, { totalRequests: 77, shed429: 3, shedAllThrottled: 1, upstreamErrors: 0, at: NOW });
});

// ── admissionStarvationRisk (WI-3565, 2026-07-09 admission-starvation incident) ─────────────────
// The wedge/saturated signature requires inFlight AT the ceiling — but the incident's actual
// reading (running:1, maxConcurrent:2, queued:24) sits BELOW the ceiling the whole time (paced by a
// lower per-account/provider floor), so `saturated` never fires. This is the distinct spatial
// signal that catches it: a deep backlog vs the LIVE ceiling, regardless of how full inFlight is.

test('detectGatewayWedge — a deep backlog vs a low ceiling is an admission-starvation RISK even though inFlight sits BELOW the ceiling (the 2026-07-09 incident shape)', () => {
  const stats = healthyStats({ admission: { running: 1, queued: 24, maxConcurrent: 2 }, aimd: { effective: 24, cap: 24, floor: 4, decreases: 0 } });
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), undefined, NOW);
  assert.equal(v.saturated, false, 'inFlight (1) is below maxConcurrent (2) — the existing saturated signal misses this');
  assert.equal(v.admissionStarvationRisk, true);
  assert.equal(v.admissionStarved, false, 'the pure detector never confirms sustain — that is gateway-sample-cache.ts');
  assert.ok(v.reasons.some((r) => r.includes('starvation risk')));
});

test('detectGatewayWedge — a queue AT (not over) the starvation ratio is not yet a risk', () => {
  const stats = healthyStats({ admission: { running: 2, queued: 8, maxConcurrent: 2 } }); // exactly 4x, not > 4x
  const v = detectGatewayWedge(summarizeGatewayMetrics(stats), undefined, NOW);
  assert.equal(v.admissionStarvationRisk, false);
});

test('detectGatewayWedge — a healthy queue depth relative to a high ceiling is never a starvation risk', () => {
  const v = detectGatewayWedge(summarizeGatewayMetrics(healthyStats({ admission: { running: 3, queued: 6, maxConcurrent: 24 } })), undefined, NOW);
  assert.equal(v.admissionStarvationRisk, false);
});

test('detectGatewayWedge — zero maxConcurrent never flags starvation (avoid a div/mul-by-zero false fire)', () => {
  const v = detectGatewayWedge(summarizeGatewayMetrics(healthyStats({ admission: { running: 0, queued: 50, maxConcurrent: 0 } })), undefined, NOW);
  assert.equal(v.admissionStarvationRisk, false);
});
