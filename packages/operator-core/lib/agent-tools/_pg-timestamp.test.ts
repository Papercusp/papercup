/**
 * Guards `toIso` against the defect that left `testing:runs` and `db:migrations` dead on
 * EVERY call: a timestamptz column reads back as a STRING on the canonical client, so a
 * formatter spelled `d.toISOString()` threw `d2.toISOString is not a function` on the
 * first row while the hand-declared `Date` row type kept it typechecking clean.
 */
import { describe, it, expect } from 'vitest';
import { toIso } from './_pg-timestamp';

describe('toIso', () => {
  it('accepts the STRING a timestamptz column actually returns', () => {
    // The measured shape: postgres renders timestamptz with a space separator and a
    // numeric offset, NOT the ISO "T"/"Z" form.
    expect(toIso('2026-08-13 03:25:16.539+00')).toBe('2026-08-13T03:25:16.539Z');
    expect(toIso('2026-08-12 23:25:16.539-04')).toBe('2026-08-13T03:25:16.539Z');
    // ...and the already-ISO form, which is what most callers eyeball.
    expect(toIso('2026-08-13T03:25:16.539Z')).toBe('2026-08-13T03:25:16.539Z');
  });

  it('still accepts a real Date, so an OID-1114 column keeps working', () => {
    expect(toIso(new Date('2026-08-13T03:25:16.539Z'))).toBe('2026-08-13T03:25:16.539Z');
  });

  it('accepts epoch milliseconds — the shape a bigint *_ts column takes', () => {
    expect(toIso(1786591516539)).toBe('2026-08-13T03:25:16.539Z');
  });

  it('returns null for absent values rather than throwing', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso('')).toBeNull();
    expect(toIso('   ')).toBeNull();
  });

  it('returns null — never the string "Invalid Date" — for junk', () => {
    // A formatter that renders "Invalid Date" into a tool result is worse than one that
    // omits the field: it reads as a real timestamp downstream.
    expect(toIso('not a timestamp')).toBeNull();
    expect(toIso(new Date('nonsense'))).toBeNull();
    expect(toIso(Number.NaN)).toBeNull();
    expect(toIso(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toIso({})).toBeNull();
  });

  it('CONTROL: the old Date-only spelling throws on the string the driver returns', () => {
    // Pins WHY this helper exists. If this control ever stops throwing, the driver began
    // returning Dates and the row annotations should be revisited — but until then, a
    // `d.toISOString()` formatter over a timestamptz column is a live defect.
    const oldSpelling = (d: any) => (d ? d.toISOString() : null);
    expect(() => oldSpelling('2026-08-13 03:25:16.539+00')).toThrow(/toISOString is not a function/);
    expect(toIso('2026-08-13 03:25:16.539+00')).toBe('2026-08-13T03:25:16.539Z');
  });
});
