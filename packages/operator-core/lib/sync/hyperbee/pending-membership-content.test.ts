/**
 * pending-membership-content.test — the WI-259 P-004 content-before-membership buffer
 * (plan shared-hive-member-content-federation-2026-06-20). Pure (injected clock), so these
 * are deterministic unit tests: defer/dedup, per-device drain, TTL eviction, size bound, and
 * the best-effort re-apply helper.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PendingMembershipContent,
  reapplyDrainedMemberContent,
  DEFAULT_MAX_PENDING_MEMBER_CONTENT,
  type DeferMemberContentInput,
  type DeferSourceLogContentInput,
} from './pending-membership-content';

const noop = async () => {};

function entry(over: Partial<DeferMemberContentInput> = {}): DeferMemberContentInput {
  return {
    authorDevice: 'devA',
    tableTag: 'features-by-id',
    rowKey: 'F-1',
    fedHlc: 'hlc-1',
    fedTs: 1000,
    reapply: noop,
    ...over,
  };
}

function sourceEntry(over: Partial<DeferSourceLogContentInput> = {}): DeferSourceLogContentInput {
  return {
    sourceLogKey: 'logA',
    tableTag: 'features-by-id',
    rowKey: 'F-1',
    fedHlc: 'hlc-1',
    fedTs: 1000,
    reapply: noop,
    ...over,
  };
}

describe('PendingMembershipContent', () => {
  it('defers a cross-member op and reports it pending', () => {
    const buf = new PendingMembershipContent();
    expect(buf.defer(entry(), 0)).toBe(true);
    expect(buf.size()).toBe(1);
    expect(buf.bucketCount()).toBe(1);
  });

  it('is idempotent per op identity (re-fold / re-drain does not duplicate)', () => {
    const buf = new PendingMembershipContent();
    expect(buf.defer(entry(), 0)).toBe(true);
    // Same projection + key + LWW keys → already pending.
    expect(buf.defer(entry(), 5)).toBe(false);
    expect(buf.size()).toBe(1);
    // A strictly-newer op for the SAME key is a DIFFERENT deferral (LWW supersedes on re-apply).
    expect(buf.defer(entry({ fedHlc: 'hlc-2', fedTs: 2000 }), 5)).toBe(true);
    expect(buf.size()).toBe(2);
  });

  it('buckets by author device — drainForDevices returns only the matching member’s ops', () => {
    const buf = new PendingMembershipContent();
    buf.defer(entry({ authorDevice: 'devA', rowKey: 'F-1' }), 0);
    buf.defer(entry({ authorDevice: 'devA', rowKey: 'F-2' }), 0);
    buf.defer(entry({ authorDevice: 'devB', rowKey: 'F-3' }), 0);
    expect(buf.size()).toBe(3);

    const drained = buf.drainForDevices(['devA'], 1);
    expect(drained.map((d) => d.rowKey)).toEqual(['F-1', 'F-2']); // FIFO
    expect(buf.size()).toBe(1); // devB still buffered
    expect(buf.drainForDevices(['devB'], 1).map((d) => d.rowKey)).toEqual(['F-3']);
    expect(buf.size()).toBe(0);
  });

  it('drains across MULTIPLE devices of one member in FIFO order', () => {
    const buf = new PendingMembershipContent();
    buf.defer(entry({ authorDevice: 'dev1', rowKey: 'F-1' }), 0);
    buf.defer(entry({ authorDevice: 'dev2', rowKey: 'F-2' }), 0);
    const drained = buf.drainForDevices(['dev1', 'dev2'], 1);
    expect(drained.map((d) => d.rowKey)).toEqual(['F-1', 'F-2']);
    expect(buf.size()).toBe(0);
  });

  it('drainForDevices on a never-deferred device returns []', () => {
    const buf = new PendingMembershipContent();
    buf.defer(entry({ authorDevice: 'devA' }), 0);
    expect(buf.drainForDevices(['someone-else'], 1)).toEqual([]);
    expect(buf.size()).toBe(1);
  });

  it('buckets unresolved source-log ops until that log identity is admitted', () => {
    const buf = new PendingMembershipContent();
    expect(buf.deferUnresolvedSourceLog(sourceEntry({ sourceLogKey: 'logA', rowKey: 'F-1' }), 0)).toBe(true);
    expect(buf.deferUnresolvedSourceLog(sourceEntry({ sourceLogKey: 'logA', rowKey: 'F-2' }), 0)).toBe(true);
    expect(buf.deferUnresolvedSourceLog(sourceEntry({ sourceLogKey: 'logB', rowKey: 'F-3' }), 0)).toBe(true);
    expect(buf.size()).toBe(3);
    expect(buf.bucketCount()).toBe(2);

    const drained = buf.drainForSourceLogKeys(['logA'], 1);
    expect(drained.map((d) => d.rowKey)).toEqual(['F-1', 'F-2']);
    expect(buf.size()).toBe(1);
    expect(buf.drainForSourceLogKeys(['logB'], 1).map((d) => d.rowKey)).toEqual(['F-3']);
    expect(buf.size()).toBe(0);
  });

  it('dedupes unresolved source-log deferrals by projected row version', () => {
    const buf = new PendingMembershipContent();
    expect(buf.deferUnresolvedSourceLog(sourceEntry(), 0)).toBe(true);
    expect(buf.deferUnresolvedSourceLog(sourceEntry(), 5)).toBe(false);
    expect(buf.deferUnresolvedSourceLog(sourceEntry({ fedHlc: 'hlc-2', fedTs: 2000 }), 5)).toBe(true);
    expect(buf.size()).toBe(2);
  });

  it('evicts entries past their TTL (genuine non-member content expires)', () => {
    const TTL = 1_000;
    const buf = new PendingMembershipContent(100, TTL);
    buf.defer(entry({ authorDevice: 'devGhost', rowKey: 'F-ghost' }), 0);
    expect(buf.size()).toBe(1);
    // A defer past the TTL sweeps the expired ghost entry.
    buf.defer(entry({ authorDevice: 'devReal', rowKey: 'F-real' }), TTL + 1);
    expect(buf.size()).toBe(1);
    // The ghost is gone — draining its device yields nothing.
    expect(buf.drainForDevices(['devGhost'], TTL + 2)).toEqual([]);
    expect(buf.drainForDevices(['devReal'], TTL + 2).map((d) => d.rowKey)).toEqual(['F-real']);
  });

  it('sweepExpired evicts at/after the deadline (kept while now < expiresAt)', () => {
    const buf = new PendingMembershipContent(100, 1_000);
    buf.defer(entry({ rowKey: 'F-1' }), 0); // expiresAt = 1000
    expect(buf.sweepExpired(999)).toBe(0); // still live before the deadline
    expect(buf.size()).toBe(1);
    expect(buf.sweepExpired(1_000)).toBe(1); // evicted once now >= expiresAt
    expect(buf.size()).toBe(0);
  });

  it('enforces the hard size cap by evicting the globally-oldest deferral', () => {
    const MAX = 3;
    const buf = new PendingMembershipContent(MAX, 1_000_000);
    for (let i = 0; i < MAX; i++) buf.defer(entry({ authorDevice: `dev${i}`, rowKey: `F-${i}` }), 0);
    expect(buf.size()).toBe(MAX);
    // One more over the cap → evict the oldest (dev0/F-0).
    buf.defer(entry({ authorDevice: 'devNew', rowKey: 'F-new' }), 1);
    expect(buf.size()).toBe(MAX);
    expect(buf.drainForDevices(['dev0'], 2)).toEqual([]); // evicted
    expect(buf.drainForDevices(['devNew'], 2).map((d) => d.rowKey)).toEqual(['F-new']);
  });

  it('enforces the hard size cap across device and source-log buckets', () => {
    const buf = new PendingMembershipContent(2, 1_000_000);
    buf.deferUnresolvedSourceLog(sourceEntry({ sourceLogKey: 'logOld', rowKey: 'F-old' }), 0);
    buf.defer(entry({ authorDevice: 'devA', rowKey: 'F-dev' }), 1);
    buf.deferUnresolvedSourceLog(sourceEntry({ sourceLogKey: 'logNew', rowKey: 'F-new' }), 2);

    expect(buf.size()).toBe(2);
    expect(buf.drainForSourceLogKeys(['logOld'], 3)).toEqual([]);
    expect(buf.drainForDevices(['devA'], 3).map((d) => d.rowKey)).toEqual(['F-dev']);
    expect(buf.drainForSourceLogKeys(['logNew'], 3).map((d) => d.rowKey)).toEqual(['F-new']);
  });

  it('default size cap is the documented backstop', () => {
    expect(DEFAULT_MAX_PENDING_MEMBER_CONTENT).toBe(5_000);
  });

  describe('WI-3852 (F2 of WI-898): eviction-signal recovery without a process restart', () => {
    it('consumeEvictionSignal is false until a TTL sweep or capacity eviction actually happens', () => {
      const buf = new PendingMembershipContent(100, 1_000);
      expect(buf.consumeEvictionSignal()).toBe(false);
      buf.defer(entry({ rowKey: 'F-1' }), 0);
      expect(buf.consumeEvictionSignal()).toBe(false); // deferring alone never trips it
      expect(buf.sweepExpired(999)).toBe(0); // not yet expired
      expect(buf.consumeEvictionSignal()).toBe(false);
    });

    it('a TTL sweep trips the signal exactly once until re-consumed', () => {
      const buf = new PendingMembershipContent(100, 1_000);
      buf.defer(entry({ authorDevice: 'devGhost', rowKey: 'F-ghost' }), 0); // expiresAt=1000
      // A later defer()'s internal sweepExpired(now) crosses the TTL for the ghost entry —
      // this is THE RECOVERY PATH: without the signal, that silent loss is invisible until
      // the next process restart re-folds the peer log from scratch.
      buf.defer(entry({ authorDevice: 'devReal', rowKey: 'F-real' }), 1_001);
      expect(buf.consumeEvictionSignal()).toBe(true);
      expect(buf.consumeEvictionSignal()).toBe(false); // read-and-clear
    });

    it('a capacity eviction also trips the signal', () => {
      const buf = new PendingMembershipContent(2, 1_000_000);
      buf.defer(entry({ authorDevice: 'dev0', rowKey: 'F-0' }), 0);
      buf.defer(entry({ authorDevice: 'dev1', rowKey: 'F-1' }), 0);
      expect(buf.consumeEvictionSignal()).toBe(false); // at cap, nothing evicted yet
      buf.defer(entry({ authorDevice: 'dev2', rowKey: 'F-2' }), 0); // over cap → evicts dev0
      expect(buf.consumeEvictionSignal()).toBe(true);
      expect(buf.consumeEvictionSignal()).toBe(false);
    });

    it('an explicit sweepExpired() call (the drain-hot-path sweep) also trips the signal', () => {
      const buf = new PendingMembershipContent(100, 1_000);
      buf.defer(entry({ rowKey: 'F-1' }), 0);
      expect(buf.sweepExpired(1_000)).toBe(1); // evicted at the deadline
      expect(buf.consumeEvictionSignal()).toBe(true);
      expect(buf.consumeEvictionSignal()).toBe(false);
    });
  });
});

describe('reapplyDrainedMemberContent', () => {
  it('re-applies every drained entry and counts the successes', async () => {
    const calls: string[] = [];
    const mk = (id: string) => ({
      authorDevice: 'd',
      tableTag: 't',
      rowKey: id,
      fedHlc: null,
      fedTs: null,
      seq: 0,
      expiresAt: 0,
      reapply: async () => {
        calls.push(id);
      },
    });
    const n = await reapplyDrainedMemberContent([mk('a'), mk('b')]);
    expect(n).toBe(2);
    expect(calls).toEqual(['a', 'b']);
  });

  it('is best-effort — a throwing re-apply does not abort the batch', async () => {
    const ok = vi.fn(async () => {});
    const boom = async () => {
      throw new Error('still not a member');
    };
    const mk = (reapply: () => Promise<void>) => ({
      authorDevice: 'd',
      tableTag: 't',
      rowKey: 'k',
      fedHlc: null,
      fedTs: null,
      seq: 0,
      expiresAt: 0,
      reapply,
    });
    const n = await reapplyDrainedMemberContent([mk(boom), mk(ok)]);
    expect(n).toBe(1); // only the non-throwing one counts
    expect(ok).toHaveBeenCalledOnce(); // the throw did not abort the batch
  });
});
