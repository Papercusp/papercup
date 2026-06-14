/**
 * insight-staleness tests (learning-system-audit-improvements-2026-06-09 P-051).
 */

import { describe, it, expect } from 'vitest';
import {
  extractCitedPaths,
  scanInsightStaleness,
  collectInsightStalenessSignals,
  DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS,
} from './insight-staleness';

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

  it('classifies all-citations-missing as apoptotic (supersede) vs partial as repoint-review (EI-441)', () => {
    const [apoptotic] = scanInsightStaleness(
      [insight('all-gone', 'Only `packages/x/gone-a.ts` and `packages/x/gone-b.ts` here.')],
      exists([]),
    );
    expect(apoptotic.title).toMatch(/obsolete .* all cited files are gone/i);
    expect(apoptotic.body).toMatch(/every citation is gone/i);
    expect(apoptotic.body).toMatch(/status: superseded/);
    expect(apoptotic.title).not.toMatch(/\d/); // still a stable, count-free title

    const [partial] = scanInsightStaleness(
      [insight('one-moved', 'Live `libs/flags/src/types.ts`, gone `packages/x/gone.ts`.')],
      exists(['libs/flags/src/types.ts']),
    );
    expect(partial.title).toMatch(/cites files that no longer exist/i);
    expect(partial.title).not.toMatch(/obsolete/i);
  });

  it('stamps a resolution cooldown on every signal — default + override (EI-427 deploy-lag suppressor)', () => {
    const [def] = scanInsightStaleness([insight('s', 'See `packages/x/gone.ts`.')], exists([]));
    expect(def.resolutionCooldownMs).toBe(DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS);

    const [overridden] = scanInsightStaleness(
      [insight('s', 'See `packages/x/gone.ts`.')],
      exists([]),
      { resolutionCooldownMs: 1000 },
    );
    expect(overridden.resolutionCooldownMs).toBe(1000);
  });
});

// The fs glue: readdir(agent-insights) → frontmatter status parse → existsSync
// delegation to the (separately-tested) pure scan. Smoke against the REAL docs
// tree — count-free so it can't drift as insights are added/retired; it pins the
// wiring (no throw, well-formed signals, the deterministic .mdx path shape).
describe('collectInsightStalenessSignals — fs glue over the real docs tree', () => {
  it('resolves to an array of well-formed insight-staleness signals', async () => {
    const signals = await collectInsightStalenessSignals();
    expect(Array.isArray(signals)).toBe(true);
    for (const s of signals) {
      expect(s.source).toBe('insight-staleness');
      expect(typeof s.key).toBe('string');
      expect(s.key.length).toBeGreaterThan(0);
      expect(s.kind).toBe('change');
      // paths[0] is the deterministic mdx location derived from the slug/key.
      expect(s.paths?.[0]).toBe(
        `apps/operator-docs/src/content/docs/agent-insights/${s.key}.mdx`,
      );
    }
  });
});
