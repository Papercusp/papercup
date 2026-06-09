/**
 * insights-usage rollup tests (learning-system-audit-improvements-2026-06-09 P-051).
 */

import { describe, it, expect } from 'vitest';
import { insightSlugsOf, rollupInsightUsage } from './insights-usage';

describe('insightSlugsOf', () => {
  it('extracts agent-insights slugs from docs:get args, stripping prefix + extension', () => {
    expect(
      insightSlugsOf({ slugs: ['agent-insights/gym-as-blueprint', 'agent-insights/foo.mdx', 'system/lifecycle'] }),
    ).toEqual(['gym-as-blueprint', 'foo']);
  });

  it('tolerates malformed args', () => {
    expect(insightSlugsOf(null)).toEqual([]);
    expect(insightSlugsOf('x')).toEqual([]);
    expect(insightSlugsOf({ slugs: 'agent-insights/x' })).toEqual([]);
    expect(insightSlugsOf({ slugs: [42, null] })).toEqual([]);
  });
});

describe('rollupInsightUsage', () => {
  it('counts reads per slug with most-recent timestamp, sorted by reads desc', () => {
    const rows = [
      { argsJson: { slugs: ['agent-insights/a'] }, invokedAt: '2026-06-01T00:00:00Z' },
      { argsJson: { slugs: ['agent-insights/a', 'agent-insights/b'] }, invokedAt: '2026-06-05T00:00:00Z' },
      { argsJson: { slugs: ['system/other'] }, invokedAt: '2026-06-06T00:00:00Z' },
      { argsJson: { slugs: ['agent-insights/a'] }, invokedAt: '2026-06-03T00:00:00Z' },
    ];
    expect(rollupInsightUsage(rows)).toEqual([
      { slug: 'a', reads: 3, lastReadAt: '2026-06-05T00:00:00Z' },
      { slug: 'b', reads: 1, lastReadAt: '2026-06-05T00:00:00Z' },
    ]);
  });

  it('empty input → empty rollup', () => {
    expect(rollupInsightUsage([])).toEqual([]);
  });
});
