import { describe, expect, it, vi } from 'vitest';
import {
  buildScorecardHistoryPredicate,
  decodeScorecardHistoryCursor,
  encodeScorecardHistoryCursor,
  normalizeScorecardHistoryArgs,
  readScorecardHistoryPage,
  readScorecardHistorySummary,
} from './scorecard-history-list-query';
import type { ScorecardRow } from '../scorecards';

const row = (issueId: string, createdAt: string): ScorecardRow => ({
  issueId,
  createdAt,
  createdBy: 'su-test',
  rubricRef: 'rubric-a',
  ratings: { criterion: { rating: 'pass', evidence: 'measured' } },
  nKeys: 1,
  missingKeys: [],
  extraKeys: [],
  rubricResolved: true,
  synthesized: false,
  score10: 10,
  linkedItems: [],
});

describe('scorecard history list query', () => {
  it('preserves submillisecond and timezone precision when restoring a saved cursor', () => {
    for (const createdAt of ['2026-11-01T00:00:00.100001Z', '2026-11-01T02:00:00.100002+02:00']) {
      const cursor = { createdAt, issueId: 'EI-precision' };
      expect(decodeScorecardHistoryCursor(JSON.stringify(cursor))).toEqual(cursor);
    }
  });
  it('bounds enriched pages by whole rows and resumes without losing any criterion evidence', async () => {
    const cards = Array.from({ length: 5 }, (_, index) => ({ ...row(`EI-${index}`, '2026-11-01T00:00:00Z'),
      ratings: { a: { rating: 'healthy', evidence: '測'.repeat(20_000) }, b: { rating: 'unknown', evidence: 'Retained second key.' } } }));
    const listPage = vi.fn(async (filter: { before?: { issueId: string } }) => ({
      rows: filter.before ? cards.slice(cards.findIndex(card => card.issueId === filter.before!.issueId) + 1) : cards,
      hasMore: false,
    }));
    const first = await readScorecardHistoryPage(buildScorecardHistoryPredicate(
      normalizeScorecardHistoryArgs({ rubricRef: 'rubric-a', limit: 5 })), { listPage });
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.length).toBeLessThan(5);
    expect(Buffer.byteLength(JSON.stringify(first.rows))).toBeLessThan(240_000);
    expect(first.hasMore).toBe(true);
    const second = await readScorecardHistoryPage(buildScorecardHistoryPredicate(
      normalizeScorecardHistoryArgs({ rubricRef: 'rubric-a', limit: 5, cursor: first.nextCursor })), { listPage });
    expect([...first.rows, ...second.rows]).toEqual(cards);
    expect(second.hasMore).toBe(false);
  });
  it('keeps explicit review and accepted pages distinct at a pinned comparison clock', async () => {
    const comparisonTime = '2026-11-01T12:00:00Z';
    const listPage = vi.fn(async () => ({ rows: [], hasMore: false }));
    const make = (mode: 'accepted' | 'review-history') => buildScorecardHistoryPredicate(
      normalizeScorecardHistoryArgs({ rubricRef: 'rubric-a', mode, comparisonTime, limit: 1 }));
    await readScorecardHistoryPage(make('review-history'), { listPage });
    await readScorecardHistoryPage(make('accepted'), { listPage });
    expect(listPage.mock.calls).toEqual([
      [{ rubricRef: 'rubric-a', includeDiagnostics: true, comparisonTime, limit: 1, includeLinks: true }],
      [{ rubricRef: 'rubric-a', finalizedOnly: true, comparisonTime, limit: 1, includeLinks: true }],
    ]);
    expect(make('accepted').fingerprint).not.toBe(make('review-history').fingerprint);
  });
  it('normalizes limits and treats malformed cursors as a first-page request', () => {
    expect(
      normalizeScorecardHistoryArgs({
        rubricRef: ' rubric-a ',
        limit: 50_000,
        cursor: '{bad',
      }),
    ).toEqual({ rubricRef: 'rubric-a', limit: 500, cursor: null });
    expect(decodeScorecardHistoryCursor('null')).toBeNull();
  });

  it('threads a stable composite cursor and preserves authoritative exhaustion', async () => {
    const first = row('EI-2', '2026-08-22T07:00:00.000Z');
    const second = row('EI-1', '2026-08-22T07:00:00.000Z');
    const cursor = encodeScorecardHistoryCursor(first);
    const listPage = vi.fn(async () => ({ rows: [second], hasMore: true }));
    const predicate = buildScorecardHistoryPredicate(
      normalizeScorecardHistoryArgs({ rubricRef: 'rubric-a', cursor, limit: 25 }),
    );

    const page = await readScorecardHistoryPage(predicate, { listPage });

    expect(listPage).toHaveBeenCalledWith({
      rubricRef: 'rubric-a',
      limit: 25,
      before: { createdAt: first.createdAt, issueId: first.issueId },
      includeLinks: true,
    });
    expect(page).toMatchObject({
      rows: [second],
      hasMore: true,
      nextCursor: encodeScorecardHistoryCursor(second),
      previousCursor: cursor,
    });
  });

  it('uses the exact aggregate with the same hidden-row policy and preserves zero', async () => {
    const countByRubric = vi.fn(async () => ({ 'rubric-a': 0 }));
    const predicate = buildScorecardHistoryPredicate(normalizeScorecardHistoryArgs({ rubricRef: 'rubric-a' }));

    await expect(readScorecardHistorySummary(predicate, { countByRubric })).resolves.toEqual([
      { kind: 'totals', total: 0, matched: 0 },
    ]);
    expect(countByRubric).toHaveBeenCalledWith({
      rubricRef: 'rubric-a',
      includeSuperseded: false,
      includeRetracted: false,
    });
  });
});
