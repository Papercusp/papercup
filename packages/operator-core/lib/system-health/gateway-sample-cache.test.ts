/**
 * Tests for the stateful freeze-anchor cache (B-GW-5) that wraps the pure wedge detector. Confirms
 * the wedge only fires once a saturated freeze has PERSISTED across ticks (≥ WEDGE_MIN_FREEZE_MS),
 * and resets on recovery — robust to tick cadence + near-simultaneous double-reads.
 */
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  readGatewayWedge,
  WEDGE_MIN_FREEZE_MS,
  ADMISSION_STARVATION_MIN_PERSIST_MS,
  __resetGatewaySampleCacheForTests,
} from './gateway-sample-cache';
import { summarizeGatewayMetrics, type RawGatewayStats } from '../inference-gateway/gateway-wedge';

const T0 = 1_750_000_000_000;

const stats = (over: Partial<RawGatewayStats> = {}): RawGatewayStats => ({
  totalRequests: 1000,
  admission: { running: 3, queued: 0, maxConcurrent: 24 },
  shed429: 0,
  shedAllThrottled: 0,
  failovers: 0,
  ...over,
});
const saturatedFrozen = (total: number) => stats({ totalRequests: total, admission: { running: 24, queued: 40, maxConcurrent: 24 } });

beforeEach(() => __resetGatewaySampleCacheForTests());

test('healthy readings never wedge', () => {
  const a = readGatewayWedge(summarizeGatewayMetrics(stats()), T0);
  const b = readGatewayWedge(summarizeGatewayMetrics(stats({ totalRequests: 1010 })), T0 + 30_000);
  assert.equal(a.wedge, false);
  assert.equal(b.wedge, false);
  assert.equal(b.saturated, false);
});

test('a saturated freeze becomes a wedge only after it PERSISTS ≥ WEDGE_MIN_FREEZE_MS', () => {
  // First reading: saturated+frozen, but no prior yet → just saturated.
  const r0 = readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5000)), T0);
  assert.equal(r0.saturated, true);
  assert.equal(r0.wedge, false);
  // 30s later, still frozen+saturated → freeze anchored at T0, age 30s < 60s → not yet a wedge.
  const r1 = readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5000)), T0 + 30_000);
  assert.equal(r1.wedge, false, 'freeze younger than the min-persist gate');
  // At T0 + (min freeze + slack), the freeze has persisted long enough → WEDGE.
  const r2 = readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5000)), T0 + WEDGE_MIN_FREEZE_MS + 5_000);
  assert.equal(r2.wedge, true, 'persisted saturated freeze → confirmed wedge');
  assert.ok(r2.reasons.some((x) => x.includes('frozen')));
});

test('a near-simultaneous double-read does NOT false-confirm a wedge (1ms apart)', () => {
  readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5000)), T0);
  const dup = readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5000)), T0 + 1); // 1ms later
  assert.equal(dup.wedge, false, 'a 1ms freeze is not a wedge');
});

test('requests advancing clears the freeze anchor → no wedge (recovery)', () => {
  readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5000)), T0);
  readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5000)), T0 + 30_000); // freeze building
  // Requests advance (still saturated, but draining) → anchor resets.
  const adv = readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5100)), T0 + 60_000);
  assert.equal(adv.wedge, false, 'advancing counter breaks the freeze');
  // Even a later frozen reading must re-accumulate from here, not from T0.
  const reFrozen = readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5100)), T0 + 70_000);
  assert.equal(reFrozen.wedge, false, 'the new freeze is only 10s old');
});

test('un-saturating (queue drains) clears the freeze anchor', () => {
  readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5000)), T0);
  readGatewayWedge(summarizeGatewayMetrics(saturatedFrozen(5000)), T0 + WEDGE_MIN_FREEZE_MS);
  // Queue drains (no longer saturated) even though totalRequests is unchanged.
  const drained = readGatewayWedge(summarizeGatewayMetrics(stats({ totalRequests: 5000, admission: { running: 5, queued: 0, maxConcurrent: 24 } })), T0 + WEDGE_MIN_FREEZE_MS + 10_000);
  assert.equal(drained.saturated, false);
  assert.equal(drained.wedge, false);
});

test('sustainedThrottle is reported instantly (no freeze history needed)', () => {
  const r = readGatewayWedge(summarizeGatewayMetrics(stats({ aimd: { effective: 6, cap: 24, floor: 4, decreases: 5 } })), T0);
  assert.equal(r.sustainedThrottle, true);
  assert.equal(r.wedge, false);
});

// ── WI-3565: admission starvation persistence (deep queue vs a LOW ceiling, distinct from saturated) ──
const starved = (total = 1000) => stats({ totalRequests: total, admission: { running: 1, queued: 24, maxConcurrent: 2 } });

test('a starvation-risk reading is only CONFIRMED once it persists ≥ ADMISSION_STARVATION_MIN_PERSIST_MS', () => {
  const r0 = readGatewayWedge(summarizeGatewayMetrics(starved()), T0);
  assert.equal(r0.admissionStarvationRisk, true);
  assert.equal(r0.admissionStarved, false, 'just started — not yet sustained');

  const r1 = readGatewayWedge(summarizeGatewayMetrics(starved()), T0 + 60_000);
  assert.equal(r1.admissionStarved, false, '1 minute in — still short of the 5min gate');

  const r2 = readGatewayWedge(summarizeGatewayMetrics(starved()), T0 + ADMISSION_STARVATION_MIN_PERSIST_MS + 1_000);
  assert.equal(r2.admissionStarved, true, 'persisted past the gate → confirmed');
});

test('the queue draining (no longer over the ratio) clears the starvation streak', () => {
  readGatewayWedge(summarizeGatewayMetrics(starved()), T0);
  readGatewayWedge(summarizeGatewayMetrics(starved()), T0 + ADMISSION_STARVATION_MIN_PERSIST_MS - 1_000);
  // Queue drains back under the ratio right before confirmation would land.
  const drained = readGatewayWedge(
    summarizeGatewayMetrics(stats({ admission: { running: 2, queued: 2, maxConcurrent: 2 } })),
    T0 + ADMISSION_STARVATION_MIN_PERSIST_MS,
  );
  assert.equal(drained.admissionStarvationRisk, false);
  assert.equal(drained.admissionStarved, false);
  // A fresh starvation episode right after must re-accumulate from here, not from T0.
  const reStarved = readGatewayWedge(summarizeGatewayMetrics(starved()), T0 + ADMISSION_STARVATION_MIN_PERSIST_MS + 10_000);
  assert.equal(reStarved.admissionStarved, false, 'the new episode is only 10s old');
});

test('raising the live ceiling (the manual mitigation lever) clears a confirmed starvation on the next tick', () => {
  readGatewayWedge(summarizeGatewayMetrics(starved()), T0);
  readGatewayWedge(summarizeGatewayMetrics(starved()), T0 + ADMISSION_STARVATION_MIN_PERSIST_MS + 1_000);
  // maxConcurrent lifted 2 -> 8 (operator:rate_limit_config providerFloors.anthropic.maxConcurrent) —
  // the same queue depth is now well under the ratio against the new ceiling.
  const lifted = readGatewayWedge(
    summarizeGatewayMetrics(stats({ admission: { running: 6, queued: 24, maxConcurrent: 8 } })),
    T0 + ADMISSION_STARVATION_MIN_PERSIST_MS + 2_000,
  );
  assert.equal(lifted.admissionStarvationRisk, false);
  assert.equal(lifted.admissionStarved, false);
});
