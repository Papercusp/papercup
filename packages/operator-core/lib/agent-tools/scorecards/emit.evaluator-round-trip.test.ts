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
import { ADEQUACY_CRITERIA } from '../plans/spec-test-adequacy';
import { resolveLocalRubric } from '../../cupboard/rubric-store';
import { emitScorecard } from './emit';

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
  over: { id: number; evidenceKind: string; evidenceRef: string; outcome: string },
  fingerprints: { sourceFingerprint: string; testFingerprint: string | null },
): Record<string, unknown> {
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
    test_run_id: 43,
    test_run_present: true,
    details: { adequacy: { ...ADEQUACY, outcome: over.outcome }, currentMeasurement: MEASUREMENT },
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
    ratings: Record<string, { rating: string; evidence: string }>;
    scorecardDraft: {
      rubricRef: string;
      subject: { kind: 'plan'; ref: string };
      ratings: Record<string, { rating: string; evidence: string; suggestion?: string }>;
      rerunRecipe: { args: Record<string, unknown>; current: { supplied: boolean; fingerprints: unknown[] } };
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
  await writeSubject('export const ackedEventsReplayed = false;\n');
  // Stored fingerprints are what binding MEASURED: derive them from the fixture checkout
  // at run time, so 'current' can only mean the server re-derived them.
  const bound = await measureRepoFilesEvidenceAtRoot(root, MEASUREMENT);
  h.rows = [
    bindingRow({ id: 1, evidenceKind: 'coverage-census', evidenceRef: 'surface:reconnect', outcome: 'passed' }, bound),
    bindingRow({ id: 2, evidenceKind: 'counterexample', evidenceRef: 'counterexample:reconnect', outcome: 'pass' }, bound),
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
    {
      rubricRef: draft.rubricRef,
      subject: draft.subject,
      ratings: draft.ratings,
      rerunRecipe: draft.rerunRecipe,
    } as never,
    { createdBy: 'su-grader' },
    { dispatchTool },
  );

describe('spec-test-adequacy evaluator → scorecards:emit round trip', () => {
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
    expect(row!.verdict).toBe('pass');
    expect(row!.ratings.freshness.rating).toBe('pass');
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
    expect(row!.scorecardDraft.rerunRecipe.args).toMatchObject({ replaySnapshot: true });

    const result = await emitDraft(row!.scorecardDraft);

    expect(result).toMatchObject({ ok: true, created: true, issueId: 'EI-ROUND-TRIP' });
    // The gate really replayed through the evaluator with the recipe's exact args.
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledWith('plans:evaluate-spec-test-adequacy', {
      ...row!.scorecardDraft.rerunRecipe.args,
      detail: 'summary',
      includeDraft: false,
      payloadTier: 'full',
    });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('refuses the same card once the proven source moves — the replay re-measures, it does not echo', async () => {
    const live = await runEvaluator({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      detail: 'full',
    });
    expect(live.rows[0]!.ratings.freshness.rating).toBe('pass');

    // The code under proof changes after grading and before filing.
    await writeSubject('export const ackedEventsReplayed = true;\n');

    const result = await emitDraft(live.rows[0]!.scorecardDraft);

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining("cannot claim freshness='pass'"),
    });
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});
