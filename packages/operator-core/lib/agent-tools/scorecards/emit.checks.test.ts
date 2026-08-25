/**
 * emit.checks.test.ts — deterministic criterion checks on scorecards:emit
 * (consult-min-max-and-rubric-vetting-2026-08-17 P-011, owner-ratified D-006).
 *
 * Unit-level, mirroring emit.vetting.test.ts: collaborators are mocked; the check
 * evaluator is injected via emitScorecard's deps seam (production shells the real
 * Vitest router through the testing:run core — that path is covered by
 * rubrics-criterion-checks.test.ts). Pinned here: a refusal from the evaluator
 * refuses the EMIT (nothing filed), a clean evaluation stamps observation.checkRuns,
 * a rubric without tests-checks never invokes the evaluator, and the
 * unchanged-evidence decline fires BEFORE any check run (a deduped re-emit never
 * burns a suite).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRubric = vi.fn();
const getRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();
const resolveHarnessPaths = vi.fn();

vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...real,
    getRubric: (...a: unknown[]) => getRubric(...a),
    getRubricPlanRevision: (...a: unknown[]) => getRubricPlanRevision(...a),
  };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../scorecards')>();
  return { ...real, listScorecards: (...a: unknown[]) => listScorecards(...a) };
});
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...a: unknown[]) => captureImprovement(...a),
}));
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: async () => null,
}));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...real, getIssue: async () => null };
});
vi.mock('../../workspace-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...real, activeWorkspaceId: () => 'ws-test' };
});
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const real = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...real, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../resolve-harness-paths', () => ({
  resolveHarnessPaths: (...a: unknown[]) => resolveHarnessPaths(...a),
}));

import scorecardEmitTool, {
  emitScorecard,
  SCORECARD_EMIT_TIMEOUT_SEC,
  SCORECARD_TEST_CHECK_TIMEOUT_MS,
} from './emit';
import { scorecardEvidenceFingerprint } from '../../scorecards';
import type { ObservationRatings } from '../../harness/improvements/observation-types';
import type { evaluateCriterionTestChecks, CriterionCheckRun } from '../../rubrics-criterion-checks';

type EvaluateChecks = typeof evaluateCriterionTestChecks;

const CHECKED_RUBRIC = {
  rubricId: 'ar-checked-plan',
  workspaceId: 'ws-test',
  kind: 'acceptance',
  subjectPlan: 'checked-plan-2026-08-17',
  characteristic: 'shipping',
  title: 'Acceptance: checked plan',
  description: '',
  criteria: [
    { key: 'fuzzy-outcome', title: 'Fuzzy', model: 'm', method: 'm', driftMarkers: 'd' },
    {
      key: 'det-outcome',
      title: 'Deterministic',
      model: 'm',
      method: 'm',
      driftMarkers: 'd',
      check: { kind: 'tests', files: ['packages/x/real.test.ts'] },
    },
  ],
  ratingScale: ['pass', 'weak', 'fail'],
  methodRef: null,
  status: 'active',
  createdBy: 'su-author',
  proposedBy: 'su-author',
  ratifiedBy: null,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

const RATINGS: ObservationRatings = {
  'fuzzy-outcome': { rating: 'pass', evidence: 'reads well' },
  'det-outcome': { rating: 'pass', evidence: 'suite green' },
};

const EMIT_INPUT = { createdBy: 'su-grader', ctxHarness: 'papercusp', checkRoot: '/tmp/fake-root' };

const PASS_RUN: CriterionCheckRun = {
  kind: 'tests',
  files: ['packages/x/real.test.ts'],
  verdict: 'pass',
  passed: 3,
  failed: 0,
  runId: 'run-1',
  measuredAt: '2026-08-17T12:00:00.000Z',
};

const emitArgs = (over: Record<string, unknown> = {}) => ({
  rubricRef: 'ar-checked-plan',
  ratings: RATINGS,
  ...over,
});

beforeEach(() => {
  getRubric.mockReset().mockImplementation(async (id: unknown) =>
    id === 'ar-checked-plan' ? CHECKED_RUBRIC : null,
  );
  getRubricPlanRevision.mockReset().mockResolvedValue(3);
  listScorecards.mockReset().mockResolvedValue([]);
  captureImprovement.mockReset().mockResolvedValue({ created: true, issue: { id: 'EI-1' } });
  resolveHarnessPaths.mockReset();
});

describe('scorecards:emit deterministic criterion checks (P-011)', () => {
  it('stamps observation.checkRuns from a clean evaluation and surfaces it on the result', async () => {
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': PASS_RUN },
    });
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateChecks });
    expect(res.ok).toBe(true);
    // the evaluator got the rubric's criteria, the canonical ratings, and the ctx root.
    expect(evaluateChecks).toHaveBeenCalledTimes(1);
    const call = evaluateChecks.mock.calls[0][0];
    expect(call.root).toBe('/tmp/fake-root');
    expect(call.criteria).toBe(CHECKED_RUBRIC.criteria);
    expect(call.timeoutMs).toBe(SCORECARD_TEST_CHECK_TIMEOUT_MS);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { checkRuns?: Record<string, CriterionCheckRun> } };
    };
    expect(payload.payloadExtra.observation.checkRuns?.['det-outcome']).toMatchObject({
      kind: 'tests',
      verdict: 'pass',
      runId: 'run-1',
    });
    expect((res as { checkRuns?: Record<string, unknown> }).checkRuns?.['det-outcome']).toBeDefined();
  });

  it('runs checks against targetHive paths for a cross-hive grader', async () => {
    resolveHarnessPaths.mockResolvedValue({
      projectDir: '/tmp/papercusp-target-tree',
      stateDir: '/tmp/papercusp-target-tree/.papercusp',
    });
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': PASS_RUN },
    });

    const res = await emitScorecard(
      emitArgs({ sourceHive: 'sb-devboard-hive', targetHive: 'papercusp' }) as never,
      {
        createdBy: 'su-grader',
        ctxHarness: 'sb-devboard-hive',
        workspaceId: 'ws-test',
        checkRoot: '/tmp/sb-devboard-grader-tree',
      },
      { evaluateChecks },
    );

    expect(res.ok).toBe(true);
    expect(resolveHarnessPaths).toHaveBeenCalledWith('papercusp', 'ws-test');
    expect(evaluateChecks.mock.calls[0][0].root).toBe('/tmp/papercusp-target-tree');
  });

  it('uses the rubric workspace when a superuser dispatch omits workspaceId', async () => {
    resolveHarnessPaths.mockResolvedValue({
      projectDir: '/tmp/papercusp-target-tree',
      stateDir: '/tmp/papercusp-target-tree/.papercusp',
    });
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': PASS_RUN },
    });

    const res = await emitScorecard(
      emitArgs({ targetHive: 'email' }) as never,
      { createdBy: 'su-grader', ctxHarness: 'papercusp', checkRoot: '/tmp/grader-tree' },
      { evaluateChecks },
    );

    expect(res.ok).toBe(true);
    expect(resolveHarnessPaths).toHaveBeenCalledWith('email', 'ws-test');
    expect(evaluateChecks.mock.calls[0][0].root).toBe('/tmp/papercusp-target-tree');
  });

  it('a check refusal refuses the EMIT — nothing is filed', async () => {
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: false,
      error: 'check_contradicted',
      criterionKey: 'det-outcome',
      rating: 'pass',
      run: { ...PASS_RUN, verdict: 'fail', failed: 1, passed: 2 },
      detail: "criterion 'det-outcome' is rated 'pass' but its deterministic tests-check FAILED",
    });
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateChecks });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('FAILED');
      expect((res as { checkRefusal?: { error: string } }).checkRefusal?.error).toBe('check_contradicted');
    }
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('a rubric without tests-checks never invokes the evaluator (fuzzy grading unchanged)', async () => {
    getRubric.mockImplementation(async () => ({
      ...CHECKED_RUBRIC,
      criteria: CHECKED_RUBRIC.criteria.map(({ check: _check, ...c }) => c),
    }));
    const evaluateChecks = vi.fn<EvaluateChecks>();
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateChecks });
    expect(res.ok).toBe(true);
    expect(evaluateChecks).not.toHaveBeenCalled();
  });

  it('the unchanged-evidence decline fires BEFORE any check run — a deduped re-emit burns no suite', async () => {
    const canonical: ObservationRatings = {
      'det-outcome': { rating: 'pass', evidence: 'suite green' },
      'fuzzy-outcome': { rating: 'pass', evidence: 'reads well' },
    };
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-prev',
        rubricRef: 'ar-checked-plan',
        ratings: canonical,
        sourceHive: 'papercusp',
        evidenceFingerprint: scorecardEvidenceFingerprint({ rubricRef: 'ar-checked-plan', ratings: canonical }),
      },
    ]);
    const evaluateChecks = vi.fn<EvaluateChecks>();
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateChecks });
    expect(res.ok).toBe(true);
    expect((res as { created?: boolean }).created).toBe(false);
    expect((res as { reason?: string }).reason).toBe('unchanged-evidence');
    expect(evaluateChecks).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});

describe('scorecards:emit deterministic-check transport budget', () => {
  it('covers the 50-file contract and keeps outer headroom for cleanup + persistence', () => {
    // WI-41341: a measured 16-file acceptance batch takes about four minutes.
    // Linear capacity at the 50-file schema cap is 12.5 minutes, rounded up.
    const measuredBatchMs = 4 * 60_000;
    const measuredFiles = 16;
    const maxFiles = 50;
    const scaledContractMs = Math.ceil((measuredBatchMs * maxFiles) / measuredFiles);

    expect(SCORECARD_TEST_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(scaledContractMs);
    expect(scorecardEmitTool.timeoutSec).toBe(SCORECARD_EMIT_TIMEOUT_SEC);
    expect(SCORECARD_EMIT_TIMEOUT_SEC * 1_000 - SCORECARD_TEST_CHECK_TIMEOUT_MS)
      .toBeGreaterThanOrEqual(2 * 60_000);
  });
});
