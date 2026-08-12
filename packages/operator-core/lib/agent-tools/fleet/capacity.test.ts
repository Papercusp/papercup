/** Tests for fleet:capacity's pure report builder (queen-capacity-aware-dispatch-2026-06-22 P-003). */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { buildCapacityReport } from './capacity';
import type { GatewayHeadroom } from '../../inference-gateway/observability';
import type { AccountStatusRow } from '../../deployment/account-pool-store';
import type { AccountSessionOverride } from '../../deployment/account-session-override';

const { mockAccountStatus, mockGetAccountOverride } = vi.hoisted(() => ({
  mockAccountStatus: vi.fn(),
  mockGetAccountOverride: vi.fn(
    async (): Promise<AccountSessionOverride> => ({ forcedAccounts: [], excludeAccounts: [] }),
  ),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));
vi.mock('../../deployment/account-session-override', async (importOriginal) => {
  // Keep the REAL applyAccountOverride (a pure filter — worth exercising for real, not a
  // stand-in) and mock only getAccountOverride (the DB-backed read), default no-op so the
  // pre-existing readBeeProviderAvailability tests below are unaffected.
  const actual = await importOriginal<typeof import('../../deployment/account-session-override')>();
  return { ...actual, getAccountOverride: mockGetAccountOverride };
});
vi.mock('../../deployment/account-pool-store', () => ({ accountStatus: mockAccountStatus }));
// Keep the end-to-end handler test hermetic (no live DB): the flag read is best-effort
// (handler already `.catch(() => false)`s a failure), so a fixed resolved value is fine.
vi.mock('@papercusp/flags', () => ({ FLAGS: { MUG_CAPACITY_DISPATCH: 'MUG_CAPACITY_DISPATCH' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));

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

test('EI-19932168784507536: an account excluded by the owner session override is NOT counted ' +
  'available/usable, even though raw pool-health says it is healthy', async () => {
  const { readBeeProviderAvailability } = await import('./capacity');
  // Reproduces the measured incident: two pool-healthy accounts, one of which is outside the
  // session-override allow-list (the same override spawn-env.ts's resolveSpawnGatewayEnv
  // enforces at admission) — that one must be excluded from available/usable, or the capacity
  // read stays a false-green for a route that spawn admission will actually refuse.
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('aviynw3', {}), // healthy, and allowed
    acctRow('excluded-acct', {}), // healthy, but session-override-excluded
  ]);
  mockGetAccountOverride.mockResolvedValueOnce({ forcedAccounts: [], excludeAccounts: ['excluded-acct'] });

  const acct = await readBeeProviderAvailability();
  assert.ok(acct, 'expected an availability read');
  assert.equal(acct!.available, 1, 'the override-excluded account must not count as available');
  assert.equal(acct!.usable, 1, 'the override-excluded account must not count as usable');
  assert.equal(acct!.overrideExcludedCount, 1, 'the report must name how many accounts the override excluded');
});

test('EI-19932168784507536: an account OUTSIDE the session-override ALLOW-LIST (forcedAccounts) is ' +
  'excluded too — the verbatim branch the measured incident actually hit', async () => {
  const { readBeeProviderAvailability } = await import('./capacity');
  // The two sibling tests here pin only the excludeAccounts (deny-list) leg. The MEASURED incident
  // was the OTHER leg: admission refused with "account 'aviynw3' is outside the session override
  // allow-list" — i.e. a non-empty `forcedAccounts` that simply did not list the account. Those are
  // two separate filters in applyAccountOverride (allow-list first, then deny-list), so covering
  // only the deny-list leaves a regression that drops the allow-list filter passing every test
  // while reproducing this item's exact incident. Both rows are pool-HEALTHY on purpose: the whole
  // defect is that raw pool-health says "usable" about a route admission will refuse outright.
  // CALIBRATION FIRST: the exact same two rows, with BOTH allow-listed, must count as 2. Without
  // this the assertions below are not falsifiable — a `1` could come from any unrelated filter (or
  // from the fixture only ever having one healthy row), and the test would keep passing against an
  // implementation that had stopped consulting the allow-list at all.
  mockAccountStatus.mockResolvedValueOnce([acctRow('aviynw3', {}), acctRow('sanctioned-acct', {})]);
  mockGetAccountOverride.mockResolvedValueOnce({
    forcedAccounts: ['aviynw3', 'sanctioned-acct'],
    excludeAccounts: [],
  });
  const calibration = await readBeeProviderAvailability();
  assert.equal(calibration!.available, 2, 'calibration: both rows are healthy AND allow-listed, so both must count');
  assert.equal(calibration!.overrideExcludedCount, 0, 'calibration: nothing is excluded when both are allow-listed');

  mockAccountStatus.mockResolvedValueOnce([
    acctRow('aviynw3', {}), // healthy, but NOT in the allow-list below
    acctRow('sanctioned-acct', {}), // healthy, and the only allow-listed account
  ]);
  mockGetAccountOverride.mockResolvedValueOnce({ forcedAccounts: ['sanctioned-acct'], excludeAccounts: [] });

  const acct = await readBeeProviderAvailability();
  assert.ok(acct, 'expected an availability read');
  assert.equal(acct!.available, 1, 'an account outside the allow-list must not count as available');
  assert.equal(acct!.usable, 1, 'an account outside the allow-list must not count as usable');
  assert.equal(acct!.overrideExcludedCount, 1, 'the allow-list exclusion must be reported, not silently dropped');
});

test('EI-19932168784507536: the full fleet:capacity report surfaces overrideExcludedAccounts ' +
  'end-to-end (capacity and admission must agree about the same pool)', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce(tieredHr());
  mockAccountStatus.mockResolvedValueOnce([acctRow('aviynw3', {}), acctRow('excluded-acct', {})]);
  mockGetAccountOverride.mockResolvedValueOnce({ forcedAccounts: [], excludeAccounts: ['excluded-acct'] });

  const res = (await capacityMod.default.handler({} as never, { role: 'su' } as never)) as {
    content: { text: string }[];
  };
  const body = JSON.parse(res.content[0]!.text);
  assert.equal(body.ok, true);
  assert.equal(body.availableAccounts, 1, 'admission-excluded account must not inflate availableAccounts');
  assert.equal(body.usableAccounts, 1, 'admission-excluded account must not inflate usableAccounts');
  assert.equal(
    body.overrideExcludedAccounts,
    1,
    'the report must name the excluded account so a caller can tell "no capacity" from "fenced off"',
  );
  headroomSpy.mockRestore();
});

test('EI-20183190844096359: Codex capacity ignores stale Claude walls and reports the requested scope', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce({
    provider: 'codex',
    reachable: true,
    priorityTiers: {
      healthyAccounts: 1,
      tier1Reserve: 1,
      tiers: [{ tier: 3, cap: 4, inFlight: 1, queued: 0 }],
    },
    healthyAccounts: 1,
    inFlight: 1,
    queueDepth: 0,
  });
  mockAccountStatus.mockResolvedValueOnce([
    // The stale Claude rows from the incident must not participate in a Codex read.
    acctRow('claude-walled', { available: false, usageWalled: true, readingStatus: 'stale' }),
    acctRow('chatgpt-sub-cli', { provider: 'codex', available: true, usageWalled: false, readingStatus: 'fresh' }),
  ]);

  const res = (await capacityMod.default.handler(
    { provider: 'codex', model: 'gpt-5.6-luna', headroom: 3 } as never,
    { role: 'su' } as never,
  )) as { content: { text: string }[] };
  const body = JSON.parse(res.content[0]!.text);

  assert.equal(body.ok, true);
  assert.equal(body.verdict, 'measured');
  assert.deepEqual(body.scope, { provider: 'codex', model: 'gpt-5.6-luna', account: null });
  assert.equal(body.usableAccounts, 1);
  assert.equal(body.poolExhausted, false);
  assert.equal(body.healthyAccounts, 1);
  assert.equal(headroomSpy.mock.calls[0]?.[0]?.provider, 'codex');
  headroomSpy.mockRestore();
});

test('fleet:capacity account-only scope resolves a Codex account instead of defaulting to Claude', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce({
    provider: 'codex',
    reachable: true,
    priorityTiers: {
      healthyAccounts: 1,
      tier1Reserve: 1,
      tiers: [{ tier: 3, cap: 4, inFlight: 0, queued: 0 }],
    },
  });
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('chatgpt-sub-cli', { provider: 'codex', available: true, readingStatus: 'fresh' }),
  ]);

  const res = (await capacityMod.default.handler({ account: 'chatgpt-sub-cli' } as never, { role: 'su' } as never)) as {
    content: { text: string }[];
  };
  const body = JSON.parse(res.content[0]!.text);
  assert.equal(body.verdict, 'measured');
  assert.equal(body.scope.provider, 'codex');
  assert.equal(body.usableAccounts, 1);
  assert.equal(headroomSpy.mock.calls[0]?.[0]?.provider, 'codex');
  headroomSpy.mockRestore();
});
