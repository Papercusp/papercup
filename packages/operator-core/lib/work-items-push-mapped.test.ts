/**
 * work-items-push-mapped.test.ts — pure unit coverage for `pushMapped`, the
 * fix for EI-22068903877831794 (`work_items:export` full-harness enumeration
 * overflows the call stack).
 *
 * `listWorkItemsWithLimit`'s unbounded (`rowLimit === null`) branch — the one
 * `listAllWorkItemsForFileExport` uses for a whole-harness `work_items:export`
 * — used to do `out.push(...rows.map(fn))`. That spreads every mapped row
 * into ONE function call as individual arguments; V8 caps that argument
 * count well below real row counts here (this harness alone holds >150k
 * issue-family rows), so the export threw `RangeError: Maximum call stack
 * size exceeded` on the very read it exists to make possible. `pushMapped`
 * replaces the spread with a plain loop — O(1) arguments per `push` call, no
 * ceiling — and this test proves both halves: the historical pattern really
 * does throw at realistic scale (the falsifiable control), and the fixed
 * helper does not, while still producing the identical output.
 *
 * db-org is mocked defensively so this stays a pure, PG-free unit test —
 * `pushMapped` touches no PG, but the module it lives in does at import time.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: Object.assign(async () => [], { unsafe: vi.fn() }) }),
}));

const { pushMapped } = await import('./work-items');

// Comfortably past the measured V8 spread-argument ceiling on this box (throws
// starting somewhere between 100_000 and 150_000; see the falsifiability
// control below) and past the real row count that triggered EI-22068903877831794
// (152,702 issue-family rows in this harness alone).
const REALISTIC_ROW_COUNT = 200_000;

describe('pushMapped — EI-22068903877831794 regression', () => {
  it('falsifiability control: the historical spread-push pattern actually throws at this scale', () => {
    const rows = new Array(REALISTIC_ROW_COUNT).fill(0);
    const out: number[] = [];
    // This is the exact pattern removed from listWorkItemsWithLimit — proving
    // it fails is what makes the fix below a genuine regression test rather
    // than an assertion about behavior nothing ever exhibited.
    expect(() => {
      out.push(...rows.map((_row, i) => i));
    }).toThrow(/call stack/i);
  });

  it('appends every mapped row at realistic full-harness scale without throwing', () => {
    const rows = new Array(REALISTIC_ROW_COUNT).fill(0).map((_v, i) => ({ n: i }));
    const out: number[] = [];
    expect(() => pushMapped(out, rows, (row) => row.n * 2)).not.toThrow();
    expect(out.length).toBe(REALISTIC_ROW_COUNT);
    expect(out[0]).toBe(0);
    expect(out[REALISTIC_ROW_COUNT - 1]).toBe((REALISTIC_ROW_COUNT - 1) * 2);
  });

  it('preserves row order and appends onto a non-empty accumulator (matches the two listWorkItemsWithLimit call sites)', () => {
    const out: string[] = ['pre-existing-feature-row'];
    pushMapped(out, ['a', 'b', 'c'], (row) => `issue:${row}`);
    expect(out).toEqual(['pre-existing-feature-row', 'issue:a', 'issue:b', 'issue:c']);
  });

  it('is a no-op on an empty input array', () => {
    const out: number[] = [1, 2];
    pushMapped(out, [], (row: number) => row);
    expect(out).toEqual([1, 2]);
  });
});
