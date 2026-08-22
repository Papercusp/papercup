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
