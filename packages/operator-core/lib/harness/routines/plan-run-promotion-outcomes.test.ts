/**
 * WI-10004234 — every promotion REFUSAL must reach the plan-run caller as its own
 * named error, never as `plan_run_promotion_incomplete`.
 *
 * Measured 2026-09-30 in the P-013 R-10 workload-B matrix
 * (`.papercusp/scratch/p013-rerun-0929/b/failed/matrix-rep1.attempt1.rc1.log`):
 * a run failed with `plan_run_promotion_incomplete:p013-fork-join@run-491:0/3`
 * right after a `CONNECTION_ENDED` on the dedicated PG. `promotePlanItems` has
 * exactly one early return whose shape is `promoted:0, skipped:<open>,
 * workItems:[]` without a refusal that `runScheduledPlanFire` classifies:
 * the acceptance-BAR lifecycle gate (`acceptanceBarBlocked`). It fails CLOSED by
 * design when its source read is unavailable, but the caller mis-named it as a
 * partial promotion. That sends a reader hunting for missing work-items instead
 * of a blocked or unreadable BAR contract.
 *
 * The table below is the CLASS guard: each refusal flag the promotion result can
 * carry is listed, and none of them may surface as "incomplete". A refusal
 * added without a caller branch is caught by the generic `refusal` case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const promoteMock = vi.hoisted(() => vi.fn());

vi.mock('../../plan-workitem-promotion-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plan-workitem-promotion-run')>()),
  promotePlanItems: promoteMock,
}));

import { runScheduledPlanFire } from './plan-run-action';

const INSTANCE = 'p013-fork-join@run-491';

/** A `sql` stand-in whose transaction phase returns an already-seeded run. */
function seededSql() {
  const prepared = {
    started: true as const,
    instanceSlug: INSTANCE,
    runId: 491,
    runSeq: 7,
    replayed: false,
    itemKind: 'feature' as const,
    runInputs: null,
    appHarnessSlug: 'p013-app',
    execution: null,
  };
  return { begin: async () => prepared } as unknown as Parameters<typeof runScheduledPlanFire>[0];
}

const NO_EDGES = {
  edgesWritten: 0,
  edgeFailures: 0,
  edgesRejectedCyclic: 0,
  blockersDangling: 0,
  blockersUnresolved: 0,
  edgesPreserved: 0,
};

function fire() {
  return runScheduledPlanFire(seededSql(), {
    installSlug: 'p013-app',
    workspaceId: 'ws-test',
    templateSlug: 'p013-fork-join',
  });
}

afterEach(() => promoteMock.mockReset());

describe('runScheduledPlanFire promotion outcome classification (WI-10004234)', () => {
  it('a complete promotion starts the run with every work-item (control)', async () => {
    promoteMock.mockResolvedValue({
      promoted: 3,
      skipped: 0,
      ...NO_EDGES,
      workItems: ['P-001', 'P-002', 'P-003'].map((planItemId, i) => ({
        planItemId,
        workItemId: `WI-${900 + i}`,
        newlyPromoted: true,
        actionable: planItemId !== 'P-003',
      })),
    });
    const out = await fire();
    expect(out.started).toBe(true);
    expect(out.workItemIds).toEqual(['WI-900', 'WI-901', 'WI-902']);
  });

  it('a genuinely partial promotion still fails as plan_run_promotion_incomplete', async () => {
    promoteMock.mockResolvedValue({
      promoted: 1,
      skipped: 2,
      ...NO_EDGES,
      workItems: [{ planItemId: 'P-001', workItemId: 'WI-900', newlyPromoted: true, actionable: true }],
    });
    await expect(fire()).rejects.toThrow(`plan_run_promotion_incomplete:${INSTANCE}:1/3`);
  });

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ['flagOff', { flagOff: true, skipped: 0 }, /^plan_run_promotion_disabled:/],
    ['specTriadBlocked', { specTriadBlocked: true, specTriadMissing: ['Design'] }, /^plan_run_spec_triad_blocked:/],
    ['specQualityBlocked', { specQualityBlocked: true }, /^plan_run_spec_quality_blocked:/],
    ['dependencyBlocked', { dependencyBlocked: true, dependencyDiagnostics: [] }, /^plan_run_invalid_dependencies:/],
    [
      'acceptanceBarBlocked',
      {
        acceptanceBarBlocked: true,
        acceptanceBarLifecycle: {
          phase: 'pre-start',
          applicable: true,
          satisfied: false,
          codes: ['bar_snapshot_source_unavailable'],
          blockingBars: [],
          contractCodes: ['bar_snapshot_source_unavailable'],
          codeAttribution: [],
          nextRepair: null,
          staleGradingScorecardId: null,
          message: 'BAR contract source read unavailable',
        },
      },
      /^plan_run_acceptance_bar_blocked:p013-fork-join@run-491:bar_snapshot_source_unavailable/,
    ],
  ];

  it.each(refusals)('%s surfaces as its own error, never as promotion_incomplete', async (_name, flags, expected) => {
    promoteMock.mockResolvedValue({ promoted: 0, skipped: 3, ...NO_EDGES, workItems: [], ...flags });
    const err = await fire().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(expected);
    expect((err as Error).message).not.toMatch(/promotion_incomplete/);
  });
});
