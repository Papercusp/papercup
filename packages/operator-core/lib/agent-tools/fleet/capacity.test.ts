/** Tests for fleet:capacity's pure report builder (queen-capacity-aware-dispatch-2026-06-22 P-003). */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { buildCapacityReport } from './capacity';
import type { GatewayHeadroom } from '../../inference-gateway/observability';
import type { AccountStatusRow } from '../../deployment/account-pool-store';

const { mockAccountStatus } = vi.hoisted(() => ({ mockAccountStatus: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));
vi.mock('../../deployment/account-session-override', () => ({
  getAccountOverride: async () => ({ forcedAccounts: [], excludeAccounts: [] }),
  applyAccountOverride: (ids: readonly string[]) => [...ids],
}));
vi.mock('../../deployment/account-pool-store', () => ({ accountStatus: mockAccountStatus }));

const tieredHr = (over: Partial<GatewayHeadroom> = {}): GatewayHeadroom => ({
  reachable: true,
  utilization: 0.1,
  utilizationPct: 10,
  paused: false,
  rejected: false,
  inFlight: 2,
  queueDepth: 0,
  priorityTiers: {
    healthyAccounts: 8,
    tier1Reserve: 4,
    tiers: [
      { tier: 1, cap: 24, inFlight: 1, queued: 0 },
      { tier: 2, cap: 20, inFlight: 1, queued: 0 },
      { tier: 3, cap: 20, inFlight: 6, queued: 3 }, // bee tier
      { tier: 4, cap: 8, inFlight: 0, queued: 0 },
    ],
  },
  ...over,
});

test('unreachable gateway ⇒ fail-safe no-clamp report (place at the normal ceiling)', () => {
  const r = buildCapacityReport({ reachable: false }, { clampArmed: true, headroom: 20 });
  assert.equal(r.reachable, false);
  assert.equal(r.factor, 1);
  assert.equal(r.recommendedHeadroom, 20, 'proposed headroom passes through unclamped');
  assert.equal(r.dispatchBudget, null);
  assert.match(r.advice, /fail-safe/);
});

test('abundant pool ⇒ dispatchBudget from the bee tier, factor 1, broad advice', () => {
  const r = buildCapacityReport(tieredHr(), { clampArmed: true });
  assert.equal(r.reachable, true);
  assert.equal(r.tierLayer, true);
  assert.equal(r.beeTier, 3, 'bee maps to tier 3 by default');
  assert.equal(r.dispatchBudget, 11, 'bee-tier spare = cap 20 − inFlight 6 − queued 3 = 11');
  assert.equal(r.healthyAccounts, 8);
  assert.equal(r.tier1Reserve, 4);
  assert.equal(r.factor, 1);
  assert.match(r.advice, /abundant/);
});

test('proposed headroom is clamped to spare capacity under load', () => {
  // queueDepth 12 of softCap 24 → factor 0.5 → 20 → ~10
  const r = buildCapacityReport(tieredHr({ queueDepth: 12 }), { clampArmed: true, headroom: 20 });
  assert.ok(r.factor > 0.49 && r.factor < 0.51, `factor ~0.5, got ${r.factor}`);
  assert.equal(r.recommendedHeadroom, 10);
  assert.equal(r.throttled, true);
});

test('GENUINELY saturated pool (paused + NO tiered spare capacity) ⇒ factor 0 + "place only tier-1" advice', () => {
  // The pool is paused AND has no healthy accounts / no bee-tier spare slots — a
  // real saturation, distinct from the bound-account-only false-saturation the
  // adjacent `rejected … broad placement` test guards (capacity-oracle-false-
  // saturation-2026-06-29). Here there IS no fresh capacity, so factor must floor to 0.
  const r = buildCapacityReport(
    tieredHr({
      paused: true,
      utilization: 1,
      priorityTiers: {
        healthyAccounts: 0, // no healthy account → pool truly has no fresh capacity
        tier1Reserve: 0,
        tiers: [
          { tier: 1, cap: 24, inFlight: 24, queued: 0 },
          { tier: 2, cap: 20, inFlight: 20, queued: 0 },
          { tier: 3, cap: 20, inFlight: 20, queued: 0 }, // bee tier full → no spare
          { tier: 4, cap: 8, inFlight: 8, queued: 0 },
        ],
      },
    }),
    { clampArmed: true, headroom: 20 },
  );
  assert.equal(r.factor, 0);
  assert.equal(r.paused, true);
  assert.match(r.advice, /SATURATED/);
});

test('rejected bound account with healthy tiered bee capacity ⇒ broad placement advice', () => {
  const r = buildCapacityReport(
    tieredHr({
      utilization: 1,
      utilizationPct: 100,
      rejected: true,
      queueDepth: 0,
      priorityTiers: {
        healthyAccounts: 2,
        tier1Reserve: 1,
        tiers: [
          { tier: 1, cap: 24, inFlight: 0, queued: 0 },
          { tier: 2, cap: 20, inFlight: 0, queued: 0 },
          { tier: 3, cap: 19, inFlight: 0, queued: 0 },
          { tier: 4, cap: 1, inFlight: 0, queued: 0 },
        ],
      },
    }),
    { clampArmed: true, headroom: 13 },
  );
  assert.equal(r.rejected, true);
  assert.equal(r.dispatchBudget, 19);
  assert.equal(r.factor, 1);
  assert.equal(r.recommendedHeadroom, 13);
  assert.equal(r.throttled, false);
  assert.match(r.advice, /abundant/);
});

test('tier layer OFF (no priorityTiers) ⇒ dispatchBudget null, still reports saturation', () => {
  const r = buildCapacityReport({ reachable: true, utilization: 0.1, queueDepth: 0, inFlight: 1 }, { clampArmed: false });
  assert.equal(r.tierLayer, false);
  assert.equal(r.dispatchBudget, null);
  assert.equal(r.capByTier, null);
  assert.equal(r.factor, 1);
  assert.equal(r.clampArmed, false);
});

test('no headroom arg ⇒ recommendedHeadroom null (report only)', () => {
  const r = buildCapacityReport(tieredHr(), { clampArmed: true });
  assert.equal(r.recommendedHeadroom, null);
  assert.equal(r.throttled, null);
});

const acctRow = (id: string, over: Partial<AccountStatusRow> = {}): AccountStatusRow => ({
  id,
  provider: 'claude',
  credentialRef: `token:~/.papercusp/${id}`,
  boundTo: [],
  available: true,
  usageWalled: false,
  sustainedlyLimited: false,
  edgeThrottleKnown: true,
  edgeThrottled: false,
  edgeThrottleCooledIps: 0,
  edgeThrottleBare429Streak: 0,
  rate: { pausedUntil: 0, penaltyCount: 0, lastPenaltyAt: 0, windowStartedAt: 0 },
  liveBuckets: [],
  readingStatus: 'fresh',
  ...over,
});

test('EI-19944752041493781: sustainedlyLimitedCount is scoped to the USABLE set — an unavailable ' +
  '(usage-walled) sustainedlyLimited account must NOT count against a DIFFERENT, actually-usable account', async () => {
  const { readBeeProviderAvailability } = await import('./capacity');
  // Reproduces the exact measured incident: 4 claude accounts — one usage-walled AND
  // sustainedlyLimited (unavailable, so NOT usable), two edge-throttled (available but not
  // usable), and one genuinely healthy + usable account that is NOT sustainedlyLimited at all.
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('aviynw', { available: false, usageWalled: true, sustainedlyLimited: true, edgeThrottled: true }),
    acctRow('aviynw3', { edgeThrottled: true }),
    acctRow('aviynw10', { edgeThrottled: true }),
    acctRow('avi_storewolf.com', { edgeThrottled: false, sustainedlyLimited: false }),
  ]);
  const acct = await readBeeProviderAvailability();
  assert.ok(acct, 'expected an availability read');
  assert.equal(acct!.usable, 1, 'only avi_storewolf.com is available AND not edge-throttled');
  assert.equal(
    acct!.sustainedlyLimitedCount,
    0,
    'the walled aviynw account (not usable) must not be counted — the one usable account is fine',
  );
});

test('EI-19944752041493781: sustainedlyLimitedCount DOES count a sustainedlyLimited account that IS usable', async () => {
  const { readBeeProviderAvailability } = await import('./capacity');
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('a', { sustainedlyLimited: true }), // available, not edge-throttled ⇒ usable AND sustainedlyLimited
    acctRow('b', { sustainedlyLimited: false }),
  ]);
  const acct = await readBeeProviderAvailability();
  assert.ok(acct);
  assert.equal(acct!.usable, 2);
  assert.equal(acct!.sustainedlyLimitedCount, 1, 'exactly the one usable, sustainedlyLimited account counts');
});
