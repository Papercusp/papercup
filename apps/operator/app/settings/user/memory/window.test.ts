/**
 * Memory page window arithmetic (WI-39540).
 *
 * The bug being guarded: the page showed a saturated 300-row window with no
 * denominator, so a 2,465-memory corpus read as "300 memories". The fix is a
 * denominator plus a window that grows — and both depend on getting "is there
 * more?" right at the boundaries below.
 */
import { describe, expect, it } from 'vitest';
import { memoryWindowState } from './window';

describe('memoryWindowState — hasMore', () => {
  it('reports more when the window came back FULL and the total is larger', () => {
    const s = memoryWindowState({ loadedRows: 500, loadedLimit: 500, total: 2465, showAll: false });
    expect(s.hasMore).toBe(true);
    expect(s.remaining).toBe(1965);
  });

  it('stops exactly when the loaded rows reach the total', () => {
    const s = memoryWindowState({ loadedRows: 2465, loadedLimit: 2500, total: 2465, showAll: false });
    expect(s.hasMore).toBe(false);
    expect(s.remaining).toBe(0);
  });

  it('stops on a SHORT page even if the total disagrees', () => {
    // The total can lag a concurrent delete by one invalidation round-trip.
    // The short page is the authority: the server had nothing more to give.
    const s = memoryWindowState({ loadedRows: 412, loadedLimit: 500, total: 9999, showAll: false });
    expect(s.hasMore).toBe(false);
  });

  it('keeps going while the total is still unknown', () => {
    // The count query resolves independently of the list. Treating null as
    // "stop" would stall the page permanently on its first screen.
    const s = memoryWindowState({ loadedRows: 500, loadedLimit: 500, total: null, showAll: false });
    expect(s.hasMore).toBe(true);
    expect(s.remaining).toBeNull();
  });

  it('never reports more while "Show all" is on', () => {
    const s = memoryWindowState({ loadedRows: 500, loadedLimit: 500, total: 2465, showAll: true });
    expect(s.hasMore).toBe(false);
  });
});

describe('memoryWindowState — denominator', () => {
  it('shows the denominator while the window is a strict subset', () => {
    expect(
      memoryWindowState({ loadedRows: 500, loadedLimit: 500, total: 2465, showAll: false }).showDenominator,
    ).toBe(true);
  });

  it('hides it once everything is loaded ("Showing 12 of 12" is noise)', () => {
    expect(
      memoryWindowState({ loadedRows: 12, loadedLimit: 500, total: 12, showAll: false }).showDenominator,
    ).toBe(false);
  });

  it('hides it when the total is unknown rather than implying zero', () => {
    // The specific failure mode this guards: coercing an unknown total to 0
    // renders "Showing 500 of 0", which is an emptiness claim, not a gap.
    expect(
      memoryWindowState({ loadedRows: 500, loadedLimit: 500, total: null, showAll: false }).showDenominator,
    ).toBe(false);
  });

  it('never reports negative remaining if the total lags behind the rows', () => {
    const s = memoryWindowState({ loadedRows: 40, loadedLimit: 500, total: 12, showAll: false });
    expect(s.remaining).toBe(0);
  });
});

describe('memoryWindowState — the reported scenario, end to end', () => {
  it('walks a 2,465-row corpus to completion in 500-row steps', () => {
    const STEP = 500;
    const total = 2465;
    let limit = STEP;
    let pages = 0;
    // Simulates the server slice: min(limit, total).
    for (;;) {
      const loadedRows = Math.min(limit, total);
      const s = memoryWindowState({ loadedRows, loadedLimit: limit, total, showAll: false });
      if (!s.hasMore) break;
      limit += STEP;
      pages += 1;
      expect(pages).toBeLessThan(20); // cannot spin forever
    }
    expect(Math.min(limit, total)).toBe(total); // everything is reachable
  });
});
