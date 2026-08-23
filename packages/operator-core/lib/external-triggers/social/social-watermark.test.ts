/**
 * The shared client-side watermark (extracted during P-018).
 *
 * WHAT THESE TESTS ARE ACTUALLY FOR. The equal-instant case is the entire
 * reason this module exists, and it is the one an implementation gets subtly
 * wrong in each place independently — which is exactly what happened before the
 * extraction, where Facebook Pages and Instagram had grown two copies that had
 * already drifted apart in three ways. So the cases below are weighted toward
 * the boundary rather than toward the obvious newer/older comparisons.
 *
 * Several cases are paired with a CONTROL demonstrating what the naive
 * implementation does, because "the watermark advanced" is true of both a
 * correct implementation and one that loses an event every time two items share
 * a second.
 */
import { describe, expect, it } from 'vitest';
import {
  isSocialWatermarkCursor,
  socialAdvanceWatermark,
  socialInstantMs,
  socialIsNewAgainstWatermark,
  type SocialWatermarkCursor,
} from './social-watermark';

const MARK = '2026-08-23T12:00:00+0000';

function cursor(watermark: string, boundaryIds: string[]): SocialWatermarkCursor {
  return { watermark, boundaryIds };
}

describe('socialInstantMs — format tolerance is deliberate', () => {
  it('parses the ISO 8601 BASIC offset Instagram documents (+0000, no colon)', () => {
    expect(socialInstantMs('2017-05-19T23:27:28+0000')).toBe(Date.parse('2017-05-19T23:27:28Z'));
  });

  it('parses the extended offset and Z alike, because Threads never documents its spelling', () => {
    const z = socialInstantMs('2026-08-23T12:00:00Z');
    expect(socialInstantMs('2026-08-23T12:00:00+00:00')).toBe(z);
    expect(socialInstantMs('2026-08-23T12:00:00+0000')).toBe(z);
  });

  it('returns null rather than NaN for junk, so callers can branch on it', () => {
    expect(socialInstantMs('not-a-date')).toBeNull();
    expect(socialInstantMs('')).toBeNull();
    expect(socialInstantMs(null)).toBeNull();
    expect(socialInstantMs(undefined)).toBeNull();
  });

  it('CONTROL: an RFC-3339-only regex would reject the real Instagram format', () => {
    // The failure this tolerance prevents is silent: a rejected timestamp makes
    // every item look un-placeable, which downstream reads as "no new items"
    // rather than as a parse error.
    const rfc3339Only = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
    expect(rfc3339Only.test('2017-05-19T23:27:28+0000')).toBe(false);
    expect(socialInstantMs('2017-05-19T23:27:28+0000')).not.toBeNull();
  });
});

describe('isSocialWatermarkCursor — a mark that cannot be placed is not a cursor', () => {
  it('accepts a well-formed cursor', () => {
    expect(isSocialWatermarkCursor(cursor(MARK, ['a']))).toBe(true);
    expect(isSocialWatermarkCursor(cursor(MARK, []))).toBe(true);
  });

  it('REJECTS an unparseable watermark rather than trusting the string', () => {
    // This is the drift that mattered: one of the two prior copies checked only
    // that the string was non-empty. A mark that cannot be placed on a timeline
    // excludes nothing, so treating it as valid re-emits the whole window every
    // pass while looking perfectly healthy. Rejecting degrades to a cold start,
    // which is loud and bounded.
    expect(isSocialWatermarkCursor(cursor('yesterday', ['a']))).toBe(false);
    expect(isSocialWatermarkCursor(cursor('', ['a']))).toBe(false);
  });

  it('rejects wrong shapes without throwing', () => {
    expect(isSocialWatermarkCursor(null)).toBe(false);
    expect(isSocialWatermarkCursor(undefined)).toBe(false);
    expect(isSocialWatermarkCursor('a string')).toBe(false);
    expect(isSocialWatermarkCursor({ watermark: MARK })).toBe(false);
    expect(isSocialWatermarkCursor({ watermark: MARK, boundaryIds: [1] })).toBe(false);
  });
});

describe('socialIsNewAgainstWatermark', () => {
  it('everything is new with no stored cursor', () => {
    expect(socialIsNewAgainstWatermark(null, MARK, 'a')).toBe(true);
  });

  it('strictly newer is new; strictly older is not', () => {
    const stored = cursor(MARK, ['a']);
    expect(socialIsNewAgainstWatermark(stored, '2026-08-23T12:00:01+0000', 'b')).toBe(true);
    expect(socialIsNewAgainstWatermark(stored, '2026-08-23T11:59:59+0000', 'b')).toBe(false);
  });

  it('AT THE MARK, the id decides — this is the whole point of boundaryIds', () => {
    const stored = cursor(MARK, ['a']);
    // Already emitted at this instant: not new.
    expect(socialIsNewAgainstWatermark(stored, MARK, 'a')).toBe(false);
    // A SIBLING at the same instant we have never seen: new.
    expect(socialIsNewAgainstWatermark(stored, MARK, 'b')).toBe(true);
  });

  it('CONTROL: a bare `>` loses the sibling and a bare `>=` re-emits forever', () => {
    const stored = cursor(MARK, ['a']);
    const at = socialInstantMs(MARK)!;
    const mark = socialInstantMs(stored.watermark)!;

    // The naive alternatives, side by side with the real answer.
    const naiveGreater = at > mark; // false → sibling 'b' dropped permanently
    const naiveGreaterEq = at >= mark; // true  → 'a' re-emitted on every pass

    expect(naiveGreater).toBe(false);
    expect(socialIsNewAgainstWatermark(stored, MARK, 'b')).toBe(true);

    expect(naiveGreaterEq).toBe(true);
    expect(socialIsNewAgainstWatermark(stored, MARK, 'a')).toBe(false);
  });

  it('an UNPARSEABLE instant is emitted, not dropped', () => {
    // Chosen deliberately: a duplicate is absorbed by the dedupe key downstream,
    // a drop is permanent and silent.
    expect(socialIsNewAgainstWatermark(cursor(MARK, ['a']), 'garbage', 'b')).toBe(true);
  });
});

describe('socialAdvanceWatermark', () => {
  it('sets the mark from nothing', () => {
    expect(socialAdvanceWatermark(null, MARK, 'a')).toEqual({ watermark: MARK, boundaryIds: ['a'] });
  });

  it('advancing past the mark REPLACES the boundary set rather than appending', () => {
    const next = socialAdvanceWatermark(cursor(MARK, ['a', 'b']), '2026-08-23T12:00:05+0000', 'c');
    // Ids at the old instant can no longer collide with anything, so carrying
    // them would grow the cursor without bound.
    expect(next).toEqual({ watermark: '2026-08-23T12:00:05+0000', boundaryIds: ['c'] });
  });

  it('at the mark, the id JOINS the boundary set', () => {
    expect(socialAdvanceWatermark(cursor(MARK, ['a']), MARK, 'b')).toEqual({
      watermark: MARK,
      boundaryIds: ['a', 'b'],
    });
  });

  it('is idempotent at the mark — re-folding the same id changes nothing', () => {
    const stored = cursor(MARK, ['a']);
    expect(socialAdvanceWatermark(stored, MARK, 'a')).toBe(stored);
  });

  it('an OLDER item never regresses the mark', () => {
    // Load-bearing for the Threads adapter, which emits in provider order
    // (newest-first) while filtering against the ORIGINAL mark. If an older item
    // could pull the mark back, every pass would end positioned behind where it
    // started.
    const stored = cursor(MARK, ['a']);
    expect(socialAdvanceWatermark(stored, '2026-08-23T11:00:00+0000', 'old')).toBe(stored);
  });

  it('an unparseable instant leaves the cursor exactly as it was', () => {
    const stored = cursor(MARK, ['a']);
    expect(socialAdvanceWatermark(stored, 'garbage', 'b')).toBe(stored);
    expect(socialAdvanceWatermark(null, 'garbage', 'b')).toBeNull();
  });

  it('newest-first folding lands on the NEWEST, whatever order items arrive in', () => {
    const items: [string, string][] = [
      ['2026-08-23T12:00:09+0000', 'c'],
      ['2026-08-23T12:00:05+0000', 'b'],
      ['2026-08-23T12:00:01+0000', 'a'],
    ];
    let c: SocialWatermarkCursor | null = null;
    for (const [ts, id] of items) c = socialAdvanceWatermark(c, ts, id);
    expect(c).toEqual({ watermark: '2026-08-23T12:00:09+0000', boundaryIds: ['c'] });

    // ...and the same set folded oldest-first reaches the identical position.
    let d: SocialWatermarkCursor | null = null;
    for (const [ts, id] of [...items].reverse()) d = socialAdvanceWatermark(d, ts, id);
    expect(d).toEqual(c);
  });
});
