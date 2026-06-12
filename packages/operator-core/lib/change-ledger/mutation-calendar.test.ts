/**
 * mutation-calendar.test.ts — the pure D-003 advisory rollup
 * (self-learning-frontier P-004 / FB-02). The PG write/read side is
 * change-ledger.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { computeMutationCalendar, DEFAULT_LIVE_WINDOW_MS } from './mutation-calendar';

const NOW = Date.parse('2026-06-12T12:00:00Z');
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();
const row = (mutationClass: string, recordedAt: string) => ({ mutationClass, recordedAt });

describe('computeMutationCalendar', () => {
  it('empty rows → empty calendar, no overlap, no advisory', () => {
    const cal = computeMutationCalendar([], { nowMs: NOW });
    expect(cal.classes).toEqual([]);
    expect(cal.liveClasses).toEqual([]);
    expect(cal.overlap).toBe(false);
    expect(cal.advisory).toBeNull();
    expect(cal.liveWindowMs).toBe(DEFAULT_LIVE_WINDOW_MS);
  });

  it('one automated class live → no overlap (one live class at a time is satisfied)', () => {
    const cal = computeMutationCalendar([row('gym', hoursAgo(2)), row('gym', hoursAgo(30))], { nowMs: NOW });
    expect(cal.liveClasses).toEqual(['gym']);
    expect(cal.overlap).toBe(false);
    expect(cal.classes[0]).toMatchObject({ mutationClass: 'gym', count: 2, live: true, automated: true });
    expect(cal.classes[0].firstAt).toBe(hoursAgo(30));
    expect(cal.classes[0].lastAt).toBe(hoursAgo(2));
  });

  it('manual classes are live but never trip the overlap advisory', () => {
    const cal = computeMutationCalendar(
      [row('gym', hoursAgo(1)), row('manual-prompt', hoursAgo(2)), row('repo-prompt', hoursAgo(3))],
      { nowMs: NOW },
    );
    expect(cal.liveClasses.sort()).toEqual(['gym', 'manual-prompt', 'repo-prompt']);
    expect(cal.overlap).toBe(false);
    expect(cal.advisory).toBeNull();
    expect(cal.classes.find((c) => c.mutationClass === 'manual-prompt')?.automated).toBe(false);
    expect(cal.classes.find((c) => c.mutationClass === 'repo-prompt')?.automated).toBe(false);
  });

  it('two automated classes live → overlap + a D-003 advisory naming both', () => {
    const cal = computeMutationCalendar([row('gym', hoursAgo(1)), row('ablation', hoursAgo(5))], { nowMs: NOW });
    expect(cal.overlap).toBe(true);
    expect(cal.advisory).toContain('D-003');
    expect(cal.advisory).toContain('gym');
    expect(cal.advisory).toContain('ablation');
  });

  it('an unknown future class counts as automated (a new mutator trips the advisory)', () => {
    const cal = computeMutationCalendar(
      [row('gym', hoursAgo(1)), row('probation-window', hoursAgo(2))],
      { nowMs: NOW },
    );
    expect(cal.overlap).toBe(true);
    expect(cal.classes.find((c) => c.mutationClass === 'probation-window')?.automated).toBe(true);
  });

  it('activity outside the liveness window is counted but not live', () => {
    const cal = computeMutationCalendar(
      [row('gym', hoursAgo(1)), row('ablation', hoursAgo(8 * 24))],
      { nowMs: NOW },
    );
    expect(cal.liveClasses).toEqual(['gym']);
    expect(cal.overlap).toBe(false);
    const ablation = cal.classes.find((c) => c.mutationClass === 'ablation');
    expect(ablation).toMatchObject({ count: 1, live: false });
  });

  it('a custom liveWindowMs moves the liveness boundary', () => {
    const rows = [row('gym', hoursAgo(1)), row('ablation', hoursAgo(10))];
    expect(computeMutationCalendar(rows, { nowMs: NOW, liveWindowMs: 4 * 3_600_000 }).overlap).toBe(false);
    expect(computeMutationCalendar(rows, { nowMs: NOW, liveWindowMs: 24 * 3_600_000 }).overlap).toBe(true);
  });

  it('classes sort most-recently-active first; future-stamped rows do not count as live', () => {
    const cal = computeMutationCalendar(
      [row('ablation', hoursAgo(48)), row('gym', hoursAgo(1)), row('repo-prompt', hoursAgo(-2))],
      { nowMs: NOW },
    );
    expect(cal.classes.map((c) => c.mutationClass)).toEqual(['repo-prompt', 'gym', 'ablation']);
    // hoursAgo(-2) is 2h in the future — outside [liveStart, now].
    expect(cal.classes.find((c) => c.mutationClass === 'repo-prompt')?.live).toBe(false);
  });
});
