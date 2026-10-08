/**
 * plans:certify-spec-clauses (review-system-rework-reduction-2026-09-23 P-005, absorbing P-006).
 *
 * The verb must add NO grading logic: it runs the real evaluator and files each passing
 * clause's draft, unedited, through the real scorecards:emit body — so every card it files
 * has crossed emit's exact-replay gate against the SAME evaluator. These tests therefore
 * mock only I/O seams (DB rows, harness root, rubric/ledger persistence) and run the real
 * evaluator, real listSpecEvidence measurement over a temp checkout, and real emitScorecard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  measurementRoot: '',
  planSlug: 'reconnect-plan',
}));

vi.mock('../../work-items', async (original) => ({
  ...(await original<typeof import('../../work-items')>()),
  getWorkItem: async () => ({ id: 'WI-101', harness: 'papercusp', kind: 'bug' }),
}));
vi.mock('./behavior-contract-resolver', async (original) => ({
  ...(await original<typeof import('./behavior-contract-resolver')>()),
  resolveWorkItemBehaviorContract: async () => ({
    groups: [{ planSlug: 'adhoc-work-item-specs', clauses: [{ specId: 'SPEC-PASS' }] }],
  }),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: unknown) => Promise<T>) => {
      const tx = ((strings: TemplateStringsArray | string[]) => {
        const sql = Array.from(strings).join(' ');
        return Promise.resolve(sql.includes('provisional') ? [] : h.rows);
      }) as unknown;
      return fn(tx);
    },
  };
});
vi.mock('./source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./source')>()),
  resolvePlanScope: async () => ({ workspaceId: 'workspace-test', harnessSlug: 'papercusp' }),
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: async () => ({}) as never,
  resolveHarnessContentPath: () => h.measurementRoot,
}));
vi.mock('../_harness-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_harness-scope')>()),
  harnessScopedCtx: vi.fn((_harness: unknown, ctx: unknown) => ctx),
}));
vi.mock('./_ctx-opts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_ctx-opts')>()),
  resolveEffectiveHarnessSlug: vi.fn(() => 'papercusp'),
}));
vi.mock('./spec-clauses-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spec-clauses-store')>()),
  listSpecClauses: vi.fn(),
}));
vi.mock('../../build-info', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../build-info')>()),
  getBuildInfo: vi.fn(() => ({ sha: 'certify-evaluator-sha', version: '1.0.0' })),
}));

const getRubric = vi.fn();
const getRubricEvidenceIdentity = vi.fn();
const getRubricPlanRevision = vi.fn();
const readRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();

vi.mock('../../rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../rubrics')>()),
  getAcceptanceRubricsForPlan: async () => [{ rubricId: 'reconnect-acceptance', classRef: 'plan-class-feature-ship' }],
  getRetiredAcceptanceRubricsForPlan: async () => [],
  getRubric: (...args: unknown[]) => getRubric(...args),
  getRubricWithoutSeeding: (...args: unknown[]) => getRubric(...args),
  getRubricEvidenceIdentity: (...args: unknown[]) => getRubricEvidenceIdentity(...args),
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
vi.mock('../../grading-integrity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grading-integrity')>()),
  readGradingAuditDispatchSuppression: async () => null,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));

import certifyTool from './certify-spec-clauses';
import { validateGradingAuditReplayConsistency } from '../scorecards/emit';
import { specTestAdequacySubjectRef } from './spec-test-adequacy';
import { asStructuredObservation } from '../../harness/improvements/observation-types';
import evaluatorTool, { argsSchema as evaluatorArgsSchema } from './evaluate-spec-test-adequacy';
import { listSpecClauses } from './spec-clauses-store';
import { measureRepoFilesEvidenceAtRoot } from './spec-evidence-store';
import { resolveLocalRubric } from '../../cupboard/rubric-store';

const listClauses = vi.mocked(listSpecClauses);

const PLAN = 'reconnect-plan';
const SPEC_FINGERPRINT = 'sha256:spec-v1';
const MEASUREMENT = {
  schemaVersion: 1 as const,
  kind: 'repo-files' as const,
  sourcePaths: ['src/reconnect.ts'],
  testPaths: ['test/reconnect.test.ts'],
};
const FIXTURE_MEASUREMENT = { ...MEASUREMENT, fixturePaths: ['test/reconnect.fixture.json'] };

function bindingRow(
  over: {
    id: number;
    specId: string;
    evidenceKind: string;
    evidenceRef: string;
    outcome: string;
    /**
     * adequacy.targeted. A mutation/counterexample row only demonstrates falsifiability when
     * this is the clause's own lowercase specId (spec-test-adequacy isAcceptedMutationTarget,
     * WI-10002724); a boolean `true` rates falsifiability `unknown` (WI-10002879).
     */
    targeted?: boolean | string;
  },
  fingerprints: { sourceFingerprint: string; testFingerprint: string | null },
): Record<string, unknown> {
  return {
    id: over.id,
    work_item_id: 'WI-101',
    plan_slug: h.planSlug,
    spec_id: over.specId,
    source_val_id: null,
    spec_revision: 1,
    current_revision: 1,
    spec_fingerprint: SPEC_FINGERPRINT,
    evidence_kind: over.evidenceKind,
    evidence_ref: over.evidenceRef,
    source_fingerprint: fingerprints.sourceFingerprint,
    test_fingerprint: fingerprints.testFingerprint,
    fixture_fingerprint: over.evidenceKind === 'fixture' ? fixtureBound.fixtureFingerprint : null,
    rubric_fingerprint: null,
    environment_fingerprint: null,
    coverage_evidence_ref: 42,
    coverage_evidence_present: true,
    test_run_id: 43,
    test_run_present: true,
    test_run_file_path: 'test/reconnect.test.ts',
    test_run_commit_sha: 'fixture-clean-commit',
    test_run_worktree_dirty: false,
    test_run_status: 'pass',
    test_run_execution_details: {
      schemaVersion: 1, root: h.measurementRoot, filePath: 'test/reconnect.test.ts', runGroupId: null,
      workspaceId: 'workspace-test', harnessSlug: 'papercusp', testNamePattern: null,
      passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
      commitSha: 'fixture-clean-commit', worktreeDirty: false, testLayer: 'integration',
      passedCaseTitles: ['acknowledged events are not replayed'],
    },
    details: {
      adequacy: {
        fixtureFree: over.evidenceKind !== 'fixture',
        testCases: ['acknowledged events are not replayed'],
        scenarioIds: over.evidenceKind === 'counterexample' ? ['acknowledged-event-negative-control'] : [],
        ...(over.evidenceKind === 'fixture' ? { fixtureCalibrated: true } : {}),
        falsifiable: true,
        testLayer: 'integration',
        pathReachable: true,
        oracleIndependent: true,
        collected: true,
        skipped: false,
        executed: true,
        targeted: over.targeted ?? true,
        coverageRungs: { l3: true, l4: false },
        outcome: over.outcome,
      },
      currentMeasurement: over.evidenceKind === 'fixture' ? FIXTURE_MEASUREMENT : MEASUREMENT,
    },
    observed_at: '2026-09-20 17:10:00-04',
    binding_fingerprint: `sha256:binding-${over.id}`,
    created_by: 'su-binder',
    created_at: `2026-09-20T21:10:${String(over.id).padStart(2, '0')}.000Z`,
    spec_is_current: true,
  };
}

const clause = (specId: string, lifecycleStatus: 'active' | 'draft' = 'active') =>
  ({
    planSlug: h.planSlug,
    specId,
    sourceValId: null,
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-003',
    behavior: `${specId}: an acknowledged event is not replayed after reconnect.`,
    behaviorClass: 'happy-path',
    requiredEvidence: ['integration fixture'],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus,
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: SPEC_FINGERPRINT,
    createdBy: 'su-author',
    createdAt: '2026-09-20T00:00:00.000Z',
    acceptedBy: lifecycleStatus === 'draft' ? null : 'reviewer',
    acceptedAt: lifecycleStatus === 'draft' ? null : '2026-09-20T00:01:00.000Z',
    acceptanceRef: lifecycleStatus === 'draft' ? null : 'D-003',
    sourceBar: null,
  }) as never;

let root = '';
let bound: { sourceFingerprint: string; testFingerprint: string | null };
let fixtureBound: Awaited<ReturnType<typeof measureRepoFilesEvidenceAtRoot>>;

const writeSubject = (body: string) => writeFile(join(root, 'src', 'reconnect.ts'), body);

/** Replay dispatch the way a real host does it: the evaluator's own schema, then its handler. */
const replayViaEvaluator = async (args: Record<string, unknown>) =>
  ((await evaluatorTool.handler(evaluatorArgsSchema.parse(args) as never, {} as never)) as { data: unknown }).data;

const dispatchTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name !== 'plans:evaluate-spec-test-adequacy') throw new Error(`unexpected dispatch: ${name}`);
  return replayViaEvaluator(args);
});

const ctx = () =>
  ({ isSuperuser: true, uiClientId: 'su-certifier', workspaceId: 'workspace-test', projectDir: root, dispatchTool }) as never;

type CertifyResult = {
  ok: boolean;
  dryRun: boolean;
  counts?: Record<string, number>;
  clauses?: Array<{ specId: string; verdict: string; wouldBlock: string[]; card: Record<string, unknown> }>;
  evaluator?: Record<string, unknown>;
};

const certify = async (args: Record<string, unknown>) =>
  ((await certifyTool.handler(
    certifyTool.args.parse({ harness: 'papercusp', slug: PLAN, classRef: 'plan-class-feature-ship', ...args }) as never,
    ctx(),
  )) as { data: CertifyResult }).data;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'certify-spec-clauses-'));
  h.measurementRoot = root;
  await Promise.all([mkdir(join(root, 'src'), { recursive: true }), mkdir(join(root, 'test'), { recursive: true })]);
  await writeFile(join(root, 'test', 'reconnect.test.ts'), 'expect(replayed).toEqual([]);\n');
  await writeFile(join(root, 'test', 'reconnect.fixture.json'), '{"acknowledgedEventIds":["event-1"]}\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.planSlug = PLAN;
  await writeSubject('export const ackedEventsReplayed = false;\n');
  bound = await measureRepoFilesEvidenceAtRoot(root, MEASUREMENT);
  fixtureBound = await measureRepoFilesEvidenceAtRoot(root, FIXTURE_MEASUREMENT);
  // SPEC-PASS has a positive proof AND a counterexample; SPEC-BLOCKED has only the
  // positive proof, so falsifiability cannot be demonstrated and the clause is blocked.
  h.rows = [
    bindingRow({ id: 1, specId: 'SPEC-PASS', evidenceKind: 'coverage-census', evidenceRef: 'surface:pass', outcome: 'passed' }, bound),
    bindingRow(
      { id: 2, specId: 'SPEC-PASS', evidenceKind: 'counterexample', evidenceRef: 'counterexample:pass', outcome: 'pass', targeted: 'spec-pass' },
      bound,
    ),
    bindingRow({ id: 3, specId: 'SPEC-BLOCKED', evidenceKind: 'coverage-census', evidenceRef: 'surface:blocked', outcome: 'passed' }, bound),
    // Current falsifiability requires a successful test binding to the same immutable clause
    // revision and canonical test file as its counterexample.
    bindingRow({ id: 4, specId: 'SPEC-PASS', evidenceKind: 'test', evidenceRef: 'test:pass', outcome: 'passed' }, bound),
    // `fixtureCalibrated` only counts when fixture-scoped evidence is bound to this clause.
    bindingRow({ id: 5, specId: 'SPEC-PASS', evidenceKind: 'fixture', evidenceRef: 'fixture:pass', outcome: 'passed' }, bound),
  ];
  listClauses.mockImplementation(async (input: { specIds?: string[] }) => {
    const all = [clause('SPEC-PASS'), clause('SPEC-BLOCKED')] as Array<{ specId: string }>;
    return (input.specIds ? all.filter((c) => input.specIds!.includes(c.specId)) : all) as never;
  });

  const bundled = resolveLocalRubric('spec-test-adequacy');
  if (!bundled) throw new Error('rubrics/spec-test-adequacy/rubric.json must resolve');
  getRubric.mockResolvedValue({
    rubricId: 'spec-test-adequacy',
    revision: 7,
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
  getRubricEvidenceIdentity.mockResolvedValue({ revision: 7, criteriaHash: null, meaningRevision: null });
  readRubricPlanRevision.mockResolvedValue({ ok: true, revision: 7 });
  listScorecards.mockResolvedValue([]);
  let seq = 0;
  captureImprovement.mockImplementation(async () => ({ ok: true, created: true, issue: { id: `EI-CERT-${++seq}` } }));
});

describe('plans:certify-spec-clauses', () => {
  it('does not certify calibrated fixture claims without a measured fixture fingerprint', async () => {
    h.rows = h.rows.map((row) => row.evidence_kind === 'fixture' ? { ...row, fixture_fingerprint: null } : row);
    const result = await certify({ specIds: ['SPEC-PASS'] });
    expect(result.counts).toMatchObject({ passing: 0, filed: 0 });
    expect(result.clauses![0]!.wouldBlock).toContain('freshness');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('certifies an exact ad-hoc bug clause through the real evaluator and replay without a namespace acceptance class', async () => {
    h.planSlug = 'adhoc-work-item-specs';
    h.rows = h.rows.filter((row) => row.spec_id === 'SPEC-PASS').map((row) => ({ ...row, plan_slug: h.planSlug }));
    const result = await certify({
      slug: h.planSlug, classRef: 'plan-class-bugfix', workItemIds: ['WI-101'], specIds: ['SPEC-PASS'],
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true, counts: { clauses: 1, passing: 1, filed: 1, refused: 0 },
    });
    const observation = asStructuredObservation((captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } }).payloadExtra.observation)!;
    expect(observation.rerunRecipe?.args).toMatchObject({
      slug: h.planSlug, classRef: 'plan-class-bugfix', workItemIds: ['WI-101'], specIds: ['SPEC-PASS'],
    });
    const replay = await replayViaEvaluator(observation.rerunRecipe!.args!);
    expect(replay).toMatchObject({ ok: true, classRefSource: 'work-item-completion-attestation', count: 1 });
  });

  it.each([true, null])('does not file a passing card from run cleanliness=%s', async (dirty) => {
    h.rows = h.rows.map((row) => ({ ...row, test_run_worktree_dirty: dirty }));
    const result = await certify({ specIds: ['SPEC-PASS'] });
    expect(result.counts).toMatchObject({ passing: 0, filed: 0 });
    expect(result.clauses![0]!.wouldBlock).toContain('freshness');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('files a terminal card for each passing clause, through the exact replay, and never files a blocked one', async () => {
    const result = await certify({ specIds: ['SPEC-PASS', 'SPEC-BLOCKED'] });

    expect(result.ok).toBe(true);
    expect(result.counts, JSON.stringify(result.clauses)).toEqual({ clauses: 2, passing: 1, filed: 1, unchanged: 0, refused: 0, notPassing: 1 });
    const bySpec = Object.fromEntries((result.clauses ?? []).map((c) => [c.specId, c]));
    expect(bySpec['SPEC-PASS']).toMatchObject({ verdict: 'pass', wouldBlock: [], card: { status: 'filed', issueId: 'EI-CERT-1' } });
    expect(bySpec['SPEC-BLOCKED']!.card).toEqual({ status: 'not-passing' });
    expect(bySpec['SPEC-BLOCKED']!.wouldBlock).toContain('falsifiability');

    // Exactly one card filed, and it crossed emit's exact-replay gate: the replay ran the
    // evaluator with the filed card's own recipe (a pinned, replaySnapshot replay).
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool.mock.calls[0]![1]).toMatchObject({ specIds: ['SPEC-PASS'], replaySnapshot: true });
  });

  it('keeps a draft clause in the exact replay when includeDraft:true was used for grading', async () => {
    const specId = 'SPEC-DRAFT';
    h.rows = [
      ...h.rows,
      bindingRow({ id: 6, specId, evidenceKind: 'coverage-census', evidenceRef: 'surface:draft', outcome: 'passed' }, bound),
      bindingRow(
        { id: 7, specId, evidenceKind: 'counterexample', evidenceRef: 'counterexample:draft', outcome: 'pass', targeted: specId.toLowerCase() },
        bound,
      ),
      bindingRow({ id: 8, specId, evidenceKind: 'test', evidenceRef: 'test:draft', outcome: 'passed' }, bound),
      bindingRow({ id: 9, specId, evidenceKind: 'fixture', evidenceRef: 'fixture:draft', outcome: 'passed' }, bound),
    ];
    listClauses.mockImplementation(async (input: { specIds?: string[] }) => {
      const all = [clause(specId, 'draft')] as Array<{ specId: string }>;
      return (input.specIds ? all.filter((c) => input.specIds!.includes(c.specId)) : all) as never;
    });

    const preview = await certify({ specIds: [specId], includeDraft: true, dryRun: true });
    expect(preview).toMatchObject({ ok: true, dryRun: true, clauses: [{ card: { status: 'would-file' } }] });
    expect(dispatchTool).not.toHaveBeenCalled();

    const result = await certify({ specIds: [specId], includeDraft: true });

    expect(result).toMatchObject({ ok: true, counts: { passing: 1, filed: 1, refused: 0 } });
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool.mock.calls[0]![1]).toMatchObject({ specIds: [specId], includeDraft: true, replaySnapshot: true });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('EI-24340389297788793: the refusal remedy is accepted and reaches scorecards:emit', async () => {
    const first = await certify({ specIds: ['SPEC-PASS'] });
    expect(first.counts).toMatchObject({ filed: 1 });
    const persisted = (captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } })
      .payloadExtra.observation;
    const prior = asStructuredObservation(persisted);
    expect(prior).toBeTruthy();
    listScorecards.mockResolvedValue([{
      issueId: 'EI-PRIOR-INDEPENDENT',
      rubricRef: 'spec-test-adequacy',
      rubricRevision: 7,
      subject: { kind: 'plan', ref: specTestAdequacySubjectRef(PLAN, 'SPEC-PASS', 1) },
      createdBy: 'su-peer',
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      synthesized: false,
    }]);

    const refused = await certify({ specIds: ['SPEC-PASS'] });
    expect(refused).toMatchObject({
      ok: false,
      clauses: [{ card: { status: 'refused', code: 'existing_independent_scorecards' } }],
    });

    const acknowledged = await certify({ specIds: ['SPEC-PASS'], acknowledgeExisting: true });
    expect(acknowledged).toMatchObject({ ok: true, counts: { filed: 1, refused: 0 } });
    expect(captureImprovement).toHaveBeenCalledTimes(2);
  });

  // Clause RSR-P-005-A: "A card emitted by the evaluate-and-emit verb passes the auditor
  // replay unchanged." Falsifier: the auditor rejects or alters a card the evaluator
  // emitted from the same snapshot. So: take the observation emit ACTUALLY PERSISTED for
  // the card this verb filed, and run the grading-integrity auditor's own replay on it.
  // 'grading_audit_replay_consistent' is the auditor's verdict that the exact replay
  // reproduced every applicable rating with no wouldBlock contradiction.
  describe('auditor replay on a card the verb filed (RSR-P-005-A)', () => {
    // Historical audit reconstructs the card at emission; it never reads today's code
    // as though it were the recorded snapshot.
    const historicalContext = { gradedCardCreatedAt: '2026-09-20T22:00:00.000Z', workspaceId: 'workspace-test' };
    const auditClaim = {
      're-runnable-evidence': { rating: 'pass', evidence: 'replayed the stored recipe' },
      'degenerate-distribution': { rating: 'fail', evidence: 'claimed contradiction to corroborate' },
    };

    const filedObservation = async () => {
      const result = await certify({ specIds: ['SPEC-PASS'] });
      expect(result.counts).toMatchObject({ filed: 1 });
      expect(captureImprovement).toHaveBeenCalledTimes(1);
      const persisted = (captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } })
        .payloadExtra.observation;
      const observation = asStructuredObservation(persisted);
      // Calibration: the persisted card is a spec-test-adequacy card with its recipe, or
      // the auditor below would short-circuit and its verdict would mean nothing.
      expect(observation).toMatchObject({ rubricRef: 'spec-test-adequacy' });
      expect(observation?.rerunRecipe).toBeTruthy();
      return observation!;
    };

    it('reproduces every rating unchanged', async () => {
      const observation = await filedObservation();

      const verdict = await validateGradingAuditReplayConsistency(observation, auditClaim as never, dispatchTool, historicalContext);

      expect(verdict).toMatchObject({ code: 'grading_audit_replay_consistent' });
    });

    it('preserves the historical verdict after code moves while current certification refuses it', async () => {
      const observation = await filedObservation();
      await writeSubject('export const ackedEventsReplayed = true;\n');

      const verdict = await validateGradingAuditReplayConsistency(observation, auditClaim as never, dispatchTool, historicalContext);

      expect(verdict).toMatchObject({ code: 'grading_audit_replay_consistent' });
      const current = await certify({ specIds: ['SPEC-PASS'] });
      expect(current.counts).toMatchObject({ passing: 0, filed: 0 });
      expect(current.clauses![0]!.wouldBlock).toContain('freshness');
      expect(captureImprovement).toHaveBeenCalledTimes(1);
    });

    it('finds an altered recorded rating through the exact historical replay (falsifier)', async () => {
      const observation = await filedObservation();
      const altered = {
        ...observation,
        ratings: { ...observation.ratings, freshness: { rating: 'fail', evidence: 'Altered recorded rating.' } },
      };
      const verdict = await validateGradingAuditReplayConsistency(altered, auditClaim as never, dispatchTool, historicalContext);

      // undefined = the auditor found a mismatch, so its claimed contradiction stands.
      expect(verdict).toBeUndefined();
    });
  });

  it('dryRun grades and reports without filing or replaying anything', async () => {
    const result = await certify({ specIds: ['SPEC-PASS', 'SPEC-BLOCKED'], dryRun: true });

    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(result.counts).toMatchObject({ passing: 1, filed: 0, notPassing: 1 });
    expect(result.clauses?.find((c) => c.specId === 'SPEC-PASS')?.card).toEqual({ status: 'would-file' });
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('dryRun reports a pending grading-audit refusal for an existing clause card', async () => {
    const subjectRef = specTestAdequacySubjectRef(PLAN, 'SPEC-PASS', 1);
    listScorecards.mockResolvedValueOnce([{
      issueId: 'EI-existing-pending',
      createdBy: 'su-prior-grader',
      subject: { kind: 'plan', ref: subjectRef },
      gradingAudit: { state: 'pending' },
      supersededBy: null,
    }] as never);

    const result = await certify({ specIds: ['SPEC-PASS'], dryRun: true });

    expect(result).toMatchObject({
      ok: false,
      dryRun: true,
      counts: { clauses: 1, passing: 1, filed: 0, unchanged: 0, refused: 1, notPassing: 0 },
      clauses: [{
        specId: 'SPEC-PASS',
        card: { status: 'refused', code: 'grading_audit_required' },
      }],
    });
    expect(result.clauses?.[0]?.card.error).toContain('pending grading audit');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('dryRun reports unchanged when the same evaluator evidence is already filed', async () => {
    const filed = await certify({ specIds: ['SPEC-PASS'] });
    expect(filed.clauses?.[0]?.card.status).toBe('filed');
    const raw = (captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } })
      .payloadExtra.observation;
    const observation = asStructuredObservation(raw);
    const subjectRef = specTestAdequacySubjectRef(PLAN, 'SPEC-PASS', 1);
    expect(observation?.evidenceFingerprint).toBeTruthy();
    listScorecards.mockResolvedValue([{
      issueId: 'EI-existing-same-evidence',
      createdBy: 'su-certifier',
      sourceHive: 'papercusp',
      subject: { kind: 'plan', ref: subjectRef },
      rubricRef: 'spec-test-adequacy',
      rubricRevision: 7,
      criteriaHash: null,
      rubricMeaningRevision: null,
      evidenceFingerprint: observation!.evidenceFingerprint,
      rubricResolved: true,
      missingKeys: [],
      extraKeys: [],
      synthesized: false,
    }] as never);

    const preview = await certify({ specIds: ['SPEC-PASS'], dryRun: true });

    expect(preview).toMatchObject({
      ok: true,
      dryRun: true,
      counts: { filed: 0, unchanged: 1, refused: 0 },
      clauses: [{ card: { status: 'unchanged', issueId: 'EI-existing-same-evidence' } }],
    });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
  });

  it('attributes an emit refusal to its clause and reports ok:false when the replay no longer reproduces the pass', async () => {
    // The proven source moves between grading and the gate's replay.
    dispatchTool.mockImplementationOnce(async (_name: string, args: Record<string, unknown>) => {
      await writeSubject('export const ackedEventsReplayed = true;\n');
      return replayViaEvaluator(args);
    });

    const result = await certify({ specIds: ['SPEC-PASS'] });

    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({ passing: 1, filed: 0, refused: 1 });
    expect(result.clauses?.[0]).toMatchObject({
      specId: 'SPEC-PASS',
      card: { status: 'refused', code: 'invalid_spec_test_adequacy_binding' },
    });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('passes an evaluator refusal through unchanged instead of reporting a vacuous success', async () => {
    listClauses.mockResolvedValue([clause('SPEC-PASS', 'draft')]);

    const result = await certify({ specIds: ['SPEC-PASS'] });

    expect(result).toMatchObject({ ok: false, evaluator: { ok: false, error: 'selection_empty' } });
    expect(result).not.toHaveProperty('counts');
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});
