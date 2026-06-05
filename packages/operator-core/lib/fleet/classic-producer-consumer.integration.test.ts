/**
 * classic-producer-consumer.integration.test.ts — D-008 (producer-consumer).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The bounded buffer that NEEDS the
 * backpressure governor (D-005): credits model the buffer's free slots. A producer takes
 * a slot (admit consumes a credit); when the buffer is full (0 credits) the producer is
 * refused — backpressure — instead of overrunning. A consumer frees a slot (grants a
 * credit), unblocking the producer. The token bucket gives the same property by rate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { configureCredits, configureBucket, grantCredits, admitSpawn } from './governor';

const FLEET_GOVERNOR_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.fleet_governor (
    workspace_id text NOT NULL, kind text NOT NULL, scope_key text NOT NULL,
    capacity numeric, refill_per_sec numeric, tokens numeric, updated_at timestamptz,
    cb_state text, cb_failures integer NOT NULL DEFAULT 0, cb_threshold integer,
    cb_cooldown_sec integer, cb_opened_at timestamptz,
    credits integer, credit_max integer, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, kind, scope_key))`;

const WS = 'default';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('prodcons');
  await db.sql.unsafe(FLEET_GOVERNOR_DDL);
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await db.sql`TRUNCATE harness_shared.fleet_governor`; });

describe('producer-consumer — bounded buffer backpressure (D-008)', () => {
  it('a full buffer refuses producers; a consumer frees a slot and unblocks them', async () => {
    // Buffer of 2 free slots (credits).
    await configureCredits(db.sql, { workspaceId: WS, scopeKey: 'role:worker', credits: 2, max: 2 });

    // Producers fill the buffer.
    expect((await admitSpawn(db.sql, { workspaceId: WS, role: 'worker' })).admitted).toBe(true);  // slot 1
    expect((await admitSpawn(db.sql, { workspaceId: WS, role: 'worker' })).admitted).toBe(true);  // slot 2
    const full = await admitSpawn(db.sql, { workspaceId: WS, role: 'worker' });                    // buffer full
    expect(full.admitted).toBe(false);
    expect(full.reason).toBe('no_credits:role:worker');

    // Consumer takes one item out → frees a slot.
    await grantCredits(db.sql, { workspaceId: WS, scopeKey: 'role:worker', n: 1 });
    expect((await admitSpawn(db.sql, { workspaceId: WS, role: 'worker' })).admitted).toBe(true);    // producer unblocked
    expect((await admitSpawn(db.sql, { workspaceId: WS, role: 'worker' })).admitted).toBe(false);   // full again
  });

  it('the token bucket bounds the long-run production RATE (refill-paced)', async () => {
    // Burst of 2, then 1 token/sec.
    const t0 = 7_000_000;
    await configureBucket(db.sql, { workspaceId: WS, scopeKey: 'global', capacity: 2, refillPerSec: 1, now: t0 });
    expect((await admitSpawn(db.sql, { workspaceId: WS, now: t0 })).admitted).toBe(true);   // burst 1
    expect((await admitSpawn(db.sql, { workspaceId: WS, now: t0 })).admitted).toBe(true);   // burst 2
    expect((await admitSpawn(db.sql, { workspaceId: WS, now: t0 })).admitted).toBe(false);  // burst exhausted
    // 1s later → exactly one more token accrued.
    expect((await admitSpawn(db.sql, { workspaceId: WS, now: t0 + 1000 })).admitted).toBe(true);
    expect((await admitSpawn(db.sql, { workspaceId: WS, now: t0 + 1000 })).admitted).toBe(false);
  });
});
