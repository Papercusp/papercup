import { describe, expect, it } from 'vitest';
import { buildCiTestHealthPatterns, type CiTestFailureAggregate } from './ci-test-health-lane';
import { flattenDigest } from './lenses';
import type { CorpusDigest } from './types';

function row(filePath: string, failedGroups: number, localPassId: string | null): CiTestFailureAggregate {
  return {
    filePath, failedGroups, localPassId, failedRows: failedGroups + 1,
    latestId: filePath === 'repeat.test.ts' ? '41' : '42',
    latestSha: 'abc123', latestAt: '2026-09-25T18:00:00Z',
  };
}

describe('CI test health patterns', () => {
  it('keeps distinct CI run groups separate from file-run rows and cites same-commit local evidence', () => {
    const lane = buildCiTestHealthPatterns([
      row('one-off.test.ts', 1, null),
      row('repeat.test.ts', 3, null),
      row('divergent.test.ts', 1, '99'),
    ]);
    const digest = {
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      ciTestHealth: lane,
    } satisfies CorpusDigest;
    const flat = flattenDigest(digest);
    expect(flat.map((pattern) => pattern.ref)).toEqual(['test-run:42', 'test-run:41']);
    expect(flat[0]).toMatchObject({ category: 'ci-test-health' });
    expect(flat[0]?.detail).toContain('test_runs.id=99');
    expect(flat[1]?.summary).toContain('3 failing CI run group(s)');
    expect(flat[1]?.detail).toContain('4 failed CI file-run row(s)');
    expect(flat[1]?.detail).toContain('not unique incidents');
  });

  it('discloses both pattern and database read caps', () => {
    const lane = buildCiTestHealthPatterns(
      [row('a.test.ts', 2, null), row('b.test.ts', 3, null)],
      { limit: 1, totalCandidates: 5 },
    );
    expect(lane.map((pattern) => pattern.ref)).toEqual(['test-run:42', 'ci-test:coverage-residue']);
    expect(lane[1]?.detail).toContain('3 outside the 100-file database read cap');
  });
});
