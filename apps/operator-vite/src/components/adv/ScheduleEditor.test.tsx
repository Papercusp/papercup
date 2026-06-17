// @vitest-environment node
/**
 * ScheduleEditor pure-helper tests (scheduled-recurring-plans-2026-06-16 P-020).
 * buildSchedulePayload is the RRULE/payload construction the plans:set-schedule
 * write path depends on; assert it tz-independently (structure + RRULE string).
 */
import { describe, expect, it } from 'vitest';
import { buildSchedulePayload, describeForm, type RecurrenceForm } from './ScheduleEditor';

const BASE: RecurrenceForm = {
  mode: 'recurring',
  oneShotAt: '2026-07-01T09:30',
  freq: 'WEEKLY',
  interval: 1,
  weekdays: [],
  startAt: '2026-07-01T09:30',
  until: '',
  tzid: 'America/New_York',
};

describe('buildSchedulePayload', () => {
  it('one-shot ⇒ scheduledAt set, schedule null', () => {
    const p = buildSchedulePayload({ ...BASE, mode: 'one-shot' });
    expect(p.schedule).toBeNull();
    expect(p.scheduledAt).toBeTruthy();
    expect(new Date(p.scheduledAt as string).toISOString()).toBe(p.scheduledAt);
    expect(p.expiresAt).toBeNull();
  });

  it('weekly with weekdays ⇒ FREQ=WEEKLY + BYDAY in canonical order', () => {
    const p = buildSchedulePayload({ ...BASE, freq: 'WEEKLY', weekdays: ['WE', 'MO'] });
    expect(p.schedule?.kind).toBe('rrule');
    expect(p.schedule?.rrule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE');
    expect(p.schedule?.tzid).toBe('America/New_York');
    expect(p.schedule?.dtstart).toBeTruthy();
    expect(p.scheduledAt).toBeNull();
  });

  it('weekly without weekdays ⇒ no BYDAY (recurs on dtstart weekday)', () => {
    const p = buildSchedulePayload({ ...BASE, freq: 'WEEKLY', weekdays: [] });
    expect(p.schedule?.rrule).toBe('FREQ=WEEKLY;INTERVAL=1');
  });

  it('daily with interval ⇒ FREQ=DAILY;INTERVAL=n', () => {
    const p = buildSchedulePayload({ ...BASE, freq: 'DAILY', interval: 3, weekdays: ['MO'] });
    // BYDAY is weekly-only.
    expect(p.schedule?.rrule).toBe('FREQ=DAILY;INTERVAL=3');
  });

  it('monthly ⇒ FREQ=MONTHLY;INTERVAL=n', () => {
    const p = buildSchedulePayload({ ...BASE, freq: 'MONTHLY', interval: 2 });
    expect(p.schedule?.rrule).toBe('FREQ=MONTHLY;INTERVAL=2');
  });

  it('interval coerces to >=1', () => {
    const p = buildSchedulePayload({ ...BASE, freq: 'DAILY', interval: 0 });
    expect(p.schedule?.rrule).toBe('FREQ=DAILY;INTERVAL=1');
  });

  it('until ⇒ expiresAt end-of-day ISO; absent ⇒ null', () => {
    const withUntil = buildSchedulePayload({ ...BASE, until: '2026-12-31' });
    expect(withUntil.expiresAt).toBeTruthy();
    expect(new Date(withUntil.expiresAt as string).toISOString()).toBe(withUntil.expiresAt);
    const without = buildSchedulePayload({ ...BASE, until: '' });
    expect(without.expiresAt).toBeNull();
  });
});

describe('describeForm', () => {
  it('summarises recurring cadence', () => {
    expect(describeForm({ ...BASE, freq: 'WEEKLY', interval: 1, weekdays: ['MO', 'FR'] })).toContain('every week');
    expect(describeForm({ ...BASE, freq: 'DAILY', interval: 2 })).toContain('every 2 days');
  });

  it('summarises a one-shot', () => {
    expect(describeForm({ ...BASE, mode: 'one-shot' })).toContain('Fires once');
  });
});
