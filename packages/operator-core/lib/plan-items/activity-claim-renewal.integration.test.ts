/**
 * activity-claim-renewal.integration.test.ts —
 * D-003 per-turn auto-renewal of plan-item ACTIVITY claims
 * (plan-item-assignment-claim-liveness-2026-06-04). Exercises the renewal SQL
 * (`renewOwnerActivityClaims`) against a real Postgres + the pure throttle that keeps
 * the activity-bus hot path cheap. The bus wiring itself (onAgentActivity → throttle →
 * renew) is a thin glue over these two tested pieces.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const claims = await import('./claims');
const { makeThrottle, ACTIVITY_RENEW_THROTTLE_MS } = await import('./activity-claim-renewal');

const WS = 'ws-activity-renew';
const OTHER_WS = 'ws-other';
const HARNESS = 'papercup';
const PLAN = 'demo-plan';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('activity-renew');
  h.sql = db.sql;
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await db.sql.unsafe(readMigration('141-plan-item-claims.sql')).simple();
  // 143 (agent_activity) rides along because acquireClaimLocal's holder-activity
  // grace check (EI-8997) joins it — same reason claims.integration.test.ts loads
  // it. Without this, every claims.acquireClaimLocal call in this file fails with
  // "relation harness_shared.agent_activity does not exist" (EI-9508).
  await db.sql.unsafe(readMigration('143-agent-activity.sql')).simple();
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_item_claims`;
});

/** Seconds remaining on a claim's lease as of now (negative = lapsed). */
async function secsLeft(itemId: string, owner: string): Promise<number> {
  const rows = await db.sql<{ secs: number }[]>`
    SELECT EXTRACT(EPOCH FROM (expires_ts - clock_timestamp()))::float8 AS secs
      FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${WS} AND owner = ${owner} AND item_id = ${itemId}`;
  return rows[0] ? Number(rows[0].secs) : NaN;
}

describe('renewOwnerActivityClaims (D-003 per-turn renewal)', () => {
  it('renews a non-expired ACTIVITY claim — pushes the lease back out to a full TTL', async () => {
    const r = await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A', livenessMode: 'activity' });
    expect(r.ok).toBe(true);
    // Age the lease down to ~30s left (simulate time passing toward lapse).
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = clock_timestamp() + interval '30 seconds' WHERE item_id = 'P-001'`;
    expect(await secsLeft('P-001', 'sess-A')).toBeLessThan(120);

    const renewed = await claims.renewOwnerActivityClaims(WS, 'sess-A');
    expect(renewed).toEqual(['P-001']);
    // Pushed back out to ~the activity TTL (1800s) — well beyond the aged 30s.
    expect(await secsLeft('P-001', 'sess-A')).toBeGreaterThan(1000);
  });

  it('DOES renew an AVAILABILITY claim too (EI-295 residual: no heartbeat path exists, so turn-active owners must keep their lanes)', async () => {
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-002', owner: 'sess-A', livenessMode: 'availability' });
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = clock_timestamp() + interval '30 seconds' WHERE item_id = 'P-002'`;

    const renewed = await claims.renewOwnerActivityClaims(WS, 'sess-A');
    expect(renewed).toEqual(['P-002']);
    expect(await secsLeft('P-002', 'sess-A')).toBeGreaterThan(1000); // pushed back out
  });

  it('does NOT resurrect an already-LAPSED activity claim (must be re-acquired)', async () => {
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-003', owner: 'sess-A', livenessMode: 'activity' });
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = clock_timestamp() - interval '5 seconds' WHERE item_id = 'P-003'`;

    const renewed = await claims.renewOwnerActivityClaims(WS, 'sess-A');
    expect(renewed).toEqual([]);
    expect(await secsLeft('P-003', 'sess-A')).toBeLessThan(0); // still lapsed
  });

  it('renews ALL of an owner’s active claims; only that owner’s; only that workspace', async () => {
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-010', owner: 'sess-A', livenessMode: 'activity' });
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-011', owner: 'sess-A', livenessMode: 'activity' });
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-012', owner: 'sess-B', livenessMode: 'activity' });

    const renewed = await claims.renewOwnerActivityClaims(WS, 'sess-A');
    expect(renewed.sort()).toEqual(['P-010', 'P-011']); // both of A's, not B's

    // Wrong workspace → nothing.
    expect(await claims.renewOwnerActivityClaims(OTHER_WS, 'sess-A')).toEqual([]);
  });
});

describe('makeThrottle (per-owner activity-bus throttle)', () => {
  it('passes at most once per interval per key, independent across keys', () => {
    const passes = makeThrottle(1000);
    expect(passes('a', 0)).toBe(true); // first
    expect(passes('a', 500)).toBe(false); // within window
    expect(passes('a', 999)).toBe(false); // still within
    expect(passes('a', 1000)).toBe(true); // window elapsed
    expect(passes('b', 500)).toBe(true); // different key, independent
  });

  it('has a sane default interval (≤ the lease TTL so a claim never lapses between renewals)', () => {
    expect(ACTIVITY_RENEW_THROTTLE_MS).toBeGreaterThan(0);
    expect(ACTIVITY_RENEW_THROTTLE_MS).toBeLessThan(claims.DEFAULT_ACTIVITY_TTL_SEC * 1000);
  });
});
