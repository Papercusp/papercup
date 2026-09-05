import { describe, it, expect } from 'vitest';
import { normalizeSubjectSignature } from './escalations';

/**
 * EI-19474857043229377 — the summary-derived dedup key must neutralize ROTATING
 * tokens, or one continuous condition mints an unbounded flood of un-coalesced
 * escalation rows (each of which re-runs the full open cascade).
 *
 * FALSIFIABILITY (permanent naive control, per the repo's mutation-probe tiers):
 * the subject here is an imported MODULE, so the control is a deliberately-wrong
 * implementation kept permanently in this file rather than an in-tree mutation.
 * `naiveNormalize` is the pre-fix normalizer — duration handling only. Every
 * collapse assertion below is paired with a control assertion proving the naive
 * version FAILS it, so deleting VOLATILE_HEX_TOKEN_RE from the real normalizer
 * turns these green tests red instead of leaving them vacuously passing.
 */
const NAIVE_VOLATILE_DURATION_RE = /(^|\s)\d+(?:\.\d+)?\s?(?:ms|s|m|h|d)\b/g;
function naiveNormalize(summary: string): string {
  return summary
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(NAIVE_VOLATILE_DURATION_RE, '$1<dur>');
}

/**
 * The five REAL signatures measured in production (papercusp-workspace,
 * coord_event_log surface='escalations', 7d window to 2026-09-05) — one
 * continuous condition, five keys, 179 un-coalesced opens.
 */
const MEASURED_GREEN_CHECKPOINT_SIGNATURES = [
  'green-checkpoint held: 6653fb41 push failed',
  'green-checkpoint held: 0092c7ab push failed',
  'green-checkpoint held: 5384ef26 push failed',
  'green-checkpoint held: 0ac0c3b1 push failed',
  'green-checkpoint held: e5e6747d push failed',
] as const;

describe('normalizeSubjectSignature — rotating-sha collapse (EI-19474857043229377)', () => {
  it('collapses the five measured green-checkpoint signatures onto ONE dedup key', () => {
    const keys = new Set(MEASURED_GREEN_CHECKPOINT_SIGNATURES.map(normalizeSubjectSignature));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('green-checkpoint held: <sha> push failed');
  });

  it('CONTROL: the pre-fix normalizer leaves all five distinct (so the assertion above can fail)', () => {
    const naiveKeys = new Set(MEASURED_GREEN_CHECKPOINT_SIGNATURES.map(naiveNormalize));
    expect(naiveKeys.size).toBe(5);
  });

  it('CALIBRATION: the control instrument is not simply broken — it still collapses durations', () => {
    expect(naiveNormalize('goal idle for 50m')).toBe('goal idle for <dur>');
    expect(naiveNormalize('goal idle for 81m')).toBe('goal idle for <dur>');
  });

  it('is case-insensitive (uppercase shas normalize to the same key)', () => {
    expect(normalizeSubjectSignature('gate held: 6653FB41 failed')).toBe(
      normalizeSubjectSignature('gate held: 6653fb41 failed'),
    );
  });

  it('collapses a full 40-char sha', () => {
    expect(normalizeSubjectSignature('candidate d153d9980dd2fefb3cd33645494213b1e6c3dc1b red')).toBe(
      'candidate <sha> red',
    );
  });
});

describe('normalizeSubjectSignature — narrowness guards (no false collapses)', () => {
  it('leaves all-letter hex-alphabet words alone (no digit ⇒ not a hash)', () => {
    // Without the digit guard these 7+ char words are valid hex and would collapse.
    for (const word of ['effaced', 'defaced', 'deadbeef']) {
      expect(normalizeSubjectSignature(`record ${word} today`)).toBe(`record ${word} today`);
    }
  });

  it('leaves bare decimal runs alone (no hex letter ⇒ a number, not a hash)', () => {
    expect(normalizeSubjectSignature('count 12345678 rows')).toBe('count 12345678 rows');
  });

  it('leaves suffixed identifiers alone (not a whole whitespace-delimited token)', () => {
    // A work-item id: the hex-ish run is preceded by '-', not whitespace.
    expect(normalizeSubjectSignature('item EI-19474857043229377 stalled')).toBe(
      'item ei-19474857043229377 stalled',
    );
  });

  it('leaves short hex runs alone (below the 7-char floor)', () => {
    expect(normalizeSubjectSignature('port 3f2a1 down')).toBe('port 3f2a1 down');
  });

  it('keeps genuinely-distinct subjects distinct', () => {
    expect(normalizeSubjectSignature('panel:infra crit')).not.toBe(
      normalizeSubjectSignature('panel:deploy crit'),
    );
  });
});

describe('normalizeSubjectSignature — pre-existing duration behaviour is preserved', () => {
  it('still collapses durations to <dur>', () => {
    expect(normalizeSubjectSignature('goal idle for 50m')).toBe('goal idle for <dur>');
    expect(normalizeSubjectSignature('goal idle for 81m')).toBe('goal idle for <dur>');
  });

  it('still leaves the documented duration non-matches untouched', () => {
    expect(normalizeSubjectSignature('pot alpha-1')).toBe('pot alpha-1');
    expect(normalizeSubjectSignature('disk 80% full')).toBe('disk 80% full');
    expect(normalizeSubjectSignature('harness-3d')).toBe('harness-3d');
  });

  it('collapses both token classes in one summary', () => {
    expect(normalizeSubjectSignature('candidate 6653fb41 held for 12m')).toBe(
      'candidate <sha> held for <dur>',
    );
  });
});
