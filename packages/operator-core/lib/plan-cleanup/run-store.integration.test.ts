/**
 * plan-cleanup/run-store.integration.test.ts — the plan-cleanup findings
 * substrate against real Postgres (cleanup-report-flows-2026-08-24 P-002;
 * migration 937).
 *
 * Validates the generalized `attention_bulk_runs` (run_kind + seed_refs +
 * per-(workspace, kind) single-flight) and the new `plan_cleanup_run_findings`
 * table + CRUD against the full migrated schema. Same org-fixture mock pattern
 * as bulk-run-store.integration.test.ts.
 *
 * Weighted toward what would fail SILENTLY in production:
 *   - single-flight is per (workspace, KIND): an inbox run and a cleanup run
 *     coexist, two cleanup runs never do — a regression either way is invisible
 *     until two agents race;
 *   - seeding is IDEMPOTENT by findingId and a re-seed must never roll back an
 *     already-resolved finding's outcome;
 *   - counters are DERIVED from finding rows (auto_applied+accepted →
 *     auto_resolved, dismissed+skipped → skipped), so a re-report cannot
 *     double-count;
 *   - settleRunPhase is KIND-AWARE: a plan-cleanup run's review/complete
 *     verdict derives from its findings, not the (empty) items table.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-cleanup-run-test' }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

const {
  seedFindings,
  executeCleanupFindingAction,
  markCleanupFindingAccepted,
  reportFindingOutcomes,
  getRunFindings,
  getPendingReviewFindings,
} = await import('./run-store');
const {
  BulkRunAlreadyActiveError,
  createRun,
  getRun,
  setRunPhase,
  failRunIfExecuting,
  settleRunPhase,
  recordRunHeartbeat,
  restartRun,
} = await import('../attention/bulk-run-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

/** Findings shaped like scanner output for two plans (deterministic ids). */
function scanFindings() {
  return [
    {
      findingId: 'flip-to-done:papercusp/plan-a#P-001',
      kind: 'flip-to-done' as const,
      planSlug: 'plan-a',
      harnessSlug: 'papercusp',
      itemId: 'P-001',
      target: 'P-001 status',
      from: 'wip',
      to: 'done',
      confidence: 'provable' as const,
      evidence: [{ kind: 'work-item' as const, ref: 'WI-1', note: 'linked WI is done' }],
    },
    {
      findingId: 'stale-now:papercusp/plan-a',
      kind: 'stale-now' as const,
      planSlug: 'plan-a',
      harnessSlug: 'papercusp',
      itemId: null,
      target: '## Now',
      from: 'names P-001',
      to: 'names P-003',
      confidence: 'recommended' as const,
      evidence: [],
    },
    {
      findingId: 'archive-candidate:papercusp/plan-b',
      kind: 'archive-candidate' as const,
      planSlug: 'plan-b',
      harnessSlug: 'papercusp',
      itemId: null,
      target: 'plan-b',
      from: 'active',
      to: 'archived',
      confidence: 'recommended' as const,
      evidence: [],
    },
  ];
}

async function createCleanupRun(seedRefs: string[] = ['plan-a', 'plan-b']) {
  return await createRun({
    items: [],
    runKind: 'plan-cleanup',
    seedRefs,
    requestedBy: 'owner:test',
    harnessSlug: 'papercusp',
  });
}

describe('plan-cleanup run store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  let wsSeq = 0;
  beforeEach(() => {
    wsSeq += 1;
    h.ws = `ws-cleanup-run-test-${wsSeq}`;
  });

  // ── per-kind single-flight (migration 937 re-keyed index) ─────────────────

  it('lets one inbox run and one plan-cleanup run coexist in a workspace', async () => {
    const cleanup = await createCleanupRun();
    expect(cleanup.runKind).toBe('plan-cleanup');
    expect(cleanup.seedRefs).toEqual(['plan-a', 'plan-b']);
    // total_items counts the SEED PLANS for a cleanup run, not item rows.
    expect(cleanup.totalItems).toBe(2);

    const inbox = await createRun({
      items: [{ itemId: 'coord-escalation:x-1', kind: 'coord-escalation', title: 't', ref: {} }],
    });
    expect(inbox.runKind).toBe('inbox-resolve');
    // Both are live at once — the 937 index keys on (workspace, kind).
    expect((await getRun(cleanup.runId))?.phase).toBe('pending');
    expect((await getRun(inbox.runId))?.phase).toBe('pending');
  });

  it('refuses a SECOND plan-cleanup run while one is live, as the typed refusal', async () => {
    const first = await createCleanupRun();
    await expect(createCleanupRun(['plan-c'])).rejects.toMatchObject({
      code: 'run_already_active',
      activeRunId: first.runId,
      runKind: 'plan-cleanup',
    });
    await expect(createCleanupRun(['plan-c'])).rejects.toBeInstanceOf(BulkRunAlreadyActiveError);
  });

  it('refuses a plan-cleanup run with zero seed plan slugs (a run over nothing is a caller bug)', async () => {
    await expect(createRun({ items: [], runKind: 'plan-cleanup', seedRefs: [] })).rejects.toThrow(
      /zero seed plan slugs/i,
    );
  });

  // ── findings lifecycle ────────────────────────────────────────────────────

  it('seeds findings in scanner order with pending outcomes and round-tripped evidence', async () => {
    const run = await createCleanupRun();
    const { findings, refused } = await seedFindings({ runId: run.runId, findings: scanFindings() });
    expect(refused).toBeNull();
    expect(findings.map((f) => f.position)).toEqual([0, 1, 2]);
    expect(findings.every((f) => f.outcome === 'pending')).toBe(true);

    const read = await getRunFindings(run.runId);
    expect(read.map((f) => f.findingId)).toEqual(scanFindings().map((f) => f.findingId));
    expect(read[0]!.evidence).toEqual([{ kind: 'work-item', ref: 'WI-1', note: 'linked WI is done' }]);
    expect(read[0]!.confidence).toBe('provable');
    expect(read[1]!.itemId).toBeNull();
  });

  it('re-seeding is idempotent: descriptive fields refresh, resolved outcomes survive', async () => {
    const run = await createCleanupRun();
    await seedFindings({ runId: run.runId, findings: scanFindings() });
    await reportFindingOutcomes({
      runId: run.runId,
      reports: [{ findingId: 'flip-to-done:papercusp/plan-a#P-001', outcome: 'auto_applied' }],
    });

    // The retried resolver re-scans: same identities, a refreshed target text.
    const rescan = scanFindings().map((f) => ({ ...f, target: `${f.target} (rescanned)` }));
    const { findings, refused } = await seedFindings({ runId: run.runId, findings: rescan });
    expect(refused).toBeNull();
    expect(findings).toHaveLength(3);

    const read = await getRunFindings(run.runId);
    // Descriptive refresh landed…
    expect(read.every((f) => f.target.endsWith('(rescanned)'))).toBe(true);
    // …and the already-resolved outcome was NOT rolled back to pending.
    expect(read.find((f) => f.findingId === 'flip-to-done:papercusp/plan-a#P-001')!.outcome).toBe(
      'auto_applied',
    );
  });

  it('serializes one action with outcome + counters under the run authority lock', async () => {
    const run = await createCleanupRun();
    await seedFindings({ runId: run.runId, findings: scanFindings() });
    let entered = false;
    const result = await executeCleanupFindingAction({
      runId: run.runId,
      findingId: 'flip-to-done:papercusp/plan-a#P-001',
      rationale: 'The linked work item is terminal with recorded completion evidence.',
      async execute(locked) {
        entered = true;
        expect(locked).toMatchObject({ planSlug: 'plan-a', itemId: 'P-001', outcome: 'pending' });
        return { dispatched: 'plans:set-status' };
      },
    });
    expect(entered).toBe(true);
    expect(result.refused).toBeNull();
    expect(result.actionResult).toEqual({ dispatched: 'plans:set-status' });
    expect(result.finding?.outcome).toBe('auto_applied');
    expect(result.finding?.evidence).toEqual([
      { kind: 'work-item', ref: 'WI-1', note: 'linked WI is done' },
      {
        kind: 'plan',
        ref: 'plan-a',
        note:
          'resolver auto-action rationale: The linked work item is terminal with recorded completion evidence.',
      },
    ]);
    expect(result.run).toMatchObject({ autoResolved: 1, recommended: 0, skipped: 0, failed: 0 });
  });

  it('refuses a missing finding before entering its action callback', async () => {
    const run = await createCleanupRun();
    await seedFindings({ runId: run.runId, findings: scanFindings() });
    const execute = vi.fn();
    const result = await executeCleanupFindingAction({
      runId: run.runId,
      findingId: 'flip-to-done:papercusp/plan-a#P-999',
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.refused).toMatchObject({ reason: 'finding_not_in_run', phase: 'pending' });
  });

  it('reports outcomes, derives the run counters, and re-reporting cannot double-count', async () => {
    const run = await createCleanupRun();
    await seedFindings({ runId: run.runId, findings: scanFindings() });

    const first = await reportFindingOutcomes({
      runId: run.runId,
      reports: [
        {
          findingId: 'flip-to-done:papercusp/plan-a#P-001',
          outcome: 'auto_applied',
          evidence: [{ kind: 'work-item', ref: 'WI-1', note: 're-verified at apply time' }],
        },
        { findingId: 'stale-now:papercusp/plan-a', outcome: 'recommended' },
        { findingId: 'archive-candidate:papercusp/plan-b', outcome: 'failed', error: 'apply blew up' },
      ],
    });
    expect(first.refused).toBeNull();
    expect(first.missing).toEqual([]);
    // Counter mapping: auto_applied → auto_resolved column, failed → failed.
    expect(first.run).toMatchObject({ autoResolved: 1, recommended: 1, skipped: 0, failed: 1 });
    // The report's evidence REPLACED the scan-time refs.
    expect(first.updated[0]!.evidence).toEqual([
      { kind: 'work-item', ref: 'WI-1', note: 're-verified at apply time' },
    ]);
    expect(first.updated[0]!.decidedAt).not.toBeNull();

    // The consult-reply path re-reports the same finding — counters must not drift.
    const second = await reportFindingOutcomes({
      runId: run.runId,
      reports: [{ findingId: 'archive-candidate:papercusp/plan-b', outcome: 'skipped' }],
    });
    expect(second.run).toMatchObject({ autoResolved: 1, recommended: 1, skipped: 1, failed: 0 });
    // Evidence omitted on the re-report → stored evidence preserved.
    const kept = await getRunFindings(run.runId);
    expect(kept.find((f) => f.findingId === 'flip-to-done:papercusp/plan-a#P-001')!.evidence).toEqual([
      { kind: 'work-item', ref: 'WI-1', note: 're-verified at apply time' },
    ]);
  });

  it('maps owner review verdicts onto the strip counters (accepted → applied, dismissed → skipped)', async () => {
    const run = await createCleanupRun();
    await seedFindings({ runId: run.runId, findings: scanFindings() });
    const { run: after } = await reportFindingOutcomes({
      runId: run.runId,
      reports: [
        { findingId: 'flip-to-done:papercusp/plan-a#P-001', outcome: 'accepted' },
        { findingId: 'stale-now:papercusp/plan-a', outcome: 'dismissed' },
        { findingId: 'archive-candidate:papercusp/plan-b', outcome: 'skipped' },
      ],
    });
    expect(after).toMatchObject({ autoResolved: 1, recommended: 0, skipped: 2, failed: 0 });
  });

  it('surfaces a never-seeded findingId as missing instead of silently dropping it', async () => {
    const run = await createCleanupRun();
    await seedFindings({ runId: run.runId, findings: scanFindings() });
    const r = await reportFindingOutcomes({
      runId: run.runId,
      reports: [{ findingId: 'flip-to-done:papercusp/plan-NOPE#P-9', outcome: 'auto_applied' }],
    });
    expect(r.refused).toBeNull();
    expect(r.updated).toEqual([]);
    expect(r.missing).toEqual(['flip-to-done:papercusp/plan-NOPE#P-9']);
  });

  // ── refusals (the run's authority envelope) ───────────────────────────────

  it('refuses writes for a missing run, a wrong-kind run, and a settled run', async () => {
    const none = await seedFindings({ runId: 'bulk-nope', findings: scanFindings() });
    expect(none.refused).toMatchObject({ reason: 'run_not_found' });

    const inbox = await createRun({
      items: [{ itemId: 'coord-escalation:y-1', kind: 'coord-escalation', title: 't', ref: {} }],
    });
    const wrong = await seedFindings({ runId: inbox.runId, findings: scanFindings() });
    expect(wrong.refused).toMatchObject({ reason: 'run_wrong_kind' });

    const run = await createCleanupRun();
    const seeded = await seedFindings({ runId: run.runId, findings: scanFindings() });
    expect(seeded.refused).toBeNull();
    await reportFindingOutcomes({
      runId: run.runId,
      reports: scanFindings().map((f) => ({ findingId: f.findingId, outcome: 'recommended' as const })),
    });
    // Settle → review: the resolver's authority is revoked.
    expect((await settleRunPhase({ runId: run.runId }))?.phase).toBe('review');
    const late = await reportFindingOutcomes({
      runId: run.runId,
      reports: [{ findingId: 'stale-now:papercusp/plan-a', outcome: 'skipped' }],
    });
    expect(late.refused).toMatchObject({ reason: 'run_authority_revoked', phase: 'review' });

    const execute = vi.fn();
    const lateAction = await executeCleanupFindingAction({
      runId: run.runId,
      findingId: 'stale-now:papercusp/plan-a',
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(lateAction.refused).toMatchObject({ reason: 'run_authority_revoked', phase: 'review' });
  });

  it('rejects the prior cleanup resolver after restart rotates ownership', async () => {
    const run = await createCleanupRun();
    await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner: 'su-prior' });
    expect(
      await seedFindings({
        runId: run.runId,
        resolverOwner: 'su-prior',
        findings: scanFindings(),
      }),
    ).toMatchObject({ refused: null });
    expect(
      await failRunIfExecuting({
        runId: run.runId,
        resolverOwner: 'su-prior',
        error: 'prior cleanup resolver exited',
      }),
    ).toMatchObject({ phase: 'failed', resolverOwner: 'su-prior' });

    const restarted = await restartRun({ runId: run.runId, resolverOwner: 'su-replacement' });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(restarted.run).toMatchObject({ phase: 'pending', resolverOwner: 'su-replacement' });

    const reseed = await seedFindings({
      runId: run.runId,
      resolverOwner: 'su-prior',
      findings: scanFindings().map((finding) => ({ ...finding, target: 'stale rewrite' })),
    });
    expect(reseed.refused).toEqual({ reason: 'resolver_owner_mismatch', phase: 'pending' });
    expect(reseed.findings).toEqual([]);

    const execute = vi.fn(async () => ({ dispatched: true }));
    const action = await executeCleanupFindingAction({
      runId: run.runId,
      findingId: 'flip-to-done:papercusp/plan-a#P-001',
      resolverOwner: 'su-prior',
      execute,
    });
    expect(action.refused).toEqual({ reason: 'resolver_owner_mismatch', phase: 'pending' });
    expect(execute).not.toHaveBeenCalled();

    const report = await reportFindingOutcomes({
      runId: run.runId,
      resolverOwner: 'su-prior',
      reports: [
        {
          findingId: 'flip-to-done:papercusp/plan-a#P-001',
          outcome: 'auto_applied',
        },
      ],
    });
    expect(report.refused).toEqual({ reason: 'resolver_owner_mismatch', phase: 'pending' });
    expect(report.updated).toEqual([]);
    expect(await recordRunHeartbeat({ runId: run.runId, resolverOwner: 'su-prior' })).toBeNull();
    expect(await settleRunPhase({ runId: run.runId, resolverOwner: 'su-prior' })).toBeNull();

    const unchanged = await getRun(run.runId);
    expect(unchanged).toMatchObject({ phase: 'pending', resolverOwner: 'su-replacement' });
    expect(unchanged!.heartbeatAt).toBeNull();
    expect((await getRunFindings(run.runId)).every((finding) => finding.outcome === 'pending')).toBe(
      true,
    );

    // CONTROL: the replacement owner can still use the same run.
    expect(
      await recordRunHeartbeat({ runId: run.runId, resolverOwner: 'su-replacement' }),
    ).toMatchObject({ resolverOwner: 'su-replacement' });
  });

  // ── kind-aware settle + review reads ──────────────────────────────────────

  it('settles a plan-cleanup run from its FINDINGS: recommended → review, all terminal → complete', async () => {
    const run = await createCleanupRun();
    await setRunPhase({ runId: run.runId, phase: 'pending', resolverOwner: 'su-resolver' });
    await seedFindings({ runId: run.runId, findings: scanFindings() });
    await reportFindingOutcomes({
      runId: run.runId,
      reports: [
        { findingId: 'flip-to-done:papercusp/plan-a#P-001', outcome: 'auto_applied' },
        { findingId: 'stale-now:papercusp/plan-a', outcome: 'recommended' },
        { findingId: 'archive-candidate:papercusp/plan-b', outcome: 'skipped' },
      ],
    });

    // One recommendation waiting → review, and it is the review list's content.
    const settled = await settleRunPhase({ runId: run.runId, resolverOwner: 'su-resolver' });
    expect(settled?.phase).toBe('review');
    const pending = await getPendingReviewFindings(run.runId);
    expect(pending.map((f) => f.findingId)).toEqual(['stale-now:papercusp/plan-a']);

    // Owner review is resolve-first/record-second through its dedicated seam;
    // the resolver's report/action APIs remain revoked in review.
    const accepted = await markCleanupFindingAccepted({
      runId: run.runId,
      findingId: 'stale-now:papercusp/plan-a',
      note: 'Approved from the grouped report',
    });
    expect(accepted.finding).toMatchObject({ outcome: 'accepted' });
    expect(accepted.finding?.evidence.at(-1)?.note).toMatch(/owner accepted/i);
    const done = await settleRunPhase({ runId: run.runId });
    expect(done?.phase).toBe('complete');
    expect(done?.finishedAt).not.toBeNull();
  });

  it('owner acceptance is review-only and refuses non-recommended findings', async () => {
    const run = await createCleanupRun();
    await seedFindings({ runId: run.runId, findings: scanFindings() });
    expect(
      (await markCleanupFindingAccepted({
        runId: run.runId,
        findingId: 'stale-now:papercusp/plan-a',
      })).finding,
    ).toBeNull();

    await reportFindingOutcomes({
      runId: run.runId,
      reports: scanFindings().map((f) => ({ findingId: f.findingId, outcome: 'recommended' as const })),
    });
    expect((await settleRunPhase({ runId: run.runId }))?.phase).toBe('review');
    expect(
      (await markCleanupFindingAccepted({
        runId: run.runId,
        findingId: 'flip-to-done:papercusp/plan-NOPE#P-9',
      })).finding,
    ).toBeNull();
  });

  it('keeps a run with an unreached (still-pending) finding OUT of complete', async () => {
    const run = await createCleanupRun();
    await seedFindings({ runId: run.runId, findings: scanFindings() });
    await reportFindingOutcomes({
      runId: run.runId,
      reports: [
        { findingId: 'flip-to-done:papercusp/plan-a#P-001', outcome: 'auto_applied' },
        { findingId: 'stale-now:papercusp/plan-a', outcome: 'skipped' },
        // archive-candidate never reported — the resolver died mid-run.
      ],
    });
    const settled = await settleRunPhase({ runId: run.runId });
    // pending counts as awaiting-owner, so the pane shows the run rather than
    // silently completing over an unworked finding…
    expect(settled?.phase).toBe('review');
    // …but it is NOT a recommendation the owner can act on.
    expect(await getPendingReviewFindings(run.runId)).toEqual([]);
  });
});
