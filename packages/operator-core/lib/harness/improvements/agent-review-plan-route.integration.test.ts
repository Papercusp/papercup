/**
 * EI-218490 — a feature enrolled in agent review before blender:route-idea
 * reused its EI id for plan learning. The plan upsert replaced routed_ref=wi:EI
 * with plan:<slug>, while payload.agentReview.ledgerIdeaId stayed on the EI id;
 * grades then updated plan learning and never advanced the review lifecycle.
 *
 * Pin the complete real-PG lifecycle: enrolled review authority → plan route →
 * deterministic fallback authority → reviewer claim → grade → approval.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { getIssue, linkIssue } = await import('../../issues-engineer');
const { getWorkItem } = await import('../../work-items');
const { recordRoutedIdea } = await import('../../scout/routed-ledger');
const { runRouteIdea } = await import('../../agent-tools/scout/route-idea');
const { runGradeIdea } = await import('../../agent-tools/scout/grade-idea');
const {
  claimAgentReview,
  preserveAgentReviewAuthorityBeforePlanRoute,
} = await import('./agent-review');

const WS = 'ws-agent-review-plan-route';
const HARNESS = 'papercusp';
const ID = 'EI-218490-REGRESSION';
const FALLBACK = `agent-review:${ID}`;
const priorWorkspacePin = process.env.PAPERCUSP_WORKSPACE_ID;

describe('agent-review authority survives a later plan route (EI-218490, real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;

    const now = new Date('2026-08-30T04:00:00.000Z');
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source, state,
         assignee, assigned_by, assigned_at, payload, found_during, created_by,
         signal_origin, created_at, updated_at, admission)
      VALUES
        (${WS}, ${ID}, 'change', ${`harness:${HARNESS}`},
         'Plan-routed feature under review', 'integration fixture', 'major', 'engineer', 'open',
         NULL, NULL, NULL,
         ${JSON.stringify({
           ideation: { lens: 'cost-leverage' },
           agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: ID, round: 1 },
         })}::text::jsonb,
         NULL, 'su-filer', 'organic', ${now}, ${now}, 'pending')`;
    await recordRoutedIdea({
      ideaId: ID,
      lens: 'agent-review',
      rail: 'improvement',
      routedRef: `wi:${ID}`,
      harnessSlug: HARNESS,
      workspaceId: WS,
      origin: 'agent-review',
      createdBy: 'su-filer',
      title: 'Plan-routed feature under review',
    });
  }, 180_000);

  afterAll(async () => {
    if (priorWorkspacePin === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = priorWorkspacePin;
    await db?.cleanup();
    if (!process.env.KEEP_TEST_PG) await teardownTestPg();
  });

  it('moves review authority before the plan upsert, refuses the colliding bare key, then grades the fallback', async () => {
    const out = await runRouteIdea(
      { featureId: ID, rail: 'plan' },
      { isSuperuser: true, uiClientId: 'su-router', workspaceId: WS, harnessSlug: HARNESS },
      {
        createPlanDraft: vi.fn(async () => ({ slug: 'plan-routed-feature-2026-08-30', created: true })),
        recordRoutedIdea,
        getIssue,
        linkIssue,
        preserveAgentReviewAuthority: preserveAgentReviewAuthorityBeforePlanRoute,
      },
    );
    expect(out).toMatchObject({ ok: true, featureId: ID, planRef: 'plan:plan-routed-feature-2026-08-30' });

    const ledger = await db.adminSql<{
      idea_id: string;
      routed_ref: string;
      origin: string;
      human_grade: number | null;
    }[]>`
      SELECT idea_id, routed_ref, origin, human_grade
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id IN (${ID}, ${FALLBACK})
       ORDER BY idea_id`;
    expect(ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ idea_id: ID, routed_ref: 'plan:plan-routed-feature-2026-08-30', origin: 'su-ideate' }),
      expect.objectContaining({ idea_id: FALLBACK, routed_ref: `wi:${ID}`, origin: 'agent-review', human_grade: null }),
    ]));

    const migrated = await getWorkItem(ID, HARNESS);
    expect((migrated!.payload as { agentReview: { ledgerIdeaId: string } }).agentReview.ledgerIdeaId).toBe(FALLBACK);

    const [preClaim] = await db.adminSql<{
      admission: string | null;
      taken_by: string | null;
      review_status: string | null;
    }[]>`
      SELECT admission, taken_by, payload -> 'agentReview' ->> 'status' AS review_status
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${ID}`;
    expect(preClaim).toEqual({ admission: 'pending', taken_by: null, review_status: 'pending' });

    const claimed = await claimAgentReview({ id: ID, reviewer: 'su-reviewer', harnessSlug: HARNESS });
    expect(claimed.claimed).toBe(true);

    const bareGrade = await runGradeIdea(
      { ideaId: ID, grade: 4, feedback: 'This must not land on the historical plan row.' },
      { ownerId: 'su-reviewer', role: 'operator' },
    );
    expect(bareGrade).toMatchObject({
      applied: false,
      reason: 'agent-review-ledger-id-required',
      ledgerIdeaId: FALLBACK,
      gradeWith: { ideaId: FALLBACK },
    });

    const [historicalAfterRefusal] = await db.adminSql<{
      human_grade: number | null;
      human_feedback: string | null;
    }[]>`
      SELECT human_grade, human_feedback
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id = ${ID}`;
    expect(historicalAfterRefusal).toEqual({ human_grade: null, human_feedback: null });
    const stillPending = await getWorkItem(ID, HARNESS);
    expect((stillPending!.payload as { agentReview: { status: string } }).agentReview.status).toBe('pending');

    const graded = await runGradeIdea(
      { ideaId: FALLBACK, grade: 5, feedback: 'The proposal is ready for implementation.' },
      { ownerId: 'su-reviewer', role: 'operator' },
    );
    expect(graded).toMatchObject({
      applied: true,
      ideaId: FALLBACK,
      agentReview: { workItemId: ID, status: 'approved', changed: true },
    });

    const approved = await getWorkItem(ID, HARNESS);
    expect((approved!.payload as { agentReview: { status: string; ledgerIdeaId: string } }).agentReview).toMatchObject({
      status: 'approved',
      ledgerIdeaId: FALLBACK,
    });
    expect(approved!.assignee).toBeNull();
  }, 120_000);
});
