/**
 * agent-governor-pg-store.integration.test.ts — RB-007.
 *
 * Proves the PG-backed cross-process GovernorStore against a REAL Postgres (testcontainer):
 * two RateLimitGovernor instances (standing in for two operator processes) that share ONE
 * `agent_rate_budget` row genuinely share the budget — a 429 on one pauses the other, and the
 * shared RPM window is enforced across both even under PARALLEL contention (the `SELECT … FOR
 * UPDATE` serializes the read-modify-write, so the counter can't be double-spent). That last one
 * is the property a pure-in-memory test can't show; it's the whole point of going to PG.
 *
 * Run: npx vitest run --config vitest.integration.config.ts apps/operator/lib/agent-governor-pg-store.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTestPg } from '@papercusp/test-config';
import { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';
import { PgGovernorStore } from './agent-governor-pg-store';

let sql: postgres.Sql;
let store: PgGovernorStore;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `gov_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 8, onnotice: () => {} });

  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  // Apply the real migration DDL so we test the shipped schema, not a hand-rolled copy.
  const ddl = readFileSync(
    join(__dirname, '../../../libs/papercusp/libs/db/sql/111-agent-rate-budget.sql'),
    'utf8',
  );
  await sql.unsafe(ddl);

  store = new PgGovernorStore(sql);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** A pair of governors with an injected clock, both bound to the SAME shared store + key. */
function sharedPair(key: string, limits: { maxConcurrent: number; rpm?: number }) {
  const clock = { t: 1_000_000 };
  const deps = {
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    store,
    storeKey: key,
  };
  return {
    clock,
    a: new RateLimitGovernor(limits, deps),
    b: new RateLimitGovernor(limits, deps),
  };
}

describe('PgGovernorStore (RB-007)', () => {
  it('a 429 penalty on one governor pauses the OTHER via the shared row', async () => {
    const { a, b, clock } = sharedPair('anthropic:opus', { maxConcurrent: 5 });
    a.penalize({ retryAfterMs: 30_000 });
    // let the fire-and-forget shared write land
    await new Promise((r) => setTimeout(r, 50));
    const blocked = await b.acquire({}, { maxWaitMs: 1000 });
    expect(blocked).toBeNull(); // B inherited A's account-wide pause
    clock.t += 30_001;
    const ok = await b.acquire({}, { maxWaitMs: 1000 });
    expect(ok).not.toBeNull();
    ok?.();
    const row = await sql`SELECT paused_until FROM harness_shared.agent_rate_budget WHERE bucket_key = 'anthropic:opus'`;
    expect(Number(row[0].paused_until)).toBe(1_030_000);
  });

  it('the shared RPM window is enforced across both governors (no double-spend under FOR UPDATE)', async () => {
    const key = 'anthropic:sonnet';
    const RPM = 5;
    // Many parallel acquires across BOTH governors; with real now/sleep they truly race the PG row.
    const a = new RateLimitGovernor({ maxConcurrent: 10, rpm: RPM }, { store, storeKey: key });
    const b = new RateLimitGovernor({ maxConcurrent: 10, rpm: RPM }, { store, storeKey: key });

    // Fire RPM+? acquires concurrently with a tight maxWait so the over-cap ones bail rather than
    // block for a whole minute. Exactly RPM should win the window; the rest get null.
    const attempts = [a, b, a, b, a, b, a, b].map((g) => g.acquire({}, { maxWaitMs: 200 }));
    const releases = await Promise.all(attempts);
    const granted = releases.filter((r) => r !== null);
    expect(granted.length).toBe(RPM); // the shared window admitted EXACTLY rpm, not 2×rpm
    for (const rel of granted) rel?.();

    const row = await sql`SELECT req_in_window FROM harness_shared.agent_rate_budget WHERE bucket_key = ${key}`;
    expect(Number(row[0].req_in_window)).toBe(RPM); // the shared counter is exactly at the cap
  });

  it('auto-tuned limits persist + reload across transacts (the shared row carries rpm)', async () => {
    const key = 'openai:default';
    // One transact learns rpm (as recordHeaders would from an x-ratelimit-limit-requests header)…
    await store.transact(key, { maxConcurrent: 5 }, (s) => {
      s.limits.rpm = 120;
    });
    // …a SECOND transact must LOAD it back from PG, not reset to the floor.
    let loadedRpm: number | undefined;
    await store.transact(key, { maxConcurrent: 5 }, (s) => {
      loadedRpm = s.limits.rpm;
    });
    expect(loadedRpm).toBe(120);
    // NOTE: we deliberately do NOT assert the raw jsonb shape of `limits` here.
    // The store binds it as `${JSON.stringify(x)}::jsonb` (required by the
    // production getOrgPg client, where sql.json THROWS). This testcontainer
    // client double-encodes that form, so a direct `row.limits.rpm` read would
    // see a string — the inverse of production. The client-agnostic guarantee
    // (rpm survives a transact→PG→transact round-trip, via the store's own
    // shape-tolerant read) is the `loadedRpm` assertion above. jsonb shape is
    // verified against the live host. See agent-insights/postgres-js-jsonb-binding.
  });
});
