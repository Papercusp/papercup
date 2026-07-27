/**
 * ref-announce-tick.test.ts — EI-15335 regression: the receive-tick fed-event
 * cursor MUST hold below a failed device-fetch so the next tick re-dials,
 * instead of advancing past it and leaving a silent, permanent
 * namespace-mirror gap until the remote happens to announce again.
 *
 * Pure unit test (no git, no PG) over `decideRefAnnounceReceiveCursor`.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/pot-git/ref-announce-tick.test.ts
 */
import { describe, expect, it } from 'vitest';
import { decideRefAnnounceReceiveCursor, type RefAnnounceReceiveResult } from './ref-announce-tick';

// The cursor decision only reads `result.action` (+ `stderr`/`timedOut`/`code`
// for a failure). A non-failed stand-in uses `noop` — every non-`fetch-failed`
// action is treated the same way (advance past), so this avoids constructing a
// full signed `fetched` snapshot.
const failed = (
  device: string,
  stderr = 'no live swarm dial yet',
  // WI-6277: the discriminators the log site needs to tell a ceiling timeout
  // from a real git error. Defaulted so existing cases read unchanged.
  extra: { timedOut?: boolean; code?: number } = {},
): RefAnnounceReceiveResult => ({
  device,
  version: 1,
  result: {
    action: 'fetch-failed',
    stderr,
    timedOut: extra.timedOut ?? false,
    code: extra.code ?? 128,
    budgetState: null,
  },
});
const ok = (device: string): RefAnnounceReceiveResult => ({
  device,
  version: 1,
  result: { action: 'noop', budgetState: null },
});

describe('decideRefAnnounceReceiveCursor (EI-15335)', () => {
  it('advances the cursor fully when every fetch succeeded', () => {
    const d = decideRefAnnounceReceiveCursor([ok('A'), ok('B'), ok('C')], [10, 11, 12], 12);
    expect(d).toEqual({ cursor: 12, held: false, fetchFailed: [] });
  });

  it('HOLDS the cursor just below a failed fetch so the next tick re-dials', () => {
    // rows 10,11,12 — row 11 failed. Cursor must stay at 10 (below 11), NOT
    // advance to 12: this is the exact live regression — advancing past the
    // failed announce leaves the mirror permanently stale.
    const d = decideRefAnnounceReceiveCursor([ok('A'), failed('B', 'dial destroyed'), ok('C')], [10, 11, 12], 12);
    expect(d.held).toBe(true);
    expect(d.cursor).toBe(10);
    expect(d.fetchFailed).toEqual([
      { rowId: 11, device: 'B', stderr: 'dial destroyed', timedOut: false, code: 128 },
    ]);
  });

  it('a failure on the FIRST row holds the cursor at the row before it (no advance at all)', () => {
    const d = decideRefAnnounceReceiveCursor([failed('A'), ok('B')], [10, 11], 11);
    expect(d.held).toBe(true);
    expect(d.cursor).toBe(9); // stays below the first failed row (10) — never past the miss
  });

  it('holds below the OLDEST failed row when several fetches fail', () => {
    const d = decideRefAnnounceReceiveCursor([ok('A'), failed('B'), failed('C')], [10, 11, 12], 12);
    expect(d.cursor).toBe(10); // oldest failed (11) - 1
    expect(d.fetchFailed.map((f) => f.rowId)).toEqual([11, 12]);
  });

  it('a later success does not let the cursor jump past an earlier failure', () => {
    // success at 12 must not advance the cursor past the failure at 11 — the
    // re-read of 12 next tick is cheap (already mirrored → stale-version).
    const d = decideRefAnnounceReceiveCursor([ok('A'), failed('B'), ok('C')], [10, 11, 12], 12);
    expect(d.cursor).toBe(10);
  });

  it('empty batch advances to the fallback cursor', () => {
    const d = decideRefAnnounceReceiveCursor([], [], 42);
    expect(d).toEqual({ cursor: 42, held: false, fetchFailed: [] });
  });

  it('is defensive against a short/misaligned results array', () => {
    // results shorter than rowIds (a dropped slot) — the missing index is
    // skipped, never crashes, and does not spuriously hold the cursor.
    const d = decideRefAnnounceReceiveCursor([ok('A')], [10, 11], 11);
    expect(d).toEqual({ cursor: 11, held: false, fetchFailed: [] });
  });

  it('never advances the held cursor above the fallback', () => {
    // A pathological rowId above the fallback still cannot push the cursor up.
    const d = decideRefAnnounceReceiveCursor([failed('A')], [100], 5);
    expect(d.cursor).toBe(5);
    expect(d.held).toBe(true);
  });

  it('WI-6277: carries timedOut/code through, so a SIGKILLed git is not reported as an empty string', () => {
    // THE LIVE REGRESSION (P-302 rig, 2026-07-27): the ceiling path SIGKILLs
    // git, a killed process writes NO stderr, and this carrier only forwarded
    // `stderr` — so the operator line ended in a bare colon and a timeout, a
    // transient dial miss and a real git error were indistinguishable while
    // replication sat stuck re-dialing every tick.
    //
    // stderr is deliberately EMPTY here: that is exactly what the kill produces,
    // and it is why `stderr` alone cannot carry this failure.
    const d = decideRefAnnounceReceiveCursor([failed('B', '', { timedOut: true, code: -1 })], [11], 11);
    expect(d.fetchFailed).toEqual([{ rowId: 11, device: 'B', stderr: '', timedOut: true, code: -1 }]);
  });

  it('WI-6277: a real git exit is distinguishable from a ceiling timeout', () => {
    // The other side of the discriminator — a non-zero exit with real stderr
    // must NOT be reported as a timeout, or the operator chases the wrong cause.
    const d = decideRefAnnounceReceiveCursor([failed('C', 'fatal: bad object', { code: 128 })], [11], 11);
    expect(d.fetchFailed[0]?.timedOut).toBe(false);
    expect(d.fetchFailed[0]?.code).toBe(128);
    expect(d.fetchFailed[0]?.stderr).toBe('fatal: bad object');
  });
});
