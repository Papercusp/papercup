/**
 * predicate-watch.test.ts — unit coverage for the pure predicate helpers
 * (fleet-deltas-leader-primitives-2026-07-10 P-008): dot-path extraction,
 * op evaluation, tool-result payload extraction, and the poller's dispatch deadline.
 * The store + poller +
 * edge-fire lifecycle is covered in predicate-watch.integration.test.ts
 * (real PG, fake dispatch via configurePredicateDispatch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  valueAtPath,
  comparePredicate,
  predicateShaShapeMismatch,
  predicateShaShapeMismatchMessage,
  extractToolPayload,
  INTERNAL_MACHINE_DISPATCH_PAYLOAD_CONTEXT,
  configurePredicateDispatch,
  dispatchPredicateTool,
  withPredicateDispatchTimeout,
  type PredicateWatchRow,
} from './predicate-watch';

describe('WI-7060 — predicate dispatch deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    configurePredicateDispatch(null);
    vi.useRealTimers();
  });

  it('aborts and rejects with a typed timeout when the resolver never settles', async () => {
    let signal: AbortSignal | undefined;
    const pending = withPredicateDispatchTimeout(
      (receivedSignal) => {
        signal = receivedSignal;
        return new Promise(() => {});
      },
      { tool: 'fake:read', timeoutMs: 25 },
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'ReadOnlyDispatchError',
      code: 'dispatch_timeout',
      message: 'predicate resolver ("fake:read") did not respond within 25ms',
    });

    await vi.advanceTimersByTimeAsync(25);
    await assertion;

    expect(signal?.aborted).toBe(true);
  });

  it('is wired around the canonical predicate dispatcher, including its test seam', async () => {
    const row = { tool: 'fake:read' } as PredicateWatchRow;
    configurePredicateDispatch(() => new Promise(() => {}));
    const pending = dispatchPredicateTool(row, 25);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'dispatch_timeout' });

    await vi.advanceTimersByTimeAsync(25);

    await assertion;
  });

  it('preserves a resolver result that arrives just under the deadline and clears the timer', async () => {
    let signal: AbortSignal | undefined;
    const pending = withPredicateDispatchTimeout(
      (receivedSignal) => {
        signal = receivedSignal;
        return new Promise((resolve) => setTimeout(() => resolve({ wm: 128 }), 24));
      },
      { tool: 'fake:read', timeoutMs: 25 },
    );

    await vi.advanceTimersByTimeAsync(24);

    await expect(pending).resolves.toEqual({ wm: 128 });
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('internal machine-dispatch payload context', () => {
  it('bypasses both tier shaping and the hard transport ceiling before path projection', () => {
    expect(INTERNAL_MACHINE_DISPATCH_PAYLOAD_CONTEXT).toEqual({
      contextTier: 'full',
      payloadTierOverride: 'full',
      transportCapExempt: true,
    });
  });
});

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

  // A watch fires a WAKE, so a spurious true is a false all-clear that resumes an
  // agent on a condition never established. `ne` is the natural readiness idiom
  // ("wake me when `blocked` is no longer true") and used to fire on BOTH an
  // UNKNOWN (null) and a MISSPELLED path (undefined).
  it('ne — an absent observation never satisfies "is not X"', () => {
    expect(comparePredicate(true, 'ne', true)).toBe(false); // genuinely still blocked
    expect(comparePredicate(false, 'ne', true)).toBe(true); // genuinely unblocked — the only true
    expect(comparePredicate(null, 'ne', true)).toBe(false); // 3-valued UNKNOWN establishes nothing
    expect(comparePredicate(undefined, 'ne', true)).toBe(false); // misspelled path
  });

  it('ne — a typo\'d dot-path cannot manufacture a wake', () => {
    const cell = { blocked: null as boolean | null, health: 'advancing' };
    expect(valueAtPath(cell, 'blocekd')).toBeUndefined();
    expect(comparePredicate(valueAtPath(cell, 'blocekd'), 'ne', true)).toBe(false);
  });

  it('asking about absence stays explicit — exists, and eq against null', () => {
    expect(comparePredicate(null, 'exists', undefined)).toBe(false);
    expect(comparePredicate(null, 'eq', null)).toBe(true); // "is it UNKNOWN?" — yes
    expect(comparePredicate(false, 'eq', null)).toBe(false); // a known false is not unknown
    expect(comparePredicate(undefined, 'eq', null)).toBe(false); // a missing path is not a reported unknown
  });
});

describe('predicate SHA operand shape guard', () => {
  const full = 'e66be3c4ff7b00d91d44334d7299464af47b7aeb';
  const short = full.slice(0, 10);

  it('identifies a strict short/full SHA prefix and reports both widths', () => {
    const mismatch = predicateShaShapeMismatch(full, short);
    expect(mismatch).toEqual({ observedWidth: 40, operandWidth: 10 });
    expect(predicateShaShapeMismatchMessage(mismatch!)).toContain('40 characters');
    expect(predicateShaShapeMismatchMessage(mismatch!)).toContain('10 characters');
    expect(predicateShaShapeMismatchMessage(mismatch!)).toContain('predicate_shape_mismatch');
  });

  it('does not classify equal-width, unrelated, or non-SHA strings as a shape mismatch', () => {
    expect(predicateShaShapeMismatch(full, full)).toBeNull();
    expect(predicateShaShapeMismatch(full, '0123456789abcdef0123456789abcdef01234567')).toBeNull();
    expect(predicateShaShapeMismatch('not-a-sha-value', short)).toBeNull();
  });

  it('prevents a short/full prefix from manufacturing a true `ne` result', () => {
    expect(comparePredicate(full, 'ne', short)).toBe(false);
    expect(comparePredicate(full, 'ne', '0123456789')).toBe(true);
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
