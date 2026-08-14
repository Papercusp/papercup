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
import type { Rubric } from '../../rubrics';
import type { ScorecardRow } from '../../scorecards';

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

const RUBRIC: Rubric = {
  rubricId: 'test-rubric',
  workspaceId: 'ws',
  characteristic: 'test',
  title: 'Test Rubric',
  description: 'd',
  criteria: [
    { key: 'crit-a', title: 'Criterion A', model: 'm', method: 'm' , driftMarkers: 'd' },
    { key: 'crit-b', title: 'Criterion B', model: 'm', method: 'm', driftMarkers: 'd' },
  ],
  ratingScale: ['pass', 'partial', 'fail'],
  methodRef: null,
  status: 'active',
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
} as unknown as Rubric;

const RATINGS = {
  'crit-a': { rating: 'pass', evidence: 'observed A working' },
  'crit-b': { rating: 'pass', evidence: 'observed B working' },
};

beforeEach(() => {
  vi.clearAllMocks();
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
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: { 'crit-a': RATINGS['crit-a'] } }, { createdBy: 'su-1' });
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

  it('DEDUPLICATION: identical evidence to the latest scorecard is declined (unchanged-evidence), never re-files', async () => {
    const firstFingerprint = (
      await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' })
    ) as { evidenceFingerprint: string };
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
    listM.mockResolvedValue([{
      issueId: 'ISS-OLD', rubricRef: 'test-rubric', ratings: RATINGS,
      missingKeys: [], rubricResolved: true, evidenceFingerprint: first.evidenceFingerprint,
      synthesized: false, score10: null, linkedItems: [],
    } as unknown as ScorecardRow]);

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
