/**
 * deferral-interest.integration.test.ts — the PG half of FB-14 against a real
 * MIGRATED Postgres: migration 252 applies (table + append-only grants), the
 * backfill reads real engineer_issues + coord_links rows end-to-end through
 * the live refit deps, model versions append, and the latest-model read feeds
 * the ranker feature. The pure backfill/fit logic is outcomes.test.ts /
 * model.test.ts; the action gates are deferral-interest-action.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import { createIssue, linkIssue, setIssueState } from '../issues-engineer';
import { IMPROVEMENT_TOPIC } from '../harness/improvements/read-items';
import { defaultDeferralRefitDeps, runDeferralInterestRefit } from './refit';
import { loadLatestDeferralModel, readDeferralEdges } from './store';
import { deferralFeatureEvaluator } from './feature';

const WS = 'ws-deferral-itest';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('FB-14 end-to-end on a real migrated PG', () => {
  it('backfills history, appends a model version, and the feature prices from it', async () => {
    // A human-lane deferral (kind=change), sitting 21 days, gating one work-item.
    const deferred = await createIssue({
      title: 'decide the retention story for spawned-agent transcripts',
      kind: 'change',
      severity: 'major',
      topics: [IMPROVEMENT_TOPIC],
      createdBy: 'su-test',
    });
    // An auto-lane bug — must NOT train the model.
    const bug = await createIssue({
      title: 'transcript reader chokes on empty jsonl lines',
      kind: 'bug',
      severity: 'minor',
      topics: [IMPROVEMENT_TOPIC],
      createdBy: 'su-test',
    });
    await linkIssue(deferred.id, { kind: 'workitem', ref: 'WI-901' }, 'blocks', 'su-test');

    // Backdate capture + edge so the deferral window has real exposure
    // (created_at is not trigger-managed; the edge timestamp must land inside
    // the window for the realized count).
    await db.adminSql`
      UPDATE harness_shared.engineer_issues SET created_at = now() - interval '21 days'
       WHERE issue_id IN (${deferred.id}, ${bug.id})`;
    await db.adminSql`
      UPDATE harness_shared.coord_links SET created_at = now() - interval '10 days'
       WHERE src_ref = ${deferred.id} AND rel = 'blocks'`;

    // The store's windowed edge read sees the backdated blocks edge.
    const edges = await readDeferralEdges(db.adminSql, [deferred.id, bug.id]);
    expect(edges.filter((e) => e.issueId === deferred.id && e.rel === 'blocks')).toHaveLength(1);

    // Live refit deps end-to-end: readImprovementItems → outcomes → fit → store.
    const result = await runDeferralInterestRefit(defaultDeferralRefitDeps(db.adminSql, WS));
    expect(result.deferrals).toBeGreaterThanOrEqual(1);
    expect(result.weak).toBe(true); // honest v0: tiny corpus

    const model = await loadLatestDeferralModel(db.adminSql, WS);
    expect(model).not.toBeNull();
    expect(model!.globalRatePerWeek).toBeGreaterThan(0); // the blocks edge realized cost
    expect(model!.buckets['severity:major']).toBeDefined();
    // The auto-lane bug stayed out of the training set: every trained bucket
    // count is consistent with deferrals only.
    expect(model!.totalItems).toBe(result.deferrals);

    // The ranker feature prices a fresh deferral off the stored model.
    const value = deferralFeatureEvaluator(model)({
      id: 'EI-new',
      kind: 'change',
      scope: 'operator',
      title: 'a brand-new deferral',
      severity: 'major',
    });
    expect(value.value).toBeGreaterThan(0);
    expect(value.reasons.some((r) => r.includes('weak coefficients'))).toBe(true);
  });

  it('a second refit APPENDS a version (never rewrites history)', async () => {
    await runDeferralInterestRefit(defaultDeferralRefitDeps(db.adminSql, WS));
    const rows = await db.adminSql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.deferral_pricing_model WHERE workspace_id = ${WS}`;
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(2);
  });

  it('the app role cannot rewrite a trained model (append-only grants, the 246 lesson)', async () => {
    await expect(
      db.appSql`UPDATE harness_shared.deferral_pricing_model SET sample_items = 999`,
    ).rejects.toThrow(/permission denied/);
    await expect(db.appSql`DELETE FROM harness_shared.deferral_pricing_model`).rejects.toThrow(
      /permission denied/,
    );
  });

  it('a decided deferral closes its window at the decision (resolved state)', async () => {
    await setIssueState((await createIssue({
      title: 'short lived gating question about flag naming',
      kind: 'change',
      severity: 'minor',
      topics: [IMPROVEMENT_TOPIC],
      createdBy: 'su-test',
    })).id, 'resolved', 'su-test');
    // Window create→resolve is sub-hour ⇒ the min-window floor drops it; the
    // refit must not crash on it and the deferral count must not include it.
    const before = await loadLatestDeferralModel(db.adminSql, WS);
    const result = await runDeferralInterestRefit(defaultDeferralRefitDeps(db.adminSql, WS));
    expect(result.deferrals).toBe(before!.totalItems);
  });
});
