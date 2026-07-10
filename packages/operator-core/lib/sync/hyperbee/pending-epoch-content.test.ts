/**
 * pending-epoch-content.test.ts — the KEY-BEFORE-CONTENT ordering invariant
 * (Brief RE-KEY / C-001 / Move 2; P-005, 46b7a). Teeth-verified: each assertion
 * pins a behaviour the apply-seam wiring relies on.
 */
import { describe, expect, it } from 'vitest';
import { PendingEpochContent } from './pending-epoch-content';
import type { OpEnvelope } from './op-envelope-types';

/** Minimal content OpEnvelope for (key, epoch-content). */
function op(hbKey: string, opts: { hlc?: string; ts?: number; type?: 'put' | 'del' } = {}): OpEnvelope {
  return {
    type: opts.type ?? 'put',
    table: 'features-by-id',
    hbKey,
    value: { marker: hbKey },
    ts: opts.ts ?? 1000,
    schema_version: 1,
    ...(opts.hlc ? { hlc: opts.hlc } : {}),
  } as OpEnvelope;
}

const HIVE = 'hello-world-hive';

describe('PendingEpochContent — key-before-content deferral', () => {
  it('content-before-key: a deferred op is held, then drained FIFO when the epoch key lands', () => {
    const p = new PendingEpochContent();
    expect(p.defer(op('F-a'), HIVE, 5)).toBe(true);
    expect(p.defer(op('F-b'), HIVE, 5)).toBe(true);
    expect(p.defer(op('F-c'), HIVE, 5)).toBe(true);
    expect(p.size()).toBe(3);

    // The (hive, epoch=5) key row arrives → drain returns them in insertion order.
    const ready = p.drainEpoch(HIVE, 5);
    expect(ready.map((d) => d.op.hbKey)).toEqual(['F-a', 'F-b', 'F-c']); // FIFO
    expect(p.size()).toBe(0);
    expect(p.bucketCount()).toBe(0);
  });

  it('key-before-content: draining an empty (hive, epoch) bucket is a no-op', () => {
    const p = new PendingEpochContent();
    expect(p.drainEpoch(HIVE, 7)).toEqual([]);
    expect(p.size()).toBe(0);
  });

  it('isolates buckets by (hive, epoch): draining one epoch leaves others pending', () => {
    const p = new PendingEpochContent();
    p.defer(op('F-e5'), HIVE, 5);
    p.defer(op('F-e6'), HIVE, 6);
    p.defer(op('F-h2'), 'other-hive', 5);
    expect(p.size()).toBe(3);

    const e5 = p.drainEpoch(HIVE, 5);
    expect(e5.map((d) => d.op.hbKey)).toEqual(['F-e5']);
    expect(p.size()).toBe(2); // (HIVE,6) + (other-hive,5) remain
    expect(p.drainEpoch(HIVE, 6).map((d) => d.op.hbKey)).toEqual(['F-e6']);
    expect(p.drainEpoch('other-hive', 5).map((d) => d.op.hbKey)).toEqual(['F-h2']);
    expect(p.size()).toBe(0);
  });

  it('re-fold safe: re-deferring the SAME op version does not duplicate it', () => {
    const p = new PendingEpochContent();
    expect(p.defer(op('F-x', { hlc: '000000000001000:00000' }), HIVE, 5)).toBe(true);
    // A cursor reset re-encounters the identical op → must NOT inflate the buffer.
    expect(p.defer(op('F-x', { hlc: '000000000001000:00000' }), HIVE, 5)).toBe(false);
    expect(p.size()).toBe(1);
    // A strictly-NEWER op for the same key IS a distinct deferral (it supersedes).
    expect(p.defer(op('F-x', { hlc: '000000000002000:00000' }), HIVE, 5)).toBe(true);
    expect(p.size()).toBe(2);
  });

  it('removed-member cut-off: undecryptable content stays pending forever, bounded (oldest evicted)', () => {
    // A removed peer keeps receiving epoch-6 content it can never decrypt (no key
    // row ever arrives). The buffer must NOT grow without limit.
    const CAP = 50;
    const p = new PendingEpochContent(CAP);
    for (let i = 0; i < CAP + 20; i++) p.defer(op(`F-${i}`), HIVE, 6);
    expect(p.size()).toBe(CAP); // bounded
    // The key never lands → the content is never applied = the C-001 read cut-off.
    // (The 20 evicted ops' ciphertext is still in the log — a re-fold re-defers.)
    // The retained set is the NEWEST CAP (oldest evicted): F-20..F-69 head is F-20.
    const ready = p.drainEpoch(HIVE, 6);
    expect(ready.length).toBe(CAP);
    expect(ready[0].op.hbKey).toBe('F-20'); // oldest-surviving (F-0..F-19 evicted)
    expect(ready[ready.length - 1].op.hbKey).toBe('F-69');
  });

  it('eviction is GLOBALLY oldest-first across buckets (fair back-pressure)', () => {
    const p = new PendingEpochContent(3);
    p.defer(op('a'), HIVE, 1); // seq 0 (oldest)
    p.defer(op('b'), HIVE, 2); // seq 1
    p.defer(op('c'), HIVE, 3); // seq 2
    p.defer(op('d'), HIVE, 4); // seq 3 → evicts seq 0 (a, in bucket epoch=1)
    expect(p.size()).toBe(3);
    expect(p.drainEpoch(HIVE, 1)).toEqual([]); // a was evicted, bucket gone
    expect(p.drainEpoch(HIVE, 2).map((d) => d.op.hbKey)).toEqual(['b']);
    expect(p.drainEpoch(HIVE, 4).map((d) => d.op.hbKey)).toEqual(['d']);
  });

  describe('WI-3852 (F2 of WI-898): eviction-signal recovery without a process restart', () => {
    it('consumeEvictionSignal is false until an eviction actually happens', () => {
      const p = new PendingEpochContent(50);
      expect(p.consumeEvictionSignal()).toBe(false);
      p.defer(op('a'), HIVE, 1);
      p.defer(op('b'), HIVE, 2);
      // Under the cap — deferring alone never trips the signal.
      expect(p.consumeEvictionSignal()).toBe(false);
    });

    it('overflowing maxPending trips the eviction signal exactly once until re-consumed', () => {
      const CAP = 10;
      const p = new PendingEpochContent(CAP);
      for (let i = 0; i < CAP; i++) p.defer(op(`F-${i}`), HIVE, 1);
      expect(p.consumeEvictionSignal()).toBe(false); // still at cap, nothing evicted yet

      p.defer(op('F-overflow'), HIVE, 1); // CAP+1 → evicts the oldest
      // THE RECOVERY PATH (no process restart): the signal fires...
      expect(p.consumeEvictionSignal()).toBe(true);
      // ...and consuming it CLEARS it (read-and-clear, not read-only) so a caller
      // that already reacted (tripped its own forceReFold) doesn't re-react forever.
      expect(p.consumeEvictionSignal()).toBe(false);

      // Multiple evictions between polls still collapse to one true (a boot.ts pass
      // only needs to know "at least one eviction happened since last pass").
      for (let i = 0; i < 5; i++) p.defer(op(`F-more-${i}`), HIVE, 1); // 5 more evictions
      expect(p.consumeEvictionSignal()).toBe(true);
      expect(p.consumeEvictionSignal()).toBe(false);

      // And critically: the evicted ops are NOT actually gone from the source-of-truth
      // (the peer log) — this buffer only forgot them. A re-fold (which boot.ts now
      // triggers off this very signal) re-defers whatever is still relevant; draining
      // proves the buffer itself recovered to a consistent, boundable state (no restart
      // needed to keep operating).
      expect(p.size()).toBe(CAP);
      const ready = p.drainEpoch(HIVE, 1);
      expect(ready.length).toBe(CAP);
    });
  });
});
