/** Tests for the gateway rate-observability read-model (P-014). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { projectHeadroom, fetchGatewayHeadroom, gatewayWholesaleThrottled } from './observability';
import type { GatewayStats } from './gateway';

const baseStats = (over: Partial<GatewayStats> = {}): GatewayStats => ({
  accountId: 'acct-main',
  upstreamBase: 'https://api.anthropic.com',
  totalRequests: 12,
  inFlight: 2,
  queueDepth: 5,
  admission: { running: 2, queued: 5, maxConcurrent: 24, byPriority: [{ priority: 100, count: 1 }, { priority: 0, count: 4 }] },
  upstream429: 0,
  queued429: 1,
  shed429: 0,
  shedAllThrottled: 0,
  bareBurstRotateSuppressed: 0,
  maxQueued: 256,
  concurrencyCap: 24,
  aimd: { effective: 24, cap: 24, floor: 4, pressure: 0, cleanStreak: 0, decreases: 0, increases: 0 },
  failovers: 0,
  upstreamErrors: 0,
  egressCircuitOpens: 0,
  egressFailsByAccount: {},
  egressAttemptsByAccount: {},
  egressFailRateByAccount: {},
  selfHealReclaims: 0,
  stallsRecorded: 0,
  codex: { requests: 0, upstream429: 0, failovers: 0, errors: 0 },
  beeFacing503: { egressExhausted: 0, tokenStall: 0 },
  pausedUntil: 0,
  cache: { read: 0, create: 0, input: 0, hits: 0, misses: 0, failoverMisses: 0, hitRate: 0, byAccount: {} },
  ...over,
});

test('projectHeadroom — maps the unified window + queue into the read-model', () => {
  const now = 1_000_000;
  const stats = baseStats({
    unified: { window: '5h', utilization: 0.83, resetAt: now + 3600_000, rejected: false },
  });
  const h = projectHeadroom(stats, now);
  assert.equal(h.reachable, true);
  assert.equal(h.accountId, 'acct-main');
  assert.equal(h.window, '5h');
  assert.equal(h.utilizationPct, 83);
  assert.equal(h.rejected, false);
  assert.equal(h.resetInSec, 3600);
  assert.equal(h.paused, false);
  assert.equal(h.queueDepth, 5);
  assert.deepEqual(h.byPriority, [{ priority: 100, count: 1 }, { priority: 0, count: 4 }]);
});

test('projectHeadroom — paused/rejected window reflected', () => {
  const now = 1_000_000;
  const h = projectHeadroom(
    baseStats({ pausedUntil: now + 600_000, unified: { window: '5h', utilization: 1.01, resetAt: now + 600_000, rejected: true } }),
    now,
  );
  assert.equal(h.paused, true);
  assert.equal(h.rejected, true);
  assert.equal(h.utilizationPct, 101);
  assert.equal(h.resetInSec, 600);
});

test('projectHeadroom — surfaces the bound account smoothing pace (P-005)', () => {
  const now = 1_000_000;
  const h = projectHeadroom(
    baseStats({
      accountId: 'acct-main',
      smoothing: {
        engaged: true,
        byAccount: {
          'acct-main': { smoothRpm: true, rpm: 60, rpmFactor: 0.5, effRpm: 30, paceDelayMs: 0, effectivePaceMs: 2000 },
          'acct-other': { smoothRpm: true, rpm: 60, rpmFactor: 1, effRpm: 60, paceDelayMs: 0, effectivePaceMs: 1000 },
        },
      },
    }),
    now,
  );
  assert.equal(h.smoothingEngaged, true);
  assert.equal(h.smoothRpm, true);
  assert.equal(h.effectivePaceMs, 2000, 'the BOUND account (acct-main) pace, not another account');
  assert.equal(h.effRpm, 30);
});

test('projectHeadroom — smoothing absent (fresh gateway) leaves smoothing fields undefined', () => {
  const h = projectHeadroom(baseStats(), 1_000_000);
  assert.equal(h.smoothingEngaged, undefined);
  assert.equal(h.effectivePaceMs, undefined);
});

test('projectHeadroom — no unified window yet (fresh gateway) leaves window fields undefined', () => {
  const h = projectHeadroom(baseStats(), 1_000_000);
  assert.equal(h.reachable, true);
  assert.equal(h.window, undefined);
  assert.equal(h.utilizationPct, undefined);
  assert.equal(h.totalRequests, 12);
});

test('fetchGatewayHeadroom — gateway down returns reachable:false (never throws)', async () => {
  const h = await fetchGatewayHeadroom({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(h.reachable, false);
  assert.match(h.error ?? '', /ECONNREFUSED/);
});

test('fetchGatewayHeadroom — reads + projects a live /stats payload', async () => {
  const now = Date.now();
  const stats = baseStats({ unified: { window: '5h', utilization: 0.5, resetAt: now + 1_000_000, rejected: false } });
  const h = await fetchGatewayHeadroom({
    fetchImpl: async () => new Response(JSON.stringify(stats), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(h.reachable, true);
  assert.equal(h.utilizationPct, 50);
  assert.equal(h.accountId, 'acct-main');
});

test('fetchGatewayHeadroom — non-200 from gateway → reachable:false with status', async () => {
  const h = await fetchGatewayHeadroom({
    fetchImpl: async () => new Response('nope', { status: 503 }),
  });
  assert.equal(h.reachable, false);
  assert.match(h.error ?? '', /503/);
});

// gatewayWholesaleThrottled — the capacity_shed corroboration (P-006/H13). True only
// when the gateway is REACHABLE and the bound account is paused OR its window rejected.
const statsResponse = (stats: GatewayStats) =>
  async () => new Response(JSON.stringify(stats), { status: 200, headers: { 'content-type': 'application/json' } });

test('gatewayWholesaleThrottled — true when the bound account is PAUSED', async () => {
  const now = Date.now();
  const throttled = await gatewayWholesaleThrottled({ fetchImpl: statsResponse(baseStats({ pausedUntil: now + 60_000 })) });
  assert.equal(throttled, true);
});

test('gatewayWholesaleThrottled — true when the unified window is REJECTED (hard limit)', async () => {
  const now = Date.now();
  const throttled = await gatewayWholesaleThrottled({
    fetchImpl: statsResponse(baseStats({ unified: { window: '5h', utilization: 1.02, resetAt: now + 60_000, rejected: true } })),
  });
  assert.equal(throttled, true);
});

test('gatewayWholesaleThrottled — false when headline window is rejected but priority tiers can still admit', async () => {
  const now = Date.now();
  const throttled = await gatewayWholesaleThrottled({
    fetchImpl: statsResponse(
      baseStats({
        unified: { window: '5h', utilization: 1.02, resetAt: now + 60_000, rejected: true },
        priorityTiers: {
          healthyAccounts: 1,
          tier1Reserve: 1,
          tiers: [
            { tier: 1, cap: 24, inFlight: 1, queued: 0 },
            { tier: 3, cap: 19, inFlight: 0, queued: 0 },
          ],
        },
      }),
    ),
  });
  assert.equal(throttled, false);
});

test('gatewayWholesaleThrottled — true when priority tiers report no healthy account capacity', async () => {
  const now = Date.now();
  const throttled = await gatewayWholesaleThrottled({
    fetchImpl: statsResponse(
      baseStats({
        unified: { window: '5h', utilization: 1.02, resetAt: now + 60_000, rejected: true },
        priorityTiers: {
          healthyAccounts: 0,
          tier1Reserve: 1,
          tiers: [{ tier: 3, cap: 19, inFlight: 19, queued: 0 }],
        },
      }),
    ),
  });
  assert.equal(throttled, true);
});

test('gatewayWholesaleThrottled — false when the gateway is healthy (not paused, not rejected)', async () => {
  const now = Date.now();
  const throttled = await gatewayWholesaleThrottled({
    fetchImpl: statsResponse(baseStats({ unified: { window: '5h', utilization: 0.4, resetAt: now + 60_000, rejected: false } })),
  });
  assert.equal(throttled, false);
});

test('gatewayWholesaleThrottled — false (conservative) when the gateway is UNREACHABLE', async () => {
  const throttled = await gatewayWholesaleThrottled({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(throttled, false);
});

test('gatewayWholesaleThrottled — default path (no injected fetchImpl) is a NO-OP under the test runner (gate-safe, never hits the live :8788 gateway)', async () => {
  // The guard that keeps every no-turn spawn-classification test (durable-spawn / launch-blueprint)
  // deterministic on a box with a live, possibly-throttled gateway — without it the classifier reads
  // the real gateway and the test flaps the deploy gate.
  const throttled = await gatewayWholesaleThrottled();
  assert.equal(throttled, false);
});
