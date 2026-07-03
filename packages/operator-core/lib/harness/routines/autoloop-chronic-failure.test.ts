import { describe, expect, it } from 'vitest';
import { selectChronicFailures, chronicErrorThreshold, type AutoloopStateRow } from './autoloop-chronic-failure';

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
});
