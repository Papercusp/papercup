import { describe, expect, it } from 'vitest';
import {
  selectChronicFailures,
  chronicErrorThreshold,
  staleWindowMs,
  isStaleWatermark,
  type AutoloopStateRow,
} from './autoloop-chronic-failure';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 3, 12, 0, 0); // 2026-07-03T12:00:00Z

describe('chronicErrorThreshold', () => {
  it('defaults to 6', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD;
    delete process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD;
    expect(chronicErrorThreshold()).toBe(6);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD = prev;
  });
});

describe('selectChronicFailures', () => {
  function row(over: Partial<AutoloopStateRow>): AutoloopStateRow {
    return { harness_slug: 'papercusp', role: 'loop-su-x', consecutive_errors: 7, last_status: 'loop-stuck-backstop', routine_active: null, ...over };
  }

  it('breaches only rows at/over the threshold, highest streak first', () => {
    const rows = [row({ role: 'a', consecutive_errors: 6 }), row({ role: 'b', consecutive_errors: 9 }), row({ role: 'c', consecutive_errors: 5 })];
    expect(selectChronicFailures(rows, 6).map((r) => r.role)).toEqual(['b', 'a']);
  });

  it('threshold <= 0 disables the sweep entirely', () => {
    expect(selectChronicFailures([row({})], 0)).toEqual([]);
    expect(selectChronicFailures([row({})], -1)).toEqual([]);
  });

  it("EI-6760/6761/6762 real shape: a routine already auto-paused (active:false) is NOT re-escalated as a live chronic failure", () => {
    const rows = [row({ role: 'loop-su-0f81d996-9f81-4f13-b56f-2962aa7eedfa', consecutive_errors: 7, routine_active: false })];
    expect(selectChronicFailures(rows, 6)).toEqual([]);
  });

  it("EI-6769 boundary: a paused routine at EXACTLY the threshold (streak == threshold) is still skipped, not escalated", () => {
    // EI-6769 (loop-su-cea4c674…) was auto-filed at streak==6 (the exact threshold)
    // while its routine was already active:false, ~15min before the routine_active
    // skip-filter landed. Pin the threshold-boundary so a >= vs > slip can never
    // re-open that pre-fix escalation of an already-resolved (paused) condition.
    const rows = [row({ role: 'loop-su-cea4c674-d05a-49df-9748-62a6702753d3', consecutive_errors: 6, routine_active: false })];
    expect(selectChronicFailures(rows, 6)).toEqual([]);
  });

  it('a routine that is still active (armed, still trying+failing) IS escalated', () => {
    const rows = [row({ role: 'loop-su-still-live', consecutive_errors: 7, routine_active: true })];
    expect(selectChronicFailures(rows, 6)).toHaveLength(1);
  });

  it('a role with NO matching routines row (routine_active: null — director/gym-cycle/overwatch/scout-cycle) fails OPEN and is still escalated', () => {
    const rows = [row({ role: 'gym-cycle', consecutive_errors: 8, routine_active: null })];
    expect(selectChronicFailures(rows, 6)).toHaveLength(1);
  });

  it('mixed batch: only the explicitly-paused row is dropped, the rest still breach in order', () => {
    const rows = [
      row({ role: 'live-high', consecutive_errors: 10, routine_active: true }),
      row({ role: 'paused', consecutive_errors: 9, routine_active: false }),
      row({ role: 'no-routine', consecutive_errors: 8, routine_active: null }),
    ];
    expect(selectChronicFailures(rows, 6).map((r) => r.role)).toEqual(['live-high', 'no-routine']);
  });

  it('EI-6765 real shape: an orphaned overwatch@papercup row (6 errors, last fired 8 days ago) is a frozen watermark, NOT escalated', () => {
    // The active overwatch loop moved to the `papercusp` home slug (which is `ok`),
    // leaving `papercup` frozen at 6 errors with a stale "180000ms" last_status. It
    // never fires again, so its streak can never reset — it must NOT re-escalate.
    const rows = [
      row({
        harness_slug: 'papercup',
        role: 'overwatch',
        consecutive_errors: 6,
        routine_active: null, // overwatch is a fixed system role — no matching routines row
        last_status: 'error: no complete scorecard within 180000ms launch deadline; backstop synthesized',
        last_fired_at: new Date(NOW - 8 * 24 * HOUR_MS).toISOString(), // 8 days stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('a still-firing loop (last fired within the staleness window) IS escalated despite fail-open null routine', () => {
    const rows = [
      row({
        role: 'gym-cycle',
        consecutive_errors: 8,
        routine_active: null,
        last_fired_at: new Date(NOW - 30 * 60 * 1000).toISOString(), // 30min ago — well within window
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toHaveLength(1);
  });

  it('null/absent last_fired_at fails OPEN — an unknown fire time never silently suppresses escalation', () => {
    const rows = [
      row({ role: 'null-fired', consecutive_errors: 7, last_fired_at: null }),
      row({ role: 'absent-fired', consecutive_errors: 7 }), // last_fired_at undefined
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS }).map((r) => r.role)).toEqual([
      'null-fired',
      'absent-fired',
    ]);
  });

  it('staleMs <= 0 disables the staleness guard entirely (fail-open — even an ancient row escalates)', () => {
    const rows = [
      row({ role: 'ancient', consecutive_errors: 9, last_fired_at: new Date(NOW - 100 * 24 * HOUR_MS).toISOString() }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 0 })).toHaveLength(1);
  });
});

describe('staleWindowMs', () => {
  it('defaults to 6 hours', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
    delete process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
    expect(staleWindowMs()).toBe(6 * HOUR_MS);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_STALE_MS = prev;
  });

  it('is env-overridable', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
    process.env.PAPERCUSP_AUTOLOOP_STALE_MS = '90000';
    expect(staleWindowMs()).toBe(90000);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_STALE_MS = prev;
    else delete process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
  });
});

describe('isStaleWatermark', () => {
  it('true when last fire is older than the window', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 7 * HOUR_MS).toISOString() }, NOW, 6 * HOUR_MS)).toBe(true);
  });
  it('false when last fire is within the window', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 5 * HOUR_MS).toISOString() }, NOW, 6 * HOUR_MS)).toBe(false);
  });
  it('accepts a Date as well as an ISO string', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 7 * HOUR_MS) }, NOW, 6 * HOUR_MS)).toBe(true);
  });
  it('fails OPEN (false) on null, undefined, or an unparseable value', () => {
    expect(isStaleWatermark({ last_fired_at: null }, NOW, 6 * HOUR_MS)).toBe(false);
    expect(isStaleWatermark({ last_fired_at: undefined }, NOW, 6 * HOUR_MS)).toBe(false);
    expect(isStaleWatermark({ last_fired_at: 'not-a-date' }, NOW, 6 * HOUR_MS)).toBe(false);
  });
  it('staleMs <= 0 disables (never stale)', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 100 * HOUR_MS).toISOString() }, NOW, 0)).toBe(false);
  });
});
