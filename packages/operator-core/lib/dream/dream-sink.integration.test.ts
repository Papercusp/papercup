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
import { rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import {
  beginDreamRun,
  beginDreamRunCall,
  settleDreamRunCall,
  recordDreamRunSelection,
  recordDreamRunReview,
  getDreamRun,
  finalizeDreamRun,
} from './dream-run-store';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
// Capture, routing, and grading all invalidate the existing Learning snapshot
// asynchronously. The integration boundary under test is PG, not a live SSE bus.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { sinkDreamInsight } = await import('./dream-sink');
const { gradeRoutedIdea, readRoutedIdeas, refreshScoutOutcomes, recordRoutedIdea } =
  await import('../scout/routed-ledger');
const { captureImprovement } = await import('../harness/improvements/capture-core');
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
    const migration = fileURLToPath(
      new URL('../../../../libs/papercusp/libs/db/sql/862-dream-runs-ledger.sql', import.meta.url),
    );
    await db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : migration + '.DRAFT', 'utf8'));
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

  it('replays concurrent and crash-after-capture capability attempts even after the captured idea becomes terminal', async () => {
    const f = await createDreamCapabilityFixture(WS, HARNESS);
    try {
      const key = { workspaceId: WS, runId: 'DR-CAPABILITY-PG' };
      await beginDreamRun(db.adminSql, {
        ...key,
        cycleId: 'capability-pg-cycle',
        potSlug: HARNESS,
        mode: 'manual',
        capability: f.header,
      });
      await recordDreamRunSelection(db.adminSql, { ...key, capability: f.sampling });
      for (const call of f.provenance.calls) {
        await beginDreamRunCall(db.adminSql, {
          ...key,
          call: { callId: call.callId, phase: call.phase, model: call.model, reservedUsd: call.reservedUsd },
        });
        await settleDreamRunCall(db.adminSql, { ...key, callId: call.callId, usage: call.usage });
      }
      await recordDreamRunReview(db.adminSql, {
        ...key,
        outcome: { verdict: 'insight', insight: f.insight },
        review: { ...f.review },
      });
      const input = {
        kind: 'capability' as const,
        sql: db.adminSql,
        workspaceId: WS,
        dreamRunId: key.runId,
        rootPath: f.root,
        manifest: f.manifest,
        sources: f.sources,
      };
      const capture = vi.fn(captureImprovement);
      const route = vi.fn(recordRoutedIdea).mockRejectedValueOnce(new Error('crash after capture'));
      const deps = { capture, recordRoutedIdea: route, now: Date.now };
      await expect(sinkDreamInsight(input, deps)).rejects.toThrow('crash after capture');
      expect((await getDreamRun(db.adminSql, key))?.routedRef).toBeNull();
      const [original] = await db.adminSql`SELECT issue_id, payload FROM harness_shared.engineer_issues
        WHERE workspace_id = ${WS} AND payload->>'watchdogKey' = 'dream:DR-CAPABILITY-PG'`;
      expect(original).toBeDefined();
      await db.adminSql`UPDATE harness_shared.engineer_issues SET state = 'resolved', terminal_owner = 'dream-test',
        terminal_completion_ref = 'terminal identity replay fixture', updated_at = now() WHERE issue_id = ${original!.issue_id}`;
      const replay = await Promise.all([sinkDreamInsight(input, deps), sinkDreamInsight(input, deps)]);
      for (const value of replay)
        expect(value).toMatchObject({ sunk: true, workItemId: original!.issue_id, created: false });
      expect(capture).toHaveBeenCalledTimes(1);
      await finalizeDreamRun(db.adminSql, {
        ...key,
        status: 'accepted',
        dreamUsage: f.provenance.calls[0]!.usage,
        reviewUsage: f.review.usage,
      });
      expect(await sinkDreamInsight(input, deps)).toMatchObject({
        sunk: true,
        workItemId: original!.issue_id,
        created: false,
      });
      const artifacts = await db.adminSql`SELECT payload FROM harness_shared.engineer_issues
        WHERE workspace_id = ${WS} AND payload->>'watchdogKey' = 'dream:DR-CAPABILITY-PG'`;
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.payload).toEqual(original!.payload);
      const rows = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, origin: 'dream' });
      const routed = rows.filter((r) => r.ideaId === 'dream:DR-CAPABILITY-PG');
      expect(routed).toHaveLength(1);
      expect(routed[0]!.addressesPatternRefs).toEqual(
        [f.selection.a, f.selection.b].map((e) => e.packet.unit.id + '@' + e.contentVersion),
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
