/**
 * provenance.integration.test.ts — the PG half of signal provenance
 * (self-learning-frontier P-002 / D-002, brief FB-03) against a real MIGRATED
 * Postgres: migration 241 applies (column + default + CHECK), the capture write
 * path stores the origin, and the END-TO-END learner read (readImprovementItems
 * over the REAL listIssues, topic tags included) keeps a drill row out of the
 * organic default while the explicit opt-in sees it. The pure gate logic is
 * provenance.test.ts; capture dedup scoping is capture-core.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import { createIssue } from '../../issues-engineer';
import { captureImprovement } from './capture-core';
import { readImprovementItems, IMPROVEMENT_TOPIC } from './read-items';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('signal_origin column (migration 241)', () => {
  it('createIssue defaults to organic; an explicit origin round-trips', async () => {
    const organic = await createIssue({ title: 'a real friction', topics: [IMPROVEMENT_TOPIC], createdBy: 'su-test' });
    expect(organic.signalOrigin).toBe('organic');

    const drill = await createIssue({
      title: 'planted flaky test (drill)',
      topics: [IMPROVEMENT_TOPIC],
      createdBy: 'red-queen',
      signalOrigin: 'drill',
    });
    expect(drill.signalOrigin).toBe('drill');

    const [row] = await db.adminSql<{ signal_origin: string }[]>`
      SELECT signal_origin FROM harness_shared.engineer_issues WHERE issue_id = ${drill.id}`;
    expect(row.signal_origin).toBe('drill');
  });

  it('the CHECK constraint rejects a junk origin at the SQL layer', async () => {
    // Post-mig-374 engineer_issues is a VIEW over work_items; the signal_origin vocabulary
    // CHECK moved with the data to the base table (mig-403 work_items_signal_origin_chk, over
    // the payload->'_ei'->>'signal_origin' JSON path). The INSTEAD OF UPDATE trigger writes
    // 'mystery' into work_items.payload, where the CHECK rejects it.
    await expect(
      db.adminSql`
        UPDATE harness_shared.engineer_issues
           SET signal_origin = 'mystery'
         WHERE issue_id = 'EI-1'`,
    ).rejects.toThrow(/work_items_signal_origin_chk/);
  });

  it('the capture core threads origin → column (the watchdog/drill write path)', async () => {
    const res = await captureImprovement({
      title: 'replay counterfactual artifact row',
      kind: 'change',
      origin: 'replay',
      createdBy: 'replay-harness',
    });
    expect(res.created).toBe(true);
    expect(res.issue?.signalOrigin).toBe('replay');
  });

  it('END-TO-END: the organic learner read never returns the synthetic rows; opt-in does', async () => {
    // Real listIssues — topic tag join + the SQL-side signal_origin filter.
    const organicView = await readImprovementItems({});
    const ids = organicView.map((i) => i.title);
    expect(ids).toContain('a real friction');
    expect(ids).not.toContain('planted flaky test (drill)');
    expect(ids).not.toContain('replay counterfactual artifact row');
    expect(organicView.every((i) => (i.origin ?? 'organic') === 'organic')).toBe(true);

    const drillView = await readImprovementItems({ origins: ['drill'] });
    expect(drillView.map((i) => i.title)).toEqual(['planted flaky test (drill)']);
    expect(drillView[0]?.origin).toBe('drill');
  });
});
