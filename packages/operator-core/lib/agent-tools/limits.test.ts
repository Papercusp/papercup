/**
 * Regression guard for the agent-tool string-limit layer
 * (agent-tooling-token-efficiency-2026-06-25 P-004, blocked-by P-001).
 *
 * A telemetry audit found ~1,000+ agent tool calls/14d FAILED purely on too-long
 * string args. The two structural fixes — softText (accept+truncate, never reject)
 * and a sane set of tiers — must not silently regress (e.g. a future edit slipping
 * a tight `.max()` back onto a soft field, or lowering a tier). These assertions are
 * deliberately mechanism-level (low false-positive): they pin the helpers' contract,
 * not any one field's wording.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { LIMITS, hardText, softText, clampText } from './limits';

// z.toJSONSchema is a static on the zod namespace; cast for the call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJSONSchema = (s: unknown): Record<string, unknown> => (z as any).toJSONSchema(s);

describe('limits — tiers', () => {
  it('exposes sane, ascending char tiers', () => {
    expect(LIMITS.IDENT).toBeLessThan(LIMITS.SHORT_TITLE);
    expect(LIMITS.SHORT_TITLE).toBeLessThan(LIMITS.ANNOTATION);
    expect(LIMITS.ANNOTATION).toBeLessThan(LIMITS.BRIEF);
    expect(LIMITS.BRIEF).toBeLessThanOrEqual(LIMITS.CONTENT);
    expect(LIMITS.CONTENT).toBeLessThan(LIMITS.BODY);
  });

  it('never drops a tier below its established floor (caps only raise)', () => {
    // These are minimums: a future edit may RAISE a tier, never LOWER it.
    expect(LIMITS.IDENT).toBeGreaterThanOrEqual(200);
    expect(LIMITS.SHORT_TITLE).toBeGreaterThanOrEqual(1000);
    expect(LIMITS.ANNOTATION).toBeGreaterThanOrEqual(2000);
    expect(LIMITS.BRIEF).toBeGreaterThanOrEqual(16000);
    expect(LIMITS.CONTENT).toBeGreaterThanOrEqual(16000);
    expect(LIMITS.BODY).toBeGreaterThanOrEqual(32000);
  });
});

describe('limits — softText (accept, never reject)', () => {
  it('accepts an over-length value WITHOUT error (the failure class P-001 kills)', () => {
    const over = 'x'.repeat(LIMITS.ANNOTATION * 3);
    // The whole point: a soft field must never throw on length. If this starts
    // throwing, someone re-introduced a hard `.max()` on a soft field.
    expect(() => softText(LIMITS.ANNOTATION).parse(over)).not.toThrow();
    expect(softText(LIMITS.ANNOTATION).parse(over)).toBe(over);
  });

  it('with { min } still rejects an EMPTY string (keeps a non-empty requirement)', () => {
    expect(() => softText(LIMITS.ANNOTATION, { min: 1 }).parse('')).toThrow();
    expect(softText(LIMITS.ANNOTATION, { min: 1 }).parse('ok')).toBe('ok');
  });

  it('advertises a plain string with no maxLength (representable in JSON Schema)', () => {
    // A transform would crash z.toJSONSchema at defineTool registration; softText
    // must stay representable as a plain string.
    const js = toJSONSchema(softText(LIMITS.BRIEF));
    expect(js.type).toBe('string');
    expect(js.maxLength).toBeUndefined();
  });
});

describe('limits — hardText (reject over cap, recoverably)', () => {
  it('rejects over the cap and accepts at the cap', () => {
    expect(() => hardText(LIMITS.SHORT_TITLE).parse('x'.repeat(LIMITS.SHORT_TITLE + 1))).toThrow();
    expect(hardText(LIMITS.SHORT_TITLE).parse('x'.repeat(LIMITS.SHORT_TITLE))).toHaveLength(LIMITS.SHORT_TITLE);
  });

  it('defaults to a non-empty (min 1) requirement', () => {
    expect(() => hardText(LIMITS.SHORT_TITLE).parse('')).toThrow();
  });

  it('advertises the maxLength so agents see the cap', () => {
    const js = toJSONSchema(hardText(LIMITS.IDENT));
    expect(js.maxLength).toBe(LIMITS.IDENT);
    expect(js.minLength).toBe(1);
  });
});

describe('limits — clampText (handler-side truncation for soft fields)', () => {
  it('truncates an over-length string to the cap', () => {
    expect(clampText('x'.repeat(5000), LIMITS.ANNOTATION)).toHaveLength(LIMITS.ANNOTATION);
  });

  it('passes a within-cap string through untouched', () => {
    expect(clampText('short', LIMITS.ANNOTATION)).toBe('short');
  });

  it('passes through undefined / null (optional fields)', () => {
    expect(clampText(undefined, LIMITS.ANNOTATION)).toBeUndefined();
    expect(clampText(null, LIMITS.ANNOTATION)).toBeNull();
  });
});
