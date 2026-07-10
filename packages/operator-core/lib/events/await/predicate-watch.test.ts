/**
 * predicate-watch.test.ts — unit coverage for the pure predicate helpers
 * (fleet-deltas-leader-primitives-2026-07-10 P-008): dot-path extraction,
 * op evaluation, and tool-result payload extraction. The store + poller +
 * edge-fire lifecycle is covered in predicate-watch.integration.test.ts
 * (real PG, fake dispatch via configurePredicateDispatch).
 */
import { describe, expect, it } from 'vitest';
import { valueAtPath, comparePredicate, extractToolPayload } from './predicate-watch';

describe('valueAtPath', () => {
  it('extracts nested object paths', () => {
    expect(valueAtPath({ counts: { open: 3 } }, 'counts.open')).toBe(3);
  });

  it('extracts array indices as numeric segments', () => {
    expect(valueAtPath({ rows: [{ status: 'done' }] }, 'rows.0.status')).toBe('done');
  });

  it('returns undefined for a missing segment anywhere along the path', () => {
    expect(valueAtPath({ counts: {} }, 'counts.open')).toBeUndefined();
    expect(valueAtPath({ counts: { open: 3 } }, 'counts.open.deeper')).toBeUndefined();
    expect(valueAtPath(null, 'a')).toBeUndefined();
    expect(valueAtPath(42, 'a')).toBeUndefined();
  });

  it('reads a top-level key', () => {
    expect(valueAtPath({ wm: 128 }, 'wm')).toBe(128);
  });
});

describe('comparePredicate', () => {
  it('eq/ne — scalars and deep structures', () => {
    expect(comparePredicate(3, 'eq', 3)).toBe(true);
    expect(comparePredicate('a', 'eq', 'b')).toBe(false);
    expect(comparePredicate({ a: 1 }, 'eq', { a: 1 })).toBe(true);
    expect(comparePredicate({ a: 1 }, 'ne', { a: 2 })).toBe(true);
  });

  it('numeric ops coerce both sides (a jsonb number often arrives as a string)', () => {
    expect(comparePredicate('128', 'gt', 127)).toBe(true);
    expect(comparePredicate(127, 'gt', 127)).toBe(false);
    expect(comparePredicate(127, 'gte', 127)).toBe(true);
    expect(comparePredicate(5, 'lt', '6')).toBe(true);
    expect(comparePredicate(6, 'lte', 6)).toBe(true);
  });

  it('numeric ops are false (never throw) on non-numeric operands', () => {
    expect(comparePredicate('not-a-number', 'gt', 1)).toBe(false);
    expect(comparePredicate(undefined, 'lt', 1)).toBe(false);
    expect(comparePredicate({}, 'gte', 1)).toBe(false);
  });

  it('exists — null/undefined are absent, falsy values are present', () => {
    expect(comparePredicate(undefined, 'exists', undefined)).toBe(false);
    expect(comparePredicate(null, 'exists', undefined)).toBe(false);
    expect(comparePredicate(0, 'exists', undefined)).toBe(true);
    expect(comparePredicate(false, 'exists', undefined)).toBe(true);
  });

  it('contains — string includes, array deep-membership, false elsewhere', () => {
    expect(comparePredicate('GREEN: wm=128', 'contains', 'GREEN')).toBe(true);
    expect(comparePredicate(['a', 'b'], 'contains', 'b')).toBe(true);
    expect(comparePredicate([{ id: 1 }], 'contains', { id: 1 })).toBe(true);
    expect(comparePredicate([{ id: 1 }], 'contains', { id: 2 })).toBe(false);
    expect(comparePredicate(42, 'contains', 4)).toBe(false);
  });
});

describe('extractToolPayload', () => {
  it('prefers structuredContent when present', () => {
    expect(extractToolPayload({ structuredContent: { n: 1 }, content: [{ type: 'text', text: '{"n":2}' }] })).toEqual({
      n: 1,
    });
  });

  it('falls back to a tolerant JSON.parse of the first text block', () => {
    expect(extractToolPayload({ content: [{ type: 'text', text: '{"counts":{"open":3}}' }] })).toEqual({
      counts: { open: 3 },
    });
  });

  it('returns the raw string when the text block is not JSON', () => {
    expect(extractToolPayload({ content: [{ type: 'text', text: 'plain words' }] })).toBe('plain words');
  });

  it('returns null for a null result and the object itself when shapeless', () => {
    expect(extractToolPayload(null)).toBeNull();
    expect(extractToolPayload({ other: true })).toEqual({ other: true });
  });
});
