/**
 * emit-goal-run-completeness.integration.test.ts — a GOAL run verdict must carry
 * EVERY CURRENT criterion of the goal rubric, and must land on the canonical
 * scorecard surface, against real migrated Postgres.
 *
 * Acceptance clause R-7 of goal-agent-behavior-feedback-2026-09-06 (AUTO-BAR-R-7-*):
 * "Each submitted run verdict contains every current GOAL criterion on the canonical
 * scorecard surface." Its falsifier: "A run verdict omits a current GOAL criterion,
 * misstates termination or uses the mutable observation store."
 *
 * The sibling unit suites (emit-evaluate.test.ts, emit.grading-audit.test.ts) mock
 * `getRubric`, `listScorecards` and `captureImprovement`, so they can only assert what
 * emit TRIED to write, against a rubric the test handed it. This suite drives the real
 * rubric read, the real ledger write and the real scorecard read, and asserts:
 *   1. a complete verdict persists and reads back through `listScorecards` with no
 *      missing keys (the canonical surface — not a hand-built observation);
 *   2. a verdict omitting one current criterion is refused and persists nothing;
 *   3. "current" means the rubric's LATEST revision: after a criterion is added, a
 *      verdict rated against the previous criteria set is refused naming the new key.
 *
 * Not covered here (named so nobody reads this suite as covering it): termination
 * semantics (`terminal` / provisional stamping) — see emit.provisional.test.ts.
 *
 * Docker-gated, like every `*.integration.test.ts` here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

// Re-point reads AND writes at the migrated throwaway DB (same seam as
// emit-acceptance-reference.integration.test.ts — spread the ACTUAL module, because
// vitest throws on access to an export missing from a partial mock).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      (h.sql as postgres.Sql).begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return cb(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

// A filed standard-rubric card triggers a fire-and-forget grading-audit dispatch that
// recruits a live auditor. That recruitment is out of scope and must not reach out of
// the test process; everything else in grading-integrity stays real.
vi.mock('../../grading-integrity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../grading-integrity')>();
  return {
    ...actual,
    dispatchPendingGradingAudits: async () => ({ requestedTargetIds: [], receipts: [] }),
  };
});

// The running-generation stamp reads host/deploy state that a throwaway DB does not
// model; a null reading is the documented "unknown generation" path.
vi.mock('../../scout/generation-watermark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scout/generation-watermark')>();
  return { ...actual, readRunningGeneration: async () => null };
});

const { emitScorecard } = await import('./emit');
const { listScorecards } = await import('../../scorecards');
const { issuesScopeWorkspace } = await import('../../issues-engineer');
const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');

const RUBRIC = 'goal-mode-e2e';
/** The rubric's owner. The grader below is a different principal. */
const RUBRIC_OWNER = 'su-goal-rubric-owner';
const GRADER = 'su-goal-run-grader';
const RUN_SUBJECT = { kind: 'agent-run' as const, ref: 'su-goal-run-subject-1' };

const SCALE = ['pass', 'partial', 'fail', 'unknown', 'n/a'];
const criterion = (key: string) => ({
  key,
  title: `Criterion ${key}`,
  model: `The goal agent satisfies ${key}.`,
  method: `Read the run transcript for ${key}.`,
  driftMarkers: `A run that violates ${key}.`,
  ratingScale: SCALE,
});
const BASE_KEYS = ['never-implements', 'settings-are-data'];
const ADDED_KEY = 'reports-measured-effect';

const rated = (keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, { rating: 'pass', evidence: `grader observed ${k} in the run transcript` }]));

async function upsertGoalRubric(db: OrgTestDb, keys: string[], version: number): Promise<void> {
  await db.adminSql`DELETE FROM harness_shared.harness_plans WHERE plan_slug = ${RUBRIC}`;
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, template_data, template_slug, origin)
    VALUES (${activeWorkspaceId()}, 'papercusp', ${RUBRIC}, '', md5(${RUBRIC + version}), ${version},
            'Goal mode end-to-end', 'active', '2026-09-10', '2026-09-10', ${RUBRIC_OWNER}, false,
            'rubric',
            ${JSON.stringify({
              kind: 'standard',
              characteristic: 'goal-mode-conduct',
              criteria: keys.map(criterion),
              ratingScale: ['pass', 'partial', 'fail', 'unknown'],
              methodRef: 'goal-mode-e2e-grading-runbook',
              description: 'Grades one run of one goal agent.',
            })}::text::jsonb,
            null, 'local')`;
}

/** Every goal-run card that actually LANDED — a SELECT, not the writer's return value. */
async function readBackGoalCards(
  db: OrgTestDb,
): Promise<Array<{ issue_id: string; created_by: string; observation: Record<string, unknown> }>> {
  return db.adminSql<Array<{ issue_id: string; created_by: string; observation: Record<string, unknown> }>>`
    SELECT issue_id, created_by, payload -> 'observation' AS observation
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND payload -> 'observation' ->> 'rubricRef' = ${RUBRIC}
     ORDER BY created_at DESC`;
}

const asGrader = () => ({ createdBy: GRADER, workspaceId: activeWorkspaceId(), ctxHarness: 'papercusp' });
const verdict = (keys: string[]) => ({ rubricRef: RUBRIC, subject: RUN_SUBJECT, ratings: rated(keys), terminal: true });

describe('scorecards:emit — a GOAL run verdict carries every current criterion (R-7), real PG', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.adminSql`TRUNCATE harness_shared.harness_plans CASCADE`;
    // engineer_issues is an insertable VIEW; TRUNCATE is refused on it.
    await db.adminSql`DELETE FROM harness_shared.engineer_issues WHERE workspace_id = ${issuesScopeWorkspace()}`;
    await upsertGoalRubric(db, BASE_KEYS, 1);
  });

  it('a complete verdict persists and reads back on the canonical scorecard surface with no missing keys', async () => {
    const r = await emitScorecard(verdict(BASE_KEYS) as never, asGrader() as never);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });

    const landed = await readBackGoalCards(db);
    expect(landed).toHaveLength(1);
    expect(landed[0].created_by).toBe(GRADER);
    expect(Object.keys(landed[0].observation.ratings as Record<string, unknown>).sort()).toEqual([...BASE_KEYS].sort());
    expect(landed[0].observation).toMatchObject({ subject: RUN_SUBJECT });

    // The canonical READ: the scorecard surface recomputes completeness itself, so a
    // card that merely carried a ratings blob could not satisfy this.
    const rows = await listScorecards({ rubricRef: RUBRIC });
    const row = rows.find((s) => s.issueId === landed[0].issue_id);
    expect(row, JSON.stringify(rows.map((s) => s.issueId))).toBeDefined();
    expect(row!.missingKeys).toEqual([]);
  });

  it('refuses a verdict that omits one current criterion, and persists nothing', async () => {
    const r = await emitScorecard(verdict([BASE_KEYS[0]]) as never, asGrader() as never);

    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain(BASE_KEYS[1]);
    expect(await readBackGoalCards(db)).toEqual([]);
  });

  it('"current" is the rubric\'s latest revision — a verdict rated against the previous criteria set is refused', async () => {
    // Control: the previous set is complete at revision 1 (same args as case 1).
    await upsertGoalRubric(db, [...BASE_KEYS, ADDED_KEY], 2);

    const r = await emitScorecard(verdict(BASE_KEYS) as never, asGrader() as never);

    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain(ADDED_KEY);
    expect(await readBackGoalCards(db)).toEqual([]);

    // And rating the current set lands.
    const ok = await emitScorecard(verdict([...BASE_KEYS, ADDED_KEY]) as never, asGrader() as never);
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(await readBackGoalCards(db)).toHaveLength(1);
  });
});
