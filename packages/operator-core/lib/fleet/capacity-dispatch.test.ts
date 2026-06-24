/** Tests for the Queen capacity-aware dispatch (gateway-priority-tiers-2026-06-22 Phase 4, QUEEN_CAPACITY_DISPATCH). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  computeCapacityHeadroom,
  capacityFactor,
  resolveCapacityConfig,
  queenCapacityHeadroom,
  DEFAULT_CAPACITY_DISPATCH_CONFIG as CFG,
} from './capacity-dispatch';

test('capacityFactor — headroom-independent; matches computeCapacityHeadroom.factor', () => {
  // unreachable ⇒ 1 (fail-safe)
  assert.equal(capacityFactor({ reachable: false }), 1);
  // idle ⇒ 1
  assert.equal(capacityFactor({ reachable: true, utilization: 0.1, queueDepth: 0 }), 1);
  // paused/rejected ⇒ 0 (no fresh capacity)
  assert.equal(capacityFactor({ reachable: true, paused: true }), 0);
  assert.equal(capacityFactor({ reachable: true, rejected: true }), 0);
  // identical to the factor computeCapacityHeadroom derives, for any raw headroom
  const sig = { reachable: true, utilization: 0.925, queueDepth: 6 };
  assert.equal(capacityFactor(sig), computeCapacityHeadroom(5, sig).factor);
  assert.equal(capacityFactor(sig), computeCapacityHeadroom(999, sig).factor);
});

test('fail-safe — gateway unreachable ⇒ NO clamp (never strand the fleet on a missing signal)', () => {
  const d = computeCapacityHeadroom(20, { reachable: false });
  assert.equal(d.headroom, 20);
  assert.equal(d.throttled, false);
  assert.equal(d.factor, 1);
});

test('idle pool — low utilization + empty queue ⇒ no clamp', () => {
  const d = computeCapacityHeadroom(20, { reachable: true, utilization: 0.1, queueDepth: 0 });
  assert.equal(d.headroom, 20);
  assert.equal(d.throttled, false);
});

test('high budget utilization throttles the fresh-spawn headroom (linear from utilizationHigh→cap)', () => {
  // util 0.925 = halfway between utilizationHigh (0.85) and cap (1.0) → budgetLeg ~0.5 → 20*0.5 ≈ 10
  // (floor of a float-just-under-0.5 → 9 or 10; the clamp is a soft throttle, exactness doesn't matter).
  const d = computeCapacityHeadroom(20, { reachable: true, utilization: 0.925, queueDepth: 0 });
  assert.equal(d.throttled, true);
  assert.ok(d.factor > 0.49 && d.factor < 0.51, `~half budget factor, got ${d.factor}`);
  assert.ok(Math.abs(d.headroom - 10) <= 1, `~half headroom, got ${d.headroom}`);
});

test('deep queue throttles (backlog ⇒ the pool cannot drain — do not add more bee load)', () => {
  // queueDepth 12 of queueSoftCap 24 → queueLeg 0.5 → 20*0.5 = 10
  const d = computeCapacityHeadroom(20, { reachable: true, utilization: 0, queueDepth: 12 });
  assert.equal(d.throttled, true);
  assert.equal(d.headroom, 10);
});

test('factor = min(budgetLeg, queueLeg) — the more-constraining leg wins', () => {
  // util 0.925 → budgetLeg ~0.5; queue 6/24 → queueLeg 0.75 → min ~0.5 → ~10
  const d = computeCapacityHeadroom(20, { reachable: true, utilization: 0.925, queueDepth: 6 });
  assert.ok(d.factor > 0.49 && d.factor < 0.51, `min leg is the ~0.5 budget leg, got ${d.factor}`);
  assert.ok(Math.abs(d.headroom - 10) <= 1, `~half headroom, got ${d.headroom}`);
});

test('paused pool ⇒ throttle to the floor (still let high-priority work flow)', () => {
  const d = computeCapacityHeadroom(20, { reachable: true, utilization: 1, paused: true, queueDepth: 50 });
  assert.equal(d.factor, 0);
  assert.equal(d.headroom, CFG.minHeadroom); // floor 2
  assert.equal(d.throttled, true);
});

test('rejected (hard budget reject) ⇒ throttle to the floor', () => {
  const d = computeCapacityHeadroom(20, { reachable: true, rejected: true });
  assert.equal(d.headroom, CFG.minHeadroom);
});

test('the floor never manufactures slots — a 0-slot pool stays 0 even when paused', () => {
  const d = computeCapacityHeadroom(0, { reachable: true, paused: true });
  assert.equal(d.headroom, 0, 'no raw headroom → no spawns; the floor lets work flow, it does not invent slots');
});

test('a raw headroom already below the floor is not raised by the floor', () => {
  // raw 1 < floor 2, paused → max(floor 2, 0)=2 then min(raw 1, 2)=1 — never exceeds the real headroom
  const d = computeCapacityHeadroom(1, { reachable: true, paused: true });
  assert.equal(d.headroom, 1);
});

test('resolveCapacityConfig — env tuning over defaults; bad values fall back', () => {
  const c = resolveCapacityConfig(undefined, {
    QUEEN_CAPACITY_MIN_HEADROOM: '5',
    QUEEN_CAPACITY_QUEUE_SOFT_CAP: '48',
    QUEEN_CAPACITY_UTIL_HIGH: '0.9',
  } as NodeJS.ProcessEnv);
  assert.equal(c.minHeadroom, 5);
  assert.equal(c.queueSoftCap, 48);
  assert.equal(c.utilizationHigh, 0.9);
  const bad = resolveCapacityConfig(undefined, { QUEEN_CAPACITY_MIN_HEADROOM: 'nope' } as NodeJS.ProcessEnv);
  assert.equal(bad.minHeadroom, CFG.minHeadroom);
});

test('queenCapacityHeadroom — flagOverride:false ⇒ no clamp (byte-identical to today, even with a saturated signal)', async () => {
  const d = await queenCapacityHeadroom(20, { flagOverride: false, signal: { reachable: true, paused: true } });
  assert.equal(d.headroom, 20);
  assert.equal(d.throttled, false);
});

test('queenCapacityHeadroom — flagOverride:true + injected saturated signal ⇒ clamps to the floor', async () => {
  const d = await queenCapacityHeadroom(20, { flagOverride: true, signal: { reachable: true, paused: true } });
  assert.equal(d.headroom, CFG.minHeadroom);
  assert.equal(d.throttled, true);
});

test('queenCapacityHeadroom — flagOverride:true + injected idle signal ⇒ no clamp', async () => {
  const d = await queenCapacityHeadroom(20, { flagOverride: true, signal: { reachable: true, utilization: 0.2, queueDepth: 0 } });
  assert.equal(d.headroom, 20);
  assert.equal(d.throttled, false);
});
