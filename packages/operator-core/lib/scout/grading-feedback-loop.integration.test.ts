/**
 * grading-feedback-loop.integration.test.ts — scout-idea-grading-2026-06-12
 * B-08 (P-008): the WHOLE grading feedback loop against real migrated PG
 * (migration 234), composing the briefs' seams end-to-end where each landed
 * suite proved only its own leg:
 *
 *   tool core (C-3, runGradeIdea w/ REAL PG deps: attribution, D-007 routedRef,
 *   owner-grade-sovereign) → ledger row (C-1/C-2) → refreshScoutOutcomes
 *   shifting the PERSISTED scout_lens_weights by the pinned C-5 math →
 *   grade-blind `outcome` cache (D-002) → C-4 priming over the REAL ledger
 *   reader → the cycle-deps ideate step priming EVERY ideator prompt with NO
 *   reader override (B-05's hermetic pin used a stub reader).
 *
 * Pinned weight math (B-04, Beta(1,1) smoothing over 4 lenses): a single
 * graded idea per lens with everything else pending gives
 *   grade-5 → 4/13 · grade-1 → (with a 5 already standing) 1/6 · grade-3 →
 *   exactly the ungraded-pending share (neutral).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { CorpusDigest, ScoutLlmCall } from './types';
import type { StateOfHiveReaders } from './corpus-digest';
import type { ArchivePort } from './gym-bridge';

const h = vi.hoisted(() => ({ sql: null as unknown }));
// PARTIAL mock: the tool core's import graph (agent-mcp bootstrap) reads the
// real `generated` schema export, so only the connection accessor is faked.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
// gradeRoutedIdea fire-and-forgets a learning.scout invalidate via a lazy
// import — stub the SSE seam so applied writes never touch a real bus.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { recordRoutedIdea, refreshScoutOutcomes } = await import('./routed-ledger');
const { runGradeIdea } = await import('../agent-tools/scout/grade-idea');
const { gatherGraderFeedbackPriming, GRADER_FEEDBACK_HEADING } = await import('./ideator-feedback-priming');
const { buildScoutCycleDeps } = await import('./cycle-deps');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-scout-grading-e2e';
const HARNESS = 'papercup';

// One idea per lens, all routed to refs ABSENT from the change feed → every
// outcome starts 'pending' and only grades move the weights (clean baseline).
const IDEAS = [
  { ideaId: 'g1', lens: 'analogical', ref: 'wi:EI-G1', title: 'borrow the gym ladder' },
  { ideaId: 'g2', lens: 'reframing', ref: 'wi:EI-G2', title: 'invert the triage queue' },
  { ideaId: 'g3', lens: 'first-principles', ref: 'wi:EI-G3', title: 'rebuild the cadence gate' },
  { ideaId: 'g4', lens: 'constraint-removal', ref: 'wi:EI-G4', title: 'drop the slug cap' },
] as const;

const weightsByLens = async (db: OrgTestDb): Promise<Record<string, number>> => {
  const rows = await db.adminSql<{ lens: string; weight: string | number }[]>`
    SELECT lens, weight FROM harness_shared.scout_lens_weights WHERE workspace_id = ${WS}`;
  return Object.fromEntries(rows.map((r) => [r.lens, Number(r.weight)]));
};

describe('scout grading feedback loop (real PG, migrations 194+208+234)', () => {
  let db: OrgTestDb;
  let envBefore: string | undefined;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    // Pin activeWorkspaceId() for the no-explicit-workspace paths (the ideate
    // leg's real reader resolves the workspace from ALS/env, like production).
    envBefore = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;
    for (const i of IDEAS) {
      await recordRoutedIdea({
        ideaId: i.ideaId,
        lens: i.lens as never,
        rail: 'improvement',
        routedRef: i.ref,
        harnessSlug: HARNESS,
        cycleId: 'cyc-grade-e2e',
        title: i.title,
        workspaceId: WS,
      });
    }
  }, 120_000);

  afterAll(async () => {
    if (envBefore === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = envBefore;
    await db?.cleanup();
  });

  it('baseline: nothing graded, nothing decided → uniform persisted weights', async () => {
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    const w = await weightsByLens(db);
    for (const i of IDEAS) expect(w[i.lens]).toBeCloseTo(0.25, 6);
  });

  it('owner grade-5 through the tool core lands the ledger row and shifts the weights by the pinned delta (4/13 vs 3/13)', async () => {
    const out = await runGradeIdea({ ideaId: 'g1', grade: 5, feedback: 'exactly right' }, undefined);
    expect(out.applied).toBe(true);
    expect(out.gradedBy).toBe('owner');
    expect(out.idea?.humanGrade).toBe(5);

    const [row] = await db.adminSql<
      { human_grade: number; human_feedback: string; graded_by: string; graded_at: Date | null }[]
    >`SELECT human_grade, human_feedback, graded_by, graded_at
        FROM harness_shared.scout_routed_ideas WHERE idea_id = 'g1'`;
    expect(row.human_grade).toBe(5);
    expect(row.human_feedback).toBe('exactly right');
    expect(row.graded_by).toBe('owner');
    expect(row.graded_at).toBeTruthy();

    const before = await weightsByLens(db);
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    const after = await weightsByLens(db);
    // Pinned C-5 math: graded lens (won 1) smoothed 2/3; three pending lenses 1/2.
    expect(after.analogical).toBeCloseTo(4 / 13, 6);
    expect(after.reframing).toBeCloseTo(3 / 13, 6);
    expect(after['first-principles']).toBeCloseTo(3 / 13, 6);
    expect(after['constraint-removal']).toBeCloseTo(3 / 13, 6);
    // The delta direction is the feature: the graded lens GAINED share, every
    // other lens proportionally lost it.
    expect(after.analogical - before.analogical).toBeCloseTo(4 / 13 - 0.25, 6);
    expect(after.reframing - before.reframing).toBeCloseTo(3 / 13 - 0.25, 6);
  });

  it("Queen grade-1 keyed by routedRef (D-007) resolves the ideaId and drags that lens's weight down (1/6)", async () => {
    const out = await runGradeIdea({ routedRef: 'wi:EI-G2', grade: 1, feedback: 'derivative' }, { role: 'queen' });
    expect(out.applied).toBe(true);
    expect(out.gradedBy).toBe('Queen');
    expect(out.ideaId).toBe('g2');

    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    const w = await weightsByLens(db);
    // Smoothed: analogical 2/3, reframing 1/3, two pending lenses 1/2 → sum 2.
    expect(w.analogical).toBeCloseTo(1 / 3, 6);
    expect(w.reframing).toBeCloseTo(1 / 6, 6);
    expect(w['first-principles']).toBeCloseTo(0.25, 6);
    expect(w['constraint-removal']).toBeCloseTo(0.25, 6);
  });

  it("the persisted `outcome` cache stays grade-blind (D-002): graded ideas absent from the feed remain 'pending'", async () => {
    const rows = await db.adminSql<{ idea_id: string; outcome: string | null }[]>`
      SELECT idea_id, outcome FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${WS} ORDER BY idea_id`;
    for (const r of rows) expect(r.outcome).toBe('pending');
  });

  it('owner-grade-sovereign through the tool: a Queen regrade of g1 is a no-op carrying the standing owner grade', async () => {
    const out = await runGradeIdea({ ideaId: 'g1', grade: 2, feedback: 'overruled?' }, { role: 'queen' });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('owner-grade-sovereign');
    expect(out.idea?.humanGrade).toBe(5);
    expect(out.idea?.gradedBy).toBe('owner');

    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    const w = await weightsByLens(db);
    expect(w.analogical).toBeCloseTo(1 / 3, 6); // the 5 still rules the tally
  });

  it('grade-3 is exactly neutral (C-5): the graded lens keeps the ungraded-pending share', async () => {
    const out = await runGradeIdea({ ideaId: 'g3', grade: 3 }, undefined);
    expect(out.applied).toBe(true);

    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    const w = await weightsByLens(db);
    // won 0.5 / lost 0.5 smooths to 1/2 — identical to the untouched pending lens.
    expect(w['first-principles']).toBeCloseTo(w['constraint-removal'], 9);
    expect(w['first-principles']).toBeCloseTo(0.25, 6);
    // Regression pin: fractional masses (wins 0.5) used to ERROR inside the
    // jsonb_to_recordset int cast, killing the whole best-effort upsert — the
    // grade-3 lens's row landing with decided=1 proves the persist survived.
    const [row] = await db.adminSql<{ decided: number }[]>`
      SELECT decided FROM harness_shared.scout_lens_weights
       WHERE workspace_id = ${WS} AND lens = 'first-principles'`;
    expect(row.decided).toBe(1);
  });

  it('C-4 priming over the REAL reader: the graded rows come back as labelled newest-first entries', async () => {
    const { priming, entries } = await gatherGraderFeedbackPriming({ workspaceId: WS });
    expect(priming.startsWith(GRADER_FEEDBACK_HEADING)).toBe(true);
    expect(entries).toHaveLength(3);
    // Graded order was g1 → g2 → g3 (separate round-trips), so newest-first:
    expect(entries[0]).toBe('- [★3 · Owner · first-principles] rebuild the cadence gate');
    expect(entries[1]).toBe('- [★1 · Queen · reframing] invert the triage queue: derivative');
    expect(entries[2]).toBe('- [★5 · Owner · analogical] borrow the gym ladder: exactly right');
  });

  it('the ideate step primes EVERY ideator prompt from the real ledger (no reader override)', async () => {
    const EMPTY_READERS: StateOfHiveReaders = {
      completions: async () => [],
      reverts: async () => [],
      friction: async () => [],
      spend: async () => [],
      deferrals: async () => [],
    };
    const DIGEST: CorpusDigest = {
      recurringFriction: [{ summary: 'lock contention on shared tree', ref: 'wi:F-1' }],
      timeTokenSinks: [],
      chronicDeferrals: [],
      capabilityGaps: [],
      headline: 'busy week',
    };
    const seen: string[] = [];
    const llmCall: ScoutLlmCall = async (opts) => {
      seen.push(opts.messages.map((m) => m.content).join('\n'));
      return {
        text: '',
        json: { ideas: [{ title: 'T', body: 'B', mechanism: 'M', addressesPatternRefs: ['wi:F-1'] }] },
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    const deps = buildScoutCycleDeps({
      harnessSlug: HARNESS,
      llmCall,
      createPlanDraft: async ({ slug }) => ({ slug }),
      archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) } as unknown as ArchivePort,
      cycleId: 'cyc-grade-e2e',
      stateOfHiveReaders: EMPTY_READERS,
      noveltyCorpus: async () => [],
    });

    await deps.ideate(DIGEST, { llmCall, maxIdeators: 2 });
    expect(seen).toHaveLength(2);
    for (const prompt of seen) {
      expect(prompt).toContain(GRADER_FEEDBACK_HEADING);
      expect(prompt).toContain('- [★5 · Owner · analogical] borrow the gym ladder: exactly right');
    }
  });
});
