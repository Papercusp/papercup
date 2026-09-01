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
import { createFreshPgDb, applyPlanItemClaimMigrations, type FreshPgDb } from '../../test/_pg-helpers';
import { SESSION_END_MARKER } from '../agent-tools/activity/lifecycle-markers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
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
  // 140/141/143 — see EI-9613: shared helper instead of a hand-copied list
  // (this file's own copy is what originally missed 143 → EI-9508).
  await applyPlanItemClaimMigrations(db.sql);
  // The renewal predicate uses the latest recorded session as the liveness
  // authority. This fixture is intentionally minimal: claims tests do not need
  // the rest of migration 079's session columns.
  await db.sql`
    CREATE TABLE IF NOT EXISTS harness_shared.adv_sessions (
      id BIGSERIAL PRIMARY KEY,
      coord_owner_id text,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz
    )
  `;
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_item_claims, harness_shared.agent_activity, harness_shared.adv_sessions`;
});

async function seedSession(
  owner: string,
  options: { startedAgoSec?: number; endedAgoSec?: number } = {},
): Promise<void> {
  const startedAt = new Date(Date.now() - (options.startedAgoSec ?? 60) * 1000);
  const endedAt = options.endedAgoSec == null ? null : new Date(Date.now() - options.endedAgoSec * 1000);
  await db.sql`
    INSERT INTO harness_shared.adv_sessions (coord_owner_id, started_at, ended_at)
    VALUES (${owner}, ${startedAt}, ${endedAt})
  `;
}

async function seedActivity(
  owner: string,
  kind: 'tool' | 'lifecycle' | 'todos',
  summary: string | null,
  ageMs = 0,
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.agent_activity (owner_id, kind, summary, created_at)
    VALUES (${owner}, ${kind}, ${summary}, clock_timestamp() - make_interval(secs => ${ageMs / 1000}))
  `;
}

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
    await seedSession('sess-A');
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
    await seedSession('sess-A');
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-002', owner: 'sess-A', livenessMode: 'availability' });
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = clock_timestamp() + interval '30 seconds' WHERE item_id = 'P-002'`;

    const renewed = await claims.renewOwnerActivityClaims(WS, 'sess-A');
    expect(renewed).toEqual(['P-002']);
    expect(await secsLeft('P-002', 'sess-A')).toBeGreaterThan(1000); // pushed back out
  });

  it('does NOT resurrect an already-LAPSED activity claim (must be re-acquired)', async () => {
    await seedSession('sess-A');
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-003', owner: 'sess-A', livenessMode: 'activity' });
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = clock_timestamp() - interval '5 seconds' WHERE item_id = 'P-003'`;

    const renewed = await claims.renewOwnerActivityClaims(WS, 'sess-A');
    expect(renewed).toEqual([]);
    expect(await secsLeft('P-003', 'sess-A')).toBeLessThan(0); // still lapsed
  });

  it('renews ALL of an owner’s active claims; only that owner’s; only that workspace', async () => {
    await seedSession('sess-A');
    await seedSession('sess-B');
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-010', owner: 'sess-A', livenessMode: 'activity' });
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-011', owner: 'sess-A', livenessMode: 'activity' });
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-012', owner: 'sess-B', livenessMode: 'activity' });

    const renewed = await claims.renewOwnerActivityClaims(WS, 'sess-A');
    expect(renewed.sort()).toEqual(['P-010', 'P-011']); // both of A's, not B's

    // Wrong workspace → nothing.
    expect(await claims.renewOwnerActivityClaims(OTHER_WS, 'sess-A')).toEqual([]);
  });

  it('does NOT renew an ended owner from lifecycle or wake-only activity', async () => {
    await seedSession('sess-ended', { endedAgoSec: 30 });
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-013', owner: 'sess-ended', livenessMode: 'activity' });
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = clock_timestamp() + interval '30 seconds' WHERE item_id = 'P-013'`;

    await seedActivity('sess-ended', 'lifecycle', SESSION_END_MARKER, 20_000);
    await seedActivity('sess-ended', 'lifecycle', 'wake delivered');
    await seedActivity('sess-ended', 'lifecycle', 'session resumed check');

    expect(await claims.renewOwnerActivityClaims(WS, 'sess-ended')).toEqual([]);
    expect(await secsLeft('P-013', 'sess-ended')).toBeLessThan(120);
  });

  it('does NOT renew a stale open session from lifecycle-only activity', async () => {
    // A crashed process can leave its adv_sessions row open even when its
    // SessionEnd activity report landed. An old open row must not be enough to
    // keep renewing the dead owner's claim.
    await seedSession('sess-stale-open', { startedAgoSec: 20 * 60 });
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-014', owner: 'sess-stale-open', livenessMode: 'activity' });
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = clock_timestamp() + interval '30 seconds' WHERE item_id = 'P-014'`;

    await seedActivity('sess-stale-open', 'lifecycle', SESSION_END_MARKER, 1_000);
    await seedActivity('sess-stale-open', 'lifecycle', 'wake delivered');

    expect(await claims.renewOwnerActivityClaims(WS, 'sess-stale-open')).toEqual([]);
    expect(await secsLeft('P-014', 'sess-stale-open')).toBeLessThan(120);
  });

  it('renews a long-lived open session when recent native activity follows its start', async () => {
    // Long-lived sessions still renew normally; age alone must not be treated as
    // death when the owner has produced a genuine recent native turn.
    await seedSession('sess-long-open', { startedAgoSec: 20 * 60 });
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-015', owner: 'sess-long-open', livenessMode: 'activity' });
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = clock_timestamp() + interval '30 seconds' WHERE item_id = 'P-015'`;

    await seedActivity('sess-long-open', 'tool', 'Read claims.ts');

    expect(await claims.renewOwnerActivityClaims(WS, 'sess-long-open')).toEqual(['P-015']);
    expect(await secsLeft('P-015', 'sess-long-open')).toBeGreaterThan(1000);
  });

  it.each(['tool', 'todos'] as const)('renews an ended owner only after a genuine post-end %s event', async (kind) => {
    await seedSession('sess-resumed', { endedAgoSec: 30 });
    await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: `P-${kind}`, owner: 'sess-resumed', livenessMode: 'activity' });
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = clock_timestamp() + interval '30 seconds' WHERE item_id = ${`P-${kind}`}`;

    await seedActivity('sess-resumed', 'lifecycle', SESSION_END_MARKER, 20_000);
    await seedActivity('sess-resumed', kind, kind === 'tool' ? 'Read claims.ts' : null);

    expect(await claims.renewOwnerActivityClaims(WS, 'sess-resumed')).toEqual([`P-${kind}`]);
    expect(await secsLeft(`P-${kind}`, 'sess-resumed')).toBeGreaterThan(1000);
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
