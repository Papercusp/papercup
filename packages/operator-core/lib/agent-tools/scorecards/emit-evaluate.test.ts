/**
 * emit-evaluate.test.ts — scorecards:emit / scorecards:evaluate (P-002 of
 * rubric-system-and-auto-loop-release-profile-2026-07-15): the typed tool-layer
 * contract over the observation ledger had NO direct test coverage (scorecards.ts's
 * own scorecards.test.ts/.integration.test.ts cover the storage layer, not this
 * validation+dedup+instrument-contract facade) — this is the P-009 gap-fill for
 * "scorecard deduplication" + "composite verdict propagation" at the tool boundary.
 *
 * DB/system boundaries (getRubric, listScorecards, captureImprovement,
 * readRunningGeneration) are mocked; the REAL scorecardEvidenceFingerprint /
 * evaluateScorecardInstrumentContract / normalizeScorecardRatings /
 * validate* functions run unmocked so the dedup fingerprint + instrument-contract
 * logic is exercised for real, not just its call shape.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/scorecards/emit-evaluate.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dispatchProjectedTool,
  lookupByMcpName,
  readJsonResult,
} from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_HARD_CEILING_CHARS, PAYLOAD_TIER_RATCHET_CHARS } from '@papercusp/tooldef';
import type { Rubric } from '../../rubrics';
import { scorecardEvidenceFingerprint, type ScorecardRow } from '../../scorecards';
import { areAcceptanceLineageRelated, isAcceptanceAuthorIdentity } from '../../acceptance-author-identity';

vi.mock('../../rubrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...actual,
    getRubric: vi.fn(),
    getRubricPlanRevision: vi.fn(async () => 7),
    readRubricPlanRevision: vi.fn(async () => ({ ok: true as const, revision: 7 })),
  };
});
vi.mock('../../scout/generation-watermark', () => ({ readRunningGeneration: vi.fn(async () => null) }));
vi.mock('../../harness/improvements/capture-core', () => ({ captureImprovement: vi.fn() }));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...actual, getIssue: vi.fn() };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return { ...actual, listScorecards: vi.fn(async () => [] as ScorecardRow[]) };
});
vi.mock('../../acceptance-author-identity', () => ({
  isAcceptanceAuthorIdentity: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  areAcceptanceLineageRelated: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
}));

import { getRubric, getRubricPlanRevision, readRubricPlanRevision } from '../../rubrics';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { getIssue } from '../../issues-engineer';
import { listScorecards } from '../../scorecards';
import { emitScorecard, scorecardEmitArgs } from './emit';
import { evaluateScorecard } from './evaluate';
import { collapseCriticsToSoleParty } from './grader-eligibility';

const getRubricM = vi.mocked(getRubric);
const getRubricPlanRevisionM = vi.mocked(getRubricPlanRevision);
const readRubricPlanRevisionM = vi.mocked(readRubricPlanRevision);
const captureM = vi.mocked(captureImprovement);
const listM = vi.mocked(listScorecards);
const getIssueM = vi.mocked(getIssue);
const sameAuthorM = vi.mocked(isAcceptanceAuthorIdentity);
const lineageRelatedM = vi.mocked(areAcceptanceLineageRelated);

const RUBRIC: Rubric = {
  rubricId: 'test-rubric',
  workspaceId: 'ws',
  characteristic: 'test',
  title: 'Test Rubric',
  description: 'd',
  criteria: [
    { key: 'crit-a', title: 'Criterion A', model: 'm', method: 'm', driftMarkers: 'd' },
    { key: 'crit-b', title: 'Criterion B', model: 'm', method: 'm', driftMarkers: 'd' },
  ],
  ratingScale: ['pass', 'partial', 'fail'],
  methodRef: null,
  status: 'active',
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
} as unknown as Rubric;

const ACCEPTANCE_RUBRIC: Rubric = {
  ...RUBRIC,
  rubricId: 'acceptance-rubric',
  kind: 'acceptance',
  proposedBy: 'su-implementer',
  createdBy: 'su-implementer',
} as Rubric;

const RATINGS = {
  'crit-a': { rating: 'pass', evidence: 'observed A working' },
  'crit-b': { rating: 'pass', evidence: 'observed B working' },
};

const RERUN_RECIPE = {
  schemaVersion: 1 as const,
  evaluator: 'plans:evaluate-spec-test-adequacy' as const,
  selection: {
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    specRevision: 1,
    specFingerprint: 'sha256:spec-v1',
    evidence: [{ evidenceKind: 'integration fixture', evidenceRef: 'surface:reconnect' }],
  },
  current: {
    supplied: true,
    fingerprints: [
      {
        evidenceKind: 'integration fixture',
        evidenceRef: 'surface:reconnect',
        sourceFingerprint: 'git:abc',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: 'sha256:fixture',
        rubricFingerprint: 'sha256:rubric',
        environmentFingerprint: 'node:24',
      },
    ],
  },
  derivation: {
    kind: 'listSpecEvidence.currentness' as const,
    classifier: 'classifySpecEvidenceCurrentness' as const,
    unknownWhenMissing: true as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  sameAuthorM.mockImplementation(async (author, candidate) => author === candidate);
  lineageRelatedM.mockImplementation(async (author, candidate) => author === candidate);
  getRubricM.mockResolvedValue(RUBRIC);
  getRubricPlanRevisionM.mockResolvedValue(7);
  readRubricPlanRevisionM.mockResolvedValue({ ok: true, revision: 7 });
  listM.mockResolvedValue([]);
  captureM.mockResolvedValue({ created: true, issue: { id: 'ISS-1' } } as never);
  getIssueM.mockResolvedValue(null);
});

describe('emitScorecard', () => {
  it('rubric not found → ok:false, never reaches captureImprovement', async () => {
    getRubricM.mockResolvedValue(null);
    const r = await emitScorecard({ rubricRef: 'nope', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("'nope' not found") });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses a retired acceptance rubric before any revision read, deduplication, or ledger write', async () => {
    getRubricM.mockResolvedValue({ ...ACCEPTANCE_RUBRIC, status: 'retired' } as Rubric);

    const r = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-grader' },
    );

    expect(r).toMatchObject({
      ok: false,
      code: 'retired_acceptance_rubric',
      error: expect.stringContaining('terminal subject plan'),
    });
    expect(getRubricPlanRevisionM).not.toHaveBeenCalled();
    expect(listM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('empty ratings → ok:false with missing criteria, never files an incomplete card', async () => {
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: {} }, { createdBy: 'su-1' });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining('missing required criterion key(s): crit-a, crit-b'),
    });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('incomplete ratings (missing a required criterion) → ok:false, never files', async () => {
    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: { 'crit-a': RATINGS['crit-a'] } },
      { createdBy: 'su-1' },
    );
    expect(r.ok).toBe(false);
    expect(captureM).not.toHaveBeenCalled();
  });

  it('files a fresh complete scorecard when no prior scorecard exists', async () => {
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: true, issueId: 'ISS-1' });
    expect((r as { evidenceFingerprint?: string }).evidenceFingerprint).toEqual(expect.any(String));
    expect(captureM).toHaveBeenCalledTimes(1);
    expect(captureM.mock.calls[0][0]).toMatchObject({
      kind: 'change',
      lane: 'observation',
      createdBy: 'su-1',
      payloadExtra: { observation: { rubricRef: 'test-rubric' } },
    });
  });

  it('stamps the graded rubric revision server-side and passes the rubric ref to the revision reader', async () => {
    getRubricPlanRevisionM.mockResolvedValue(11);
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(getRubricPlanRevisionM).toHaveBeenCalledWith('test-rubric');
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'test-rubric', rubricRevision: 11 } },
    });
  });

  it('accepts, persists, and fingerprints the spec-test-adequacy rerun recipe', async () => {
    const parsed = scorecardEmitArgs.safeParse({
      rubricRef: 'test-rubric',
      ratings: RATINGS,
      rerunRecipe: RERUN_RECIPE,
    });
    expect(parsed.success).toBe(true);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, rerunRecipe: RERUN_RECIPE },
      { createdBy: 'su-1' },
    );
    const expectedFingerprint = scorecardEvidenceFingerprint({
      rubricRef: 'test-rubric',
      ratings: RATINGS,
      rerunRecipe: RERUN_RECIPE,
    });
    expect(r).toMatchObject({ ok: true, created: true, evidenceFingerprint: expectedFingerprint });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'test-rubric', rerunRecipe: RERUN_RECIPE } },
    });
  });

  it('refuses a spec-test-adequacy card without the evaluator rerun recipe', async () => {
    getRubricM.mockResolvedValue({ ...RUBRIC, rubricId: 'spec-test-adequacy' } as Rubric);

    const r = await emitScorecard(
      {
        rubricRef: 'spec-test-adequacy',
        ratings: RATINGS,
        subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
      },
      { createdBy: 'su-1' },
    );

    expect(r).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining('rerunRecipe'),
    });
    expect(getRubricPlanRevisionM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-plan subject kind', { kind: 'work-item', ref: 'WI-101' }],
    ['a subject ref that differs from the evaluator selection', { kind: 'plan', ref: 'reconnect-plan#SPEC-003-02@1' }],
  ] as const)('refuses spec-test-adequacy with %s', async (_label, subject) => {
    getRubricM.mockResolvedValue({ ...RUBRIC, rubricId: 'spec-test-adequacy' } as Rubric);

    const r = await emitScorecard(
      {
        rubricRef: 'spec-test-adequacy',
        ratings: RATINGS,
        rerunRecipe: RERUN_RECIPE,
        subject,
      },
      { createdBy: 'su-1' },
    );

    expect(r).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining("kind:'plan'"),
    });
    expect(getRubricPlanRevisionM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('accepts and persists the evaluator-owned plan subject for spec-test-adequacy', async () => {
    getRubricM.mockResolvedValue({ ...RUBRIC, rubricId: 'spec-test-adequacy' } as Rubric);

    const r = await emitScorecard(
      {
        rubricRef: 'spec-test-adequacy',
        ratings: RATINGS,
        rerunRecipe: RERUN_RECIPE,
        subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
      },
      { createdBy: 'su-1' },
    );

    expect(r).toMatchObject({ ok: true, created: true, issueId: 'ISS-1' });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: {
        observation: {
          rubricRef: 'spec-test-adequacy',
          subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
          rerunRecipe: RERUN_RECIPE,
        },
      },
    });
  });

  it('uses a persisted rerun recipe in the latest-hash fallback for legacy rows without a stored fingerprint', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'ISS-RECIPE',
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        rerunRecipe: RERUN_RECIPE,
        rubricRevision: 7,
        missingKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, rerunRecipe: RERUN_RECIPE },
      { createdBy: 'su-1' },
    );
    expect(r).toMatchObject({ ok: true, created: false, reason: 'unchanged-evidence', previousIssueId: 'ISS-RECIPE' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('files the scorecard ALREADY-TERMINAL (initialState done) — a verdict, not pending work (D-002, observation-lane-scorecard-classification-2026-08-16)', async () => {
    await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(captureM).toHaveBeenCalledTimes(1);
    // The load-bearing byte: without initialState the row files state 'open' and
    // renders forever as an untriaged observation — the exact misread that opened
    // the 01a0031d investigation ("EI-… remains open only as evidence").
    expect(captureM.mock.calls[0][0]).toMatchObject({ initialState: 'done' });
  });

  it('DEDUPLICATION: identical evidence to the latest scorecard is declined (unchanged-evidence), never re-files', async () => {
    const firstFingerprint = (await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS },
      { createdBy: 'su-1' },
    )) as { evidenceFingerprint: string };
    captureM.mockClear();
    listM.mockResolvedValue([
      {
        issueId: 'ISS-1',
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        missingKeys: [],
        rubricResolved: true,
        rubricRevision: 7,
        evidenceFingerprint: firstFingerprint.evidenceFingerprint,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: false, reason: 'unchanged-evidence', previousIssueId: 'ISS-1' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses another complete independent card for the same rubric revision and returns every existing id', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'EI-INDEPENDENT-1',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
      {
        issueId: 'EI-INDEPENDENT-2',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-peer-2',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-grader' });

    expect(r).toMatchObject({
      ok: false,
      code: 'existing_independent_scorecards',
      existingIndependentScorecardIds: ['EI-INDEPENDENT-1', 'EI-INDEPENDENT-2'],
      acknowledgementRequired: 'acknowledgeExisting:true',
    });
    expect((r as { error: string }).error).toContain('revision 7');
    expect(captureM).not.toHaveBeenCalled();
  });

  it('explicit acknowledgement permits an intentional additional independent card', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'EI-INDEPENDENT',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard(
      {
        rubricRef: 'test-rubric',
        ratings: {
          ...RATINGS,
          'crit-a': { rating: 'pass', evidence: 'new independent observation' },
        },
        acknowledgeExisting: true,
      },
      { createdBy: 'su-grader' },
    );

    expect(r).toMatchObject({ ok: true, created: true, issueId: 'ISS-1' });
    expect(captureM).toHaveBeenCalledTimes(1);
  });

  it('force:true does not bypass the same-revision independent-card acknowledgement guard', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'EI-INDEPENDENT',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: { 'crit-a': { rating: 'fail', evidence: 'new evidence' }, 'crit-b': RATINGS['crit-b'] },
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 4,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, force: true },
      { createdBy: 'su-grader' },
    );

    expect(r).toMatchObject({ ok: false, code: 'existing_independent_scorecards' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('ignores stale, incomplete, synthesized, and same-grader cards when deciding whether acknowledgement is needed', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'EI-OLD-REVISION',
        rubricRef: 'test-rubric',
        rubricRevision: 6,
        ratings: RATINGS,
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
      {
        issueId: 'EI-INCOMPLETE',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-peer',
        missingKeys: ['crit-b'],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 5,
        linkedItems: [],
      } as unknown as ScorecardRow,
      {
        issueId: 'EI-SYNTHETIC',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: true,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
      {
        issueId: 'EI-SAME-GRADER',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-grader',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-grader' });

    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM).toHaveBeenCalledTimes(1);
  });

  it('types acknowledgement as a literal true', () => {
    expect(scorecardEmitArgs.safeParse({ rubricRef: 'test-rubric', ratings: RATINGS }).success).toBe(true);
    expect(
      scorecardEmitArgs.safeParse({ rubricRef: 'test-rubric', ratings: RATINGS, acknowledgeExisting: true }).success,
    ).toBe(true);
    expect(
      scorecardEmitArgs.safeParse({ rubricRef: 'test-rubric', ratings: RATINGS, acknowledgeExisting: false }).success,
    ).toBe(false);
  });

  it('CHANGED rubric revision vs the latest scorecard files a new card even when evidence is unchanged', async () => {
    const fingerprint = scorecardEvidenceFingerprint({ rubricRef: 'test-rubric', ratings: RATINGS });
    listM.mockResolvedValue([
      {
        issueId: 'ISS-OLD-REVISION',
        rubricRef: 'test-rubric',
        rubricRevision: 6,
        ratings: RATINGS,
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: fingerprint,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);
    getRubricPlanRevisionM.mockResolvedValue(7);

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM).toHaveBeenCalledTimes(1);
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'test-rubric', rubricRevision: 7 } },
    });
  });

  it('CHANGED evidence vs the latest scorecard files a new one even with a latest on record', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'ISS-OLD',
        rubricRef: 'test-rubric',
        ratings: { 'crit-a': { rating: 'fail', evidence: 'was broken' }, 'crit-b': RATINGS['crit-b'] },
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: 'stale-fingerprint-does-not-match',
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM).toHaveBeenCalledTimes(1);
  });

  it('force:true re-files even when evidence is unchanged', async () => {
    const first = (await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' })) as {
      evidenceFingerprint: string;
    };
    captureM.mockClear();
    listM.mockResolvedValue([
      {
        issueId: 'ISS-1',
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: first.evidenceFingerprint,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS, force: true }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM).toHaveBeenCalledTimes(1);
  });

  it('a corrected filing records supersedes and is not swallowed by unchanged-evidence dedup', async () => {
    const first = (await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' })) as {
      evidenceFingerprint: string;
    };
    captureM.mockClear();
    getIssueM.mockResolvedValue({
      payload: { observation: { rubricRef: 'test-rubric', ratings: RATINGS } },
    } as never);
    listM.mockResolvedValue([
      {
        issueId: 'ISS-OLD',
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: first.evidenceFingerprint,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, supersedes: 'ISS-OLD' },
      { createdBy: 'su-1' },
    );
    expect(r).toMatchObject({ ok: true, created: true, supersedes: 'ISS-OLD' });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'test-rubric', supersedes: 'ISS-OLD' } },
    });
  });

  it('inherits an omitted sourceHive from the superseded scorecard instead of the caller harness', async () => {
    getIssueM.mockResolvedValue({
      payload: {
        observation: {
          rubricRef: 'test-rubric',
          ratings: RATINGS,
          sourceHive: 'prior-hive',
        },
      },
    } as never);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, supersedes: 'ISS-PRIOR' },
      { createdBy: 'su-1', ctxHarness: 'caller-hive' },
    );

    expect(r).toMatchObject({ ok: true, created: true, supersedes: 'ISS-PRIOR' });
    expect(listM).toHaveBeenCalledWith({ rubricRef: 'test-rubric', sourceHive: 'prior-hive', limit: 1 });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: {
        observation: {
          rubricRef: 'test-rubric',
          sourceHive: 'prior-hive',
          supersedes: 'ISS-PRIOR',
        },
      },
    });
  });

  it('preserves a legacy empty sourceHive when a Hive-scoped caller supersedes the card', async () => {
    getIssueM.mockResolvedValue({
      payload: { observation: { rubricRef: 'test-rubric', ratings: RATINGS } },
    } as never);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, supersedes: 'ISS-LEGACY' },
      { createdBy: 'su-1', ctxHarness: 'papercusp' },
    );

    expect(r).toMatchObject({ ok: true, created: true, supersedes: 'ISS-LEGACY' });
    expect(listM).toHaveBeenCalledWith({ rubricRef: 'test-rubric', sourceHive: undefined, limit: 1 });
    expect(captureM.mock.calls[0][0].payloadExtra?.observation).not.toHaveProperty('sourceHive');
  });

  it('still refuses an explicit sourceHive that conflicts with the superseded scorecard', async () => {
    getIssueM.mockResolvedValue({
      payload: {
        observation: {
          rubricRef: 'test-rubric',
          ratings: RATINGS,
          sourceHive: 'prior-hive',
        },
      },
    } as never);

    const r = await emitScorecard(
      {
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        sourceHive: 'different-hive',
        supersedes: 'ISS-PRIOR',
      },
      { createdBy: 'su-1', ctxHarness: 'caller-hive' },
    );

    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("belongs to sourceHive 'prior-hive', not 'different-hive'"),
    });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses to supersede a scorecard from another rubric', async () => {
    getIssueM.mockResolvedValue({
      payload: { observation: { rubricRef: 'other-rubric', ratings: RATINGS } },
    } as never);
    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, supersedes: 'ISS-OTHER' },
      { createdBy: 'su-1' },
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("grades 'other-rubric'") });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('release-gating rubric with an invalid instrument contract refuses to file (never calls captureImprovement)', async () => {
    getRubricM.mockResolvedValue({
      ...RUBRIC,
      releaseGating: true,
      criteria: [{ ...RUBRIC.criteria[0], instrumentKey: 'some-live-instrument' }, RUBRIC.criteria[1]],
    } as Rubric);
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r.ok).toBe(false);
    expect((r as { instrumentContract?: unknown }).instrumentContract).toBeDefined();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses acceptance on a standard rubric', async () => {
    const r = await emitScorecard(
      {
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        acceptance: { verdict: 'accept', reasoning: 'The independent evidence satisfies this plan.' },
      },
      { createdBy: 'su-1' },
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("only for kind:'acceptance'") });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('an independent acceptance grader emits ratings without an implementer verdict', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    const r = await emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS }, { createdBy: 'su-grader' });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'acceptance-rubric', ratings: RATINGS } },
    });
    expect(captureM.mock.calls[0][0].payloadExtra?.observation).not.toHaveProperty('acceptance');
  });

  it('refuses an acceptance grader descended from the implementer even when its owner id differs', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    lineageRelatedM.mockImplementation(
      async (author, candidate) => author === candidate || (author === 'su-implementer' && candidate === 'su-child'),
    );
    const r = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-child' },
    );
    expect(r).toMatchObject({
      ok: false,
      code: 'grader_in_implementer_lineage',
      error: expect.stringContaining('spawn/rebind lineage'),
    });
    expect((r as { error?: string }).error).toContain('existing unrelated live session');
    expect((r as { error?: string }).error).toContain('unassigned grading work-item');
    expect((r as { error?: string }).error).toContain('never launch a grader from this lineage');
    expect((r as { error?: string }).error).not.toContain('launch or assign a lineage-independent grader');
    expect(captureM).not.toHaveBeenCalled();
  });

  it('P-005: the lineage guard is judged PER EMITTER — grader 1 passing does not carry grader 2', async () => {
    // Grading is a min-1/max-2 cascade since D-003, so the same rubric is graded
    // by two different parties in sequence. This pins that the verdict keys on
    // `createdBy` and nothing else: a clean first card must not license a second
    // grader who is in the implementer's lineage, and the refusal of one must not
    // taint the other. Head-only enforcement would pass every other test here.
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    lineageRelatedM.mockImplementation(
      async (author, candidate) => author === candidate || (author === 'su-implementer' && candidate === 'su-grader-2'),
    );

    const first = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-grader-1' },
    );
    expect(first).toMatchObject({ ok: true, created: true });

    const second = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-grader-2' },
    );
    expect(second).toMatchObject({ ok: false, code: 'grader_in_implementer_lineage' });

    // …and the order does not matter: the refused grader is refused first too.
    const secondFirst = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-grader-2' },
    );
    expect(secondFirst).toMatchObject({ ok: false, code: 'grader_in_implementer_lineage' });
    const cleanAfterRefusal = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-grader-1' },
    );
    expect(cleanAfterRefusal).toMatchObject({ ok: true, created: true });
  });

  it('fails closed when an acceptance grader cannot read the current rubric revision', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    readRubricPlanRevisionM.mockResolvedValue({ ok: false, revision: null });

    await expect(
      emitScorecard(
        { rubricRef: 'acceptance-rubric', ratings: RATINGS },
        { createdBy: 'su-grader' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'grader_is_sole_vetting_critic_revision_unreadable',
      error: expect.stringContaining('current revision could not be read'),
    });
    expect(readRubricPlanRevisionM).toHaveBeenCalledWith('acceptance-rubric');
    expect(listM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses an independent grade from the acceptance rubric sole vetting critic', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([
      {
        issueId: 'EI-vetting',
        createdAt: '2026-08-25T21:00:12Z',
        createdBy: 'su-vetting-author',
        rubricRef: 'meta-acceptance-rubric',
        subject: { kind: 'rubric', ref: 'acceptance-rubric' },
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 7,
          critiquePosts: 1,
          critics: ['su-critic'],
        },
      } as unknown as ScorecardRow,
    ]);

    await expect(
      emitScorecard(
        { rubricRef: 'acceptance-rubric', ratings: RATINGS },
        { createdBy: 'su-critic' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'grader_is_sole_vetting_critic',
      error: expect.stringContaining('sole recorded vetting critic'),
    });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses a grade when every one of several vetting critics resolves to the grader', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    // WI-905074 regression. Both recorded critics are the SAME party as the grader
    // (an alias/rebind of one identity). The old guard tested `critics.length === 1`,
    // so a second row made the identity comparison unreachable and this bypassed the
    // refusal entirely — no independent party ever challenged the rubric.
    lineageRelatedM.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-critic-rebound' && candidate === 'su-critic'),
    );
    listM.mockResolvedValue([
      {
        issueId: 'EI-vetting',
        createdAt: '2026-08-25T21:00:12Z',
        createdBy: 'su-vetting-author',
        rubricRef: 'meta-acceptance-rubric',
        subject: { kind: 'rubric', ref: 'acceptance-rubric' },
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 7,
          critiquePosts: 2,
          critics: ['su-critic', 'su-critic-rebound'],
        },
      } as unknown as ScorecardRow,
    ]);

    await expect(
      emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS }, { createdBy: 'su-critic' }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'grader_is_sole_vetting_critic',
      error: expect.stringContaining('only distinct party among the 2'),
    });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('allows one of several vetting critics to grade because another critic preserves independent challenge', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([
      {
        issueId: 'EI-vetting',
        createdAt: '2026-08-25T21:00:12Z',
        createdBy: 'su-vetting-author',
        rubricRef: 'meta-acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 7,
          critiquePosts: 2,
          critics: ['su-critic', 'su-other-critic'],
        },
      } as unknown as ScorecardRow,
    ]);

    await expect(
      emitScorecard(
        { rubricRef: 'acceptance-rubric', ratings: RATINGS },
        { createdBy: 'su-critic' },
      ),
    ).resolves.toMatchObject({ ok: true, created: true });
  });

  it('refuses a verdict from the independent grader', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    const r = await emitScorecard(
      {
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        acceptance: { verdict: 'accept', reasoning: 'I am not the rubric author.' },
      },
      { createdBy: 'su-grader' },
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('must be recorded by') });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('requires the implementer verdict and a prior complete independent grading', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    const missing = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-implementer' },
    );
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('must record acceptance') });

    const tooEarly = await emitScorecard(
      {
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        acceptance: { verdict: 'accept', reasoning: 'No independent card exists yet.' },
      },
      { createdBy: 'su-implementer' },
    );
    expect(tooEarly).toMatchObject({ ok: false, error: expect.stringContaining('must follow') });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('stores an implementer verdict after independent grading and includes it in evidence identity', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([
      {
        issueId: 'EI-independent',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);
    const acceptance = { verdict: 'accept' as const, reasoning: 'The independent evidence meets this plan.' };
    const r = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS, acceptance },
      { createdBy: 'su-implementer' },
    );
    expect(r).toMatchObject({ ok: true, created: true, acceptance });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'acceptance-rubric', acceptance } },
    });
    expect((r as { evidenceFingerprint: string }).evidenceFingerprint).not.toBe(
      scorecardEvidenceFingerprint({ rubricRef: 'acceptance-rubric', ratings: RATINGS }),
    );
  });

  it('rejects an acceptance-author verdict that supersedes the independent grading', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([
      {
        issueId: 'EI-independent',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);

    const r = await emitScorecard(
      {
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        acceptance: { verdict: 'accept', reasoning: 'The independent evidence meets this plan.' },
        supersedes: 'EI-independent',
      },
      { createdBy: 'su-implementer' },
    );

    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining('must not use supersedes'),
    });
    expect(captureM).not.toHaveBeenCalled();
    expect(getIssueM).not.toHaveBeenCalled();
  });

  it('lets an audited successor record the author verdict and never treats that successor as an independent grader', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    sameAuthorM.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-implementer' && candidate === 'su-successor'),
    );
    lineageRelatedM.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-implementer' && candidate === 'su-successor'),
    );
    listM.mockResolvedValue([
      {
        issueId: 'EI-independent',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);
    const acceptance = { verdict: 'accept' as const, reasoning: 'The independent evidence meets this plan.' };
    await expect(
      emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS, acceptance }, { createdBy: 'su-successor' }),
    ).resolves.toMatchObject({ ok: true, created: true, acceptance });

    listM.mockResolvedValue([
      {
        issueId: 'EI-successor-self-grade',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-successor',
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);
    await expect(
      emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS, acceptance }, { createdBy: 'su-successor' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('must follow') });
  });
});

describe('evaluateScorecard', () => {
  it('no ratings → returns the read-only grading skeleton (never validates/dedupes)', async () => {
    const r = await evaluateScorecard({ rubricRef: 'test-rubric' });
    expect(r).toMatchObject({ ok: true, skeleton: [{ key: 'crit-a' }, { key: 'crit-b' }], latest: null });
    expect(listM).toHaveBeenCalledWith({ rubricRef: 'test-rubric', sourceHive: undefined, limit: 1 });
  });

  it('rubric not found → ok:false', async () => {
    getRubricM.mockResolvedValue(null);
    const r = await evaluateScorecard({ rubricRef: 'nope' });
    expect(r).toMatchObject({ ok: false });
  });

  it('with ratings + no latest scorecard: changed:true and every criterion listed as changed', async () => {
    const r = await evaluateScorecard({ rubricRef: 'test-rubric', ratings: RATINGS });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect((r as { delta: { changedCriteria: string[] } }).delta.changedCriteria.sort()).toEqual(['crit-a', 'crit-b']);
  });

  it('keeps every skeleton + canonical-rating row through an ambient trimmed dispatch', async () => {
    const criteria = Array.from({ length: 26 }, (_, i) => ({
      key: `criterion-${i + 1}`,
      title: `Criterion ${i + 1} ${'t'.repeat(120)}`,
      model: 'm',
      method: 'm',
      driftMarkers: 'd',
    }));
    const rubric = { ...RUBRIC, criteria } as Rubric;
    const ratings = Object.fromEntries(
      criteria.map((criterion) => [
        criterion.key,
        { rating: 'pass', evidence: `verified ${criterion.key} ${'e'.repeat(180)}` },
      ]),
    );
    getRubricM.mockResolvedValue(rubric);

    // Non-vacuity: this is large enough to trigger the generic trimmed fallback
    // that caused the live 26 → 12+marker / 6 split, but still below the separate
    // hard ceiling. The declaration under test must therefore be the reason the
    // payload remains complete.
    const raw = await evaluateScorecard({ rubricRef: rubric.rubricId, ratings });
    const rawChars = JSON.stringify(raw).length;
    expect(rawChars).toBeGreaterThan(PAYLOAD_TIER_RATCHET_CHARS);
    expect(rawChars).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);

    const projected = lookupByMcpName('scorecards:evaluate');
    expect(projected).toBeDefined();
    expect(projected?.ignoreSessionPayloadTier).toBe(true);
    const dispatched = await dispatchProjectedTool(
      projected!,
      'scorecards:evaluate',
      { rubricRef: rubric.rubricId, ratings },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'scorecards-evaluate-completeness-test',
        isSuperuser: true,
        uiClientId: 'su-scorecards-evaluate-test',
        role: 'su',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        contextTier: 'trimmed',
        tx: {},
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{
      rubric: { criteriaCount: number };
      skeleton: unknown[];
      canonicalRatings: Record<string, unknown>;
      _projection?: unknown;
    }>(dispatched.result!);
    expect(payload?._projection).toBeUndefined();
    expect(payload?.rubric.criteriaCount).toBe(26);
    expect(payload?.skeleton).toHaveLength(26);
    expect(Object.keys(payload?.canonicalRatings ?? {})).toHaveLength(26);
  });

  it('with ratings identical to the latest scorecard: changed:false and an empty changedCriteria delta', async () => {
    const evalR = (await evaluateScorecard({ rubricRef: 'test-rubric', ratings: RATINGS })) as {
      evidenceFingerprint: string;
    };
    listM.mockResolvedValue([
      {
        issueId: 'ISS-1',
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: evalR.evidenceFingerprint,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);
    const r2 = await evaluateScorecard({ rubricRef: 'test-rubric', ratings: RATINGS });
    expect(r2).toMatchObject({ ok: true, changed: false });
    expect((r2 as { delta: { changedCriteria: string[] } }).delta.changedCriteria).toEqual([]);
  });

  it('a SINGLE criterion change vs the latest is reflected precisely in changedCriteria', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'ISS-1',
        rubricRef: 'test-rubric',
        ratings: { 'crit-a': RATINGS['crit-a'], 'crit-b': { rating: 'fail', evidence: 'was broken' } },
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: 'irrelevant-old-fingerprint',
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);
    const r = await evaluateScorecard({ rubricRef: 'test-rubric', ratings: RATINGS });
    expect((r as { delta: { changedCriteria: string[] } }).delta.changedCriteria).toEqual(['crit-b']);
  });

  it('release-gating rubric with an invalid instrument contract returns ok:false but STILL includes the skeleton + latest for the caller to inspect', async () => {
    getRubricM.mockResolvedValue({
      ...RUBRIC,
      releaseGating: true,
      criteria: [{ ...RUBRIC.criteria[0], instrumentKey: 'some-live-instrument' }, RUBRIC.criteria[1]],
    } as Rubric);
    const r = await evaluateScorecard({ rubricRef: 'test-rubric', ratings: RATINGS });
    expect(r.ok).toBe(false);
    expect((r as { skeleton?: unknown }).skeleton).toBeDefined();
    expect((r as { instrumentContract?: unknown }).instrumentContract).toBeDefined();
  });
});

describe('acceptance-grader eligibility is answerable BEFORE the grading work (EI-21974075442192005)', () => {
  // The rails are pure identity facts, so the only thing that made them expensive
  // was WHERE they were reachable: a launched reviewer completed a full independent
  // pass — re-running both bound suites, verifying every claimed repair, writing
  // evidence strings for seven criteria — and learned at the terminal emit that it
  // could never file the result. Each test below pins the PRE-FLIGHT answer AND the
  // refusal it predicts in the same case: an advisory that drifts from its rail is
  // the failure this module exists to prevent (WI-905074 widened the refusal and
  // left the advisory speaking for it on the old narrow test).
  const vettingCard = (critics: string[]) =>
    ({
      issueId: 'EI-vetting',
      createdAt: '2026-08-25T21:00:12Z',
      createdBy: 'su-vetting-author',
      rubricRef: 'meta-acceptance-rubric',
      subject: { kind: 'rubric', ref: 'acceptance-rubric' },
      ratings: RATINGS,
      nKeys: 2,
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      synthesized: false,
      score10: 10,
      linkedItems: [],
      vetting: { consultId: 'conv-vet-1', rubricRevision: 7, critiquePosts: 1, critics },
    }) as unknown as ScorecardRow;

  it('the sole vetting critic is told it is disqualified by the PRE-FLIGHT, with the same code emit refuses with', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([vettingCard(['su-critic'])]);

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-critic', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      ok: true,
      graderEligibility: {
        role: 'disqualified',
        blocksEmit: true,
        canEmitGrading: false,
        refusal: { code: 'grader_is_sole_vetting_critic' },
      },
    });
    // The pre-flight still returns the skeleton: a disqualified reviewer's useful
    // next act is handing it to the replacement grader.
    expect((preflight as { skeleton?: unknown[] }).skeleton).toHaveLength(2);

    // …and it agrees with the surface that actually refuses.
    const emitted = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-critic' },
    );
    expect(emitted).toMatchObject({ ok: false, code: 'grader_is_sole_vetting_critic' });
  });

  it('a grader inside the implementer lineage is refused by the pre-flight too, not only by emit', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    lineageRelatedM.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-implementer' && candidate === 'su-relative'),
    );

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-relative', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      graderEligibility: {
        role: 'disqualified',
        blocksEmit: true,
        refusal: { code: 'grader_in_implementer_lineage' },
      },
    });
    const refusal = (preflight as {
      graderEligibility?: { refusal?: { error?: string } };
    }).graderEligibility?.refusal;
    expect(refusal?.error).toContain('existing unrelated live session');
    expect(refusal?.error).toContain('unassigned grading work-item');
    expect(refusal?.error).toContain('never launch a grader from this lineage');
    await expect(
      emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS }, { createdBy: 'su-relative' }),
    ).resolves.toMatchObject({ ok: false, code: 'grader_in_implementer_lineage' });
  });

  it('an eligible independent grader is told so — the pre-flight is not a blanket warning', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([vettingCard(['su-critic'])]);

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-someone-else', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      graderEligibility: { role: 'independent-grader', canEmitGrading: true, blocksEmit: false },
    });
  });

  it('a retired acceptance rubric is a hard pre-flight block with the same refusal emit returns', async () => {
    getRubricM.mockResolvedValue({ ...ACCEPTANCE_RUBRIC, status: 'retired' } as Rubric);

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-someone-else', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      ok: true,
      graderEligibility: {
        role: 'disqualified',
        canEmitGrading: false,
        blocksEmit: true,
        refusal: { code: 'retired_acceptance_rubric' },
      },
    });
    expect(readRubricPlanRevisionM).not.toHaveBeenCalled();

    const emitted = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-someone-else' },
    );
    expect(emitted).toMatchObject({
      ok: false,
      code: 'retired_acceptance_rubric',
      error: preflight.graderEligibility?.refusal?.error,
    });
  });

  it('the rubric author is told it records the acceptance verdict, not the grading', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-implementer', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      graderEligibility: {
        role: 'acceptance-author',
        canEmitGrading: false,
        blocksEmit: false,
        implementer: 'su-implementer',
      },
    });
  });

  it('a NON-acceptance rubric, and a caller-less call, report null rather than a guess', async () => {
    getRubricM.mockResolvedValue(RUBRIC);
    await expect(
      evaluateScorecard({ rubricRef: 'test-rubric' }, { id: 'su-anyone', workspaceId: 'ws' }),
    ).resolves.toMatchObject({ graderEligibility: null });

    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    await expect(evaluateScorecard({ rubricRef: 'acceptance-rubric' })).resolves.toMatchObject({
      graderEligibility: null,
    });
  });

  it('an unresolvable eligibility read reports `unknown` and explicitly denies clearance', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    readRubricPlanRevisionM.mockRejectedValue(new Error('pg down'));

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-someone-else', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      ok: true,
      graderEligibility: { role: 'unknown', canEmitGrading: false },
    });
    // The wording matters: silence from a pre-flight reads as permission.
    expect(
      (preflight as { graderEligibility: { advice: string } }).graderEligibility.advice,
    ).toContain('NOT a clearance');
  });
});

describe('collapseCriticsToSoleParty — the predicate the refusal and its advisory share', () => {
  it('collapses a lone critic, and a longer list that is all one lineage', async () => {
    await expect(collapseCriticsToSoleParty(['su-a'], { workspaceId: 'ws' })).resolves.toBe('su-a');
    await expect(
      collapseCriticsToSoleParty(['su-a', 'su-a-rebound'], {
        workspaceId: 'ws',
        lineageRelated: (async (x: string | null, y: string | null) =>
          x === y || (x === 'su-a-rebound' && y === 'su-a')) as typeof areAcceptanceLineageRelated,
      }),
    ).resolves.toBe('su-a');
  });

  it('does NOT collapse two genuinely independent critics — that vetting preserved the three-party chain', async () => {
    await expect(collapseCriticsToSoleParty(['su-a', 'su-b'], { workspaceId: 'ws' })).resolves.toBeNull();
    await expect(collapseCriticsToSoleParty([], { workspaceId: 'ws' })).resolves.toBeNull();
  });
});
