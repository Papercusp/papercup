/** P-001: exercise the production census reader and labelled ledger on migrated PostgreSQL. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createPgCensusPlanStore } from './census-store';
import {
  CENSUS_MEASURE_IDS, PLAN_LINE_HOLD_BY, runPlanPortfolioCensus, type CensusResume,
} from './census';
import {
  measuresWithoutPairedRuns, readCensusRunRows, recordPlanPortfolioCensusRun,
} from './census-instruments';

let db: OrgTestDb;
const NOW = Date.parse('2026-11-15T14:00:00Z');
type CensusSql = NonNullable<Parameters<typeof createPgCensusPlanStore>[0]['sql']>;
const sql = () => db.adminSql as unknown as CensusSql;
const store = (workspaceId: string) => createPgCensusPlanStore({ workspaceId, sql: sql() });

beforeAll(async () => {
  db = await createOrgTestDb();
  // Verify fixture admission against the migrated schema before any census case.
  // Generated hold fields and blocked-row provenance must use the real writer shape.
  await seedPlan('census-seed-preflight', 'check', { parked: true });
  const rows = await store('census-seed-preflight').readPlans({ after: null, limit: 1 });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.workItems).toEqual([{ planLineId: 'P-001', status: 'blocked', held: false,
    claimHold: true, claimHoldBy: PLAN_LINE_HOLD_BY, lane: null }]);
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

async function seedPlan(workspace: string, slug: string, options: {
  harness?: string; heldBy?: string; parked?: boolean;
} = {}) {
  const harness = options.harness ?? 'papercusp';
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, status, archived, content, items, decisions, created_at, updated_at)
    VALUES (${workspace}, ${harness}, ${slug}, 'active', false, 'Census fixture',
      ${JSON.stringify([{ id: 'P-001', status: 'todo', blockedBy: [] }])}::jsonb, '[]'::jsonb,
      '2026-11-14T00:00:00Z', '2026-11-14T00:00:00Z')
  `;
  if (!options.parked && !options.heldBy) return;
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, nature, audience, origin,
       plan_slug, plan_line_id, source_plan_slug, source_plan_item_ids, taken_by, payload,
       created_ts, updated_ts, ts)
    VALUES (${workspace}, ${harness}, ${`WI-census-${workspace}-${harness}-${slug}`}, 'Census fixture',
      'blocked', 'feature', 'work', 'agent', 'local', ${slug}, 'P-001', ${slug}, ${db.adminSql.array(['P-001'])},
      ${options.heldBy ?? null},
      ${JSON.stringify({ _claimHold: options.parked === true, claim_hold_by: PLAN_LINE_HOLD_BY })}::jsonb,
      ${NOW}, ${NOW}, ${NOW})
  `;
}

describe('production census keyset recovery', () => {
  for (const reverse of [false, true]) {
    it.each([2, 3, 4])('recovers %i plans around a three-row boundary, reverse insertion=' + reverse, async count => {
      const workspace = `census-boundary-${count}-${reverse}`;
      const slugs = Array.from({ length: count }, (_, i) => `plan-${String(i).padStart(2, '0')}`);
      for (const slug of reverse ? [...slugs].reverse() : slugs) {
        // The decisive blocked work-item lies AFTER the first batch when count = N+1.
        await seedPlan(workspace, slug, { parked: slug === slugs.at(-1) });
      }
      const first = await runPlanPortfolioCensus({ store: store(workspace), now: NOW, batchSize: 3, maxBatches: 1 });
      expect(first.plansRead).toBe(Math.min(count, 3));
      expect(first.omitted).toBe(Math.max(0, count - 3));
      expect(first.complete).toBe(count <= 3);
      if (count > 3) {
        expect(first.heldOnlyWorkableItems.count).toBe(0);
        expect(first.cursor?.after).toEqual({ harnessSlug: 'papercusp', planSlug: slugs[2] });
      }
      const recovered = first.resume
        ? await runPlanPortfolioCensus({ store: store(workspace), batchSize: 3, maxBatches: 1,
          resume: JSON.parse(JSON.stringify(first.resume)) as CensusResume })
        : first;
      const uninterrupted = await runPlanPortfolioCensus({ store: store(workspace), now: NOW, batchSize: 3 });
      expect(recovered).toEqual(uninterrupted);
      expect(recovered).toMatchObject({ complete: true, omitted: 0, cursor: null, plansRead: count,
        population: { total: count }, heldOnlyWorkableItems: { count: 1 } });
      expect(recovered.heldOnlyWorkableItems.sample).toEqual([`${slugs.at(-1)}#P-001`]);
    });
  }

  it('makes durable progress across many restarts and reaches the final parked item', async () => {
    const workspace = 'census-many-restarts';
    for (let i = 10; i >= 0; i--) {
      await seedPlan(workspace, `plan-${String(i).padStart(2, '0')}`, { parked: i === 10 });
    }
    let resume: CensusResume | undefined;
    let previousRead = 0;
    for (let pass = 0; pass < 6; pass++) {
      const run = await runPlanPortfolioCensus({ store: store(workspace), now: NOW,
        batchSize: 2, maxBatches: 1, ...(resume ? { resume } : {}) });
      expect(run.plansRead).toBeGreaterThan(previousRead);
      expect(run.omitted).toBe(11 - run.plansRead);
      previousRead = run.plansRead;
      if (run.complete) {
        expect(pass).toBe(5);
        expect(run).toEqual(await runPlanPortfolioCensus({ store: store(workspace), now: NOW, batchSize: 2 }));
        expect(run.heldOnlyWorkableItems.count).toBe(1);
        return;
      }
      expect(run.resume).not.toBeNull();
      expect(run.heldOnlyWorkableItems.count).toBe(0);
      resume = JSON.parse(JSON.stringify(run.resume)) as CensusResume;
    }
    throw new Error('The final plan was never reached');
  });

  it('keeps equal plan slugs in other harnesses and workspaces out of the item join', async () => {
    const workspace = 'census-scope';
    await seedPlan(workspace, 'same-slug', { parked: true });
    await seedPlan(workspace, 'same-slug', { harness: 'other', heldBy: 'other-harness-agent' });
    await seedPlan('census-foreign', 'same-slug', { heldBy: 'other-workspace-agent' });
    const run = await runPlanPortfolioCensus({ store: store(workspace), now: NOW, batchSize: 1 });
    expect(run).toMatchObject({ complete: true, omitted: 0, plansRead: 2, population: { total: 1 },
      heldOnlyWorkableItems: { count: 1 } });
    expect(run.measures['M-2'].value).toBe(0);
    expect(run.measures['M-3'].value).toBe(1);
  });
});

it('persists and re-reads all nine labelled measurements with matching definition fingerprints', async () => {
  const workspaceId = 'census-ledger-pair';
  await seedPlan(workspaceId, 'ledger-plan', { parked: true });
  const baseline = await recordPlanPortfolioCensusRun({ workspaceId, label: 'baseline', now: () => NOW, sql: sql() });
  const final = await recordPlanPortfolioCensusRun({ workspaceId, label: 'final', now: () => NOW + 1_000, sql: sql() });
  expect(baseline.testRunIds).toHaveLength(CENSUS_MEASURE_IDS.length);
  expect(final.testRunIds).toHaveLength(CENSUS_MEASURE_IDS.length);
  expect(new Set([...baseline.testRunIds, ...final.testRunIds]).size).toBe(18);
  const read = (label: 'baseline' | 'final', workspace = workspaceId) =>
    readCensusRunRows({ label, workspaceId: workspace, measureIds: CENSUS_MEASURE_IDS, sql: sql() });
  const before = await read('baseline');
  const after = await read('final');
  expect([...before.keys()].sort()).toEqual([...CENSUS_MEASURE_IDS].sort());
  expect([...after.keys()].sort()).toEqual([...CENSUS_MEASURE_IDS].sort());
  expect(measuresWithoutPairedRuns({ measureIds: CENSUS_MEASURE_IDS, baseline: before, final: after }))
    .toEqual({ lacking: [], paired: [...CENSUS_MEASURE_IDS] });
  expect(await read('baseline', 'census-ledger-other')).toEqual(new Map());
  const rows = await db.adminSql`
    SELECT id, run_group_id, workspace_id, framework FROM harness_shared.test_runs
     WHERE run_group_id = ANY(${[baseline.runGroupId, final.runGroupId]}::text[])
  `;
  expect(rows).toHaveLength(18);
  expect(rows.every(row => row.workspace_id === workspaceId && row.framework === 'rubric-check')).toBe(true);
  expect(rows.map(row => Number(row.id)).sort((a, b) => a - b))
    .toEqual([...baseline.testRunIds, ...final.testRunIds].sort((a, b) => a - b));
});
