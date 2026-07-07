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
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { findAccountRow } from './stall-waker-loop';
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
  rate: { pausedUntil: 0, penaltyCount: 0, lastPenaltyAt: 0, windowStartedAt: 0 } as AccountStatusRow['rate'],
  liveBuckets: [],
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
