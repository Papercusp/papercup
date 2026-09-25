import { describe, it, expect } from 'vitest';
import { DroppedDeferrals, currentDeferralSource, runWithDeferralSource } from '../deferral-source';
import { PendingEpochContent } from '../pending-epoch-content';
import { PendingMembershipContent, reapplyDrainedMemberContent } from '../pending-membership-content';
import { drainQueuedEpochContent, type DrainedEpoch } from '../hive-epoch-op-gate';
import type { OpEnvelope } from '../op-envelope-types';

/**
 * p2p-join-catchup-speed D-016 (P-522): the content-deferral buffers record each drop under
 * its blocker with the op's log position, and a drop owes a re-fold only once that blocker
 * clears. The end-to-end fold behaviour is pinned in fresh-join-livelock.test.ts.
 */

const LOG = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);

function op(hbKey: string): OpEnvelope {
  return { type: 'put', table: 'content', hbKey, value: { hbKey }, ts: 1000 } as OpEnvelope;
}

function member(rowKey: string, reapply: () => Promise<void> = async () => {}) {
  return { authorDevice: 'dev-1', tableTag: 'engineer-issues', rowKey, reapply };
}

describe('DroppedDeferrals', () => {
  it('keeps the lowest position per log and owes nothing until the blocker is released', () => {
    const d = new DroppedDeferrals();
    d.note('pot\u00000', { keyHex: LOG, position: 90 }, 'evicted');
    d.note('pot\u00000', { keyHex: LOG, position: 40 }, 'evicted');
    d.note('pot\u00000', { keyHex: OTHER, position: 7 }, 'evicted');
    d.note('pot\u00001', { keyHex: LOG, position: 3 }, 'expired');
    expect(d.takeDropCounts()).toEqual({ evicted: 3, expired: 1 });
    expect(d.takeDropCounts()).toEqual({ evicted: 0, expired: 0 });
    expect(d.takeOwed()).toBeNull();

    d.release('pot\u00000');
    const owed = d.takeOwed()!;
    expect(Object.fromEntries(owed.floors)).toEqual({ [LOG]: 40, [OTHER]: 7 });
    expect(owed).toMatchObject({ sourceless: false, drops: 3 });
    // The other blocker's drop (position 3) is still unreleased and owes nothing.
    expect(d.takeOwed()).toBeNull();
    expect(d.has('pot\u00001')).toBe(true);
    expect(d.blockerCount).toBe(1);
  });

  it('a drop with no source is carried as sourceless until released', () => {
    const d = new DroppedDeferrals();
    d.note('device:x', undefined, 'expired');
    expect(d.holdsSourceless).toBe(true);
    d.release('device:x');
    expect(d.holdsSourceless).toBe(false);
    expect(d.takeOwed()).toMatchObject({ sourceless: true, drops: 1 });
  });

  it('releasing a blocker with no drops is a no-op', () => {
    const d = new DroppedDeferrals();
    d.release('device:nobody');
    expect(d.takeOwed()).toBeNull();
  });
});

describe('runWithDeferralSource', () => {
  it('scopes the source to the call and its awaits, and undefined clears an outer source', async () => {
    expect(currentDeferralSource()).toBeUndefined();
    await runWithDeferralSource({ keyHex: LOG, position: 5 }, async () => {
      await Promise.resolve();
      expect(currentDeferralSource()).toEqual({ keyHex: LOG, position: 5 });
      runWithDeferralSource(undefined, () => expect(currentDeferralSource()).toBeUndefined());
    });
    expect(currentDeferralSource()).toBeUndefined();
  });
});

describe('PendingEpochContent drops (D-016)', () => {
  it('stamps each deferral with the fold position and records an eviction under its (pot, epoch)', () => {
    const p = new PendingEpochContent(2);
    runWithDeferralSource({ keyHex: LOG, position: 10 }, () => p.defer(op('a'), 'pot', 0));
    runWithDeferralSource({ keyHex: LOG, position: 11 }, () => p.defer(op('b'), 'pot', 0));
    runWithDeferralSource({ keyHex: LOG, position: 12 }, () => p.defer(op('c'), 'pot', 0));
    expect(p.hasEvicted('pot', 0)).toBe(true);
    expect(p.hasEvicted('pot', 1)).toBe(false);
    expect(p.drainEpoch('pot', 0).map((d) => d.source?.position)).toEqual([11, 12]);
    expect(p.dropped.takeOwed()).toBeNull();
    p.releaseEpoch('pot', 0);
    expect(Object.fromEntries(p.dropped.takeOwed()!.floors)).toEqual({ [LOG]: 10 });
  });

  it('a deferral outside any fold apply has no source', () => {
    const p = new PendingEpochContent(1);
    p.defer(op('a'), 'pot', 0);
    p.defer(op('b'), 'pot', 0);
    expect(p.dropped.holdsSourceless).toBe(true);
  });
});

describe('PendingMembershipContent drops (D-016)', () => {
  it('a TTL expiry is recorded under the author device with its position', () => {
    const buf = new PendingMembershipContent(100, 1_000);
    runWithDeferralSource({ keyHex: LOG, position: 77 }, () => buf.defer(member('r1'), 0));
    expect(buf.sweepExpired(5_000)).toBe(1);
    expect(buf.dropped.has('device:dev-1')).toBe(true);
    expect(buf.dropped.takeDropCounts()).toEqual({ evicted: 0, expired: 1 });
  });

  it('holdExpiry pauses the TTL sweep; the cap still bounds the buffer', () => {
    const buf = new PendingMembershipContent(2, 1_000);
    buf.holdExpiry(true);
    buf.defer(member('r1'), 0);
    buf.defer(member('r2'), 0);
    expect(buf.sweepExpired(60_000)).toBe(0);
    expect(buf.size()).toBe(2);
    buf.defer(member('r3'), 60_000);
    expect(buf.size()).toBe(2);
    expect(buf.dropped.takeDropCounts()).toEqual({ evicted: 1, expired: 0 });
    buf.holdExpiry(false);
    // P-538: the release re-arms r2 and r3 from the first observed now (60_000): one full TTL.
    expect(buf.sweepExpired(60_000)).toBe(0);
    expect(buf.sweepExpired(60_999)).toBe(0);
    expect(buf.sweepExpired(61_000)).toBe(2);
    expect(buf.dropped.takeDropCounts()).toEqual({ evicted: 0, expired: 2 });
  });

  it('P-538: content deferred during catch-up survives a member admitted just after it ends', () => {
    const buf = new PendingMembershipContent(100, 5 * 60_000);
    buf.holdExpiry(true); // a 943 s snapshot-set pass
    runWithDeferralSource({ keyHex: LOG, position: 7_789_134 }, () => buf.defer(member('r1'), 0));
    buf.holdExpiry(false); // the fold caught up at 943 s
    buf.defer({ ...member('r2'), authorDevice: 'dev-other' }, 943_000); // any later sweep
    const drained = buf.drainForDevices(['dev-1'], 965_000); // admitted 22 s later
    expect(drained.map((d) => d.rowKey)).toEqual(['r1']);
    expect(buf.dropped.takeDropCounts()).toEqual({ evicted: 0, expired: 0 });
    expect(buf.dropped.takeOwed()).toBeNull(); // nothing to re-fold: no rewind into the set
  });

  it('P-538: a member drain returns its own entries even past their TTL, while other buckets still expire', () => {
    const buf = new PendingMembershipContent(100, 1_000);
    runWithDeferralSource({ keyHex: LOG, position: 12 }, () => buf.defer(member('r1'), 0));
    runWithDeferralSource({ keyHex: OTHER, position: 5 }, () =>
      buf.defer({ ...member('x1'), authorDevice: 'dev-2' }, 0),
    );
    const drained = buf.drainForDevices(['dev-1'], 5_000);
    expect(drained.map((d) => d.rowKey)).toEqual(['r1']);
    expect(buf.size()).toBe(0); // dev-2's entry was past its TTL and swept after the drain
    expect(buf.dropped.takeDropCounts()).toEqual({ evicted: 0, expired: 1 });
    expect(buf.dropped.takeOwed()).toBeNull(); // dev-2 was never admitted: nothing owed
    expect(buf.dropped.has('device:dev-1')).toBe(false);
  });

  it('P-538: a source-log drain returns its own entries even past their TTL', () => {
    const buf = new PendingMembershipContent(100, 1_000);
    runWithDeferralSource({ keyHex: LOG, position: 30 }, () =>
      buf.deferUnresolvedSourceLog({ sourceLogKey: 'log-9', tableTag: 'engineer-issues', rowKey: 's1', reapply: async () => {} }, 0),
    );
    const drained = buf.drainForSourceLogKeys(['log-9'], 5_000);
    expect(drained.map((d) => d.rowKey)).toEqual(['s1']);
    expect(buf.dropped.takeDropCounts()).toEqual({ evicted: 0, expired: 0 });
    expect(buf.dropped.takeOwed()).toBeNull();
  });

  it('the member drain releases the device record even when every entry was dropped', () => {
    const buf = new PendingMembershipContent(100, 1_000);
    runWithDeferralSource({ keyHex: LOG, position: 12 }, () => buf.defer(member('r1'), 0));
    buf.sweepExpired(5_000);
    expect(buf.drainForDevices(['dev-1'], 5_000)).toEqual([]);
    expect(Object.fromEntries(buf.dropped.takeOwed()!.floors)).toEqual({ [LOG]: 12 });
  });

  it('a drained re-apply that defers again keeps the entry position, not the drain caller', async () => {
    const buf = new PendingMembershipContent(100, 1_000);
    const reapply = async () => {
      buf.defer({ ...member('r1'), authorDevice: 'dev-2', reapply }, 0);
    };
    runWithDeferralSource({ keyHex: LOG, position: 33 }, () => buf.defer({ ...member('r1'), reapply }, 0));
    const drained = buf.drainForDevices(['dev-1'], 0);
    await runWithDeferralSource({ keyHex: OTHER, position: 900 }, () => reapplyDrainedMemberContent(drained));
    expect(buf.drainForDevices(['dev-2'], 0).map((d) => d.source)).toEqual([{ keyHex: LOG, position: 33 }]);
  });
});

describe('drainQueuedEpochContent releases evicted ops only once this device holds the key (D-016)', () => {
  async function setup(hasKey: boolean, decryptOnDrain: boolean) {
    const pending = new PendingEpochContent(1);
    runWithDeferralSource({ keyHex: LOG, position: 4 }, () => pending.defer(op('a'), 'pot', 0));
    runWithDeferralSource({ keyHex: LOG, position: 5 }, () => pending.defer(op('b'), 'pot', 0));
    const drainQueue: DrainedEpoch[] = [{ potHomeSlug: 'pot', epoch: 0 }];
    const probes: number[] = [];
    await drainQueuedEpochContent({
      pending,
      drainQueue,
      applyImpl: async () => decryptOnDrain,
      hasEpochKey: async (_pot, epoch) => {
        probes.push(epoch);
        return hasKey;
      },
    });
    return { owed: pending.dropped.takeOwed(), probes, pending };
  }

  it('another device key row fires the drain, but the probe says no: nothing is owed', async () => {
    const r = await setup(false, false);
    expect(r.probes).toEqual([0]);
    expect(r.owed).toBeNull();
    expect(r.pending.hasEvicted('pot', 0)).toBe(true);
  });

  it('the probe says yes: the evicted op owes a re-read from its own position', async () => {
    const r = await setup(true, false);
    expect(Object.fromEntries(r.owed!.floors)).toEqual({ [LOG]: 4 });
  });

  it('a drained op that decrypts proves the key without a probe', async () => {
    const r = await setup(false, true);
    expect(r.probes).toEqual([]);
    expect(Object.fromEntries(r.owed!.floors)).toEqual({ [LOG]: 4 });
  });
});
