import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../scorecards', () => ({ scorecardTrend: vi.fn() }));

import { scorecardTrend } from '../../scorecards';
import trendTool from './trend';

beforeEach(() => vi.clearAllMocks());

describe('rubrics:trend observation age contract', () => {
  it('forwards the validated explicit horizon and returns the age verdict', async () => {
    const result = {
      rubricRef: 'test-rubric', scorecardCount: 0, sample: { limit: 500, inputCount: 0 }, window: {}, criteria: [],
      supersededExcluded: 0, preContractResetExcluded: 0, provisionalExcluded: 0, gradingAuditPendingExcluded: 0,
      staleness: { stale: false, staleCriteria: [], judgedCriteria: 0, assessed: false, reason: 'empty' },
      observationAge: {
        status: 'unknown' as const, horizonSec: 3600, asOf: '2026-10-05T12:00:00.000Z', reason: 'empty',
        coverage: { population: 'retained-scorecards' as const, total: 0, timed: 0, missing: 0, invalid: 0, future: 0 },
      },
    };
    vi.mocked(scorecardTrend).mockResolvedValue(result);
    const args = trendTool.args.parse({ rubricRef: 'test-rubric', observationMaxAgeSec: 3600 });
    const response = await trendTool.handler(args, {} as never);
    expect(scorecardTrend).toHaveBeenCalledWith(expect.objectContaining({ observationMaxAgeSec: 3600 }));
    const content = (response as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(content[0].text).trend.observationAge).toEqual(result.observationAge);
  });

  it('leaves the horizon optional for existing callers', () => {
    expect(trendTool.args.parse({ rubricRef: 'test-rubric' })).not.toHaveProperty('observationMaxAgeSec');
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid public horizons %s', (horizon) => {
    expect(trendTool.args.safeParse({ rubricRef: 'test-rubric', observationMaxAgeSec: horizon }).success).toBe(false);
  });
});
