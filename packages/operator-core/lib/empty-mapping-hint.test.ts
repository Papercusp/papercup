/**
 * EI-10892 — the detector must catch the real mis-mapping signature and must NOT
 * cry wolf on a legitimate empty result. A false accusation is worse than silence:
 * it trains agents to distrust true negatives.
 */
import { describe, expect, it } from 'vitest';
import { maybeEmptyMappingHint } from './empty-mapping-hint';

describe('maybeEmptyMappingHint (EI-10892)', () => {
  it('fires on the REAL sessions:search mis-mapping — blank rows NESTED under populated ones', () => {
    // The verbatim shape of the wasted call (2026-07-13). This is the regression that
    // matters: the OUTER rows are fully populated (q, n are real), and only the nested
    // `h` hit-rows are blank — because that is where the per-hit field mapping was
    // applied (sid/ts/own/t instead of provenance.session_id/excerpt). A top-level-only
    // detector calls this healthy, which is the exact false negative it must not have.
    const payload = [
      { q: 'auto-loop reliable', n: 6, h: [{ sid: '', ts: '', own: '', t: '' }, { sid: '', ts: '', own: '', t: '' }] },
      { q: 'auto loop reliability', n: 6, h: [{ sid: '', ts: '', own: '', t: '' }, { sid: '', ts: '', own: '', t: '' }] },
    ];
    const hit = maybeEmptyMappingHint(payload, ['sessions:search']);
    expect(hit).not.toBeNull();
    expect(hit!.text).toContain('MIS-MAPPED RESPONSE SHAPE');
    expect(hit!.text).toContain('sessions:search');
  });

  it('fires on a flat all-blank row set too', () => {
    const payload = [
      { sid: '', ts: '', own: '', t: '' },
      { sid: '', ts: '', own: '', t: '' },
    ];
    expect(maybeEmptyMappingHint(payload)).not.toBeNull();
  });

  it('does NOT fire when the nested rows carry real data', () => {
    // Guard the new nested hop against over-firing: populated inner rows are healthy.
    const payload = [
      { q: 'x', n: 2, h: [{ sid: 'c3a5178a', t: 'real excerpt' }, { sid: '960343fc', t: 'another' }] },
    ];
    expect(maybeEmptyMappingHint(payload)).toBeNull();
  });

  it('fires on the work_items:get mis-mapping', () => {
    const payload = { summary: [{ state: '', title: '', cp: '' }, { state: '', title: '', cp: '' }] };
    const hit = maybeEmptyMappingHint(payload, ['work_items:get']);
    expect(hit).not.toBeNull();
    expect(hit!.blankRows).toBe(2);
  });

  it('does NOT fire on a legitimately empty result set (no rows at all)', () => {
    expect(maybeEmptyMappingHint([])).toBeNull();
    expect(maybeEmptyMappingHint({ results: [] })).toBeNull();
  });

  it('does NOT fire when rows carry real data', () => {
    const payload = [
      { id: 'EI-1', title: 'a real title' },
      { id: 'EI-2', title: 'another' },
    ];
    expect(maybeEmptyMappingHint(payload)).toBeNull();
  });

  it('does NOT fire on a partially-populated result (some rows genuinely blank)', () => {
    // A real query CAN return sparse rows; only an overwhelming blank ratio accuses.
    const payload = [
      { id: 'EI-1', title: 'real' },
      { id: '', title: '' },
      { id: 'EI-3', title: 'real' },
      { id: 'EI-4', title: 'real' },
    ];
    expect(maybeEmptyMappingHint(payload)).toBeNull();
  });

  it('treats 0 and false as REAL values, not blanks', () => {
    // The nastiest false-positive: a count of 0 is a real answer, not a missing field.
    const payload = [
      { count: 0, ok: false },
      { count: 0, ok: false },
    ];
    expect(maybeEmptyMappingHint(payload)).toBeNull();
  });

  it('does not accuse on a single blank row (too weak a signal)', () => {
    expect(maybeEmptyMappingHint([{ a: '', b: '' }])).toBeNull();
  });

  it('ignores non-object rows (there is no field mapping to get wrong)', () => {
    expect(maybeEmptyMappingHint(['', '', ''])).toBeNull();
    expect(maybeEmptyMappingHint([1, 2, 3])).toBeNull();
  });

  it('never throws on odd payloads', () => {
    expect(() => maybeEmptyMappingHint(null)).not.toThrow();
    expect(() => maybeEmptyMappingHint(undefined)).not.toThrow();
    expect(() => maybeEmptyMappingHint('a string')).not.toThrow();
    expect(maybeEmptyMappingHint(null)).toBeNull();
  });
});
