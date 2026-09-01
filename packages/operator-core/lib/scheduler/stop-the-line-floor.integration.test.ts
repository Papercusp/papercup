/**
 * stop-the-line-floor.integration.test.ts — P-013/D-012 of
 * gate-verdict-liveness-and-repair-reliability-2026-08-31: while a harness's
 * `gate-red-streak:<harness>` condition item has been OPEN for more than
 * STOP_THE_LINE_RED_HOURS, non-repair rows are not SELF-SELECTABLE on that harness —
 * and repair keeps flowing (bugs + alarm-condition items exempt).
 *
 * What only a real database can prove, asserted against BOTH sides of the anti-drift
 * contract (the same both-sides shape as claim-respects-blocking.integration.test.ts):
 *
 *   1. PREVIEW — aggregateIssueClaimExclusions counts the `stopTheLine` bucket and
 *      listIssueClaimableRows drops the throttled row (the shared subquery's
 *      ok_stop_line leg).
 *   2. CLAIM DOOR — claimNextIssueWorkItem (the real issue self-select UPDATE, which
 *      hand-ANDs individual floor fragments) refuses the same rows the preview refuses.
 *   3. FEATURE FAMILY — claimNextWorkItem (claimFloorsWhereSql) pauses feature
 *      self-select on the harness entirely while the line is stopped.
 *   4. The trigger is the condition item's AGE + OPENNESS: 23h-old ⇒ no throttle;
 *      terminal ⇒ no throttle (settling the item IS the kill-switch, D-012);
 *      another harness is never affected.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/stop-the-line-floor.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  SUBSTRATE_OUTBOX_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { aggregateIssueClaimExclusions, listIssueClaimableRows } = await import('./get-next');
const { claimNextIssueWorkItem, claimNextWorkItem } = await import('../work-items');
const { STOP_THE_LINE_RED_HOURS } = await import('../work-items-admission');

const H = 'papercup';
const H2 = 'other-harness';
const WS = 'default';
const HOUR_MS = 3_600_000;
let db: FreshPgDb;

/** Seed one work_items row (either family) with explicit kind/harness/condition/age. */
async function seedRow(
  id: string,
  opts: {
    itemKind: 'bug' | 'change' | 'task' | 'feature';
    harness?: string;
    status?: string;
    conditionKey?: string;
    createdAgoMs?: number;
  },
) {
  const createdTs = Date.now() - (opts.createdAgoMs ?? 0);
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, origin,
       created_ts, updated_ts, title, condition_key)
    VALUES (${opts.harness ?? H}, ${id}, ${opts.itemKind}, ${opts.status ?? 'open'}, ${WS}, 'local',
            ${createdTs}, 0, ${'t ' + id}, ${opts.conditionKey ?? null})`;
}

/** The open red-streak condition item that arms the throttle for `harness`. */
async function seedRedStreakCondition(opts: { ageMs: number; status?: string; harness?: string }) {
  const harness = opts.harness ?? H;
  await seedRow(`WI-STL-${harness}`, {
    itemKind: 'bug',
    harness,
    status: opts.status ?? 'open',
    conditionKey: `gate-red-streak:${harness}`,
    createdAgoMs: opts.ageMs,
  });
}

beforeAll(async () => {
  db = await createFreshPgDb('stop-the-line-floor');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(SUBSTRATE_OUTBOX_DDL).simple();
  await db.sql.unsafe(USER_TRUST_LIST_DDL).simple();
  await db.sql
    .unsafe(
      `ALTER TABLE harness_shared.work_items
         ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`,
    )
    .simple();
}, 90_000);
afterAll(async () => {
  await db?.cleanup?.();
});
beforeEach(async () => {
  setFlagOverridesForTest({ [FLAGS.SCHEDULER_MAINTAINED_READY]: false });
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});
afterEach(() => setFlagOverridesForTest({}));

const AGE_ACTIVE = (STOP_THE_LINE_RED_HOURS + 1) * HOUR_MS; // 25h — over the threshold
const AGE_FRESH = (STOP_THE_LINE_RED_HOURS - 1) * HOUR_MS; // 23h — under it

describe('P-013/D-012 — stop-the-line claim floor', () => {
  it('PREVIEW: >24h open red-streak throttles non-repair rows, exempts bugs + alarm conditions', async () => {
    await seedRedStreakCondition({ ageMs: AGE_ACTIVE });
    await seedRow('WI-CHANGE', { itemKind: 'change' });
    await seedRow('WI-TASK', { itemKind: 'task' });
    await seedRow('WI-BUG', { itemKind: 'bug' });
    // The prefix leg, independent of the bug exemption: a CHANGE that is itself an
    // alarm-condition item (P-015's deploy-parity is filed directly, outside the bridge).
    await seedRow('WI-PARITY', { itemKind: 'change', conditionKey: `deploy-parity:${H}` });
    // NOT exempt: an ordinary work-flow condition item (plan-promotion inflow).
    await seedRow('WI-PROMO', { itemKind: 'change', conditionKey: `plan-promotion:${WS}/${H}/some-plan/P-001` });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });
    // Throttled: the plain change, the task, and the plan-promotion condition change.
    expect(out.excluded.stopTheLine).toBe(3);
    const rows = await listIssueClaimableRows(undefined, { harness: H }, 50);
    const ids = rows.map((r) => r.id).sort();
    // Claimable: the bug, the deploy-parity condition change, and the red-streak
    // condition item itself (kind bug AND exempt prefix — the fix must stay claimable).
    expect(ids).toEqual(['WI-BUG', 'WI-PARITY', `WI-STL-${H}`].sort());
  });

  it('CLAIM DOOR: claimNextIssueWorkItem refuses exactly what the preview refuses', async () => {
    await seedRedStreakCondition({ ageMs: AGE_ACTIVE });
    await seedRow('WI-CHANGE', { itemKind: 'change' });
    await seedRow('WI-BUG', { itemKind: 'bug' });

    const filter = { harness: H, assignee: 'su-test' } as Parameters<typeof claimNextIssueWorkItem>[0];
    const first = await claimNextIssueWorkItem(filter, WS);
    const second = await claimNextIssueWorkItem(filter, WS);
    const third = await claimNextIssueWorkItem(filter, WS);
    const served = [first, second, third].filter((r) => r != null).map((r) => r!.id);
    // Only the exempt rows are ever served; the plain change never is.
    expect(served.sort()).toEqual(['WI-BUG', `WI-STL-${H}`].sort());
    expect(served).not.toContain('WI-CHANGE');
    expect(third).toBeNull();
  });

  it('FEATURE FAMILY: feature self-select pauses while active, resumes when the item settles', async () => {
    await seedRedStreakCondition({ ageMs: AGE_ACTIVE });
    await seedRow('F-1', { itemKind: 'feature' });

    const filter = { harness: H, assignee: 'su-test' } as Parameters<typeof claimNextWorkItem>[0];
    expect(await claimNextWorkItem(filter)).toBeNull();

    // Settling the condition item IS the kill-switch (D-012): terminal ⇒ throttle lifts.
    await db.sql`
      UPDATE harness_shared.work_items SET status = 'resolved'
       WHERE feature_id = ${`WI-STL-${H}`} AND workspace_id = ${WS}`;
    const claimed = await claimNextWorkItem(filter);
    expect(claimed?.id).toBe('F-1');
  });

  it('BOUNDARY: a red streak under the threshold does not throttle', async () => {
    await seedRedStreakCondition({ ageMs: AGE_FRESH });
    await seedRow('WI-CHANGE', { itemKind: 'change' });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(out.excluded.stopTheLine).toBe(0);
    const rows = await listIssueClaimableRows(undefined, { harness: H }, 50);
    expect(rows.map((r) => r.id)).toContain('WI-CHANGE');
  });

  it('TERMINAL: a settled red-streak item never throttles, however old', async () => {
    await seedRedStreakCondition({ ageMs: AGE_ACTIVE, status: 'resolved' });
    await seedRow('WI-CHANGE', { itemKind: 'change' });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(out.excluded.stopTheLine).toBe(0);
  });

  it('SCOPE: only the affected harness throttles', async () => {
    await seedRedStreakCondition({ ageMs: AGE_ACTIVE, harness: H });
    await seedRow('WI-OTHER-CHANGE', { itemKind: 'change', harness: H2 });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H2 });
    expect(out.excluded.stopTheLine).toBe(0);
    const rows = await listIssueClaimableRows(undefined, { harness: H2 }, 50);
    expect(rows.map((r) => r.id)).toContain('WI-OTHER-CHANGE');
  });
});
