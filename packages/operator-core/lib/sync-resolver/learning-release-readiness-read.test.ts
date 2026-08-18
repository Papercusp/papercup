/**
 * learning.releaseReadiness read (learning-tab-alignment-2026-07-13 P-001).
 *
 * The contract under test: (a) the snapshot is assembled from the SAME readers the MCP
 * tools serve (D-001 — the mocks stand in for buildProgramSuccessReport / getRubric /
 * listScorecards, and nothing else is consulted); (b) every leg is fail-soft — a broken
 * ledger read must not blank the rubric line, a broken scorecard read must not hide the
 * rubric's governance state, and nothing throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildProgramSuccessReport = vi.fn();
vi.mock('../scout/success-metrics', () => ({
  buildProgramSuccessReport: (...a: unknown[]) => buildProgramSuccessReport(...a),
}));
const getRubric = vi.fn();
vi.mock('../rubrics', () => ({
  getRubric: (...a: unknown[]) => getRubric(...a),
}));
const listScorecards = vi.fn();
vi.mock('../scorecards', () => ({
  listScorecards: (...a: unknown[]) => listScorecards(...a),
}));

import { readReleaseReadiness, RELEASE_READINESS_RUBRIC_ID } from './learning-release-readiness-read';

const sampleReport = {
  criteria: [
    { key: 'lens-diversity', bar: '>=2 lenses', status: 'pass', observed: '2 lenses' },
    { key: 'cycle-error-rate', bar: '<5%', status: 'fail', observed: '13.8%' },
  ],
  passed: 1,
  failed: 1,
  unknown: 0,
  verdict: 'fail',
  window: { ticks: 500, ranCycles: 351, routedIdeas: 167, ledgerTruncated: false },
};

const sampleRubric = {
  rubricId: RELEASE_READINESS_RUBRIC_ID,
  workspaceId: 'w',
  characteristic: 'release-readiness',
  title: 'Blender release readiness',
  description: 'the gate',
  criteria: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
  ratingScale: ['pass', 'at-risk', 'fail', 'unknown'],
  methodRef: null,
  status: 'proposed',
  createdBy: 'su-x',
  proposedBy: 'su-f69a7',
  ratifiedBy: null,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T02:00:00.000Z',
};

describe('readReleaseReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildProgramSuccessReport.mockResolvedValue(sampleReport);
    getRubric.mockResolvedValue(sampleRubric);
    listScorecards.mockResolvedValue([
      { createdAt: '2026-07-12T10:00:00.000Z', score10: 4 },
      { createdAt: '2026-07-13T01:00:00.000Z', score10: 7 }, // newest — wins latest*
    ]);
  });

  it('assembles the report + rubric governance from the tool readers (D-001)', async () => {
    const snap = await readReleaseReadiness();
    expect(snap.report).toEqual(sampleReport);
    expect(snap.rubric).toMatchObject({
      rubricId: RELEASE_READINESS_RUBRIC_ID,
      status: 'proposed',
      criteriaCount: 3,
      proposedBy: 'su-f69a7',
      ratifiedBy: null,
      scorecardCount: 2,
      latestScorecardAt: '2026-07-13T01:00:00.000Z',
      latestScore10: 7,
    });
    expect(snap.errors).toBeUndefined();
    expect(getRubric).toHaveBeenCalledWith(RELEASE_READINESS_RUBRIC_ID);
    expect(listScorecards).toHaveBeenCalledWith({ rubricRef: RELEASE_READINESS_RUBRIC_ID, limit: 100 });
  });

  it('a broken ledger read does not blank the rubric line (fail-soft per leg)', async () => {
    buildProgramSuccessReport.mockRejectedValue(new Error('pg down'));
    const snap = await readReleaseReadiness();
    expect(snap.report).toBeNull();
    expect(snap.rubric?.rubricId).toBe(RELEASE_READINESS_RUBRIC_ID);
    expect(snap.errors?.some((e) => e.includes('success-metrics') && e.includes('pg down'))).toBe(true);
  });

  it('no rubric proposed yet → rubric null, NOT an error (an honest missing state)', async () => {
    getRubric.mockResolvedValue(null);
    const snap = await readReleaseReadiness();
    expect(snap.rubric).toBeNull();
    expect(snap.report).toEqual(sampleReport);
    expect(snap.errors).toBeUndefined();
  });

  it('a broken scorecard read degrades to governance-only — the rubric status must not vanish', async () => {
    listScorecards.mockRejectedValue(new Error('scorecards table sad'));
    const snap = await readReleaseReadiness();
    expect(snap.rubric).toMatchObject({
      status: 'proposed',
      scorecardCount: 0,
      latestScorecardAt: null,
      latestScore10: null,
    });
  });

  it('never throws even when every leg fails', async () => {
    buildProgramSuccessReport.mockRejectedValue(new Error('a'));
    getRubric.mockRejectedValue(new Error('b'));
    const snap = await readReleaseReadiness();
    expect(snap.report).toBeNull();
    expect(snap.rubric).toBeNull();
    expect(snap.errors).toHaveLength(2);
    expect(snap.readAt).toBeTruthy();
  });

  /**
   * EI-20801200386596605 (sibling of WI-39813) — fail-soft covered a leg that
   * THROWS and nothing at all for a leg that HANGS. `Promise.all` waits for the
   * slowest, so one wedged reader blew the ~10s resolver timeout and 500'd the
   * whole strip — which could not then show the degraded state the `.catch`es
   * above so carefully computed, because the response itself never shipped.
   */
  describe('a hung leg degrades instead of hanging the strip (EI-20801200386596605)', () => {
    /** Never settles — a wedged reader, not a failing one. */
    const hang = () => new Promise<never>(() => {});

    it('a hanging ledger read degrades that leg while the rubric line still serves', async () => {
      buildProgramSuccessReport.mockImplementation(hang);
      const snap = await readReleaseReadiness({ budgetMs: 40 });

      expect(snap.report).toBeNull();
      // The whole point: the strip still SERVES. Before the budget this returned
      // nothing at all — the hung leg took the entire read down with it.
      expect(snap.rubric?.rubricId).toBe(RELEASE_READINESS_RUBRIC_ID);
      expect(snap.errors?.some((e) => e.includes('success-metrics'))).toBe(true);
    });

    // Without this control the guard above would pass just as happily against a
    // read that degrades unconditionally — "always degraded" satisfies every
    // assertion that only ever inspects the failing case.
    it('a healthy read under the SAME budget degrades nothing — the guard discriminates on the hang, not on the budget', async () => {
      const snap = await readReleaseReadiness({ budgetMs: 40 });

      expect(snap.errors).toBeUndefined();
      expect(snap.report).toEqual(sampleReport);
      expect(snap.rubric?.rubricId).toBe(RELEASE_READINESS_RUBRIC_ID);
    });

    /**
     * FALSIFIABILITY CONTROL for the two guards above. The read builds its
     * deadline internally, so the lever is the one knob it exposes: a budget
     * outside the test's patience is observationally identical to no bound at
     * all, and under it the SAME hang takes the whole strip down — the defect
     * reproduced on demand instead of asserted. "Never settles" is the
     * condition under test, so it has to be an assertable outcome rather than
     * a test timeout.
     */
    const PENDING = Symbol('still-pending');
    const settledWithin = <T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> =>
      Promise.race([
        p,
        new Promise<typeof PENDING>((resolve) => {
          const t = setTimeout(() => resolve(PENDING), ms);
          (t as unknown as { unref?: () => void }).unref?.();
        }),
      ]);

    it('CONTROL: with a budget that cannot fire, the same hang takes the whole strip down — so the guards above are falsifiable', async () => {
      buildProgramSuccessReport.mockImplementation(hang);

      expect(await settledWithin(readReleaseReadiness({ budgetMs: 10 * 60_000 }), 150)).toBe(PENDING);

      // Calibration: the identical call under a REAL budget settles, degraded.
      const bounded = await settledWithin(readReleaseReadiness({ budgetMs: 40 }), 2000);
      expect(bounded).not.toBe(PENDING);
      expect(bounded !== PENDING && bounded.report).toBeNull();
    });
  });
});
