/**
 * hive-epoch-drain.test.ts — the re-key DRAIN HOOK (shared-hive-rekey-2026-06-19, su-c2a63;
 * ee7e9 reviews). The pre-ship convergence guarantee the P-008 witness can't exercise
 * (it orders keys-first → never defers → never drains).
 *
 * `drainQueuedEpochContent` is the complement of the decrypt gate's DEFER: once a
 * `hive_epoch_keys` row applies (the projection's `onEpochKeyApplied` pushes the
 * `(hive, epoch)` onto the boot-scope queue), the deferred epoch-N content for that bucket
 * is re-applied through the SAME applyImpl (now decryptable) → it converges instead of
 * being silently lost. These tests pin: re-apply on signal, epoch-scoping, FIFO, the
 * empty-queue no-op, queue consumption, non-re-entrancy, and best-effort throw-swallowing.
 */
import { describe, it, expect, vi } from 'vitest';
import { drainQueuedEpochContent, type DrainedEpoch } from '../hive-epoch-op-gate';
import { PendingEpochContent } from '../pending-epoch-content';
import type { OpEnvelope } from '../op-envelope-types';

function contentOp(table: string, hbKey: string, epoch: number, hlc = `${epoch}:0`): OpEnvelope {
  return { type: 'put', table, hbKey, value: { v: hbKey }, ts: epoch, schema_version: 1, hlc, epoch };
}

describe('drainQueuedEpochContent — the re-key drain hook', () => {
  it('re-applies a deferred epoch-N op once its (hive, epoch) key is queued', async () => {
    const pending = new PendingEpochContent();
    const op = contentOp('queue', 'A', 5);
    expect(pending.defer(op, 'hive-x', 5)).toBe(true); // gate deferred it (no key yet)
    expect(pending.size()).toBe(1);

    const applied: OpEnvelope[] = [];
    const applyImpl = async (o: OpEnvelope) => {
      applied.push(o);
      return true;
    };
    // onEpochKeyApplied('hive-x', 5) recorded this when the key row applied.
    const drainQueue: DrainedEpoch[] = [{ hiveHomeSlug: 'hive-x', epoch: 5 }];

    const n = await drainQueuedEpochContent({ pending, drainQueue, applyImpl });

    expect(n).toBe(1); // one deferred op re-applied → converges
    expect(applied).toEqual([op]); // re-run through the SAME applyImpl
    expect(pending.size()).toBe(0); // bucket drained
    expect(drainQueue).toEqual([]); // queue consumed (spliced)
  });

  it('drains ONLY the queued epoch — an op waiting on a NOT-yet-applied epoch stays deferred', async () => {
    const pending = new PendingEpochContent();
    pending.defer(contentOp('queue', 'A', 5), 'hive-x', 5);
    pending.defer(contentOp('queue', 'B', 6), 'hive-x', 6); // epoch-6 key NOT applied
    const applied: OpEnvelope[] = [];
    const applyImpl = async (o: OpEnvelope) => {
      applied.push(o);
      return true;
    };
    const drainQueue: DrainedEpoch[] = [{ hiveHomeSlug: 'hive-x', epoch: 5 }];

    await drainQueuedEpochContent({ pending, drainQueue, applyImpl });

    expect(applied.map((o) => o.hbKey)).toEqual(['A']); // only the epoch-5 op
    expect(pending.size()).toBe(1); // the epoch-6 op is still pending (its key hasn't arrived)
  });

  it('re-applies a bucket FIFO (insertion order)', async () => {
    const pending = new PendingEpochContent();
    pending.defer(contentOp('queue', 'first', 3, '3:1'), 'hive-x', 3);
    pending.defer(contentOp('queue', 'second', 3, '3:2'), 'hive-x', 3);
    pending.defer(contentOp('queue', 'third', 3, '3:3'), 'hive-x', 3);
    const applied: OpEnvelope[] = [];
    const applyImpl = async (o: OpEnvelope) => {
      applied.push(o);
      return true;
    };
    await drainQueuedEpochContent({
      pending,
      drainQueue: [{ hiveHomeSlug: 'hive-x', epoch: 3 }],
      applyImpl,
    });
    expect(applied.map((o) => o.hbKey)).toEqual(['first', 'second', 'third']);
  });

  it('empty queue → no-op (no applyImpl calls)', async () => {
    const pending = new PendingEpochContent();
    const applyImpl = vi.fn(async () => true);
    const n = await drainQueuedEpochContent({ pending, drainQueue: [], applyImpl });
    expect(n).toBe(0);
    expect(applyImpl).not.toHaveBeenCalled();
  });

  it('a queued epoch with NOTHING deferred → no-op (the common keys-first ordering)', async () => {
    const pending = new PendingEpochContent();
    const applyImpl = vi.fn(async () => true);
    // Key applied but content arrived AFTER (normal case) → nothing was ever deferred.
    const n = await drainQueuedEpochContent({
      pending,
      drainQueue: [{ hiveHomeSlug: 'hive-x', epoch: 7 }],
      applyImpl,
    });
    expect(n).toBe(0);
    expect(applyImpl).not.toHaveBeenCalled();
  });

  it('TEETH (best-effort): a re-apply throw is swallowed and does not abort the rest of the drain', async () => {
    const pending = new PendingEpochContent();
    pending.defer(contentOp('queue', 'A', 5, '5:1'), 'hive-x', 5);
    pending.defer(contentOp('queue', 'B', 5, '5:2'), 'hive-x', 5);
    let calls = 0;
    const applied: OpEnvelope[] = [];
    const applyImpl = async (o: OpEnvelope) => {
      calls++;
      if (calls === 1) throw new Error('transient apply error');
      applied.push(o);
      return true;
    };
    const n = await drainQueuedEpochContent({
      pending,
      drainQueue: [{ hiveHomeSlug: 'hive-x', epoch: 5 }],
      applyImpl,
    });
    expect(calls).toBe(2); // both attempted — the first threw but didn't abort
    expect(applied.map((o) => o.hbKey)).toEqual(['B']); // the second still applied
    expect(n).toBe(1); // only the successful one counted
  });

  it('multiple queued (hive, epoch) buckets all drain', async () => {
    const pending = new PendingEpochContent();
    pending.defer(contentOp('queue', 'A', 1), 'hive-x', 1);
    pending.defer(contentOp('queue', 'B', 2), 'hive-x', 2);
    pending.defer(contentOp('queue', 'C', 1), 'hive-y', 1); // a different hive
    const applied: OpEnvelope[] = [];
    const applyImpl = async (o: OpEnvelope) => {
      applied.push(o);
      return true;
    };
    const n = await drainQueuedEpochContent({
      pending,
      drainQueue: [
        { hiveHomeSlug: 'hive-x', epoch: 1 },
        { hiveHomeSlug: 'hive-x', epoch: 2 },
        { hiveHomeSlug: 'hive-y', epoch: 1 },
      ],
      applyImpl,
    });
    expect(n).toBe(3);
    expect(applied.map((o) => o.hbKey).sort()).toEqual(['A', 'B', 'C']);
    expect(pending.size()).toBe(0);
  });
});
