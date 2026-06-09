/**
 * insight-staleness tests (learning-system-audit-improvements-2026-06-09 P-051).
 */

import { describe, it, expect } from 'vitest';
import { extractCitedPaths, scanInsightStaleness } from './insight-staleness';

const insight = (slug: string, raw: string, status = 'active') => ({ slug, status, raw });

describe('extractCitedPaths — conservative repo-file extraction', () => {
  it('keeps anchored repo files with extensions; drops globs, placeholders, URLs, dirs', () => {
    const raw = [
      'Read `packages/operator-core/lib/gym/loop.ts` and `apps/operator/lib/x.tsx`.',
      'Not these: `lib/unanchored.ts`, `packages/operator-core/lib/**`, `apps/<slug>/y.ts`,',
      '`https://example.com/a.ts`, `packages/operator-core/lib/gym` (no extension),',
      '`npm run test:affected`, `a b.ts`.',
    ].join('\n');
    expect(extractCitedPaths(raw).sort()).toEqual([
      'apps/operator/lib/x.tsx',
      'packages/operator-core/lib/gym/loop.ts',
    ]);
  });

  it('dedups repeated citations', () => {
    expect(extractCitedPaths('`libs/flags/src/types.ts` then `libs/flags/src/types.ts`')).toHaveLength(1);
  });
});

describe('scanInsightStaleness', () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);

  it('signals an active insight citing a missing file; stable title + kind=change', () => {
    const signals = scanInsightStaleness(
      [insight('gone-runbook', 'See `packages/operator-core/lib/old/removed.ts` for the fix.')],
      exists([]),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('insight-staleness');
    expect(signals[0].key).toBe('gone-runbook');
    expect(signals[0].kind).toBe('change');
    expect(signals[0].severity).toBe('minor');
    expect(signals[0].title).not.toMatch(/\d/); // no counts in the stable title
    expect(signals[0].body).toContain('packages/operator-core/lib/old/removed.ts');
    expect(signals[0].paths).toEqual(['apps/operator-docs/src/content/docs/agent-insights/gone-runbook.mdx']);
  });

  it('stays silent for: all-paths-exist, retired/superseded, and no-citations insights', () => {
    const signals = scanInsightStaleness(
      [
        insight('healthy', 'See `libs/flags/src/types.ts`.'),
        insight('retired-one', 'See `packages/x/missing.ts`.', 'retired'),
        insight('superseded-one', 'See `packages/x/missing.ts`.', 'superseded'),
        insight('prose-only', 'No code citations here at all.'),
      ],
      exists(['libs/flags/src/types.ts']),
    );
    expect(signals).toHaveLength(0);
  });

  it('caps signals per sweep', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      insight(`stale-${i}`, `See \`packages/x/missing-${i}.ts\`.`),
    );
    expect(scanInsightStaleness(many, exists([]), { maxSignals: 3 })).toHaveLength(3);
  });
});
