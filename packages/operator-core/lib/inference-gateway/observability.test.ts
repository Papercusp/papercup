/** Tests for the gateway rate-observability read-model (P-014). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { projectHeadroom, fetchGatewayHeadroom } from './observability';
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
  maxQueued: 256,
  concurrencyCap: 24,
  aimd: { effective: 24, cap: 24, floor: 4, pressure: 0, cleanStreak: 0, decreases: 0, increases: 0 },
  failovers: 0,
  upstreamErrors: 0,
  pausedUntil: 0,
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
