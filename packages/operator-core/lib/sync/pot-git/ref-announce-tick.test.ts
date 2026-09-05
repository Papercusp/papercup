/**
 * ref-announce-tick.test.ts — EI-15335 + P-203 Leg A regression: an inbound
 * ref-announcement whose device-fetch failed MUST be retried next tick (never
 * silently dropped, which leaves a permanent namespace-mirror gap until the
 * remote happens to announce again) — AND it must do so WITHOUT holding the
 * fed-event cursor, because a held cursor is head-of-line blocking: one
 * announcer nobody can reach (live-caught 2026-09-02 on the two-machine rig)
 * pinned the cursor for the whole pot and starved a perfectly reachable peer.
 *
 * Pure unit test (no git, no PG) over `decideRefAnnounceReceiveCursor` +
 * `mergeParkedIntoReceiveBatch`.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/pot-git/ref-announce-tick.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  decideRefAnnounceReceiveCursor,
  mergeParkedIntoReceiveBatch,
  REF_ANNOUNCE_RECEIVE_IDLE_MS,
  type ParkedRefAnnouncements,
  type RefAnnounceReceiveBatchRow,
  type RefAnnounceReceiveResult,
} from './ref-announce-tick';
import type { SignedRefAnnouncement } from './ref-announce';
import { DEFAULT_FETCH_TIMEOUT_MS } from './fetch-transport';
import { DEFAULT_SERVE_PROGRESS_WINDOW_MS } from './serve-wiring';

// The decision reads `result.action` (+ `stderr`/`timedOut`/`code` for a
// failure) and the row's `announcement.{device_pubkey,version}`. A non-failed
// stand-in uses `noop`, which avoids constructing a full signed `fetched`
// snapshot.
//
// ⚠ THREE dispositions (WI-6418): `fetch-failed` PARKS the row AND is reported;
// `already-in-flight` parks the row and is NOT reported (nothing went wrong);
// everything else settles the device. `noop` stands in for that third group
// only — do not read it as "all non-failures".
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
const inFlight = (device: string): RefAnnounceReceiveResult => ({
  device,
  version: 1,
  result: { action: 'already-in-flight', budgetState: null },
});
const ann = (device: string, version = 1): SignedRefAnnouncement =>
  ({ device_pubkey: device, version }) as unknown as SignedRefAnnouncement;
const row = (rowId: number, device: string, version = 1): RefAnnounceReceiveBatchRow => ({
  rowId,
  announcement: ann(device, version),
});
const NOW = 1_700_000_000_000;

describe('generation ordering in receive queues (P-513)', () => {
  const generated = (rowId: number, generation: number, version: number): RefAnnounceReceiveBatchRow => ({
    rowId, announcement: { ...ann('B', version), store_generation: `sg2-${generation}-${'a'.repeat(40)}` },
  });
  it('supersedes a parked old generation even when its sequence is much higher', () => {
    const old = generated(1, 1, 999);
    const fresh = generated(2, 2, 1);
    const parked = { B: { ...old, parkedSinceMs: NOW, attempts: 1 } };
    expect(mergeParkedIntoReceiveBatch(parked, [fresh])).toEqual([fresh]);
  });
  it('keeps a failed current generation when a late older-generation row follows it', () => {
    const current = generated(1, 2, 1);
    const old = generated(2, 1, 999);
    const decision = decideRefAnnounceReceiveCursor([failed('B'), ok('B')], [current, old], 2, {}, NOW);
    expect(decision.parked.B?.announcement).toEqual(current.announcement);
  });
});

describe('decideRefAnnounceReceiveCursor (EI-15335 → P-203 Leg A parking)', () => {
  it('advances the cursor fully when every fetch succeeded, parking nothing', () => {
    const d = decideRefAnnounceReceiveCursor([ok('A'), ok('B'), ok('C')], [row(10, 'A'), row(11, 'B'), row(12, 'C')], 12, {}, NOW);
    expect(d).toEqual({ cursor: 12, fetchFailed: [], parked: {}, unparked: [] });
  });

  it('PARKS a failed fetch (by value, newest per device) and STILL advances the cursor past it', () => {
    // rows 10,11,12 — row 11 failed. The announcement must survive for the
    // next tick (EI-15335) — but as a parked entry, NOT by holding the cursor
    // at 10: holding starved every announcer behind the miss (P-203 Leg A).
    const d = decideRefAnnounceReceiveCursor(
      [ok('A'), failed('B', 'dial destroyed'), ok('C')],
      [row(10, 'A'), row(11, 'B', 7), row(12, 'C')],
      12,
      {},
      NOW,
    );
    expect(d.cursor).toBe(12);
    expect(d.fetchFailed).toEqual([{ rowId: 11, device: 'B', stderr: 'dial destroyed', timedOut: false, code: 128 }]);
    expect(d.parked).toEqual({
      B: { rowId: 11, announcement: ann('B', 7), parkedSinceMs: NOW, attempts: 1 },
    });
    expect(d.unparked).toEqual([]);
  });

  it('THE LIVE REGRESSION: one unreachable announcer never pins the cursor for the others', () => {
    // Device U is a pot member that never joins this topic — every dial fails
    // forever. Under the old hold, the cursor sat below U's oldest row for the
    // life of the pair and R's announcements behind it were never fetched.
    const d = decideRefAnnounceReceiveCursor(
      [failed('U', 'no live dial path'), failed('U', 'no live dial path'), ok('R')],
      [row(10, 'U', 1), row(11, 'U', 2), row(12, 'R', 9)],
      12,
      {},
      NOW,
    );
    expect(d.cursor).toBe(12);
    expect(Object.keys(d.parked)).toEqual(['U']);
    // Only U's NEWEST announcement is kept — the fetch it would trigger brings
    // everything the older one named.
    expect(d.parked.U?.announcement.version).toBe(2);
    expect(d.parked.U?.rowId).toBe(11);
  });

  it('a parked device that fails again keeps its original parkedSince and counts the attempt', () => {
    const prior: ParkedRefAnnouncements = {
      B: { rowId: 11, announcement: ann('B', 7), parkedSinceMs: NOW - 60_000, attempts: 3 },
    };
    const d = decideRefAnnounceReceiveCursor([failed('B')], [{ ...row(11, 'B', 7), parked: true }], 11, prior, NOW);
    expect(d.parked.B).toEqual({ rowId: 11, announcement: ann('B', 7), parkedSinceMs: NOW - 60_000, attempts: 4 });
  });

  it('a parked device that SETTLES is unparked and reported with its history', () => {
    const prior: ParkedRefAnnouncements = {
      B: { rowId: 11, announcement: ann('B', 7), parkedSinceMs: NOW - 60_000, attempts: 3 },
    };
    const d = decideRefAnnounceReceiveCursor([ok('B')], [{ ...row(11, 'B', 7), parked: true }], 11, prior, NOW);
    expect(d.parked).toEqual({});
    expect(d.unparked).toEqual([
      { device: 'B', rowId: 11, version: 7, attempts: 3, parkedSinceMs: NOW - 60_000, action: 'noop' },
    ]);
  });

  it('the LAST row per device decides: an older failure below a newer success is moot', () => {
    // The success at 12 brought everything 11 named — B must not stay parked.
    const d = decideRefAnnounceReceiveCursor(
      [failed('B'), ok('B')],
      [row(11, 'B', 1), row(12, 'B', 2)],
      12,
      {},
      NOW,
    );
    expect(d.parked).toEqual({});
    expect(d.fetchFailed.map((f) => f.rowId)).toEqual([11]); // still reported — it did fail
  });

  it('an older success below a newer failure parks the NEWER announcement', () => {
    const d = decideRefAnnounceReceiveCursor(
      [ok('B'), failed('B')],
      [row(11, 'B', 1), row(12, 'B', 2)],
      12,
      {},
      NOW,
    );
    expect(d.parked.B?.announcement.version).toBe(2);
  });

  it('a `rejected` announcement settles the device — a decision, not a transient failure, is never parked', () => {
    const rejected: RefAnnounceReceiveResult = {
      device: 'X',
      version: 1,
      result: { action: 'rejected', reason: 'not-a-member', budgetState: null } as unknown as RefAnnounceReceiveResult['result'],
    };
    const prior: ParkedRefAnnouncements = { X: { rowId: 5, announcement: ann('X'), parkedSinceMs: NOW, attempts: 1 } };
    const d = decideRefAnnounceReceiveCursor([rejected], [{ ...row(5, 'X'), parked: true }], 9, prior, NOW);
    expect(d.parked).toEqual({});
    expect(d.unparked[0]?.action).toBe('rejected');
  });

  it('empty batch advances to the fallback cursor', () => {
    const d = decideRefAnnounceReceiveCursor([], [], 42, {}, NOW);
    expect(d).toEqual({ cursor: 42, fetchFailed: [], parked: {}, unparked: [] });
  });

  it('is defensive against a short/misaligned results array — the undriven row is parked, never lost', () => {
    // results shorter than rows (a dropped slot): never crashes, the cursor
    // still advances, and the row with no result is carried as parked so a
    // seam bug cannot silently drop an announcement.
    const d = decideRefAnnounceReceiveCursor([ok('A')], [row(10, 'A'), row(11, 'B')], 11, {}, NOW);
    expect(d.cursor).toBe(11);
    expect(d.fetchFailed).toEqual([]);
    expect(Object.keys(d.parked)).toEqual(['B']);
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
    const d = decideRefAnnounceReceiveCursor([failed('B', '', { timedOut: true, code: -1 })], [row(11, 'B')], 11, {}, NOW);
    expect(d.fetchFailed).toEqual([{ rowId: 11, device: 'B', stderr: '', timedOut: true, code: -1 }]);
  });

  it('WI-6277: a real git exit is distinguishable from a ceiling timeout', () => {
    // The other side of the discriminator — a non-zero exit with real stderr
    // must NOT be reported as a timeout, or the operator chases the wrong cause.
    const d = decideRefAnnounceReceiveCursor([failed('C', 'fatal: bad object', { code: 128 })], [row(11, 'C')], 11, {}, NOW);
    expect(d.fetchFailed[0]?.timedOut).toBe(false);
    expect(d.fetchFailed[0]?.code).toBe(128);
    expect(d.fetchFailed[0]?.stderr).toBe('fatal: bad object');
  });

  /**
   * WI-6418 — the two halves of `already-in-flight`, which pull in opposite
   * directions and are why it could not reuse either existing disposition.
   */
  it('WI-6418: `already-in-flight` PARKS the row — the announce is not yet mirrored', () => {
    // Forgetting it would drop the announcement forever and leave a silent,
    // permanent namespace gap — the exact bug EI-15335 fixed.
    const d = decideRefAnnounceReceiveCursor([ok('A'), inFlight('B'), ok('C')], [row(10, 'A'), row(11, 'B'), row(12, 'C')], 12, {}, NOW);
    expect(d.cursor).toBe(12);
    expect(Object.keys(d.parked)).toEqual(['B']);
  });

  it('WI-6418: `already-in-flight` is NOT reported as a fetch failure', () => {
    // Nothing went wrong — a peer drive is mid-transfer. Folding it into
    // fetchFailed would log a phantom transport error against a perfectly
    // healthy stream, which is precisely the false signal that made this
    // livelock read as ordinary noise for days.
    const d = decideRefAnnounceReceiveCursor([inFlight('B')], [row(11, 'B')], 11, {}, NOW);
    expect(d.fetchFailed).toEqual([]);
    expect(d.parked.B).toBeDefined();
  });
});

describe('mergeParkedIntoReceiveBatch', () => {
  it('drives parked announcements FIRST (oldest row first), then the fresh rows in order', () => {
    const parked: ParkedRefAnnouncements = {
      B: { rowId: 30, announcement: ann('B', 2), parkedSinceMs: NOW, attempts: 1 },
      A: { rowId: 20, announcement: ann('A', 5), parkedSinceMs: NOW, attempts: 2 },
    };
    const batch = mergeParkedIntoReceiveBatch(parked, [row(40, 'C', 1), row(41, 'D', 1)]);
    expect(batch.map((r) => [r.rowId, r.announcement.device_pubkey, r.parked ?? false])).toEqual([
      [20, 'A', true],
      [30, 'B', true],
      [40, 'C', false],
      [41, 'D', false],
    ]);
  });

  it('drops a parked entry superseded by a fresh row from the same device at the same or a higher version', () => {
    const parked: ParkedRefAnnouncements = {
      B: { rowId: 30, announcement: ann('B', 2), parkedSinceMs: NOW, attempts: 1 },
      A: { rowId: 20, announcement: ann('A', 5), parkedSinceMs: NOW, attempts: 1 },
    };
    const batch = mergeParkedIntoReceiveBatch(parked, [row(40, 'B', 2), row(41, 'A', 4)]);
    // B@2 superseded by fresh B@2; A@5 is NEWER than fresh A@4 so it stays.
    expect(batch.map((r) => [r.rowId, r.announcement.device_pubkey, r.announcement.version])).toEqual([
      [20, 'A', 5],
      [40, 'B', 2],
      [41, 'A', 4],
    ]);
  });

  it('an empty parked set is the identity', () => {
    const fresh = [row(1, 'A'), row(2, 'B')];
    expect(mergeParkedIntoReceiveBatch({}, fresh)).toEqual(fresh);
  });

  it('tolerates a malformed parked entry (no announcement) instead of crashing the tick', () => {
    const parked = { Z: { rowId: 1, parkedSinceMs: NOW, attempts: 1 } } as unknown as ParkedRefAnnouncements;
    expect(mergeParkedIntoReceiveBatch(parked, [row(2, 'A')])).toEqual([row(2, 'A')]);
  });
});

describe('REF_ANNOUNCE_RECEIVE_IDLE_MS (WI-2039873: the receive leg must outlive the serve window)', () => {
  it('is the transport default, not a tighter leg-local ceiling', () => {
    expect(REF_ANNOUNCE_RECEIVE_IDLE_MS).toBe(DEFAULT_FETCH_TIMEOUT_MS);
  });

  it('is comfortably longer than serve-wiring’s progress window, so a requester never kills a serve the server still protects', () => {
    // serve-wiring sizes its window as "far under the requester's own 120s idle
    // ceiling". A leg that gives up sooner than the window inverts that and
    // livelocks a cold join (killed at 15s, refused busy-streaming for 30s,
    // repeat). Pin the ORDER, with margin, so a future "let's tighten the
    // receive leg" edit fails here instead of on the rig.
    expect(REF_ANNOUNCE_RECEIVE_IDLE_MS).toBeGreaterThanOrEqual(2 * DEFAULT_SERVE_PROGRESS_WINDOW_MS);
  });
});
