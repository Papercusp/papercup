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
import {
  drainQueuedEpochContent,
  buildEpochDecryptGate,
  buildEpochEncryptCapability,
  type DrainedEpoch,
} from '../hive-epoch-op-gate';
import { PendingEpochContent } from '../pending-epoch-content';
import { EpochKeyUnavailableError } from '../hive-epoch-key-provider';
import type { OpEnvelope } from '../op-envelope-types';
import type { HiveEpochCrypto, EpochKey } from '../hive-epoch-crypto';
import type { LocalWriteOp } from '../boot';

/** Fake symmetric crypto (mirrors hive-epoch-op-gate.test.ts): decrypt round-trips only when
 *  BOTH key + AAD opId match what sealed it, so the gate's defer/decrypt logic is exercised
 *  without real AEAD. */
function fakeCrypto(): HiveEpochCrypto {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    deriveEpochKey: async () => 'K' as unknown as EpochKey,
    wrapKeyToMember: async () => new Uint8Array(),
    unwrapEpochKey: async () => 'K' as unknown as EpochKey,
    encryptOp: async (payload: Uint8Array, key: EpochKey, aad: { opId: string }) =>
      enc.encode(JSON.stringify({ k: String(key), aad: aad.opId, p: Buffer.from(payload).toString('base64') })),
    decryptOp: async (ct: Uint8Array, key: EpochKey, aad: { opId: string }) => {
      const o = JSON.parse(dec.decode(ct)) as { k: string; aad: string; p: string };
      if (o.k !== String(key) || o.aad !== aad.opId) throw new Error('AEAD verify failed');
      return new Uint8Array(Buffer.from(o.p, 'base64'));
    },
  } as unknown as HiveEpochCrypto;
}

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
    const drainQueue: DrainedEpoch[] = [{ potHomeSlug: 'hive-x', epoch: 5 }];

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
    const drainQueue: DrainedEpoch[] = [{ potHomeSlug: 'hive-x', epoch: 5 }];

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
      drainQueue: [{ potHomeSlug: 'hive-x', epoch: 3 }],
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
      drainQueue: [{ potHomeSlug: 'hive-x', epoch: 7 }],
      applyImpl,
    });
    expect(n).toBe(0);
    expect(applyImpl).not.toHaveBeenCalled();
  });

  it('TEETH (best-effort): a re-apply throw does not abort the rest of the drain, and is REPORTED with its op', async () => {
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
    const reported: Array<{ hbKey: string | undefined; message: string }> = [];
    const n = await drainQueuedEpochContent({
      pending,
      drainQueue: [{ potHomeSlug: 'hive-x', epoch: 5 }],
      applyImpl,
      onReapplyError: (op, err) => reported.push({ hbKey: op.hbKey, message: (err as Error).message }),
    });
    expect(calls).toBe(2); // both attempted — the first threw but didn't abort
    expect(applied.map((o) => o.hbKey)).toEqual(['B']); // the second still applied
    expect(n).toBe(1); // only the successful one counted
    // WI-10002487: the cursor is already past a deferred op, so a swallowed throw is
    // silent, unrecoverable loss. The failure must surface, naming the op that was lost.
    expect(reported).toEqual([{ hbKey: 'A', message: 'transient apply error' }]);
  });

  it('WI-10002487: without an onReapplyError hook a re-apply throw is still reported (console.warn), never silent', async () => {
    const pending = new PendingEpochContent();
    pending.defer(contentOp('queue', 'A', 5, '5:1'), 'hive-x', 5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const n = await drainQueuedEpochContent({
        pending,
        drainQueue: [{ potHomeSlug: 'hive-x', epoch: 5 }],
        applyImpl: async () => {
          throw new Error('projection write failed');
        },
      });
      expect(n).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('queue/A');
      expect(String(warn.mock.calls[0]?.[1])).toContain('projection write failed');
    } finally {
      warn.mockRestore();
    }
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
        { potHomeSlug: 'hive-x', epoch: 1 },
        { potHomeSlug: 'hive-x', epoch: 2 },
        { potHomeSlug: 'hive-y', epoch: 1 },
      ],
      applyImpl,
    });
    expect(n).toBe(3);
    expect(applied.map((o) => o.hbKey).sort()).toEqual(['A', 'B', 'C']);
    expect(pending.size()).toBe(0);
  });
});

describe('decrypt-gate DEFER → drain CONVERGE — the end-to-end ship-gate guarantee', () => {
  const HIVE = 'hello-world-hive';
  const localOp = (over: Partial<LocalWriteOp> = {}): LocalWriteOp =>
    ({ type: 'put', table: 'harness-features', hbKey: 'F-1', value: { title: 'hi' }, ts: 0, writerPubkey: 'author1', ...over }) as LocalWriteOp;

  it('content arriving BEFORE its epoch key is deferred, then CONVERGES once the key lands + the drain runs', async () => {
    const crypto = fakeCrypto();
    // Encrypt an epoch-3 content op (owner side: key always derivable).
    const cap = buildEpochEncryptCapability({
      crypto,
      resolveKey: async () => 'K' as unknown as EpochKey,
      potId: HIVE,
      getCurrentEpoch: async () => 3,
    });
    const enc = await cap.encryptOp(localOp());
    expect(enc).not.toBeNull();
    const encOp = {
      type: 'put',
      table: 'harness-features',
      hbKey: 'F-1',
      writerPubkey: 'author1',
      value: enc!.value,
      epoch: enc!.epoch,
    } as OpEnvelope;

    // A REMAINING member whose epoch-3 key hasn't arrived yet (resolver rejects until it does).
    // WI-898 F1: the gate only defers a GENUINE absence — throw the real typed error real
    // resolvers (hive-epoch-key-provider.ts) use, not a generic Error.
    let keyAvailable = false;
    const resolveKey = async () => {
      if (!keyAvailable) throw new EpochKeyUnavailableError(HIVE, 3);
      return 'K' as unknown as EpochKey;
    };
    const pending = new PendingEpochContent();
    const gate = buildEpochDecryptGate({ crypto, resolveKey, potId: HIVE, pending });
    const applied: OpEnvelope[] = [];
    const applyImpl = gate(async (op) => {
      applied.push(op);
      return true;
    });

    // 1. Content arrives before the key → DEFERRED (never applied as garbage, never lost).
    expect(await applyImpl(encOp)).toBe(false);
    expect(applied).toEqual([]);
    expect(pending.size()).toBe(1);

    // 2. The epoch-3 hive_epoch_keys row applies → onEpochKeyApplied queued (HIVE, 3); key now local.
    keyAvailable = true;
    const drainQueue: DrainedEpoch[] = [{ potHomeSlug: HIVE, epoch: 3 }];

    // 3. The drain re-applies through the SAME gate → decrypts → CONVERGES.
    const n = await drainQueuedEpochContent({ pending, drainQueue, applyImpl });
    expect(n).toBe(1);
    expect(applied).toHaveLength(1);
    expect(applied[0].value).toEqual({ title: 'hi' }); // decrypted plaintext
    expect(applied[0].epoch).toBeUndefined(); // epoch cleared downstream
    expect(pending.size()).toBe(0); // converged — the bucket is drained
  });

  it('TEETH: WITHOUT the drain, deferred content NEVER converges (the silent-loss bug the hook closes)', async () => {
    const crypto = fakeCrypto();
    const cap = buildEpochEncryptCapability({
      crypto,
      resolveKey: async () => 'K' as unknown as EpochKey,
      potId: HIVE,
      getCurrentEpoch: async () => 1,
    });
    const enc = await cap.encryptOp(localOp());
    const encOp = {
      type: 'put',
      table: 'harness-features',
      hbKey: 'F-1',
      writerPubkey: 'author1',
      value: enc!.value,
      epoch: enc!.epoch,
    } as OpEnvelope;
    let keyAvailable = false;
    const resolveKey = async () => {
      if (!keyAvailable) throw new EpochKeyUnavailableError(HIVE, 1);
      return 'K' as unknown as EpochKey;
    };
    const pending = new PendingEpochContent();
    const applied: OpEnvelope[] = [];
    const applyImpl = buildEpochDecryptGate({ crypto, resolveKey, potId: HIVE, pending })(async (op) => {
      applied.push(op);
      return true;
    });

    expect(await applyImpl(encOp)).toBe(false); // deferred (key missing)
    keyAvailable = true; // the key arrives…
    // …but NO drain is invoked (the pre-fix bug) → the merge cursor has advanced past the
    // content op, so it is NEVER re-applied → silent loss for a legitimate remaining member.
    expect(applied).toEqual([]); // the gap: content lost despite the key now being local
    expect(pending.size()).toBe(1); // still stuck in the buffer, never converged
  });
});
