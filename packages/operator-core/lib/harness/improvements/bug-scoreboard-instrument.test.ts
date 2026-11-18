import { describe, expect, it, vi } from 'vitest';
import { computeBugScoreboardMetrics, bugScoreboardRescore, BUG_SCOREBOARD_INSTRUMENT,
  type BugScoreboardHistory } from './bug-scoreboard-instrument';
import { getRegisteredInstrument } from '../../rubric-instrument-registry';
import { runInstrumentChecks } from '../../check-results-ledger';

const start = '2026-11-10T00:00:00.000Z', end = '2026-11-11T00:00:00.000Z';
const measured = '2026-11-12T00:00:00.000Z';
const scope = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', windowStart: start, windowEnd: end };
const claimable = { count: 1, population: 4, protected: 1, held: 1, blocked: 1, unknown: 0 };
function history(): BugScoreboardHistory {
  return {
    filings: [{ itemId: 'old', filedAt: '2026-11-09T00:00:00Z', source: 'agent' },
      { itemId: 'a', filedAt: start, source: '__proto__' },
      { itemId: 'b', filedAt: '2026-11-10T23:59:59Z', source: 'watchdog' },
      { itemId: 'after', filedAt: end, source: 'agent' }],
    closes: [{ itemId: 'old', at: start, kind: 'ordinary' }, { itemId: 'a', at: start, kind: 'fold' },
      { itemId: 'a', at: end, kind: 'ordinary' }, { itemId: 'b', at: '2026-11-10T23:59:59Z', kind: 'cleanup' }],
    reopens: [{ itemId: 'old', at: '2026-11-10T03:00:00Z', ordinary: true }],
    reviews: [{ itemId: 'a', at: '2026-11-10T02:00:00Z' }, { itemId: 'a', at: '2026-11-11T04:00:00Z' }],
    bypasses: [{ itemId: 'b', at: end, route: 'specific-route', reason: 'recorded' }],
    flags: [{ itemId: 'a', at: start }, { itemId: 'a', at: end }],
    merges: [{ at: start, outcome: 'committed' }, { at: end, outcome: 'failed' }],
  };
}

describe('R11 event metric writer arithmetic (synthetic normalized events, not source qualification)', () => {
  it('retains all seven raw metrics, UTC boundaries, original first review/flag clocks, pending and ordinary reopen adjustments', () => {
    const metrics = computeBugScoreboardMetrics(history(), claimable, start, end, measured);
    expect(Object.keys(metrics)).toHaveLength(7);
    expect(metrics.filedPerDayBySource).toEqual({ countsBySource: JSON.parse('{"__proto__":1,"watchdog":1}') });
    expect(metrics.closedPerDay).toEqual({ ordinary: 1, cleanup: 1, fold: 1, reopenedOrdinary: 1, adjustedOrdinary: 0 });
    expect(metrics.shareReviewed).toEqual({ numerator: 1, denominator: 2, onTimeNumerator: 1, onTimeDenominator: 2 });
    expect(metrics.shareBypassed).toEqual({ numerator: 1, denominator: 2, routes: { 'specific-route': 1 }, reasons: { recorded: 1 } });
    expect(metrics.reviewerWait).toEqual({ rows: [
      { itemId: 'a', filedAt: start, decidedAt: '2026-11-10T02:00:00Z', waitMs: 7_200_000,
        flaggedAt: start, dueAt: measured },
      { itemId: 'b', filedAt: '2026-11-10T23:59:59Z', decidedAt: null, waitMs: null, rightCensoredAt: measured },
    ], pending: 1, rightCensored: 1, missing: 0 });
    expect(metrics.mergesPerDay).toEqual({ committed: 1, duplicate: 0, alreadyFolded: 0, protected: 0, failed: 0 });
    expect(metrics.claimableCount).toEqual(claimable);
    const reversed = history();
    for (const events of Object.values(reversed)) events.reverse();
    expect(computeBugScoreboardMetrics(reversed, claimable, start, end, measured)).toEqual(metrics);
  });

  it('rejects duplicate original filing IDs, orphan events, invalid windows and overlapping claimability buckets', () => {
    const duplicate = history(); duplicate.filings.push(duplicate.filings[0]);
    expect(() => computeBugScoreboardMetrics(duplicate, claimable, start, end, measured)).toThrow(/filing identity/);
    const orphan = history(); orphan.reviews.push({ itemId: 'missing', at: start });
    expect(() => computeBugScoreboardMetrics(orphan, claimable, start, end, measured)).toThrow(/original filing/);
    expect(() => computeBugScoreboardMetrics(history(), { ...claimable, population: 3 }, start, end, measured)).toThrow(/disjoint/);
    expect(() => computeBugScoreboardMetrics(history(), claimable, '2026-11-10T00:00:01Z', end, measured)).toThrow(/UTC window/);
    const empty = history(); empty.filings = []; empty.closes = []; empty.reopens = []; empty.reviews = []; empty.bypasses = []; empty.flags = [];
    expect(computeBugScoreboardMetrics(empty, claimable, start, end, measured).shareReviewed?.denominator).toBe(0);
  });
});

describe('R11 scheduled same-cycle producer/consumer', () => {
  it('registers the maintained platform instrument with an executable daily harness resolver', () => {
    expect(getRegisteredInstrument(BUG_SCOREBOARD_INSTRUMENT)).toMatchObject({ evaluator: 'platform',
      rescore: { windowMs: 86_400_000, scope: 'harness', resolve: expect.any(Function) } });
  });

  it('passes exact new receipt identity and never reuses an earlier healthy consumer after writer failure', async () => {
    const produce = vi.fn().mockResolvedValueOnce({ ref: 'fresh-packet', cycleId: 'fresh-cycle' })
      .mockRejectedValueOnce(new Error('writer failed'));
    const consume = vi.fn().mockResolvedValue({ verdict: 'pass', detail: 'synthetic seam only', value: 1 });
    const resolver = bugScoreboardRescore({ produce, consume }).resolve;
    await expect(resolver(scope)).resolves.toMatchObject({ verdict: 'pass' });
    expect(consume).toHaveBeenCalledWith('fresh-packet', 'fresh-cycle', scope);
    await expect(resolver(scope)).rejects.toThrow('writer failed');
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('records missing history as an error with retained receipt provenance in the existing ledger path', async () => {
    const results = await runInstrumentChecks({ rubricRef: 'bugs-daily-test', workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug, now: () => Date.parse(measured), criteria: [{ key: 'daily',
        check: { kind: 'instrument', instrumentKey: BUG_SCOREBOARD_INSTRUMENT } }],
      resolvePlatform: async () => ({ verdict: 'unknown', detail: 'unqualified event history',
        evidenceRefs: ['immutable-cycle', 'immutable-source'], reportRef: 'immutable-cycle' }) });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ verdict: 'error', check: { kind: 'instrument', value: null } });
    expect(JSON.stringify(results[0].check.provenance)).toContain('immutable-cycle');
  });
});
