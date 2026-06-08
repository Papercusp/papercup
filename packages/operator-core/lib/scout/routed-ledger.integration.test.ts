/**
 * routed-ledger.integration.test.ts — Scout P-013 production wiring against real
 * migrated Postgres (migration 194). Pins:
 *  - recordRoutedIdea upsert + readRoutedIdeas round-trip (provenance shape, scope filter);
 *  - getScoutLensOutcomes deriving per-lens outcomes by JOINING the ledger's
 *    routedRef to the live Change Feed (gym_proposals / harness_plans);
 *  - refreshScoutOutcomes persisting the outcome cache back to the ledger.
 *
 * The pure derivation is covered by outcome-feedback.test.ts; this proves the
 * real join + the SQL are correct (the change-feed-deps Phase-7 lesson: a wrong
 * query silently returns [] — so pin it against the migrated schema).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));

const { recordRoutedIdea, readRoutedIdeas, getScoutLensOutcomes, refreshScoutOutcomes } = await import(
  './routed-ledger'
);
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-scout-ledger-test';
const HARNESS = 'papercup';
const T_GYM = Date.parse('2026-06-07T08:00:00Z');
const T_PLAN = Date.parse('2026-06-06T07:00:00Z');

describe('scout routed-ledger (real PG, migration 194)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    const sql = db.adminSql;

    // Completions the ledger refs will join against:
    // gym sp-1 accepted (a win), sp-2 rejected (a loss).
    await sql`
      INSERT INTO harness_shared.gym_proposals
        (id, workspace_id, harness_slug, role, proposed_md, status, created_at, decided_at)
      VALUES
        ('sp-1', ${WS}, ${HARNESS}, 'worker', '# v', 'accepted', ${T_GYM - 1000}, ${T_GYM}),
        ('sp-2', ${WS}, ${HARNESS}, 'worker', '# v', 'rejected', ${T_GYM - 1000}, ${T_GYM})`;
    // plan scout-x op done (a win).
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, op_status, op_updated_at)
      VALUES
        (${WS}, ${HARNESS}, 'scout-x', 'A Scout-spawned plan', 'done', ${new Date(T_PLAN)})`;

    // Routed-idea provenance (via the production write path — also exercises upsert).
    await recordRoutedIdea({ ideaId: 'i1', lens: 'analogical', rail: 'gym', routedRef: 'gym:sp-1', harnessSlug: HARNESS, cycleId: 'c1', title: 'win idea', workspaceId: WS, addressesPatternRefs: ['wi:F-1'] });
    await recordRoutedIdea({ ideaId: 'i2', lens: 'analogical', rail: 'gym', routedRef: 'gym:sp-2', harnessSlug: HARNESS, cycleId: 'c1', title: 'loss idea', workspaceId: WS });
    await recordRoutedIdea({ ideaId: 'i3', lens: 'reframing', rail: 'plan', routedRef: 'plan:scout-x', harnessSlug: HARNESS, cycleId: 'c1', title: 'plan idea', workspaceId: WS });
    await recordRoutedIdea({ ideaId: 'i4', lens: 'first-principles', rail: 'improvement', routedRef: 'wi:EI-NONE', harnessSlug: HARNESS, cycleId: 'c1', title: 'pending idea', workspaceId: WS });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('reads back routed provenance, newest-first, scoped to the workspace', async () => {
    const rows = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS });
    expect(rows.map((r) => r.ideaId).sort()).toEqual(['i1', 'i2', 'i3', 'i4']);
    const i1 = rows.find((r) => r.ideaId === 'i1')!;
    expect(i1.lens).toBe('analogical');
    expect(i1.rail).toBe('gym');
    expect(i1.routedRef).toBe('gym:sp-1');
    expect(i1.cycleId).toBe('c1');
    expect(i1.title).toBe('win idea');
    expect(typeof i1.routedAt).toBe('string');
  });

  it('upserts by ideaId (re-routing overwrites, no duplicate row)', async () => {
    await recordRoutedIdea({ ideaId: 'i1', lens: 'analogical', rail: 'gym', routedRef: 'gym:sp-1', harnessSlug: HARNESS, cycleId: 'c1', title: 'win idea (re-routed)', workspaceId: WS });
    const rows = await readRoutedIdeas({ workspaceId: WS });
    expect(rows.filter((r) => r.ideaId === 'i1')).toHaveLength(1);
    expect(rows.find((r) => r.ideaId === 'i1')!.title).toBe('win idea (re-routed)');
  });

  it('derives per-lens outcomes by joining routedRef to the Change Feed', async () => {
    const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    // analogical: one accepted gym (won) + one rejected gym (lost) → winRate 0.5
    expect(report.byLens.analogical.won).toBe(1);
    expect(report.byLens.analogical.lost).toBe(1);
    expect(report.byLens.analogical.winRate).toBeCloseTo(0.5, 9);
    // reframing: one op-done plan (won)
    expect(report.byLens.reframing.won).toBe(1);
    expect(report.byLens.reframing.winRate).toBe(1);
    // first-principles: routed to an artifact NOT in the feed → pending
    expect(report.byLens['first-principles'].pending).toBe(1);
    expect(report.byLens['first-principles'].winRate).toBeNull();
    // every lens carries a weight; they sum to 1
    const total = (['analogical', 'first-principles', 'reframing', 'constraint-removal'] as const).reduce(
      (a, l) => a + report.byLens[l].weight,
      0,
    );
    expect(total).toBeCloseTo(1, 9);
    expect(report.generatedAt).toBeTruthy();
  });

  it('refreshScoutOutcomes persists the outcome cache back to the ledger', async () => {
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    const rows = await db.adminSql<{ idea_id: string; outcome: string | null; outcome_checked_at: string | null }[]>`
      SELECT idea_id, outcome, outcome_checked_at
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${WS}
       ORDER BY idea_id`;
    const byId = new Map(rows.map((r) => [r.idea_id, r]));
    expect(byId.get('i1')!.outcome).toBe('won');
    expect(byId.get('i2')!.outcome).toBe('lost');
    expect(byId.get('i3')!.outcome).toBe('won');
    expect(byId.get('i4')!.outcome).toBe('pending');
    expect(byId.get('i1')!.outcome_checked_at).toBeTruthy();
  });
});
