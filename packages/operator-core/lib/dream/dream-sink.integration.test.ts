/**
 * dream-sink.integration.test.ts — REM dreaming P-004 against real migrated PG.
 *
 * Pins the reuse-first boundary end to end: an independently accepted dream is
 * captured as an ordinary improvement work item, enrolled in the existing
 * routed-idea ledger with origin/lens `dream` and source-fragment provenance,
 * then remains gradeable and outcome-refreshable through Blender's existing
 * machinery. There is deliberately no dream-specific artifact or outcome table.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
// Capture, routing, and grading all invalidate the existing Learning snapshot
// asynchronously. The integration boundary under test is PG, not a live SSE bus.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { sinkDreamInsight } = await import('./dream-sink');
const { gradeRoutedIdea, readRoutedIdeas, refreshScoutOutcomes } = await import('../scout/routed-ledger');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-dream-sink';
const HARNESS = 'papercusp';

describe('accepted dream sink (real PG — P-004)', () => {
  let db: OrgTestDb;
  let workspaceBefore: string | undefined;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    workspaceBefore = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;
  }, 180_000);

  afterAll(async () => {
    if (workspaceBefore === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = workspaceBefore;
    await db?.cleanup();
    if (!process.env.KEEP_TEST_PG) await teardownTestPg();
  });

  it('persists dream provenance, accepts an ordinary grade, and refreshes the routed work-item outcome', async () => {
    const result = await sinkDreamInsight({
      dreamRunId: 'DR-PG-1',
      cycleId: 'dream-cycle-pg',
      harnessSlug: HARNESS,
      workspaceId: WS,
      createdBy: 'system:dream-cycle',
      insight: {
        text: 'Use the completion watermark to suppress repeated fleet recovery wakes.',
        requiresA: 'The observation establishes the repeated recovery symptom.',
        requiresB: 'The memory provides the completion-watermark mechanism.',
        actionable: 'Replay two completion wakes and assert only the first reaches recovery.',
      },
      fragments: [
        {
          id: 'recent-observation',
          kind: 'observation',
          ref: 'wi:EI-RECOVERY-WAKES',
          text: 'A completed lane was re-woken twice.',
          createdAt: '2026-08-20T12:00:00.000Z',
          harness: HARNESS,
        },
        {
          id: 'remote-memory',
          kind: 'memory',
          ref: 'memory:completion-watermark',
          text: 'A monotonic completion watermark suppressed an earlier replay.',
          createdAt: '2026-07-01T12:00:00.000Z',
          harness: HARNESS,
        },
      ],
      review: {
        verdict: 'accept',
        stage: 'grader',
        scores: { dependence: 2, actionability: 2, novelty: 1 },
        note: 'Both fragments are necessary and the replay is falsifiable.',
        priorMatches: [],
        usage: { model: 'independent-reviewer', costUsd: 0.01, inputTokens: 200, outputTokens: 40 },
      },
    });

    expect(result).toMatchObject({
      sunk: true,
      ideaId: 'dream:DR-PG-1',
      created: true,
      sourceRefs: ['wi:EI-RECOVERY-WAKES', 'memory:completion-watermark'],
    });
    if (!result.sunk) throw new Error('accepted dream unexpectedly failed to sink');

    const [issue] = await db.adminSql<{ scope: string; state: string; payload: Record<string, unknown> }[]>`
      SELECT scope, state, payload
        FROM harness_shared.engineer_issues
       WHERE issue_id = ${result.workItemId}`;
    expect(issue).toMatchObject({ scope: `harness:${HARNESS}`, state: 'open' });
    expect(issue.payload).toMatchObject({
      improvementKind: 'feature',
      sourceRole: 'system',
      filedByRole: 'dream',
      watchdogKey: 'dream:DR-PG-1',
      dream: {
        dreamRunId: 'DR-PG-1',
        cycleId: 'dream-cycle-pg',
        sourceRefs: ['wi:EI-RECOVERY-WAKES', 'memory:completion-watermark'],
      },
    });

    await expect(
      gradeRoutedIdea({
        ideaId: 'dream:DR-PG-1',
        grade: 4,
        feedback: 'Concrete and worth trying.',
        gradedBy: 'auto-grader',
      }),
    ).resolves.toEqual({ applied: true });

    const [routed] = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, origin: 'dream' });
    expect(routed).toMatchObject({
      ideaId: 'dream:DR-PG-1',
      lens: 'dream',
      rail: 'improvement',
      routedRef: `wi:${result.workItemId}`,
      cycleId: 'dream-cycle-pg',
      addressesPatternRefs: ['wi:EI-RECOVERY-WAKES', 'memory:completion-watermark'],
      humanGrade: 4,
      humanFeedback: 'Concrete and worth trying.',
      gradedBy: 'auto-grader',
      createdBy: 'system:dream-cycle',
    });

    await db.adminSql`
      UPDATE harness_shared.engineer_issues
         SET state = 'resolved',
             terminal_owner = 'dream-sink-test',
             terminal_completion_ref = 'real-PG dream sink fixture completed',
             updated_at = now()
       WHERE issue_id = ${result.workItemId}`;
    const report = await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS, origin: 'dream' });
    expect(report.total).toBe(1);

    const [ledger] = await db.adminSql<
      {
        origin: string;
        lens: string;
        routed_ref: string;
        addresses_pattern_refs: string[];
        human_grade: number;
        outcome: string;
      }[]
    >`
      SELECT origin, lens, routed_ref, addresses_pattern_refs, human_grade, outcome
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id = 'dream:DR-PG-1'`;
    expect(ledger).toEqual({
      origin: 'dream',
      lens: 'dream',
      routed_ref: `wi:${result.workItemId}`,
      addresses_pattern_refs: ['wi:EI-RECOVERY-WAKES', 'memory:completion-watermark'],
      human_grade: 4,
      outcome: 'won',
    });
  });
});
