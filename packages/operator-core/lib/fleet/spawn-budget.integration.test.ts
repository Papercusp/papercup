/**
 * spawn-budget.integration.test.ts — the P-009 pre-alloc budget primitive
 * (`tryConsumeSpawnCredit`, real PG).
 *
 * Plan: unify-agent-spawn-chokepoint-2026-06-06. The brain pre-allocates a stream a
 * spawn budget (a `fleet_governor` credit pool); `new_subagent:request` consumes one
 * to auto-approve, so per-spawn brain adjudication is optional until the budget runs
 * out. Atomic + never goes below zero; absent pool → false (routes to the brain).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { tryConsumeSpawnCredit, spawnBudgetScopeKey } from './governor';

const FLEET_GOVERNOR_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.fleet_governor (
    workspace_id text NOT NULL, kind text NOT NULL, scope_key text NOT NULL,
    capacity double precision, refill_per_sec double precision, tokens double precision,
    updated_at timestamptz, cb_state text, cb_failures int, cb_threshold int,
    cb_cooldown_sec int, cb_opened_at timestamptz, credits int, credit_max int,
    PRIMARY KEY (workspace_id, kind, scope_key))`;

const WS = 'default';
let db: FreshPgDb;

async function seedCredits(scopeKey: string, credits: number) {
  await db.sql`
    INSERT INTO harness_shared.fleet_governor (workspace_id, kind, scope_key, credits, credit_max)
    VALUES (${WS}, 'credit', ${scopeKey}, ${credits}, ${credits})
    ON CONFLICT (workspace_id, kind, scope_key) DO UPDATE SET credits = ${credits}`;
}
async function creditsOf(scopeKey: string): Promise<number | null> {
  const rows = await db.sql<{ credits: number | null }[]>`
    SELECT credits FROM harness_shared.fleet_governor
     WHERE workspace_id = ${WS} AND kind = 'credit' AND scope_key = ${scopeKey}`;
  return rows[0]?.credits ?? null;
}

beforeAll(async () => {
  db = await createFreshPgDb('spawn-budget');
  await db.sql.unsafe(FLEET_GOVERNOR_DDL);
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await db.sql`TRUNCATE harness_shared.fleet_governor`; });

describe('tryConsumeSpawnCredit (P-009 pre-alloc budget, real PG)', () => {
  it('consumes one credit + returns true while budget remains, then false when exhausted', async () => {
    const scope = spawnBudgetScopeKey('worker-stream');
    await seedCredits(scope, 2);
    expect(await tryConsumeSpawnCredit(db.sql, { workspaceId: WS, scopeKey: scope })).toBe(true);
    expect(await creditsOf(scope)).toBe(1);
    expect(await tryConsumeSpawnCredit(db.sql, { workspaceId: WS, scopeKey: scope })).toBe(true);
    expect(await creditsOf(scope)).toBe(0);
    // exhausted → false, never decrements below zero
    expect(await tryConsumeSpawnCredit(db.sql, { workspaceId: WS, scopeKey: scope })).toBe(false);
    expect(await creditsOf(scope)).toBe(0);
  });

  it('returns false when no budget pool exists (the default — request routes to the brain)', async () => {
    const ok = await tryConsumeSpawnCredit(db.sql, { workspaceId: WS, scopeKey: spawnBudgetScopeKey('untrusted') });
    expect(ok).toBe(false);
  });

  it('budget is per-stream (scope key keyed to the stream owner)', () => {
    expect(spawnBudgetScopeKey('abc')).toBe('spawn-budget:abc');
    expect(spawnBudgetScopeKey('abc')).not.toBe(spawnBudgetScopeKey('xyz'));
  });

  // Gap 3 — concurrent debit must NOT over-grant. The SELECT … FOR UPDATE serializes the
  // read-then-decrement, so N racing consumers against a pool of K credits hand out EXACTLY
  // K trues; the rest see false and the pool floors at 0 (never negative). A failure here is a
  // real race bug in the FOR UPDATE gate, not a flaky test.
  it('8 concurrent consumers against 3 credits grant EXACTLY 3 (FOR UPDATE serializes; never negative)', async () => {
    const scope = spawnBudgetScopeKey('race-stream');
    await seedCredits(scope, 3);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => tryConsumeSpawnCredit(db.sql, { workspaceId: WS, scopeKey: scope })),
    );
    expect(results.filter((r) => r === true)).toHaveLength(3);
    expect(results.filter((r) => r === false)).toHaveLength(5);
    expect(await creditsOf(scope)).toBe(0); // floored, never below zero
  });
});
