/**
 * Evaluator → auditor ROUND TRIP for spec-test-adequacy cards
 * (review-system-rework-reduction-2026-09-23 P-005, WI-10002645; regression class WI-10002320).
 *
 * Every other emit replay test hands `dispatchTool` a CANNED replay row. That proves the
 * gate compares ratings correctly, but it never asks the question that actually broke the
 * fleet: can the evaluator's OWN `scorecardDraft` survive the evaluator's OWN replay? For
 * WI-10002320 the answer was structurally "no" — `rerunRecipeFor` always emits
 * `replaySnapshot:true` plus a matching `current` tuple, the store suppressed server
 * measurement on every replay, the classifier capped freshness at `unknown`, and
 * scorecards:emit refused every freshness=pass card the evaluator had just produced.
 * Both halves were individually tested and individually green.
 *
 * So this suite wires the REAL pieces end to end, mocking only the I/O seams below them:
 *
 *   plans:evaluate-spec-test-adequacy (real handler)
 *     → listSpecEvidence (real; DB rows faked at withWorkspace, repo measured for real
 *       against a temp checkout)
 *     → evaluateSpecTestAdequacy + rerunRecipeFor (real)
 *   scorecards:emit (real emitScorecard, real replay gate)
 *     → dispatchTool → THE SAME real evaluator handler, args parsed by its real schema
 *
 * An emitted card is "auditor-reproducible by construction" exactly when the first test
 * holds. The second is its falsifier: the same round trip after the proven code moves
 * must be REFUSED, which is what makes the first a measurement rather than an echo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  querySql: [] as string[],
  measurementRoot: '',
}));

// ── evidence-store I/O seams ────────────────────────────────────────────────────────
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: unknown) => Promise<T>) => {
      const tx = ((strings: TemplateStringsArray | string[]) => {
        const sql = Array.from(strings).join(' ');
        h.querySql.push(sql);
        // The provisional-scorecard lookup finds none; every other read returns the bindings.
        return Promise.resolve(sql.includes('provisional') ? [] : h.rows);
      }) as unknown;
      return fn(tx);
    },
  };
});
vi.mock('../plans/source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plans/source')>()),
  resolvePlanScope: async () => ({ workspaceId: 'workspace-test', harnessSlug: 'papercusp' }),
}));
// Server measurement resolves a real harness checkout: point it at this suite's temp root so
// the replay's re-measurement is observable. Without it every measurement would fail with
// repo_measurement_harness_root_unavailable and the round trip would pass or fail for the
// wrong reason.
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: async () => ({}) as never,
  resolveHarnessContentPath: () => h.measurementRoot,
}));

// ── evaluator-handler seams ─────────────────────────────────────────────────────────
vi.mock('../_harness-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_harness-scope')>()),
  harnessScopedCtx: vi.fn((_harness: unknown, ctx: unknown) => ctx),
}));
vi.mock('../plans/_ctx-opts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plans/_ctx-opts')>()),
  resolveEffectiveHarnessSlug: vi.fn(() => 'papercusp'),
}));
vi.mock('../plans/spec-clauses-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plans/spec-clauses-store')>()),
  listSpecClauses: vi.fn(),
}));
// One build for the evaluator AND the recipe it records, so the replay is a same-build
// replay: build drift is a different refusal with its own tests (emit.replay.test.ts).
vi.mock('../../build-info', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../build-info')>()),
  getBuildInfo: vi.fn(() => ({ sha: 'round-trip-evaluator-sha', version: '1.0.0' })),
}));

// ── scorecards:emit persistence seams (same set as emit.replay.test.ts) ─────────────
const getRubric = vi.fn();
const getRubricPlanRevision = vi.fn();
const readRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();

vi.mock('../../rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../rubrics')>()),
  getRubric: (...args: unknown[]) => getRubric(...args),
  getRubricWithoutSeeding: (...args: unknown[]) => getRubric(...args),
  getRubricPlanRevision: (...args: unknown[]) => getRubricPlanRevision(...args),
  readRubricPlanRevision: (...args: unknown[]) => readRubricPlanRevision(...args),
}));
vi.mock('../../scorecards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scorecards')>()),
  listScorecards: (...args: unknown[]) => listScorecards(...args),
}));
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...args: unknown[]) => captureImprovement(...args),
}));
vi.mock('../../scout/generation-watermark', () => ({ readRunningGeneration: async () => null }));
vi.mock('../../issues-engineer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../issues-engineer')>()),
  getIssue: async () => null,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));

import evaluatorTool, { argsSchema as evaluatorArgsSchema } from '../plans/evaluate-spec-test-adequacy';
import { listSpecClauses } from '../plans/spec-clauses-store';
import { measureRepoFilesEvidenceAtRoot } from '../plans/spec-evidence-store';
import { ADEQUACY_CRITERIA, SPEC_TEST_ADEQUACY_EVALUATOR_REVISION } from '../plans/spec-test-adequacy';
import { resolveLocalRubric } from '../../cupboard/rubric-store';
import { emitScorecard, scorecardEmitArgs } from './emit';
import type { SpecTestAdequacyRerunRecipe } from '../../harness/improvements/observation-types';

const listClauses = vi.mocked(listSpecClauses);

const PLAN = 'reconnect-plan';
const SPEC = 'SPEC-003-01';
const SPEC_FINGERPRINT = 'sha256:spec-v1';
const MEASUREMENT = {
  schemaVersion: 1 as const,
  kind: 'repo-files' as const,
  sourcePaths: ['src/reconnect.ts'],
  testPaths: ['test/reconnect.test.ts'],
};

const ADEQUACY = {
  fixtureCalibrated: true,
  falsifiable: true,
  testLayer: 'integration',
  pathReachable: true,
  oracleIndependent: true,
  collected: true,
  skipped: false,
  executed: true,
  // This fixture's clause declares no falsifier scenarios, so name the clause itself.
  targeted: SPEC.toLowerCase(),
  coverageRungs: { l3: true, l4: false },
};

/** A stored binding row exactly as listSpecEvidence's SQL returns it (snake_case). */
function bindingRow(
  over: {
    id: number;
    evidenceKind: string;
    evidenceRef: string;
    outcome: string;
    testRunId?: number;
    testRunSource?: string;
    testRunStatus?: string;
    testRunOutputTail?: string | null;
    testCases?: string[];
  },
  fingerprints: { sourceFingerprint: string; testFingerprint: string | null },
): Record<string, unknown> {
  const mutationFailureCaseTitle =
    over.evidenceKind === 'mutation' &&
    over.testRunSource === 'mutation-probe' &&
    over.testRunStatus === 'fail' &&
    over.testRunOutputTail?.includes(' — ')
      ? over.testRunOutputTail.split(' — ')[0]?.trim() ?? null
      : null;
  return {
    id: over.id,
    work_item_id: 'WI-101',
    plan_slug: PLAN,
    spec_id: SPEC,
    source_val_id: 'VAL-003-01',
    spec_revision: 1,
    current_revision: 1,
    spec_fingerprint: SPEC_FINGERPRINT,
    evidence_kind: over.evidenceKind,
    evidence_ref: over.evidenceRef,
    source_fingerprint: fingerprints.sourceFingerprint,
    test_fingerprint: fingerprints.testFingerprint,
    // Non-repository dimensions stay null: a caller-supplied value for any of them is
    // attested, not measured, and would legitimately cap freshness below pass.
    fixture_fingerprint: null,
    rubric_fingerprint: null,
    environment_fingerprint: null,
    coverage_evidence_ref: 42,
    coverage_evidence_present: true,
    test_run_id: over.testRunId ?? 43,
    test_run_present: true,
    // The fake durable ledger represents a measured clean run. Missing/dirty
    // provenance must stay unknown, independently of matching file hashes.
    test_run_file_path: 'test/reconnect.test.ts',
    test_run_commit_sha: 'fixture-clean-commit',
    test_run_worktree_dirty: false,
    mutation_failure_case_title: mutationFailureCaseTitle,
    details: {
      adequacy: {
        ...ADEQUACY,
        outcome: over.outcome,
        ...(over.testCases ? { testCases: over.testCases } : {}),
      },
      currentMeasurement: MEASUREMENT,
    },
    observed_at: '2026-09-20 17:10:00-04',
    binding_fingerprint: `sha256:binding-${over.id}`,
    created_by: 'su-binder',
    created_at: `2026-09-20T21:10:0${over.id}.000Z`,
    spec_is_current: true,
  };
}

const activeClause = {
  planSlug: PLAN,
  specId: SPEC,
  sourceValId: 'VAL-003-01',
  currentRevision: 1,
  revision: 1,
  planItemId: 'P-003',
  behavior: 'An acknowledged event is not replayed after reconnect.',
  behaviorClass: 'happy-path',
  requiredEvidence: ['integration fixture'],
  requiredTestLayers: ['integration'],
  mutationRequired: false,
  lifecycleStatus: 'active',
  supersedes: null,
  exemption: null,
  falsifier: null,
  contentHash: SPEC_FINGERPRINT,
  createdBy: 'su-author',
  createdAt: '2026-09-20T00:00:00.000Z',
  acceptedBy: 'reviewer',
  acceptedAt: '2026-09-20T00:01:00.000Z',
  acceptanceRef: 'D-003',
  sourceBar: null,
};

type EvaluatorPayload = {
  ok: boolean;
  rows: Array<{
    verdict: string;
    wouldBlock: string[];
    ratings: Record<string, { rating: string; evidence: string; suggestion?: string }>;
    scorecardDraft: {
      rubricRef: string;
      subject: { kind: 'plan'; ref: string };
      ratings: Record<string, { rating: string; evidence: string; suggestion?: string }>;
      // The REAL recipe contract, not a hand-narrowed copy: a local subset silently fell
      // behind when assertions on evaluatorRevision/evaluatorBuild/selection were added
      // (WI-10006618), and vitest never typechecks, so only lint:tsc saw it.
      rerunRecipe: SpecTestAdequacyRerunRecipe;
    };
  }>;
};

/** Exactly what a real dispatch does to evaluator args: parse with the tool's own schema
 *  (which strips framework-reserved keys such as payloadTier), then run the handler. */
async function runEvaluator(args: Record<string, unknown>): Promise<EvaluatorPayload> {
  const parsed = evaluatorArgsSchema.parse(args);
  return ((await evaluatorTool.handler(parsed as never, {} as never)) as { data: EvaluatorPayload }).data;
}

let root = '';

async function writeSubject(sourceBody: string): Promise<void> {
  await writeFile(join(root, 'src', 'reconnect.ts'), sourceBody);
  await writeFile(join(root, 'test', 'reconnect.test.ts'), 'expect(replayed).toEqual([]);\n');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'emit-evaluator-round-trip-'));
  h.measurementRoot = root;
  await Promise.all([mkdir(join(root, 'src'), { recursive: true }), mkdir(join(root, 'test'), { recursive: true })]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.querySql = [];
  await writeSubject('export const ackedEventsReplayed = false;\n');
  // Stored fingerprints are what binding MEASURED: derive them from the fixture checkout
  // at run time, so 'current' can only mean the server re-derived them.
  const bound = await measureRepoFilesEvidenceAtRoot(root, MEASUREMENT);
  h.rows = [
    bindingRow({ id: 1, evidenceKind: 'coverage-census', evidenceRef: 'surface:reconnect', outcome: 'passed' }, bound),
    bindingRow({ id: 2, evidenceKind: 'counterexample', evidenceRef: 'counterexample:reconnect', outcome: 'pass' }, bound),
    // Evaluator revision 5 requires a successful current test binding for the mutation or
    // counterexample's canonical test file on this exact clause revision.
    bindingRow({
      id: 3,
      evidenceKind: 'test',
      evidenceRef: 'test:reconnect',
      outcome: 'passed',
      testCases: ['reconnect after acknowledgement'],
    }, bound),
    // The clause requires an 'integration fixture'. Only fixture-scoped proof (an
    // evidenceKind='fixture' binding or a non-null fixture fingerprint) may attest
    // fixtureCalibrated; the flag on the test row above no longer counts
    // (guard-rail:spec-fixture-calibration-requires-proof). A fixture-kind binding keeps the
    // attested fixture fingerprint null, so freshness stays a measured pass.
    bindingRow({ id: 4, evidenceKind: 'fixture', evidenceRef: 'fixture:reconnect', outcome: 'passed' }, bound),
  ];
  listClauses.mockResolvedValue([activeClause as never]);

  const bundled = resolveLocalRubric('spec-test-adequacy');
  if (!bundled) throw new Error('rubrics/spec-test-adequacy/rubric.json must resolve');
  getRubric.mockResolvedValue({
    rubricId: 'spec-test-adequacy',
    workspaceId: 'workspace-test',
    kind: 'standard',
    characteristic: 'plan-proof',
    title: bundled.title,
    description: '',
    criteria: bundled.criteria,
    ratingScale: bundled.ratingScale,
    methodRef: null,
    status: 'active',
    createdBy: null,
    proposedBy: null,
    ratifiedBy: null,
  });
  getRubricPlanRevision.mockResolvedValue(7);
  readRubricPlanRevision.mockResolvedValue({ ok: true, revision: 7 });
  listScorecards.mockResolvedValue([]);
  captureImprovement.mockResolvedValue({ ok: true, created: true, issue: { id: 'EI-ROUND-TRIP' } });
});

const dispatchTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name !== 'plans:evaluate-spec-test-adequacy') throw new Error(`unexpected replay dispatch: ${name}`);
  return runEvaluator(args);
});

/** Submit the evaluator's draft verbatim — the auditor-facing contract is "file what the
 *  evaluator returned, unedited". */
const emitDraft = (draft: EvaluatorPayload['rows'][number]['scorecardDraft']) =>
  emitScorecard(
    scorecardEmitArgs.parse(draft),
    { createdBy: 'su-grader' },
    { dispatchTool },
  );

describe('spec-test-adequacy evaluator → scorecards:emit round trip', () => {
  it('requires the measured mutation failed case in the successful same-clause testCases before scoring falsifiability', async () => {
    h.rows = h.rows
      .filter((row) => row.id !== 2)
      .map((row) => {
        if (row.id !== 3) return row;
        const details = row.details as Record<string, unknown>;
        const adequacy = details.adequacy as Record<string, unknown>;
        return {
          ...row,
          details: { ...details, adequacy: { ...adequacy, testCases: ['code-search.definition-lookup'] } },
        };
      });
    h.rows.push(bindingRow({
      id: 5,
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:callers-lookup:caught',
      outcome: 'caught',
      testRunId: 44,
      testRunSource: 'mutation-probe',
      testRunStatus: 'fail',
      testRunOutputTail: "code-search.callers-lookup — measurement and promotion state > expected 'needs-widening' to be 'equivalent'",
    }, await measureRepoFilesEvidenceAtRoot(root, MEASUREMENT)));

    const result = await runEvaluator({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      detail: 'full',
    });

    expect(result.rows[0]!.ratings.falsifiability.rating).toBe('unknown');
    expect(result.rows[0]!.ratings.falsifiability.evidence).toContain('code-search.callers-lookup');
    expect(result.rows[0]!.ratings.falsifiability.suggestion).toContain('adequacy.testCases');
    expect(h.querySql.some((sql) => sql.includes('tr.output_tail'))).toBe(true);
  });

  it.each([true, null])('refuses freshness pass when the durable run cleanliness is %s', async (dirty) => {
    h.rows = h.rows.map((row) => ({ ...row, test_run_worktree_dirty: dirty }));
    const live = await runEvaluator({ harness: 'papercusp', slug: PLAN, classRef: 'plan-class-feature-ship', specIds: [SPEC], detail: 'full' });
    expect(live.rows[0]!.verdict).toBe('unknown');
    expect(live.rows[0]!.wouldBlock).toContain('freshness');
    expect(live.rows[0]!.ratings.freshness.evidence).toContain(
      dirty === true ? 'test-run-worktree-not-clean' : 'test-run-worktree-cleanliness-unproven',
    );
  });

  it('files the evaluator’s own all-pass card, freshness included, through its own exact replay', async () => {
    const live = await runEvaluator({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      detail: 'full',
    });

    // Calibration: the live grade must itself be a full pass, or a green emit below
    // proves nothing about freshness=pass reproducing.
    expect(live.ok).toBe(true);
    expect(live.rows).toHaveLength(1);
    const [row] = live.rows;
    expect(Object.keys(row!.ratings).sort()).toEqual([...ADEQUACY_CRITERIA].sort());
    expect(row!.verdict, JSON.stringify({ wouldBlock: row!.wouldBlock, freshness: row!.ratings.freshness })).toBe('pass');
    expect(row!.ratings.freshness.rating, row!.ratings.freshness.evidence).toBe('pass');
    // `disclosed-gap` is legitimately not-applicable when the clause discloses no gap;
    // every other criterion must be a real pass for the card to be all-pass.
    for (const [criterion, rating] of Object.entries(row!.ratings)) {
      expect({ criterion, rating: rating.rating }).toEqual({
        criterion,
        rating: criterion === 'disclosed-gap' ? 'not-applicable' : 'pass',
      });
    }
    expect(row!.wouldBlock).toEqual([]);
    // The recipe carries the SERVER-measured tuple, so emit's supplied:false refusal
    // cannot be what lets freshness through.
    expect(row!.scorecardDraft.rerunRecipe.current.supplied).toBe(true);
    const recipe = row!.scorecardDraft.rerunRecipe;
    // The graded rule revision is envelope metadata; executable args stay valid against
    // the evaluator's strict schema while preserving the full scored input population.
    expect(recipe.evaluatorRevision).toBe(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION);
    expect(recipe.args).not.toHaveProperty('evaluatorRevision');
    expect(recipe.args.evaluatorBuild).toEqual(recipe.evaluatorBuild);
    expect(recipe.args).toMatchObject({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      specRevision: recipe.selection.specRevision,
      specFingerprint: recipe.selection.specFingerprint,
      replaySnapshot: true,
      bindingIds: [1, 2, 3, 4],
      current: recipe.current.fingerprints,
    });
    expect(recipe.args.evidenceRefs).toEqual(
      recipe.selection.evidence.map(({ evidenceRef }) => evidenceRef).sort((a, b) => a.localeCompare(b)),
    );
    expect(row!.scorecardDraft.rerunRecipe.args).toMatchObject({ replaySnapshot: true, bindingIds: [1, 2, 3, 4] });
    expect(scorecardEmitArgs.parse(row!.scorecardDraft).rerunRecipe?.selection.bindingIds).toEqual([1, 2, 3, 4]);

    const result = await emitDraft(row!.scorecardDraft);

    expect(result).toMatchObject({ ok: true, created: true, issueId: 'EI-ROUND-TRIP' });
    // The gate really replayed through the evaluator with the recipe's exact args.
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledWith('plans:evaluate-spec-test-adequacy', {
      ...row!.scorecardDraft.rerunRecipe.args,
      detail: 'summary',
      includeDraft: true,
      payloadTier: 'full',
    });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('refuses the same card once the proven source moves because its current test witness no longer qualifies', async () => {
    const live = await runEvaluator({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      detail: 'full',
    });
    expect(live.rows[0]!.ratings.freshness.rating, live.rows[0]!.ratings.freshness.evidence).toBe('pass');

    // The code under proof changes after grading and before filing. The replay re-measures;
    // evaluator revision 5 withdraws falsifiability first because its canonical test witness is stale.
    await writeSubject('export const ackedEventsReplayed = true;\n');

    const result = await emitDraft(live.rows[0]!.scorecardDraft);

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining("cannot claim falsifiability='pass'"),
    });
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});
