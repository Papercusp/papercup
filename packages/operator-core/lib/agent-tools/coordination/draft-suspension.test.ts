import { describe, expect, it } from 'vitest';
import {
  DRAFT_SUSPENSION_THRESHOLD_MS,
  readDraftSuspension,
  renderDraftSuspensionSuffix,
  suspensionGap,
  type DraftSuspensionStamp,
} from './draft-suspension';

const T0 = Date.parse('2026-08-03T00:55:00.000Z');
const MIN = 60_000;

describe('suspensionGap', () => {
  it('reports nothing when the sender made no recorded calls', () => {
    expect(suspensionGap([], { nowMs: T0 + 60 * MIN })).toBeNull();
  });

  it('does NOT describe a continuously-working agent as suspended', () => {
    // The precision property. A long turn is not a suspended one: an agent calling
    // tools every two minutes for an hour must never be told its draft aged.
    const series = Array.from({ length: 30 }, (_, i) => T0 + i * 2 * MIN);
    const nowMs = T0 + 30 * 2 * MIN;
    expect(suspensionGap(series, { nowMs })).toBeNull();
  });

  it('catches the motivating 45-minute wake-pump interleave (EI-19395608899173941)', () => {
    // Measured at 00:55, interleaved, sent 01:40.
    const measuredAt = T0;
    const resumedAt = Date.parse('2026-08-03T01:40:00.000Z');
    const stamp = suspensionGap([measuredAt], { nowMs: resumedAt });
    expect(stamp).not.toBeNull();
    expect(stamp!.gapMs).toBe(45 * MIN);
    expect(stamp!.gapStartedAt).toBe('2026-08-03T00:55:00.000Z');
    expect(stamp!.openAtSend).toBe(true);
  });

  it('closes the gap at the first call after the resume, not at the send', () => {
    const resumedAt = T0 + 45 * MIN;
    const stamp = suspensionGap([T0, resumedAt, resumedAt + 30_000], { nowMs: resumedAt + 60_000 });
    expect(stamp!.gapMs).toBe(45 * MIN);
    expect(stamp!.gapEndedAt).toBe(new Date(resumedAt).toISOString());
    expect(stamp!.openAtSend).toBe(false);
  });

  it('reports the LARGEST gap when a turn was interrupted more than once', () => {
    const stamp = suspensionGap([T0, T0 + 12 * MIN, T0 + 60 * MIN], { nowMs: T0 + 61 * MIN });
    expect(stamp!.gapMs).toBe(48 * MIN);
  });

  it('holds exactly at the threshold and rejects just under it', () => {
    const atEdge = suspensionGap([T0], { nowMs: T0 + DRAFT_SUSPENSION_THRESHOLD_MS });
    expect(atEdge).not.toBeNull();
    const under = suspensionGap([T0], { nowMs: T0 + DRAFT_SUSPENSION_THRESHOLD_MS - 1 });
    expect(under).toBeNull();
  });

  it('tolerates unsorted, duplicate, future and non-finite rows', () => {
    // The caller reads a DB; a decorative stamp must not be the thing that throws.
    const now = T0 + 40 * MIN;
    const messy = [T0 + 30 * MIN, Number.NaN, T0, T0, now + 5 * MIN, Number.POSITIVE_INFINITY];
    const stamp = suspensionGap(messy, { nowMs: now });
    expect(stamp).not.toBeNull();
    expect(stamp!.gapMs).toBe(30 * MIN);
  });

  it('returns null for a non-finite now rather than emitting an Invalid Date stamp', () => {
    expect(suspensionGap([T0], { nowMs: Number.NaN })).toBeNull();
  });
});

describe('readDraftSuspension', () => {
  it('round-trips a real stamp and rejects malformed envelope values', () => {
    const stamp = suspensionGap([T0], { nowMs: T0 + 45 * MIN })!;
    expect(readDraftSuspension(JSON.parse(JSON.stringify(stamp)))).toEqual(stamp);
    for (const bad of [null, undefined, 'x', 42, {}, { gapMs: 'long' }, { gapMs: 1 }]) {
      expect(readDraftSuspension(bad)).toBeNull();
    }
  });
});

describe('renderDraftSuspensionSuffix', () => {
  it('states the gap without naming which claim is stale', () => {
    const suffix = renderDraftSuspensionSuffix(suspensionGap([T0], { nowMs: T0 + 45 * MIN }));
    expect(suffix).toContain('45m gap');
    expect(suffix).toContain('idle since');
    expect(suffix).toContain('measured claims may predate it');
  });

  it('is empty for a non-stamp, so a clean send gets no suffix', () => {
    expect(renderDraftSuspensionSuffix(null)).toBe('');
    expect(renderDraftSuspensionSuffix({ gapMs: 'nope' })).toBe('');
  });
});

describe('CONTROL: these assertions can actually fail', () => {
  // Kept permanently rather than run once by hand. A guard that has never failed is a
  // guard nobody has tested, and the cheap wrong implementation here is the one a
  // reasonable person would write: measure the whole span instead of the largest GAP.
  // It gets the motivating case right, which is exactly why it is dangerous — only the
  // continuous-activity property tells the two apart.
  const spanNotGap = (
    invokedAtMs: readonly number[],
    opts: { nowMs: number },
  ): DraftSuspensionStamp | null => {
    const series = invokedAtMs.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
    if (!series.length) return null;
    const span = opts.nowMs - series[0]!;
    if (span < DRAFT_SUSPENSION_THRESHOLD_MS) return null;
    return {
      gapMs: span,
      gapStartedAt: new Date(series[0]!).toISOString(),
      gapEndedAt: new Date(opts.nowMs).toISOString(),
      openAtSend: true,
    };
  };

  it('CALIBRATION: the wrong implementation agrees on the motivating case', () => {
    // Without this, the control below could "pass" because the property is untestable
    // rather than because the real implementation is correct.
    const args = { nowMs: Date.parse('2026-08-03T01:40:00.000Z') };
    expect(spanNotGap([T0], args)!.gapMs).toBe(suspensionGap([T0], args)!.gapMs);
  });

  it('CONTROL: span-not-gap mislabels a continuously-working agent, and the real one does not', () => {
    const series = Array.from({ length: 30 }, (_, i) => T0 + i * 2 * MIN);
    const nowMs = T0 + 60 * MIN;
    expect(spanNotGap(series, { nowMs })).not.toBeNull(); // the bug this test would catch
    expect(suspensionGap(series, { nowMs })).toBeNull();
  });
});
