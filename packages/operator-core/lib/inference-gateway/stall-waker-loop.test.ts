/**
 * Tests for the stall-waker-loop's cross-workspace account resolution (WI-3310 layer 2).
 *
 * /admin/stalls is GLOBAL (one gateway, stalls from every workspace's bees) while the loop is a
 * module singleton bound to ONE workspaceId (the registry's first entry — 'default' — on
 * boot-start). A same-workspace-only accountStatus lookup therefore MISSED every real account on
 * this box, and capacityBack's unknown-account fallback (`return true`) waived the whole
 * availability check — waking agents onto usage-walled accounts ("rate limit recovered on
 * avistorewolf.com" for DAYS, 2026-07-07 owner report). findAccountRow resolves the account across
 * every registry workspace (own first), with a learned accountId→workspace cache.
 */
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { findAccountRow, ensureStallWakerLoop, stopStallWakerLoop, getStallWakerStatus } from './stall-waker-loop';
import type { AccountStatusRow } from '../deployment/account-pool-store';

const row = (id: string, over: Partial<AccountStatusRow> = {}): AccountStatusRow => ({
  id,
  provider: 'claude',
  credentialRef: `token:~/.papercusp/${id}`,
  boundTo: [],
  available: false,
  usageWalled: true,
  usageResetAt: 2_000_000,
  sustainedlyLimited: true,
  edgeThrottleKnown: false,
  edgeThrottled: false,
  edgeThrottleCooledIps: 0,
  edgeThrottleBare429Streak: 0,
  rate: { pausedUntil: 0, penaltyCount: 0, lastPenaltyAt: 0, windowStartedAt: 0 } as AccountStatusRow['rate'],
  liveBuckets: [],
  // Required on AccountStatusRow (EI-18809949582687481's freshness field). These fixture rows
  // carry a real measured verdict (usageWalled + a usageResetAt), so 'fresh' is the coherent
  // default; stall-waker-loop.ts does not branch on it, so this is semantically neutral here.
  // Override via `over` if a test needs to exercise stale/never-observed readings.
  readingStatus: 'fresh',
  // WI-41147: the burn governor verdict is required on AccountStatusRow. A neutral 'none'
  // (no history in these fixtures) keeps every existing assertion untouched; override via
  // `over` to exercise throttle/shed rows.
  burn: {
    burnRatePerHr: null,
    headroomFraction: null,
    projectedExhaustionAt: null,
    exhaustsBeforeReset: false,
    action: 'none',
    reason: 'test fixture — no burn history',
  },
  ...over,
});

function deps(pools: Record<string, AccountStatusRow[]>) {
  const calls: string[] = [];
  return {
    calls,
    d: {
      status: async (ws: string) => {
        calls.push(ws);
        if (!(ws in pools)) throw new Error(`no pool for ${ws}`);
        return pools[ws];
      },
      listWorkspaces: () => Object.keys(pools),
      cache: new Map<string, string>(),
    },
  };
}

test('the incident shape: account lives in another workspace than the loop is bound to — found, not fallback-waived', async () => {
  const { d } = deps({
    default: [],
    'papercusp-workspace': [row('avistorewolf.com')],
  });
  const a = await findAccountRow('default', 'avistorewolf.com', d);
  assert.ok(a, 'the account must be RESOLVED cross-workspace, never left to the unknown-account fallback');
  assert.equal(a!.usageWalled, true);
  assert.equal(a!.available, false);
});

test('own workspace is preferred (no registry scan when the account is local)', async () => {
  const { d, calls } = deps({
    'papercusp-workspace': [row('aviynw8', { available: true, usageWalled: false, usageResetAt: undefined })],
    other: [row('aviynw8')],
  });
  const a = await findAccountRow('papercusp-workspace', 'aviynw8', d);
  assert.equal(a!.available, true, 'the own-workspace row wins');
  assert.deepEqual(calls, ['papercusp-workspace'], 'no cross-workspace scan needed');
});

test('a genuinely unknown account (in NO workspace) stays undefined — the fallback is for real frame-default creds only', async () => {
  const { d } = deps({ default: [], 'papercusp-workspace': [row('aviynw8')] });
  assert.equal(await findAccountRow('default', 'not-a-pool-account', d), undefined);
});

test('the learned cache short-circuits repeat lookups and self-heals when the pool changes', async () => {
  const pools: Record<string, AccountStatusRow[]> = { default: [], wsB: [row('acct')] };
  const { d, calls } = deps(pools);
  await findAccountRow('default', 'acct', d); // scan: default → wsB (learned)
  calls.length = 0;
  await findAccountRow('default', 'acct', d);
  assert.deepEqual(calls, ['wsB'], 'second lookup goes straight to the learned workspace');
  // Pool changes under us: the account moves — the stale cache entry must not strand the lookup.
  pools.wsC = [row('acct')];
  pools.wsB = [];
  d.listWorkspaces = () => Object.keys(pools);
  const a = await findAccountRow('default', 'acct', d);
  assert.ok(a, 'stale cache entry is dropped and the account re-resolved');
});

test('an erroring workspace pool is skipped, not fatal', async () => {
  const { d } = deps({ 'papercusp-workspace': [row('acct')] });
  const withBroken = {
    ...d,
    status: async (ws: string) => {
      if (ws === 'broken') throw new Error('pg down');
      return d.status(ws);
    },
    listWorkspaces: () => ['broken', 'papercusp-workspace'],
  };
  const a = await findAccountRow('broken', 'acct', withBroken);
  assert.ok(a, 'resolution survives a broken workspace pool');
});

// EI-2432: runtime observability for the loop itself — running?, since when, poll cadence,
// last-tick health, live counters — without grepping operator stdout.
afterEach(() => {
  stopStallWakerLoop(); // never leak a live timer/singleton across test files
});

test('getStallWakerStatus reports not-running with null/zeroed fields before the loop ever starts', () => {
  stopStallWakerLoop(); // ensure a clean slate regardless of test order
  const s = getStallWakerStatus();
  assert.equal(s.running, false);
  assert.equal(s.workspaceId, null);
  assert.equal(s.startedAt, null);
  assert.equal(s.lastTickAt, null);
  assert.equal(s.tickCount, 0);
  assert.equal(s.pendingCount, 0);
  assert.equal(s.breadcrumbCount, 0);
  assert.equal(s.wokenTotal, 0);
  assert.equal(s.pollMs > 0, true, 'pollMs is always a positive cadence, even when not running');
});

test('ensureStallWakerLoop flips running:true + records startedAt/workspaceId; stopStallWakerLoop reverts it', () => {
  const before = Date.now();
  ensureStallWakerLoop('a-test-workspace');
  const s = getStallWakerStatus();
  assert.equal(s.running, true);
  assert.equal(s.workspaceId, 'a-test-workspace');
  assert.ok(s.startedAt !== null && s.startedAt >= before, 'startedAt is stamped at start time');
  assert.equal(s.tickCount, 0, 'no tick has fired yet — managedSetInterval only fires after pollMs elapses');

  stopStallWakerLoop();
  const s2 = getStallWakerStatus();
  assert.equal(s2.running, false);
  assert.equal(s2.workspaceId, null);
  assert.equal(s2.startedAt, null);
});

test('ensureStallWakerLoop is idempotent — a second call while running does not reset startedAt', () => {
  ensureStallWakerLoop('ws-1');
  const first = getStallWakerStatus().startedAt;
  ensureStallWakerLoop('ws-2'); // no-op per the existing `if (timer) return;` guard
  const second = getStallWakerStatus();
  assert.equal(second.startedAt, first, 'the running loop is untouched by a second ensure call');
  assert.equal(second.workspaceId, 'ws-1', 'still bound to the FIRST workspace, not silently re-bound');
});
