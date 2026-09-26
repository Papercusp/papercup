import { describe, expect, it } from 'vitest';
import {
  RESOURCE_TOTALS_FILTER,
  RESOURCE_TOTALS_LIMIT,
  computeResourceTotals,
  cpuBusyPercent,
  emptyResourceTotals,
  foldResourceTotals,
  projectLiveProcess,
  type TaskResourceTotals,
} from './inventory';
import type { ScannedProcess } from './reconcile';

const row = (rssBytes: number | null, cpuUsec: number | null) => ({ rssBytes, cpuUsec });
const NOW = 1_785_740_000_000;

describe('public process projection', () => {
  it('returns stable metadata and never exposes credential-bearing argv to a task-manager client', () => {
    const localBearer = '8c91f74d2e6a4bbf90f44a71d142d095';
    const row: ScannedProcess = {
      pid: 42,
      cmdline:
        'worker.ts --api-key=opaque-value-123 ' +
        `http://127.0.0.1:9071 ${localBearer} ` +
        'Authorization: Bearer another-opaque-value',
      cgroupPath: '/papercusp.slice/pc-task.scope',
      processIdentity: 'linux:boot:42',
      owned: true,
      scope: 'owned',
      exemptReason: null,
    };

    const projected = projectLiveProcess(row);
    expect(projected).toMatchObject({
      pid: 42,
      startedAt: null,
      executable: 'worker.ts',
      role: null,
      build: null,
      cgroupPath: '/papercusp.slice/pc-task.scope',
      owned: true,
      scope: 'owned',
      exemptReason: null,
    });
    expect(projected).not.toHaveProperty('cmdline');
    expect(JSON.stringify(projected)).not.toContain('opaque-value');
    expect(JSON.stringify(projected)).not.toContain(localBearer);
  });
});

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

  it('a bare fold never claims truncation — only the fetcher can know', () => {
    expect(foldResourceTotals([row(1, 1)], NOW).truncated).toBe(false);
  });
});

/**
 * The acceptance criterion this work-item turns on: "totals reflect the FULL tracked set,
 * provably independent of the active filter". Moving the fold server-side does NOT deliver
 * that on its own — `getTaskInventory` filters its own `listTasks` — so these assert the
 * property directly instead of trusting the layer it lives in.
 */
describe('computeResourceTotals filter-independence (WI-7371)', () => {
  const storeRow = (lastMemoryBytes: number | null, cpuUsec: number | null) => ({
    lastMemoryBytes,
    cpuUsec,
  });

  it('hands the store NO state/class filter — the pane cannot narrow the totals', async () => {
    const seen: unknown[] = [];
    await computeResourceTotals(NOW, async (f) => {
      seen.push(f);
      return [];
    });
    expect(seen).toHaveLength(1);
    const f = seen[0] as Record<string, unknown>;
    // Assert on KEY ABSENCE, not on values: threading `states: undefined` through would
    // pass a value check while leaving the door open for a later `states: opts.state`.
    expect(Object.keys(f).sort()).toEqual(['includeEnded', 'limit']);
    expect(f.includeEnded).toBe(false);
  });

  it('excludes ended tasks, whose rssBytes is memory the kernel already reclaimed', () => {
    // Measured 2026-08-03: 13 live rows = 15 GB, all 971 ledger rows = 131 GB on a 257 GB
    // box. `includeEnded` is a ROW-LIST toggle; letting it reach the totals would let the
    // header report more memory than the machine physically has.
    expect(RESOURCE_TOTALS_FILTER.includeEnded).toBe(false);
  });

  it('is frozen, so a caller cannot mutate the shared filter into a narrower one', () => {
    expect(Object.isFrozen(RESOURCE_TOTALS_FILTER)).toBe(true);
  });

  it('maps lastMemoryBytes -> rssBytes rather than folding a silent zero', async () => {
    // The store row and the wire row name this field differently. Fold the store shape
    // through the wire shape and every row reads `undefined`, producing a confident 0.
    const t = await computeResourceTotals(NOW, async () => [storeRow(100, 10), storeRow(200, null)]);
    expect(t.rssBytesTotal).toBe(300);
    expect(t.cpuUsecTotal).toBe(10);
    expect(t.rowsConsidered).toBe(2);
    expect(t.cpuUsecKnown).toBe(1);
  });

  it('flags truncation when the fetch hits its cap, so the total reads as a lower bound', async () => {
    const capped = Array.from({ length: RESOURCE_TOTALS_LIMIT }, () => storeRow(1, 1));
    expect((await computeResourceTotals(NOW, async () => capped)).truncated).toBe(true);
    expect((await computeResourceTotals(NOW, async () => capped.slice(1))).truncated).toBe(false);
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
