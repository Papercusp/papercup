/**
 * WI-2142873 detector — the ref-announce receive leg must leave an observable
 * trace on every pass, and the NOT CONVERGED alarm must say whether the
 * receive leg is even running.
 *
 * On the Mac VM rig the receive leg was starved for 11+ hours (every git-sync
 * tick timed out in an earlier leg), yet the log showed ZERO receive lines —
 * indistinguishable from a leg that ran and rejected every announcement,
 * because rejections were never logged.
 */
import { describe, expect, it } from 'vitest';
import {
  formatRefAnnounceReceiveCensus,
  formatRefAnnounceReceiveFreshness,
  REF_ANNOUNCE_RECEIVE_BATCH_LIMIT,
  REF_ANNOUNCE_RECEIVE_STALE_MS,
  type RefAnnounceReceiveResult,
} from './ref-announce-tick';

const r = (device: string, version: number, result: RefAnnounceReceiveResult['result']): RefAnnounceReceiveResult => ({
  device,
  version,
  result,
});

describe('formatRefAnnounceReceiveCensus', () => {
  it('counts every action and breaks rejections out by reason', () => {
    const line = formatRefAnnounceReceiveCensus(
      'papercusp',
      [
        r('XPAsvso1AAAA', 2918, { action: 'rejected', reason: 'context-mismatch', budgetState: null } as never),
        r('XPAsvso1AAAA', 2919, { action: 'rejected', reason: 'context-mismatch', budgetState: null } as never),
        r('dcJWGlbQAAAA', 1, { action: 'rejected', reason: 'stale-version', budgetState: null } as never),
        r('IXfGu216AAAA', 8197, { action: 'noop', budgetState: null }),
      ],
      { batch: 5, fromCursor: 71553, toCursor: 71753, parked: 1 },
    );
    expect(line).toContain('[git-sync] papercusp: ref-announce receive census');
    expect(line).toContain('batch=5 driven=4 devices=3');
    expect(line).toContain('noop=1 rejected=3');
    expect(line).toContain('rejectedBy{context-mismatch=2 stale-version=1}');
    expect(line).toContain('parked=1 cursor 71553→71753');
  });

  it('breaks out a fetch that landed but whose snapshot was NOT accepted (it is not a success)', () => {
    // Measured 2026-09-27T16:52Z on the Mac VM: `fetched=1` while the fetch was a
    // snapshot-mismatch, so the replay floor never moved and the bridge starved.
    const snapshot = { version: 2921 } as never;
    const line = formatRefAnnounceReceiveCensus(
      'papercusp',
      [
        r('XPAsvso1AAAA', 2683, { action: 'fetched', sigrefs: { accepted: false, reason: 'snapshot-mismatch' }, mismatches: [], budgetState: null }),
        r('XPAsvso1AAAA', 2684, { action: 'fetched', sigrefs: { accepted: true, snapshot }, mismatches: [], budgetState: null }),
      ],
      { batch: 2, fromCursor: 1, toCursor: 3, parked: 0 },
    );
    expect(line).toContain('fetched=2');
    expect(line).toContain('fetchedNotAcceptedBy{snapshot-mismatch=1}');
    const clean = formatRefAnnounceReceiveCensus(
      'papercusp',
      [r('XPAsvso1AAAA', 2684, { action: 'fetched', sigrefs: { accepted: true, snapshot }, mismatches: [], budgetState: null })],
      { batch: 1, fromCursor: 1, toCursor: 2, parked: 0 },
    );
    expect(clean).not.toContain('fetchedNotAcceptedBy');
  });

  it('still emits a line for an empty pass, so silence can only mean the leg did not run', () => {
    const line = formatRefAnnounceReceiveCensus('papercusp', [], { batch: 0, fromCursor: 10, toCursor: 10, parked: 0 });
    expect(line).toContain('no-results');
    expect(line).not.toContain('rejectedBy');
  });
});

describe('formatRefAnnounceReceiveFreshness', () => {
  const now = Date.parse('2026-09-27T15:41:44.868Z');

  it('flags the measured 11h-starved receive leg as STALE and names the cursor', () => {
    const at = String(Date.parse('2026-09-27T04:01:57.342Z'));
    const line = formatRefAnnounceReceiveFreshness(at, '71553', now);
    expect(line).toContain('last persisted 700m ago');
    expect(line).toContain('cursor 71553');
    expect(line).toContain('STALE');
  });

  it('a recent pass is not called stale', () => {
    const line = formatRefAnnounceReceiveFreshness(String(now - REF_ANNOUNCE_RECEIVE_STALE_MS + 60_000), '9', now);
    expect(line).not.toContain('STALE');
  });

  it('a missing or unparsable stamp says the leg never persisted a pass', () => {
    expect(formatRefAnnounceReceiveFreshness(null, null, now)).toContain('NEVER persisted');
    expect(formatRefAnnounceReceiveFreshness('garbage', null, now)).toContain('NEVER persisted');
  });
});

describe('receive backlog (WI-2142873 post-starvation drain)', () => {
  const noop = [r('XPAsvso1AAAA', 8815, { action: 'noop', budgetState: null })];

  it('flags a full batch so a backlog is visible in the census', () => {
    const line = formatRefAnnounceReceiveCensus('papercusp', noop, {
      batch: 1,
      fromCursor: 71553,
      toCursor: 73992,
      parked: 0,
      rowsRead: REF_ANNOUNCE_RECEIVE_BATCH_LIMIT,
      limit: REF_ANNOUNCE_RECEIVE_BATCH_LIMIT,
    });
    expect(line).toContain(`BACKLOG: read a full ${REF_ANNOUNCE_RECEIVE_BATCH_LIMIT}-row batch`);
  });

  it('a partial batch (caught up) carries no backlog flag, nor does a caller that omits the counts', () => {
    const partial = formatRefAnnounceReceiveCensus('papercusp', noop, {
      batch: 1,
      fromCursor: 1,
      toCursor: 2,
      parked: 0,
      rowsRead: 3,
      limit: REF_ANNOUNCE_RECEIVE_BATCH_LIMIT,
    });
    expect(partial).not.toContain('BACKLOG');
    expect(formatRefAnnounceReceiveCensus('papercusp', noop, { batch: 1, fromCursor: 1, toCursor: 2, parked: 0 })).not.toContain(
      'BACKLOG',
    );
  });

  it('drains the measured Mac VM backlog within an hour of 10-minute ticks', () => {
    // Measured 2026-09-27: 8,576 papercusp announcements queued after an 11h
    // starvation; steady production about 67 rows per 10-minute tick. The old
    // 200-row batch needed about 64 ticks (10.7h), and the mirror stayed frozen
    // at its first post-stall fetch until the cursor caught up.
    const backlog = 8576;
    const producedPerTick = 67;
    let queued = backlog;
    let ticks = 0;
    while (queued > 0 && ticks < 1000) {
      queued = queued + producedPerTick - REF_ANNOUNCE_RECEIVE_BATCH_LIMIT;
      ticks++;
    }
    expect(ticks).toBeLessThanOrEqual(6);
    // Control: the old limit really was too small.
    let oldQueued = backlog;
    let oldTicks = 0;
    while (oldQueued > 0 && oldTicks < 1000) {
      oldQueued = oldQueued + producedPerTick - 200;
      oldTicks++;
    }
    expect(oldTicks).toBeGreaterThan(60);
  });
});
