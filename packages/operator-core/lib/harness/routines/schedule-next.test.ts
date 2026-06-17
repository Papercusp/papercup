/**
 * Unit tests for the recurrence → next-fire dispatcher (P-006, D-004).
 * Assertions are timezone-robust: they compare DURATIONS between lib-generated
 * instants (and feed the lib's own ISO output back as EXDATE) rather than
 * asserting exact wall-clock instants, so they pass regardless of the runner tz.
 */
import { describe, it, expect } from 'vitest';
import { computeNextFire, computeNextFireFromRrule, validateRrule, frequencyWarning, type ScheduleTrigger } from './schedule-next';

const DAY = 24 * 60 * 60 * 1000;

describe('computeNextFireFromRrule', () => {
  it('returns the next daily occurrence strictly after `from` (within 24h)', () => {
    const cfg: ScheduleTrigger = { rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z' };
    const from = new Date('2026-06-16T08:00:00.000Z');
    const next = computeNextFireFromRrule(cfg, from);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
    expect(next!.getTime() - from.getTime()).toBeLessThanOrEqual(DAY + 1000);
  });

  it('expresses "every 2 weeks" — the cron-impossible case (interval from anchor)', () => {
    const cfg: ScheduleTrigger = { rrule: 'FREQ=WEEKLY;INTERVAL=2', dtstart: '2026-01-06T09:00:00.000Z' };
    const from = new Date('2026-06-01T00:00:00.000Z');
    const first = computeNextFireFromRrule(cfg, from);
    expect(first).not.toBeNull();
    const second = computeNextFireFromRrule(cfg, first!);
    expect(second).not.toBeNull();
    // Two consecutive occurrences are exactly 14 days apart — cron cannot do this.
    expect(second!.getTime() - first!.getTime()).toBe(14 * DAY);
  });

  it('honors COUNT exhaustion (no further occurrence → null)', () => {
    const cfg: ScheduleTrigger = { rrule: 'FREQ=DAILY;COUNT=1', dtstart: '2026-01-01T09:00:00.000Z' };
    // `from` is well past the single (COUNT=1) occurrence.
    const next = computeNextFireFromRrule(cfg, new Date('2026-06-16T00:00:00.000Z'));
    expect(next).toBeNull();
  });

  it('honors UNTIL exhaustion (past the end date → null)', () => {
    const cfg: ScheduleTrigger = {
      rrule: 'FREQ=DAILY;UNTIL=20260201T000000Z',
      dtstart: '2026-01-01T09:00:00.000Z',
    };
    const next = computeNextFireFromRrule(cfg, new Date('2026-06-16T00:00:00.000Z'));
    expect(next).toBeNull();
  });

  it('skips an EXDATE-excluded occurrence (edit-this-occurrence model)', () => {
    const base: ScheduleTrigger = { rrule: 'FREQ=DAILY', dtstart: '2026-01-01T12:00:00.000Z' };
    const from = new Date('2026-06-10T00:00:00.000Z');
    const occ = computeNextFireFromRrule(base, from);
    expect(occ).not.toBeNull();
    // Exclude exactly that occurrence (feed the lib's own instant back as EXDATE).
    const withEx: ScheduleTrigger = { ...base, exdate: [occ!.toISOString()] };
    const afterEx = computeNextFireFromRrule(withEx, from);
    expect(afterEx).not.toBeNull();
    expect(afterEx!.getTime()).toBeGreaterThan(occ!.getTime());
  });

  it('returns null for empty / unparseable rrule', () => {
    expect(computeNextFireFromRrule({ rrule: '' }, new Date())).toBeNull();
    expect(computeNextFireFromRrule({ rrule: '   ' }, new Date())).toBeNull();
    expect(computeNextFireFromRrule({ rrule: 'NOT A RULE' }, new Date('2026-06-16T00:00:00Z'))).toBeNull();
  });
});

describe('computeNextFire (dispatcher)', () => {
  it('routes RRULE configs to the rrule branch', () => {
    const from = new Date('2026-06-16T08:00:00.000Z');
    const next = computeNextFire({ rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z' }, from);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });

  it('routes cron configs to the cron branch', () => {
    const from = new Date('2026-06-16T08:00:00.000Z');
    const next = computeNextFire({ cron: '0 9 * * *' }, from);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });

  it('prefers RRULE when both are present', () => {
    const from = new Date('2026-06-01T00:00:00.000Z');
    const cfg: ScheduleTrigger = {
      rrule: 'FREQ=WEEKLY;INTERVAL=2',
      dtstart: '2026-01-06T09:00:00.000Z',
      cron: '0 9 * * *',
    };
    const first = computeNextFire(cfg, from)!;
    const second = computeNextFire(cfg, first)!;
    // 14-day spacing proves the rrule branch (not cron) produced these.
    expect(second.getTime() - first.getTime()).toBe(14 * DAY);
  });

  it('returns null for null / empty config', () => {
    expect(computeNextFire(null, new Date())).toBeNull();
    expect(computeNextFire(undefined, new Date())).toBeNull();
    expect(computeNextFire({}, new Date())).toBeNull();
  });
});

describe('validateRrule', () => {
  it('accepts a well-formed rrule', () => {
    expect(validateRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toEqual({ ok: true });
    expect(validateRrule('FREQ=DAILY;INTERVAL=2')).toEqual({ ok: true });
    expect(validateRrule('FREQ=MONTHLY;BYDAY=2TU')).toEqual({ ok: true });
  });

  it('rejects empty / whitespace', () => {
    expect(validateRrule('').ok).toBe(false);
    expect(validateRrule('   ').ok).toBe(false);
  });

  it('rejects an rrule with no FREQ', () => {
    const r = validateRrule('BYDAY=MO');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/FREQ/);
  });
});

describe('frequencyWarning', () => {
  const from = new Date('2026-06-16T00:00:00.000Z');
  it('warns on a sub-15-min cadence', () => {
    const w = frequencyWarning({ kind: 'cron', cron: '*/5 * * * *' }, from);
    expect(w).toBeTruthy();
    expect(w).toMatch(/frequently/);
  });
  it('does not warn on a daily cadence', () => {
    expect(frequencyWarning({ kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00Z' }, from)).toBeNull();
  });
  it('does not warn for a one-shot / null', () => {
    expect(frequencyWarning(null, from)).toBeNull();
    expect(frequencyWarning({ kind: 'rrule', rrule: 'FREQ=DAILY;COUNT=1', dtstart: '2026-01-01T09:00:00Z' }, from)).toBeNull();
  });
});
