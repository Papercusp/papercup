import { describe, expect, it } from 'vitest';
import {
  cpuBusyPercent,
  emptyResourceTotals,
  foldResourceTotals,
  type TaskResourceTotals,
} from './inventory';

const row = (rssBytes: number | null, cpuUsec: number | null) => ({ rssBytes, cpuUsec });
const NOW = 1_785_740_000_000;

describe('foldResourceTotals (WI-7371)', () => {
  it('sums both metrics and stamps the sample time', () => {
    const t = foldResourceTotals([row(100, 10), row(200, 20), row(300, 30)], NOW);
    expect(t.rssBytesTotal).toBe(600);
    expect(t.cpuUsecTotal).toBe(60);
    expect(t.sampledAtMs).toBe(NOW);
    expect(t.rowsConsidered).toBe(3);
    expect(t.rssBytesKnown).toBe(3);
    expect(t.cpuUsecKnown).toBe(3);
  });

  it('SKIPS nulls rather than coercing them to 0, and counts what reported', () => {
    // Both fields are `number | null`. Coercing null to 0 would understate the total
    // while looking like a complete answer — the caller must be able to say "M of N".
    const t = foldResourceTotals([row(100, null), row(null, 20), row(50, 5)], NOW);
    expect(t.rssBytesTotal).toBe(150);
    expect(t.cpuUsecTotal).toBe(25);
    expect(t.rowsConsidered).toBe(3);
    expect(t.rssBytesKnown).toBe(2);
    expect(t.cpuUsecKnown).toBe(2);
  });

  it('ignores non-finite values instead of poisoning the total with NaN', () => {
    const t = foldResourceTotals([row(Number.NaN, Number.POSITIVE_INFINITY), row(10, 10)], NOW);
    expect(t.rssBytesTotal).toBe(10);
    expect(t.cpuUsecTotal).toBe(10);
    expect(t.rssBytesKnown).toBe(1);
  });

  it('an empty row set reports zero totals over zero rows, not a missing answer', () => {
    const t = foldResourceTotals([], NOW);
    expect(t.rowsConsidered).toBe(0);
    expect(t.rssBytesKnown).toBe(0);
    expect(t.sampledAtMs).toBe(NOW);
  });

  it('emptyResourceTotals marks never-sampled with sampledAtMs 0', () => {
    expect(emptyResourceTotals().sampledAtMs).toBe(0);
  });
});

describe('cpuBusyPercent (WI-7371)', () => {
  const at = (cpuUsecTotal: number, sampledAtMs: number): TaskResourceTotals => ({
    ...emptyResourceTotals(),
    cpuUsecTotal,
    sampledAtMs,
  });

  it('100% = one core saturated for the whole wall-clock interval', () => {
    // 1s of wall clock (1_000_000 usec) consuming 1_000_000 usec of CPU = one core.
    expect(cpuBusyPercent(at(0, NOW), at(1_000_000, NOW + 1000))).toBeCloseTo(100, 5);
  });

  it('reports >100% for multiple busy cores rather than clamping', () => {
    // A 16-core box legitimately reads 1600%. Clamping to 100 would hide saturation.
    expect(cpuBusyPercent(at(0, NOW), at(16_000_000, NOW + 1000))).toBeCloseTo(1600, 5);
  });

  it('returns NULL, not 0, with no previous sample', () => {
    // The distinction is the point: 0 means "measured, idle"; null means "cannot say".
    expect(cpuBusyPercent(null, at(5, NOW))).toBeNull();
    expect(cpuBusyPercent(undefined, at(5, NOW))).toBeNull();
  });

  it('returns NULL when the counter goes BACKWARDS (a task ended and left the set)', () => {
    // cpuUsecTotal is a sum over CURRENT rows, so it legitimately drops when a task
    // exits. Rendering that as 0% busy would be a lie about a possibly-busy box.
    expect(cpuBusyPercent(at(9_000_000, NOW), at(1_000_000, NOW + 1000))).toBeNull();
  });

  it('returns NULL when the clock did not advance or went backwards', () => {
    expect(cpuBusyPercent(at(0, NOW), at(1_000_000, NOW))).toBeNull();
    expect(cpuBusyPercent(at(0, NOW), at(1_000_000, NOW - 5000))).toBeNull();
  });

  it('returns NULL when either sample was never taken (sampledAtMs 0)', () => {
    expect(cpuBusyPercent(at(0, 0), at(1_000_000, NOW))).toBeNull();
    expect(cpuBusyPercent(at(0, NOW), at(1_000_000, 0))).toBeNull();
  });

  it('an idle box reads exactly 0, which is distinct from null', () => {
    expect(cpuBusyPercent(at(500, NOW), at(500, NOW + 1000))).toBe(0);
  });
});
