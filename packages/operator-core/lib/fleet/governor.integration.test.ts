/**
 * governor.integration.test.ts — the layered backpressure governor (P2, D-005).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Drives the REAL governor engine
 * against real Postgres: token-bucket spend ceiling + refill, per-harness/user BULKHEAD
 * isolation, circuit breaker (closed→open→half_open→closed), credit-based stage
 * admission, and the ALL-OR-NOTHING composite gate. Time is injected for determinism.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  configureBucket, configureCircuit, configureCredits, grantCredits,
  recordCircuitFailure, recordCircuitSuccess, admitSpawn,
} from './governor';

const FLEET_GOVERNOR_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.fleet_governor (
    workspace_id text NOT NULL, kind text NOT NULL, scope_key text NOT NULL,
    capacity numeric, refill_per_sec numeric, tokens numeric, updated_at timestamptz,
    cb_state text, cb_failures integer NOT NULL DEFAULT 0, cb_threshold integer,
    cb_cooldown_sec integer, cb_opened_at timestamptz,
    credits integer, credit_max integer, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, kind, scope_key),
    CONSTRAINT fleet_governor_kind_chk CHECK (kind IN ('bucket','circuit','credit')))`;

const WS = 'default';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('governor');
  await db.sql.unsafe(FLEET_GOVERNOR_DDL);
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await db.sql`TRUNCATE harness_shared.fleet_governor`; });

describe('governor — token bucket spend ceiling (D-005)', () => {
  it('admits up to capacity then refuses; unconfigured scope is unconstrained', async () => {
    // No config → unconstrained.
    expect((await admitSpawn(db.sql, { workspaceId: WS, harness: 'x' })).admitted).toBe(true);

    await configureBucket(db.sql, { workspaceId: WS, scopeKey: 'global', capacity: 3, refillPerSec: 0 });
    const t = 1_000_000;
    expect((await admitSpawn(db.sql, { workspaceId: WS, cost: 1, now: t })).admitted).toBe(true);
    expect((await admitSpawn(db.sql, { workspaceId: WS, cost: 1, now: t })).admitted).toBe(true);
    expect((await admitSpawn(db.sql, { workspaceId: WS, cost: 1, now: t })).admitted).toBe(true);
    const denied = await admitSpawn(db.sql, { workspaceId: WS, cost: 1, now: t });
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toBe('bucket_exhausted:global');
  });

  it('refills over time at refill_per_sec', async () => {
    const t0 = 2_000_000;
    await configureBucket(db.sql, { workspaceId: WS, scopeKey: 'global', capacity: 3, refillPerSec: 1, tokens: 0, now: t0 });
    expect((await admitSpawn(db.sql, { workspaceId: WS, cost: 1, now: t0 })).admitted).toBe(false); // empty
    // 2s later → 2 tokens accrued.
    expect((await admitSpawn(db.sql, { workspaceId: WS, cost: 2, now: t0 + 2000 })).admitted).toBe(true);
  });
});

describe('governor — bulkhead isolation (D-005)', () => {
  it('a runaway in one harness does not drain another', async () => {
    await configureBucket(db.sql, { workspaceId: WS, scopeKey: 'harness:A', capacity: 1, refillPerSec: 0 });
    await configureBucket(db.sql, { workspaceId: WS, scopeKey: 'harness:B', capacity: 1, refillPerSec: 0 });
    const t = 3_000_000;
    expect((await admitSpawn(db.sql, { workspaceId: WS, harness: 'A', now: t })).admitted).toBe(true);
    expect((await admitSpawn(db.sql, { workspaceId: WS, harness: 'A', now: t })).admitted).toBe(false); // A drained
    expect((await admitSpawn(db.sql, { workspaceId: WS, harness: 'B', now: t })).admitted).toBe(true);  // B intact
  });
});

describe('governor — circuit breaker (D-005)', () => {
  it('trips open on repeated failures, half-opens after cooldown, closes on success', async () => {
    await configureCircuit(db.sql, { workspaceId: WS, scopeKey: 'harness:A', threshold: 2, cooldownSec: 60 });
    const t = 4_000_000;
    expect((await admitSpawn(db.sql, { workspaceId: WS, harness: 'A', now: t })).admitted).toBe(true); // closed

    expect((await recordCircuitFailure(db.sql, { workspaceId: WS, scopeKey: 'harness:A', now: t }))?.state).toBe('closed');
    expect((await recordCircuitFailure(db.sql, { workspaceId: WS, scopeKey: 'harness:A', now: t }))?.state).toBe('open'); // 2 ≥ threshold

    const open = await admitSpawn(db.sql, { workspaceId: WS, harness: 'A', now: t + 1000 });
    expect(open.admitted).toBe(false);
    expect(open.reason).toBe('circuit_open:harness:A');

    // After cooldown → half_open admits a probe.
    const probe = await admitSpawn(db.sql, { workspaceId: WS, harness: 'A', now: t + 61_000 });
    expect(probe.admitted).toBe(true);

    // Probe succeeds → circuit closes.
    await recordCircuitSuccess(db.sql, { workspaceId: WS, scopeKey: 'harness:A' });
    expect((await admitSpawn(db.sql, { workspaceId: WS, harness: 'A', now: t + 62_000 })).admitted).toBe(true);
  });

  it('a failed half_open probe re-opens the circuit', async () => {
    await configureCircuit(db.sql, { workspaceId: WS, scopeKey: 'r', threshold: 1, cooldownSec: 30 });
    const t = 5_000_000;
    await recordCircuitFailure(db.sql, { workspaceId: WS, scopeKey: 'r', now: t }); // open
    await admitSpawn(db.sql, { workspaceId: WS, circuitKey: 'r', now: t + 31_000 }); // half_open probe
    const reopened = await recordCircuitFailure(db.sql, { workspaceId: WS, scopeKey: 'r', now: t + 31_000 });
    expect(reopened?.state).toBe('open');
  });
});

describe('governor — credit-based stage admission (D-005)', () => {
  it('consumes a credit per admit and refuses at zero; grants restore capacity', async () => {
    await configureCredits(db.sql, { workspaceId: WS, scopeKey: 'role:worker', credits: 1, max: 3 });
    expect((await admitSpawn(db.sql, { workspaceId: WS, role: 'worker' })).admitted).toBe(true);
    const denied = await admitSpawn(db.sql, { workspaceId: WS, role: 'worker' });
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toBe('no_credits:role:worker');

    expect(await grantCredits(db.sql, { workspaceId: WS, scopeKey: 'role:worker', n: 2 })).toBe(2);
    expect((await admitSpawn(db.sql, { workspaceId: WS, role: 'worker' })).admitted).toBe(true);
    // grant respects credit_max=3.
    await grantCredits(db.sql, { workspaceId: WS, scopeKey: 'role:worker', n: 99 });
    const capped = await db.sql<{ credits: number }[]>`SELECT credits FROM harness_shared.fleet_governor WHERE kind='credit' AND scope_key='role:worker'`;
    expect(Number(capped[0].credits)).toBe(3);
  });
});

describe('governor — all-or-nothing composite (D-005)', () => {
  it('a single failing gate consumes nothing from the passing gates', async () => {
    // Global bucket has plenty, but harness:A bucket is empty → deny, and global must be untouched.
    await configureBucket(db.sql, { workspaceId: WS, scopeKey: 'global', capacity: 5, refillPerSec: 0 });
    await configureBucket(db.sql, { workspaceId: WS, scopeKey: 'harness:A', capacity: 0, refillPerSec: 0, tokens: 0 });
    const t = 6_000_000;
    const res = await admitSpawn(db.sql, { workspaceId: WS, harness: 'A', cost: 1, now: t });
    expect(res.admitted).toBe(false);
    expect(res.reason).toBe('bucket_exhausted:harness:A');
    const g = await db.sql<{ tokens: string }[]>`SELECT tokens FROM harness_shared.fleet_governor WHERE kind='bucket' AND scope_key='global'`;
    expect(Number(g[0].tokens)).toBe(5); // global NOT debited
  });
});
