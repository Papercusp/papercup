/**
 * promote.test.ts — findUnknownFromItems guards plans:promote: it returns every
 * referenced from_items id that isn't a known plan item (a non-empty result blocks
 * the promote). A bug here lets a promote bind to a non-existent item or falsely
 * rejects a valid one. Pinned: all-known → [], unknowns returned sorted+deduped,
 * missing from_items tolerated, dedup across features.
 *
 * Borrowable-lib unit test (pubsub-substrate, node env) — tab-neutral, genuine.
 * Run: cd libs/generic/pubsub-substrate && npx vitest run src/core/promote.test.ts
 */
import { describe, expect, it } from 'vitest';
import { findUnknownFromItems } from './promote';

describe('findUnknownFromItems', () => {
  it('returns [] when every referenced item is known', () => {
    const out = findUnknownFromItems([{ from_items: ['P-001', 'P-002'] }], ['P-001', 'P-002', 'P-003']);
    expect(out).toEqual([]);
  });

  it('returns the unknown ids, sorted and de-duplicated', () => {
    const out = findUnknownFromItems(
      [{ from_items: ['P-009', 'P-001'] }, { from_items: ['P-009', 'P-005'] }],
      new Set(['P-001']),
    );
    expect(out).toEqual(['P-005', 'P-009']); // sorted + deduped (P-009 once)
  });

  it('tolerates features with no from_items', () => {
    expect(findUnknownFromItems([{}, { from_items: undefined }, { from_items: ['P-001'] }], [])).toEqual(['P-001']);
  });

  it('returns [] for empty features', () => {
    expect(findUnknownFromItems([], ['P-001'])).toEqual([]);
  });

  it('accepts any Iterable of known ids (array or Set)', () => {
    expect(findUnknownFromItems([{ from_items: ['x'] }], ['x'])).toEqual([]);
    expect(findUnknownFromItems([{ from_items: ['x'] }], new Set(['x']))).toEqual([]);
  });
});
