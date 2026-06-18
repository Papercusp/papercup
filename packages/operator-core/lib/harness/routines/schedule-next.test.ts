/**
 * Unit tests for the recurrence → next-fire dispatcher (P-006, D-004).
 * Assertions are timezone-robust: they compare DURATIONS between lib-generated
 * instants (and feed the lib's own ISO output back as EXDATE) rather than
 * asserting exact wall-clock instants, so they pass regardless of the runner tz.
 */
import { describe, it, expect } from 'vitest';
import { computeNextFire, computeNextFireFromRrule, expandOccurrences, validateRrule, frequencyWarning, type ScheduleTrigger } from './schedule-next';

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

describe('computeNextFireFromRrule — tzid wall-clock + DST (EI-1370)', () => {
  // A 9am America/New_York daily rule. The ABSOLUTE instant must track the zone's DST offset:
  // 13:00 UTC in summer (EDT, UTC-4), 14:00 UTC in winter (EST, UTC-5).
  const cfg: ScheduleTrigger = {
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    dtstart: '2026-01-01T00:00:00.000Z',
    tzid: 'America/New_York',
  };

  it('fires at 9am wall-clock in the zone, not 9am UTC (summer → 13:00 UTC)', () => {
    const next = computeNextFireFromRrule(cfg, new Date('2026-06-15T00:00:00.000Z'));
    expect(next!.toISOString()).toBe('2026-06-15T13:00:00.000Z'); // 09:00 EDT
  });

  it('honors DST: the same 9am rule is 14:00 UTC in winter (EST)', () => {
    const next = computeNextFireFromRrule(cfg, new Date('2026-12-15T00:00:00.000Z'));
    expect(next!.toISOString()).toBe('2026-12-15T14:00:00.000Z'); // 09:00 EST
  });

  it('without tzid the same rule stays 9am UTC (unchanged legacy behavior)', () => {
    const utc: ScheduleTrigger = { rrule: cfg.rrule, dtstart: cfg.dtstart };
    const next = computeNextFireFromRrule(utc, new Date('2026-06-15T00:00:00.000Z'));
    expect(next!.toISOString()).toBe('2026-06-15T09:00:00.000Z');
  });

  it('expandOccurrences emits zone-correct instants across the spring-forward boundary', () => {
    // US spring-forward 2026 = Mar 8. A 9am rule: Mar 7 is EST (14:00Z), Mar 9 is EDT (13:00Z).
    const occ = expandOccurrences(cfg, new Date('2026-03-07T00:00:00.000Z'), new Date('2026-03-10T00:00:00.000Z'));
    const iso = occ.map((d) => d.toISOString());
    expect(iso).toContain('2026-03-07T14:00:00.000Z'); // EST
    expect(iso).toContain('2026-03-09T13:00:00.000Z'); // EDT
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

describe('expandOccurrences (calendar-window expansion)', () => {
  it('returns every daily occurrence within an inclusive window', () => {
    const cfg: ScheduleTrigger = { rrule: 'FREQ=DAILY', dtstart: '2026-06-01T09:00:00.000Z' };
    const start = new Date('2026-06-10T00:00:00.000Z');
    const end = new Date('2026-06-16T23:59:59.000Z');
    const occ = expandOccurrences(cfg, start, end);
    // Jun 10–16 inclusive = 7 daily fires.
    expect(occ).toHaveLength(7);
    for (const d of occ) {
      expect(d.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(d.getTime()).toBeLessThanOrEqual(end.getTime());
    }
    // strictly ascending
    for (let i = 1; i < occ.length; i++) expect(occ[i].getTime()).toBeGreaterThan(occ[i - 1].getTime());
  });

  it('honors EXDATE within the window', () => {
    const base: ScheduleTrigger = { rrule: 'FREQ=DAILY', dtstart: '2026-06-01T12:00:00.000Z' };
    const start = new Date('2026-06-10T00:00:00.000Z');
    const end = new Date('2026-06-12T23:59:59.000Z');
    const before = expandOccurrences(base, start, end);
    expect(before).toHaveLength(3);
    const withEx: ScheduleTrigger = { ...base, exdate: [before[1].toISOString()] };
    const after = expandOccurrences(withEx, start, end);
    expect(after).toHaveLength(2);
    expect(after.map((d) => d.getTime())).not.toContain(before[1].getTime());
  });

  it('expands a cron schedule by stepping (range with inclusive bounds)', () => {
    const cfg: ScheduleTrigger = { cron: '0 9 * * *' }; // 09:00 daily
    const start = new Date('2026-06-10T00:00:00.000Z');
    const end = new Date('2026-06-14T23:59:59.000Z');
    const occ = expandOccurrences(cfg, start, end);
    expect(occ.length).toBe(5); // Jun 10–14
    for (let i = 1; i < occ.length; i++) expect(occ[i].getTime()).toBeGreaterThan(occ[i - 1].getTime());
  });

  it('returns [] for no recurrence / inverted range / unparseable rule', () => {
    const win = [new Date('2026-06-10T00:00:00Z'), new Date('2026-06-16T00:00:00Z')] as const;
    expect(expandOccurrences(null, ...win)).toEqual([]);
    expect(expandOccurrences({}, ...win)).toEqual([]);
    expect(expandOccurrences({ rrule: 'NOPE' }, ...win)).toEqual([]);
    // inverted range
    expect(expandOccurrences({ rrule: 'FREQ=DAILY' }, win[1], win[0])).toEqual([]);
  });

  it('caps a pathological sub-minute cadence at `limit`', () => {
    const cfg: ScheduleTrigger = { rrule: 'FREQ=MINUTELY', dtstart: '2026-06-10T00:00:00.000Z' };
    const start = new Date('2026-06-10T00:00:00.000Z');
    const end = new Date('2026-06-20T00:00:00.000Z'); // ~14400 minutes
    const occ = expandOccurrences(cfg, start, end, 50);
    expect(occ).toHaveLength(50);
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
