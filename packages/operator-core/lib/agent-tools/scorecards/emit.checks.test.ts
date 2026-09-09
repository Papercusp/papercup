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
const readRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();
const resolveHarnessPaths = vi.fn();
const resolvePlanHarnessSlug = vi.fn();

vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...real,
    getRubric: (...a: unknown[]) => getRubric(...a),
    getRubricPlanRevision: (...a: unknown[]) => getRubricPlanRevision(...a),
    readRubricPlanRevision: (...a: unknown[]) => readRubricPlanRevision(...a),
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
// Collaborator mock, matching emit-evaluate.test.ts. emit.ts's acceptance branch
// calls these identity helpers, which fall back to a REAL org-admin pool when no
// sql seam is injected — a unit tier must not open a live connection. This file
// declares itself unit-level ("collaborators are mocked") and simply predated the
// callerInImplementerLineage guard added to emit.ts on 2026-08-30.
vi.mock('../../acceptance-author-identity', () => ({
  isAcceptanceAuthorIdentity: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  areAcceptanceLineageRelated: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  resolvePlanImplementerIdentities: vi.fn(async () => []),
}));
// These tests own deterministic criterion checks, not the post-write wake bridge.
// Keep the newly-created-card event from reaching its real PG-backed await latch.
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));
vi.mock('../../resolve-harness-paths', () => ({
  resolveHarnessPaths: (...a: unknown[]) => resolveHarnessPaths(...a),
}));
vi.mock('../plans/source', () => ({
  resolvePlanHarnessSlug: (...a: unknown[]) => resolvePlanHarnessSlug(...a),
}));

import scorecardEmitTool, {
  emitScorecard,
  SCORECARD_EMIT_TIMEOUT_SEC,
  SCORECARD_TEST_CHECK_TIMEOUT_MS,
} from './emit';
import { scorecardEvidenceFingerprint } from '../../scorecards';
import type { ObservationRatings } from '../../harness/improvements/observation-types';
import type {
  evaluateCriterionCargoChecks,
  evaluateCriterionTestChecks,
  CriterionCheckRun,
} from '../../rubrics-criterion-checks';

type EvaluateChecks = typeof evaluateCriterionTestChecks;
type EvaluateCargoChecks = typeof evaluateCriterionCargoChecks;

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

// EI-22177729599840121: a valid meta-acceptance-rubric attestation for CHECKED_RUBRIC's
// current revision (3, matching getRubricPlanRevision's default below) — satisfies the
// vet-before-grade prerequisite emitScorecard now enforces for every non-implementer
// acceptance-kind grading (EMIT_INPUT's 'su-grader' ≠ CHECKED_RUBRIC's author 'su-author').
// Returned only for a query against the META rubric ref, so the pre-existing
// duplicate/dedup listScorecards({ rubricRef: args.rubricRef, ... }) queries against
// 'ar-checked-plan' are left exactly as they were (empty), unlike a blanket mockResolvedValue.
const META_VETTING_CARD = {
  issueId: 'EI-vetting',
  createdAt: '2026-08-25T21:00:12Z',
  createdBy: 'su-vetting-author',
  rubricRef: 'meta-acceptance-rubric',
  subject: { kind: 'rubric', ref: 'ar-checked-plan' },
  ratings: RATINGS,
  nKeys: 2,
  missingKeys: [],
  extraKeys: [],
  rubricResolved: true,
  synthesized: false,
  score10: 10,
  linkedItems: [],
  vetting: { consultId: 'conv-vet-1', rubricRevision: 3, critiquePosts: 1, critics: ['su-critic'] },
};

const PASS_RUN: CriterionCheckRun = {
  kind: 'tests',
  files: ['packages/x/real.test.ts'],
  verdict: 'pass',
  passed: 3,
  failed: 0,
  runId: 'run-1',
  measuredAt: '2026-08-17T12:00:00.000Z',
};

const CARGO_PASS_RUN: CriterionCheckRun = {
  kind: 'cargo',
  manifestPath: 'apps/tui/Cargo.toml',
  sourceFiles: ['apps/tui/src/app.rs'],
  verdict: 'pass',
  passed: 12,
  failed: 0,
  ignored: 1,
  runId: 'cargo-1',
  measuredAt: '2026-08-30T07:30:00.000Z',
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
  readRubricPlanRevision.mockReset().mockResolvedValue({ ok: true, revision: 3 });
  // EI-22177729599840121: vet-before-grade now queries listScorecards for the
  // meta-acceptance-rubric before every non-implementer acceptance grading — answer
  // that one query with a satisfying attestation, everything else stays '[]' exactly
  // as before (this file's own dedup/duplicate-detection queries key on the REAL
  // rubricRef, 'ar-checked-plan', never the meta ref).
  listScorecards.mockReset().mockImplementation(async (filter: { rubricRef?: string } = {}) =>
    filter.rubricRef === 'meta-acceptance-rubric' ? [META_VETTING_CARD] : [],
  );
  captureImprovement.mockReset().mockResolvedValue({ created: true, issue: { id: 'EI-1' } });
  resolveHarnessPaths.mockReset();
  resolvePlanHarnessSlug.mockReset();
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

  it('runs native Cargo checks through their own evaluator and stamps the native run', async () => {
    const cargoRubric = {
      ...CHECKED_RUBRIC,
      criteria: [
        CHECKED_RUBRIC.criteria[0],
        {
          ...CHECKED_RUBRIC.criteria[1],
          check: {
            kind: 'cargo' as const,
            manifestPath: 'apps/tui/Cargo.toml',
            sourceFiles: ['apps/tui/src/app.rs'],
          },
        },
      ],
    };
    getRubric.mockResolvedValue(cargoRubric);
    const evaluateCargoChecks = vi.fn<EvaluateCargoChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': CARGO_PASS_RUN },
    });
    const evaluateChecks = vi.fn<EvaluateChecks>();
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, {
      evaluateChecks,
      evaluateCargoChecks,
    });

    expect(res.ok).toBe(true);
    expect(evaluateChecks).not.toHaveBeenCalled();
    expect(evaluateCargoChecks).toHaveBeenCalledTimes(1);
    const call = evaluateCargoChecks.mock.calls[0][0];
    expect(call.root).toBe('/tmp/fake-root');
    expect(call.criteria).toBe(cargoRubric.criteria);
    expect(call.timeoutMs).toBe(SCORECARD_TEST_CHECK_TIMEOUT_MS);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { checkRuns?: Record<string, CriterionCheckRun> } };
    };
    expect(payload.payloadExtra.observation.checkRuns?.['det-outcome']).toMatchObject({
      kind: 'cargo',
      manifestPath: 'apps/tui/Cargo.toml',
      sourceFiles: ['apps/tui/src/app.rs'],
      verdict: 'pass',
      runId: 'cargo-1',
    });
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
    expect(resolvePlanHarnessSlug).not.toHaveBeenCalled();
  });

  it('derives targetHive from the rubric subject plan when targetHive is omitted', async () => {
    resolvePlanHarnessSlug.mockResolvedValue('papercusp');
    resolveHarnessPaths.mockResolvedValue({
      projectDir: '/tmp/papercusp-target-tree',
      stateDir: '/tmp/papercusp-target-tree/.papercusp',
    });
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': PASS_RUN },
    });

    const res = await emitScorecard(
      emitArgs({ sourceHive: 'sb-devboard-hive' }) as never,
      {
        createdBy: 'su-grader',
        ctxHarness: 'sb-devboard-hive',
        workspaceId: 'ws-test',
        checkRoot: '/tmp/sb-devboard-grader-tree',
      },
      { evaluateChecks },
    );

    expect(res.ok).toBe(true);
    expect(resolvePlanHarnessSlug).toHaveBeenCalledWith('ws-test', CHECKED_RUBRIC.subjectPlan);
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

  it('surfaces the internal test-run identity and bounded router evidence on an unjudgeable check', async () => {
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: false, error: 'check_run_failed', criterionKey: 'det-outcome',
      detail: 'the batched tests-check run could not be judged (route_error; runId route-run-42)',
      runner: { runId: 'route-run-42', root: '/tmp/fake-root', error: 'route_error',
        routerOutput: 'TEST_FILE_ROUTE_ERROR exact router evidence' },
    });
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateChecks });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected an unjudgeable check refusal');
    expect(res.checkRefusal).toMatchObject({
      error: 'check_run_failed',
      runner: { runId: 'route-run-42', error: 'route_error',
        routerOutput: 'TEST_FILE_ROUTE_ERROR exact router evidence' },
    });
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
        rubricRevision: 3,
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
