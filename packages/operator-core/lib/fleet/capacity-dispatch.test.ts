/** Tests for the Queen capacity-aware dispatch (gateway-priority-tiers-2026-06-22 Phase 4, MUG_CAPACITY_DISPATCH). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  computeCapacityHeadroom,
  capacityFactor,
  resolveCapacityConfig,
  queenCapacityHeadroom,
  DEFAULT_CAPACITY_DISPATCH_CONFIG as CFG,
  buildFleetSizingAdvisory,
  buildCapacityReport,
} from './capacity-dispatch';
import { planBatchPlacement } from './batch-placement';
import type { PlacementTask } from './placement-affinity';

test('capacity-aware dispatch SCENARIO — FEW placed when the pool is saturated, MANY when idle (P-005)', () => {
  // The end-to-end Queen behavior: the SAME importance-ranked frontier dispatches broadly when the pool is
  // idle and is throttled to the floor (top-ranked first, tail deferred) when it is saturated. Composes the
  // real capacity clamp with the real batch placement planner — deterministic, no LLM.
  const frontier: PlacementTask[] = Array.from({ length: 12 }, (_, i) => ({ id: `wi-${i}`, harness: 'h', title: `t${i}` }));
  const rawHeadroom = 12; // the raw spawn ceiling before the capacity clamp

  // ABUNDANT pool → no clamp → place the WHOLE frontier.
  const abundant = computeCapacityHeadroom(rawHeadroom, { reachable: true, utilization: 0.1, queueDepth: 0 });
  assert.equal(abundant.headroom, 12);
  const planHi = planBatchPlacement({ tasks: frontier, bees: [], headroom: abundant.headroom });
  assert.equal(planHi.spawnCount, 12);
  assert.equal(planHi.unplacedCount, 0);

  // SATURATED pool (paused) → clamp to the floor → place only a FEW; defer the rest to the next wake.
  const scarce = computeCapacityHeadroom(rawHeadroom, { reachable: true, utilization: 1, paused: true, queueDepth: 40 });
  assert.equal(scarce.headroom, CFG.minHeadroom); // floor 2
  const planLo = planBatchPlacement({ tasks: frontier, bees: [], headroom: scarce.headroom });
  assert.equal(planLo.spawnCount, CFG.minHeadroom);
  assert.equal(planLo.unplacedCount, frontier.length - CFG.minHeadroom); // 10 deferred to the next wake
  // The frontier is importance-ordered, so the TOP-ranked flow and the LOWEST-priority tail is deferred.
  assert.equal(planLo.decisions[0].disposition, 'spawn', 'highest-priority task placed even under saturation');
  assert.equal(planLo.decisions[frontier.length - 1].disposition, 'unplaced', 'lowest-priority task deferred under saturation');
});

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

test('tiered spare bee capacity overrides a rejected bound account window', () => {
  // The live failure: /stats.unified was for one exhausted bound account
  // (rejected=true, util=100%, reset in days) while priorityTiers still reported
  // healthy accounts and many spare bee-tier slots. Queen dispatch must trust the
  // pool-level tier oracle, not throttle the whole hive to the floor.
  const d = computeCapacityHeadroom(13, {
    reachable: true,
    utilization: 1,
    rejected: true,
    queueDepth: 0,
    healthyAccounts: 2,
    dispatchBudget: 19,
  });
  assert.equal(d.factor, 1);
  assert.equal(d.headroom, 13);
  assert.equal(d.throttled, false);
});

test('tiered spare bee capacity overrides a PAUSED+rejected (weekly-capped) bound account', () => {
  // capacity-oracle-false-saturation-2026-06-29: a weekly-capped account reports BOTH paused:true
  // AND rejected:true on /stats. The original escape hatch required paused!==true, so this re-armed
  // the false-saturation gate (util 100%, resetIn ~16.5h) and stalled the WHOLE autonomous loop —
  // 0 Queen/bee spawns — even though the tier oracle reported 6 healthy accounts + 20 spare bee slots.
  const signal = {
    reachable: true,
    utilization: 1,
    paused: true,
    rejected: true,
    queueDepth: 0,
    healthyAccounts: 6,
    dispatchBudget: 20,
  };
  assert.ok(capacityFactor(signal) > 0, 'pool with healthy accounts + spare slots is NOT saturated');
  const d = computeCapacityHeadroom(13, signal);
  assert.equal(d.factor, 1);
  assert.equal(d.headroom, 13);
  assert.equal(d.throttled, false);
});

test('a GENUINELY all-paused pool (no healthy accounts) still throttles to the floor', () => {
  // No-regression: the escape hatch fires ONLY when the tier oracle shows real spare capacity.
  // With 0 healthy accounts / 0 dispatchBudget a paused+rejected pool is genuinely saturated.
  const d = computeCapacityHeadroom(13, {
    reachable: true, paused: true, rejected: true, healthyAccounts: 0, dispatchBudget: 0,
  });
  assert.equal(d.headroom, CFG.minHeadroom, 'genuinely saturated → floor');
  assert.equal(capacityFactor({ reachable: true, paused: true, healthyAccounts: 0, dispatchBudget: 0 }), 0);
});

test('fresh gateway restart avoids treating startup zero-capacity snapshot as sustained exhaustion', () => {
  const signal = {
    reachable: true,
    paused: true,
    rejected: true,
    utilization: 1,
    queueDepth: 0,
    healthyAccounts: 0,
    dispatchBudget: 0,
    processUptimeMs: 5_000,
  };
  assert.equal(capacityFactor(signal), 1);
  const d = computeCapacityHeadroom(13, signal);
  assert.equal(d.factor, 1);
  assert.equal(d.headroom, 13);
  assert.equal(d.throttled, false);
  assert.match(d.reason, /capacity-recovering/);
});

test('expired gateway restart grace still treats no-capacity paused pool as saturated', () => {
  const signal = {
    reachable: true,
    paused: true,
    rejected: true,
    utilization: 1,
    healthyAccounts: 0,
    dispatchBudget: 0,
    processUptimeMs: 45_000,
  };
  assert.equal(capacityFactor(signal), 0);
  const d = computeCapacityHeadroom(13, signal);
  assert.equal(d.headroom, CFG.minHeadroom);
  assert.equal(d.throttled, true);
});

test('capacity report labels fresh gateway zero-capacity snapshot as recovering advice', () => {
  const r = buildCapacityReport(
    {
      reachable: true,
      paused: true,
      rejected: true,
      utilization: 1,
      utilizationPct: 100,
      queueDepth: 0,
      processUptimeMs: 4_000,
      priorityTiers: {
        healthyAccounts: 0,
        tier1Reserve: 0,
        tiers: [{ tier: 3, cap: 20, inFlight: 20, queued: 0 }],
      },
    },
    { clampArmed: true, headroom: 13 },
  );
  assert.equal(r.restartRecovering, true);
  assert.equal(r.factor, 1);
  assert.equal(r.recommendedHeadroom, 13);
  assert.equal(r.throttled, false);
  assert.match(r.advice, /startup capacity snapshot is recovering/);
});

test('EI-12282 — gateway reports spare bee slots but the REAL account pool is exhausted ⇒ poolExhausted, factor 0, loud hold', () => {
  // The live false-green: /stats.priorityTiers said healthyAccounts>0 with ~13 spare bee-tier slots
  // (dispatchBudget 13), so the old report read "tightening (factor 0.92) → trim low-priority; ~13 bee
  // slots free" — place broadly. But accounts:status showed 6/7 claude accounts usage-walled and the 7th
  // edge-throttled, so a caller spawning against that signal watched its cups die on their first call.
  // Cross-checking dispatchBudget against real per-account availability must flip the read to a loud HOLD.
  const hr = {
    reachable: true,
    utilization: 0.97,
    utilizationPct: 97,
    paused: true,
    queueDepth: 2,
    inFlight: 1,
    priorityTiers: {
      healthyAccounts: 7, // gateway's split-brain-stale count (disagrees with the store)
      tier1Reserve: 2,
      tiers: [{ tier: 3, cap: 16, inFlight: 1, queued: 2 }], // dispatchBudget = 16-1-2 = 13
    },
  };
  const accountAvailability = { provider: 'claude', total: 7, available: 1, usable: 0 };

  // Without the cross-check the report is the false-green (regression baseline).
  const green = buildCapacityReport(hr, { clampArmed: true, headroom: 13 });
  assert.equal(green.dispatchBudget, 13);
  assert.equal(green.poolExhausted, false);
  assert.ok(green.factor > 0.5, `false-green factor ~0.92, got ${green.factor}`);
  assert.doesNotMatch(green.advice, /EXHAUSTED/);

  // WITH the cross-check the false-green is corrected to a loud, honest HOLD.
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 13, accountAvailability });
  assert.equal(r.poolExhausted, true, 'zero usable accounts + spare gateway slots ⇒ exhausted');
  assert.equal(r.factor, 0, 'no real capacity → factor forced to 0');
  assert.equal(r.usableAccounts, 0);
  assert.equal(r.availableAccounts, 1);
  assert.equal(r.dispatchBudget, 13, 'the raw gateway figure is still surfaced (for diagnosis)');
  assert.equal(r.recommendedHeadroom, CFG.minHeadroom, 'clamped to the floor, not the queue-slot count');
  assert.equal(r.throttled, true);
  assert.match(r.advice, /EXHAUSTED/);
  assert.match(r.advice, /0\/7 claude accounts are usable/);
  // No edge/usage-wall breakdown supplied on this fixture ⇒ unchanged generic phrasing, no dominant-cause clause.
  assert.doesNotMatch(r.advice, /DOMINANT CAUSE/);
});

test('EI-18664933641195210 — poolExhausted names EGRESS-THROTTLE as the dominant cause (owner-infra, not quota)', () => {
  // The real incident this regression pins: every account looked "walled/rate-paused/edge-throttled" in the
  // generic phrasing, which reads as ordinary quota exhaustion — but the actual cause was three DOWN forward
  // proxies forcing every account onto one already-throttled shared IP. The breakdown must say so loudly.
  const hr = {
    reachable: true, utilization: 0.97, utilizationPct: 97, paused: true, queueDepth: 2, inFlight: 1,
    priorityTiers: { healthyAccounts: 5, tier1Reserve: 1, tiers: [{ tier: 3, cap: 10, inFlight: 1, queued: 2 }] },
  };
  const accountAvailability = { provider: 'claude', total: 5, available: 2, usable: 0, edgeThrottledCount: 5, usageWalledCount: 1 };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.poolExhausted, true);
  assert.match(r.advice, /EXHAUSTED/);
  assert.match(r.advice, /DOMINANT CAUSE/);
  assert.match(r.advice, /5\/5 edge-throttled/);
  assert.match(r.advice, /OWNER-GATED/, 'egress-throttle dominant ⇒ points at owner-provisioned infra, not a quota wait');
});

test('EI-18664933641195210 — poolExhausted names USAGE-WALL as the dominant cause (just wait, no infra escalation)', () => {
  const hr = {
    reachable: true, utilization: 0.97, utilizationPct: 97, paused: true, queueDepth: 2, inFlight: 1,
    priorityTiers: { healthyAccounts: 5, tier1Reserve: 1, tiers: [{ tier: 3, cap: 10, inFlight: 1, queued: 2 }] },
  };
  const accountAvailability = { provider: 'claude', total: 5, available: 0, usable: 0, edgeThrottledCount: 0, usageWalledCount: 5 };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.poolExhausted, true);
  assert.match(r.advice, /dominant cause: 5\/5 usage-walled/);
  assert.doesNotMatch(r.advice, /OWNER-GATED/, 'usage-wall dominant ⇒ no infra escalation language');
});

test('EI-12282 — poolExhausted does NOT fire when real accounts ARE usable (no false alarm)', () => {
  const hr = {
    reachable: true,
    utilization: 0.5,
    paused: false,
    queueDepth: 0,
    priorityTiers: { healthyAccounts: 4, tier1Reserve: 2, tiers: [{ tier: 3, cap: 16, inFlight: 1, queued: 0 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 13,
    accountAvailability: { provider: 'claude', total: 7, available: 4, usable: 4 },
  });
  assert.equal(r.poolExhausted, false);
  assert.equal(r.factor, 1);
  assert.equal(r.usableAccounts, 4);
  assert.equal(r.recommendedHeadroom, 13, 'usable pool → no exhaustion clamp');
  assert.match(r.advice, /abundant/);
});

test('EI-12282 — no account cross-check supplied ⇒ byte-identical to before (fail-safe)', () => {
  const hr = {
    reachable: true,
    utilization: 0.97,
    paused: true,
    queueDepth: 2,
    priorityTiers: { healthyAccounts: 7, tier1Reserve: 2, tiers: [{ tier: 3, cap: 16, inFlight: 1, queued: 2 }] },
  };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 13 });
  assert.equal(r.poolExhausted, false);
  assert.equal(r.usableAccounts, null);
  assert.equal(r.availableAccounts, null);
  assert.ok(r.factor > 0.5, 'unchanged escape-hatch behaviour when no cross-check is passed');
});

test('EI-12282 — exhaustion suppressed during the fresh-gateway restart grace (startup snapshot is not the store)', () => {
  const hr = {
    reachable: true,
    utilization: 1,
    paused: true,
    rejected: true,
    queueDepth: 0,
    processUptimeMs: 4_000, // within the 30s restart grace
    priorityTiers: { healthyAccounts: 0, tier1Reserve: 0, tiers: [{ tier: 3, cap: 16, inFlight: 0, queued: 0 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 13,
    accountAvailability: { provider: 'claude', total: 7, available: 0, usable: 0 },
  });
  assert.equal(r.restartRecovering, true);
  assert.equal(r.poolExhausted, false, 'restart grace wins — do not treat startup snapshot as sustained exhaustion');
  assert.equal(r.factor, 1);
  assert.match(r.advice, /recovering/);
});

test('EI-12282 — zero usable accounts but ZERO gateway slots is the ordinary saturated path, not the split-brain flag', () => {
  // When the gateway ALSO reports no spare slots, poolBlocked/saturation already handles it; poolExhausted
  // is specifically the CONTRADICTION (gateway says slots free, store says none) — so it must NOT fire here.
  const hr = {
    reachable: true,
    paused: true,
    rejected: true,
    queueDepth: 0,
    priorityTiers: { healthyAccounts: 0, tier1Reserve: 0, tiers: [{ tier: 3, cap: 16, inFlight: 16, queued: 0 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 13,
    accountAvailability: { provider: 'claude', total: 7, available: 0, usable: 0 },
  });
  assert.equal(r.dispatchBudget, 0);
  assert.equal(r.poolExhausted, false, 'no spare gateway slots → ordinary saturation, not the contradiction flag');
  assert.equal(r.recommendedHeadroom, CFG.minHeadroom, 'still clamps to the floor via the normal saturated path');
  assert.match(r.advice, /SATURATED/);
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
    QUEEN_CAPACITY_RESTART_GRACE_MS: '15000',
  } as NodeJS.ProcessEnv);
  assert.equal(c.minHeadroom, 5);
  assert.equal(c.queueSoftCap, 48);
  assert.equal(c.utilizationHigh, 0.9);
  assert.equal(c.restartRecoveryWindowMs, 15_000);
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

test('buildFleetSizingAdvisory — warns only when requested members exceed healthy account headroom', () => {
  assert.equal(buildFleetSizingAdvisory(3, { reachable: true, healthyAccounts: 3 }), null);
  assert.equal(buildFleetSizingAdvisory(2, { reachable: true, healthyAccounts: 3 }), null);

  const advisory = buildFleetSizingAdvisory(5, { reachable: true, healthyAccounts: 3 });
  assert.ok(advisory);
  assert.equal(advisory?.requestedMembers, 5);
  assert.equal(advisory?.healthyHeadroom, 3);
  assert.equal(advisory?.extraMembers, 2);
  assert.match(advisory?.message ?? '', /requested 5 fleet members, but only 3 healthy accounts/);
});

test('buildFleetSizingAdvisory — fail-soft when the gateway/headroom signal is unavailable', () => {
  assert.equal(buildFleetSizingAdvisory(5, { reachable: false, healthyAccounts: 3 }), null);
  assert.equal(buildFleetSizingAdvisory(5, { reachable: true, healthyAccounts: null }), null);
});
