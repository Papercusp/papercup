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
import { isAcceptanceAuthorIdentity } from '../../acceptance-author-identity';

vi.mock('../../rubrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rubrics')>();
  return { ...actual, getRubric: vi.fn() };
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
}));

import { getRubric } from '../../rubrics';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { getIssue } from '../../issues-engineer';
import { listScorecards } from '../../scorecards';
import { emitScorecard } from './emit';
import { evaluateScorecard } from './evaluate';

const getRubricM = vi.mocked(getRubric);
const captureM = vi.mocked(captureImprovement);
const listM = vi.mocked(listScorecards);
const getIssueM = vi.mocked(getIssue);
const sameAuthorM = vi.mocked(isAcceptanceAuthorIdentity);

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

beforeEach(() => {
  vi.clearAllMocks();
  sameAuthorM.mockImplementation(async (author, candidate) => author === candidate);
  getRubricM.mockResolvedValue(RUBRIC);
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

  it('lets an audited successor record the author verdict and never treats that successor as an independent grader', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    sameAuthorM.mockImplementation(
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
