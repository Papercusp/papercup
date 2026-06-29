/**
 * done-without-test-collect.integration.test.ts — the PG read behind the P-009
 * recurrence guard (enforce-system-on-generic-work-2026-06-29 P-009), against real Postgres.
 *
 * The pure detector (detectDoneWithoutTest) is unit-tested in done-without-test-detect.test.ts;
 * this drives `collectDoneWithoutTestSignals` over real harness_features_consolidated +
 * harness_plan_assertions + harness_tests, with getOrgPg pointed at a throwaway DB.
 *
 * Proves: a DONE (passed) work-item carrying a requires_test VAL with no passing test fires a
 * per-harness signal whose `count` is the metric; a done item whose required VAL has a passing
 * covering test is healthy; a non-done item is ignored; an item that requires no test is ignored;
 * a requires_test=false VAL never drags coverage; and multiple flagged items in a harness roll
 * into ONE finding (count = 2).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../../test/_work-items-schema';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { collectDoneWithoutTestSignals } = await import('./done-without-test-detect');

let db: FreshPgDb;
const WS = 'default';

const HARNESS_PLAN_ASSERTIONS_MIN_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_plan_assertions (
    workspace_id text NOT NULL DEFAULT 'default',
    harness_slug text NOT NULL,
    val_id text NOT NULL,
    plan_slug text NOT NULL,
    item_id text NOT NULL,
    verify_text text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'todo',
    requires_test boolean NOT NULL DEFAULT true,
    PRIMARY KEY (workspace_id, harness_slug, val_id))`;

const HARNESS_TESTS_MIN_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_tests (
    harness_slug text NOT NULL,
    phase text NOT NULL DEFAULT 'staging',
    test_id text NOT NULL,
    name text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending',
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    workspace_id text NOT NULL DEFAULT 'default',
    PRIMARY KEY (harness_slug, phase, test_id))`;

beforeAll(async () => {
  db = await createFreshPgDb('done-without-test-collect');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(HARNESS_PLAN_ASSERTIONS_MIN_DDL);
  await db.sql.unsafe(HARNESS_TESTS_MIN_DDL);
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.harness_plan_assertions, harness_shared.harness_tests RESTART IDENTITY`;
});

async function seedDoneItem(
  featureId: string,
  opts: { status?: string; planSlug?: string | null; itemIds?: string[] | null; harness?: string } = {},
) {
  const { status = 'passed', planSlug = 'plan-a', itemIds = ['P-001'], harness = 'demo' } = opts;
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, status, item_kind, source_plan_slug, source_plan_item_ids, origin)
    VALUES (${WS}, ${harness}, ${featureId}, ${status}, 'feature', ${planSlug},
            ${itemIds as string[] | null}, 'local')`;
}
async function seedAssertion(
  valId: string,
  opts: { planSlug?: string; itemId?: string; requiresTest?: boolean; harness?: string } = {},
) {
  const { planSlug = 'plan-a', itemId = 'P-001', requiresTest = true, harness = 'demo' } = opts;
  await db.sql`
    INSERT INTO harness_shared.harness_plan_assertions
      (workspace_id, harness_slug, val_id, plan_slug, item_id, verify_text, requires_test)
    VALUES (${WS}, ${harness}, ${valId}, ${planSlug}, ${itemId}, 'verify', ${requiresTest})`;
}
async function seedTest(
  testId: string,
  covers: string[],
  status: string,
  opts: { harness?: string } = {},
) {
  const { harness = 'demo' } = opts;
  await db.sql`
    INSERT INTO harness_shared.harness_tests (workspace_id, harness_slug, test_id, status, payload)
    VALUES (${WS}, ${harness}, ${testId}, ${status}, ${db.sql.json({ coversVALs: covers })})`;
}

describe('collectDoneWithoutTestSignals (P-009): recurrence guard over real PG', () => {
  it('fires for a DONE work-item with a requires_test VAL and NO passing test', async () => {
    await seedDoneItem('F-1');
    await seedAssertion('VAL-1');
    const { signals } = await collectDoneWithoutTestSignals(WS);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: 'done-without-test',
      key: 'demo',
      scope: 'harness:demo',
      findingClass: 'test-gate:done-without-test',
      severity: 'major',
      count: 1,
    });
    expect(signals[0].workItemIds).toEqual(['F-1']);
    expect(signals[0].body).toContain('F-1');
  });

  it('is healthy (no signal) when the required VAL has a PASSING covering test', async () => {
    await seedDoneItem('F-1');
    await seedAssertion('VAL-1');
    await seedTest('t1', ['VAL-1'], 'passing');
    const { signals } = await collectDoneWithoutTestSignals(WS);
    expect(signals).toHaveLength(0);
  });

  it('fires when the covering test is FAILING (covered ≠ passing)', async () => {
    await seedDoneItem('F-1');
    await seedAssertion('VAL-1');
    await seedTest('t1', ['VAL-1'], 'failing');
    const { signals } = await collectDoneWithoutTestSignals(WS);
    expect(signals.map((s) => s.count)).toEqual([1]);
  });

  it('ignores a NON-done work-item (only terminal/passed items are guarded)', async () => {
    await seedDoneItem('F-1', { status: 'todo' });
    await seedDoneItem('F-2', { status: 'wip', itemIds: ['P-002'] });
    await seedAssertion('VAL-1', { itemId: 'P-001' });
    await seedAssertion('VAL-2', { itemId: 'P-002' });
    const { signals } = await collectDoneWithoutTestSignals(WS);
    expect(signals).toHaveLength(0);
  });

  it('ignores a done item that requires NO test (requires_test = false)', async () => {
    await seedDoneItem('F-1');
    await seedAssertion('VAL-1', { requiresTest: false });
    const { signals } = await collectDoneWithoutTestSignals(WS);
    expect(signals).toHaveLength(0);
  });

  it('ignores a done item with no plan provenance (source_plan_item_ids null)', async () => {
    await seedDoneItem('F-1', { planSlug: null, itemIds: null });
    await seedAssertion('VAL-1');
    const { signals } = await collectDoneWithoutTestSignals(WS);
    expect(signals).toHaveLength(0);
  });

  it('rolls multiple flagged done items in a harness into ONE finding (count metric)', async () => {
    await seedDoneItem('F-1', { itemIds: ['P-001'] });
    await seedDoneItem('F-2', { itemIds: ['P-002'] });
    await seedDoneItem('F-3', { itemIds: ['P-003'] }); // healthy
    await seedAssertion('VAL-1', { itemId: 'P-001' });
    await seedAssertion('VAL-2', { itemId: 'P-002' });
    await seedAssertion('VAL-3', { itemId: 'P-003' });
    await seedTest('t3', ['VAL-3'], 'passing');
    const { signals } = await collectDoneWithoutTestSignals(WS);
    expect(signals).toHaveLength(1);
    expect(signals[0].count).toBe(2);
    expect(signals[0].workItemIds.sort()).toEqual(['F-1', 'F-2']);
  });

  it('returns no signals when there are no done items at all', async () => {
    const { signals } = await collectDoneWithoutTestSignals(WS);
    expect(signals).toHaveLength(0);
  });
});
