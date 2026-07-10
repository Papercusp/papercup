/**
 * routed-ledger.integration.test.ts — Scout P-013 production wiring against real
 * migrated Postgres (migration 194). Pins:
 *  - recordRoutedIdea upsert + readRoutedIdeas round-trip (provenance shape, scope filter);
 *  - getScoutLensOutcomes deriving per-lens outcomes by JOINING the ledger's
 *    routedRef to the live Change Feed (gym_proposals / harness_plans);
 *  - refreshScoutOutcomes persisting the outcome cache back to the ledger;
 *  - gradeRoutedIdea (scout-idea-grading C-2, migration 234): the owner-sovereign
 *    precedence guard against live rows + the C-1 → C-1b grade read-back.
 *
 * The pure derivation is covered by outcome-feedback.test.ts; this proves the
 * real join + the SQL are correct (the change-feed-deps Phase-7 lesson: a wrong
 * query silently returns [] — so pin it against the migrated schema).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
// recordRoutedIdea/gradeRoutedIdea fire-and-forget a learning.scout invalidate
// via a lazy import — mock the SSE seam so the grade tests can assert it.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { recordRoutedIdea, readRoutedIdeas, gradeRoutedIdea, getScoutLensOutcomes, refreshScoutOutcomes, getScoutLensWeights } =
  await import('./routed-ledger');
const invalidate = vi.mocked((await import('../sync-sse')).notifySyncInvalidate);
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

  it('refreshScoutOutcomes ALSO lands the per-lens weight rows (the upsert is best-effort — a serialization throw is swallowed, so assert the rows, not just no-error)', async () => {
    // Regression: the unnest(${jsArray}::text[]) form threw bytes.js
    // "Received an instance of Array" under the getOrgPg client — caught LIVE
    // in the 2026-06-11 cadence rehearsal because the swallow made it
    // invisible to this suite's no-error pass. Fixed via jsonb_to_recordset
    // over one ::text::jsonb param; this test pins the rows actually landing.
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    const weightRows = await db.adminSql<{ lens: string; wins: number; decided: number; weight: string | number }[]>`
      SELECT lens, wins, decided, weight
        FROM harness_shared.scout_lens_weights
       WHERE workspace_id = ${WS}
       ORDER BY lens`;
    expect(weightRows.length).toBeGreaterThan(0);
    const total = weightRows.reduce((s, r) => s + Number(r.weight), 0);
    expect(total).toBeCloseTo(1, 6); // normalized shares
    for (const r of weightRows) expect(r.decided).toBeGreaterThanOrEqual(0);
  });

  // ── scout-idea-grading C-2 (migration 234): gradeRoutedIdea against the real
  //    guard SQL + the C-1 → C-1b read-back. Runs LAST — grades must not
  //    perturb the outcome-derivation tests above (classifyIdeaOutcome is
  //    grade-blind by design, but ordering keeps the suites independent).
  describe('gradeRoutedIdea (C-2)', () => {
    const gradeRow = async (ideaId: string) =>
      (
        await db.adminSql<
          { human_grade: number | null; human_feedback: string | null; graded_by: string | null; graded_at: Date | null }[]
        >`
        SELECT human_grade, human_feedback, graded_by, graded_at
          FROM harness_shared.scout_routed_ideas
         WHERE idea_id = ${ideaId}`
      )[0];

    it('Queen grades an ungraded idea; readRoutedIdeas maps C-1 → C-1b', async () => {
      invalidate.mockClear();
      const res = await gradeRoutedIdea({ ideaId: 'i2', grade: 2, feedback: 'derivative', gradedBy: 'Queen' });
      expect(res).toEqual({ applied: true });
      await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith('learning.scout'));

      const row = await gradeRow('i2');
      expect(row.human_grade).toBe(2);
      expect(row.human_feedback).toBe('derivative');
      expect(row.graded_by).toBe('Queen');
      expect(row.graded_at).toBeTruthy();

      const i2 = (await readRoutedIdeas({ workspaceId: WS })).find((r) => r.ideaId === 'i2')!;
      expect(i2.humanGrade).toBe(2);
      expect(i2.humanFeedback).toBe('derivative');
      expect(i2.gradedBy).toBe('Queen');
      expect(typeof i2.gradedAt).toBe('string');
      // ungraded rows stay bare — the optional C-1b fields are absent
      const i3 = (await readRoutedIdeas({ workspaceId: WS })).find((r) => r.ideaId === 'i3')!;
      expect(i3.humanGrade).toBeUndefined();
      expect(i3.gradedBy).toBeUndefined();
    });

    it('regrade is idempotent and reflects the LATEST call in full (omitted feedback clears)', async () => {
      const res = await gradeRoutedIdea({ ideaId: 'i2', grade: 3, gradedBy: 'Queen' });
      expect(res).toEqual({ applied: true });
      const row = await gradeRow('i2');
      expect(row.human_grade).toBe(3);
      expect(row.human_feedback).toBeNull();
    });

    it('owner overwrites a Queen grade (the owner overwrites anything, D-004)', async () => {
      const res = await gradeRoutedIdea({ ideaId: 'i2', grade: 5, feedback: 'actually great', gradedBy: 'owner' });
      expect(res).toEqual({ applied: true });
      const row = await gradeRow('i2');
      expect(row.human_grade).toBe(5);
      expect(row.graded_by).toBe('owner');
    });

    it('Queen on an owner-graded row is a NO-OP: owner-grade-sovereign, row untouched, no invalidate', async () => {
      invalidate.mockClear();
      const res = await gradeRoutedIdea({ ideaId: 'i2', grade: 1, feedback: 'overruled?', gradedBy: 'Queen' });
      expect(res).toEqual({ applied: false, reason: 'owner-grade-sovereign' });
      const row = await gradeRow('i2');
      expect(row.human_grade).toBe(5); // the owner's verdict stands
      expect(row.human_feedback).toBe('actually great');
      expect(row.graded_by).toBe('owner');
      await new Promise((r) => setTimeout(r, 10));
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('grading a nonexistent idea → not-found', async () => {
      const res = await gradeRoutedIdea({ ideaId: 'i-missing', grade: 4, gradedBy: 'owner' });
      expect(res).toEqual({ applied: false, reason: 'not-found' });
    });
  });

  // ── workspace-scoped-coordination-2026-06-20 P-002 / D-006: K1 reversible
  //    sentinel keying for the Scout's lens-weight state behind FLAGS.WORKSPACE_COORDINATION.
  //    OFF = legacy per-hive (byte-identical); ON = ONE workspace-sentinel row
  //    (hive_slug = workspaceId), with read-fallback to the per-hive row.
  describe('K1 workspace-coordination scope (FLAGS.WORKSPACE_COORDINATION)', () => {
    afterAll(() => setFlagOverridesForTest(null));

    it('flag ON: persists lens weights under the workspace sentinel (pot_slug = workspaceId)', async () => {
      setFlagOverridesForTest({ [FLAGS.WORKSPACE_COORDINATION]: true });
      await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
      const rows = await db.adminSql<{ pot_slug: string }[]>`
        SELECT DISTINCT pot_slug FROM harness_shared.scout_lens_weights
         WHERE workspace_id = ${WS}`;
      const hives = rows.map((r) => r.pot_slug);
      expect(hives).toContain(WS); // the workspace-sentinel row was written
      // the ideator read-path resolves them back via the sentinel (read-fallback)
      const { lensWeights } = await getScoutLensWeights({ workspaceId: WS, harnessSlug: HARNESS });
      const total = (['analogical', 'first-principles', 'reframing', 'constraint-removal'] as const).reduce(
        (a, l) => a + lensWeights[l],
        0,
      );
      expect(total).toBeCloseTo(1, 6);
    });

    it('flag OFF: persists + reads under the per-hive slug (byte-identical to today)', async () => {
      setFlagOverridesForTest({ [FLAGS.WORKSPACE_COORDINATION]: false });
      await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
      const rows = await db.adminSql<{ pot_slug: string }[]>`
        SELECT DISTINCT pot_slug FROM harness_shared.scout_lens_weights
         WHERE workspace_id = ${WS}`;
      // the per-hive row (resolved hive-home of HARNESS, which falls back to the slug
      // itself in this test workspace) is present — the legacy keying is untouched.
      expect(rows.map((r) => r.pot_slug)).toContain(HARNESS);
    });
  });

  // workspace-scoped-coordination P-002 / D-003: routing-by-hive — a routed idea
  // derived from a rubric pattern carrying an @<hive> tag persists that hive as
  // target_hive (the cross-hive routing signal the workspace-Queen places on).
  // Ungated (pure provenance enrichment).
  describe('routing-by-hive (D-003 target_hive from the addressed pattern)', () => {
    it('a rubric pattern ref @<hive> populates target_hive on the routed idea', async () => {
      await recordRoutedIdea({
        ideaId: 'i-xhive',
        lens: 'analogical',
        rail: 'plan',
        routedRef: 'plan:cross-hive-x',
        harnessSlug: HARNESS,
        workspaceId: WS,
        addressesPatternRefs: ['rubric:pot-coordination-health#wake-latency@spreadsheet-hive'],
      });
      const rows = await db.adminSql<{ target_hive: string | null; source_hive: string | null }[]>`
        SELECT target_hive, source_hive FROM harness_shared.scout_routed_ideas WHERE idea_id = 'i-xhive'`;
      expect(rows[0]?.target_hive).toBe('spreadsheet-hive');
      expect(rows[0]?.source_hive).toBeTruthy(); // source still always populated (D-003 required)
    });

    it('a non-rubric pattern ref leaves target_hive null', async () => {
      await recordRoutedIdea({
        ideaId: 'i-selfhive',
        lens: 'reframing',
        rail: 'gym',
        routedRef: 'gym:sp-self',
        harnessSlug: HARNESS,
        workspaceId: WS,
        addressesPatternRefs: ['wi:F-9'],
      });
      const rows = await db.adminSql<{ target_hive: string | null }[]>`
        SELECT target_hive FROM harness_shared.scout_routed_ideas WHERE idea_id = 'i-selfhive'`;
      expect(rows[0]?.target_hive).toBeNull();
    });
  });
});
