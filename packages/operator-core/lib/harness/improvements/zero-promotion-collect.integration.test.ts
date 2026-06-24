/**
 * zero-promotion-collect.integration.test.ts — the PG read behind the P-009
 * recurrence guard (unified-work-item-ledger-2026-06-21 P-009), against real Postgres.
 *
 * The pure detector (detectZeroPromotion) is unit-tested in zero-promotion-detect.test.ts;
 * this drives `collectZeroPromotionSignals` over real harness_plans + work_items, with
 * getOrgPg pointed at a throwaway DB and the promotion flag mocked.
 *
 * Proves: a STARTED plan with open items but ZERO work-items fires a signal; a started
 * plan whose items all promoted (work_items present) is healthy; a started plan with no
 * open items is healthy; an UNSTARTED plan is ignored; and the whole collector is inert
 * (a 'dark' note, no signals) while the flag is OFF.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../../test/_work-items-schema';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, flagOn: true }));

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return { ...actual, getFlag: async () => h.flagOn };
});

const { collectZeroPromotionSignals } = await import('./zero-promotion-detect');

let db: FreshPgDb;
const WS = 'default';

const HARNESS_PLANS_MIN_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_plans (
    workspace_id text NOT NULL DEFAULT 'default',
    harness_slug text NOT NULL,
    plan_slug text NOT NULL,
    op_status text,
    archived boolean DEFAULT false,
    items jsonb DEFAULT '[]'::jsonb)`;

beforeAll(async () => {
  db = await createFreshPgDb('zero-promotion-collect');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_PLANS_MIN_DDL);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.harness_plans, harness_shared.work_items RESTART IDENTITY`;
  h.flagOn = true;
});

async function seedPlan(slug: string, opStatus: string, items: { id: string; status: string }[], harness = 'demo') {
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, op_status, items)
    VALUES (${WS}, ${harness}, ${slug}, ${opStatus}, ${db.sql.json(items)})`;
}
async function seedWorkItem(planSlug: string, harness = 'demo', feature = 'F-1') {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, status, item_kind, source_plan_slug, origin)
    VALUES (${WS}, ${harness}, ${feature}, 'todo', 'feature', ${planSlug}, 'local')`;
}

describe('collectZeroPromotionSignals (P-009): recurrence guard over real PG', () => {
  it('fires for a STARTED plan with open items but ZERO work-items', async () => {
    await seedPlan('plan-broken', 'started', [{ id: 'P-001', status: 'todo' }, { id: 'P-002', status: 'wip' }]);
    const { signals } = await collectZeroPromotionSignals(WS);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: 'zero-promotion',
      key: 'plan-broken',
      scope: 'harness:demo',
      findingClass: 'promotion:zero-conversion',
      severity: 'major',
    });
    expect(signals[0].body).toContain('2 open plan-item(s) but 0 work-items');
  });

  it('is healthy (no signal) when the plan’s items promoted to work-items', async () => {
    await seedPlan('plan-ok', 'started', [{ id: 'P-001', status: 'todo' }]);
    await seedWorkItem('plan-ok');
    const { signals } = await collectZeroPromotionSignals(WS);
    expect(signals).toHaveLength(0);
  });

  it('is healthy when a started plan has NO open items (all done/dropped)', async () => {
    await seedPlan('plan-done', 'started', [{ id: 'P-001', status: 'done' }, { id: 'P-002', status: 'dropped' }]);
    const { signals } = await collectZeroPromotionSignals(WS);
    expect(signals).toHaveLength(0);
  });

  it('ignores UNSTARTED plans (only started+eligible plans are guarded)', async () => {
    await seedPlan('plan-draft', 'draft', [{ id: 'P-001', status: 'todo' }]);
    await seedPlan('plan-stopped', 'stopped', [{ id: 'P-001', status: 'todo' }]);
    const { signals } = await collectZeroPromotionSignals(WS);
    expect(signals).toHaveLength(0);
  });

  it('counts work-items per (plan, harness) — a different plan’s work-item does not satisfy the guard', async () => {
    await seedPlan('plan-a', 'started', [{ id: 'P-001', status: 'todo' }]);
    await seedWorkItem('plan-other'); // work-item for a DIFFERENT plan
    const { signals } = await collectZeroPromotionSignals(WS);
    expect(signals.map((s) => s.key)).toEqual(['plan-a']);
  });

  it('is INERT (dark note, no signals) while the promotion flag is OFF', async () => {
    h.flagOn = false;
    await seedPlan('plan-broken', 'started', [{ id: 'P-001', status: 'todo' }]);
    const res = await collectZeroPromotionSignals(WS);
    expect(res.signals).toHaveLength(0);
    expect(res.note).toContain('dark');
  });
});
