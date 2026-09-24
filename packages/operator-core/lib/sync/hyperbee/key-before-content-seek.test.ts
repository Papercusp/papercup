/**
 * key-before-content-seek.test.ts — p2p-join-catchup-speed-2026-09-23 P-524 (D-009 (b)).
 *
 * A fresh joiner's wrapped epoch-key row is appended when it is admitted, so it sits after
 * the content it unlocks. Folding in log order, every encrypted row reached the decrypt
 * gate before the key, deferred into the bounded PendingEpochContent buffer and overflowed
 * it (P-007 run #1: nothing applied across 438 of 1,053 set chunks).
 *
 * These tests run the REAL decrypt gate, deferral buffer and drain hook through
 * `mergeAdmittedLogsIncremental`. The only fakes are the AEAD (round-trips on matching key +
 * AAD, as in hive-epoch-op-gate.test.ts) and the key store standing in for pot_epoch_keys.
 * The control case (no `keySeek`) is kept permanently: it is what shows the seek changes the
 * outcome, rather than the fixture never deferring in the first place.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildEpochDecryptGate,
  buildEpochEncryptCapability,
  buildEpochKeySeek,
  drainQueuedEpochContent,
  type DrainedEpoch,
  type EpochKeyResolver,
} from './hive-epoch-op-gate';
import { PendingEpochContent } from './pending-epoch-content';
import { EpochKeyUnavailableError } from './hive-epoch-key-provider';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog, type EpochKeySeek } from './read-merge';
import { SNAPSHOT_TABLE_TAG, type SnapshotPayload } from './log-snapshot';
import type { HiveEpochCrypto, EpochKey } from './hive-epoch-crypto';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';
import type { LocalWriteOp } from './boot';

const HIVE = 'papercusp-hive';
const DEVICE = 'dcJWGl-this-device';
const OTHER = 'zz-another-member';
const EPOCH = 1;
const KEY = 'K' as unknown as EpochKey;

function fakeCrypto(): HiveEpochCrypto {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    deriveEpochKey: async () => KEY,
    wrapKeyToMember: async () => new Uint8Array(),
    unwrapEpochKey: async () => KEY,
    encryptOp: async (payload: Uint8Array, key: EpochKey, aad: { opId: string }) =>
      enc.encode(JSON.stringify({ k: String(key), aad: aad.opId, p: Buffer.from(payload).toString('base64') })),
    decryptOp: async (ct: Uint8Array, key: EpochKey, aad: { opId: string }) => {
      const o = JSON.parse(dec.decode(ct)) as { k: string; aad: string; p: string };
      if (o.k !== String(key) || o.aad !== aad.opId) throw new Error('AEAD verify failed');
      return new Uint8Array(Buffer.from(o.p, 'base64'));
    },
  } as unknown as HiveEpochCrypto;
}

async function contentOps(prefix: string, n: number, ts0: number): Promise<PeerLogOp[]> {
  const cap = buildEpochEncryptCapability({
    crypto: fakeCrypto(),
    resolveKey: async () => KEY,
    potId: HIVE,
    getCurrentEpoch: async () => EPOCH,
  });
  const ops: PeerLogOp[] = [];
  for (let i = 0; i < n; i++) {
    const hbKey = `${prefix}-${i}`;
    const sealed = await cap.encryptOp({
      type: 'put',
      table: 'work-items',
      hbKey,
      value: { title: hbKey },
      ts: ts0 + i,
      writerPubkey: '',
    } as LocalWriteOp);
    ops.push({
      type: 'put',
      table: 'work-items',
      hbKey,
      value: sealed!.value,
      epoch: sealed!.epoch,
      ts: ts0 + i,
      schema_version: 1,
      author_pubkey: '',
    });
  }
  return ops;
}

function keyRow(device: string, ts: number): PeerLogOp {
  return {
    type: 'put',
    table: 'hive-epoch-keys',
    hbKey: `${EPOCH}:${device}`,
    value: { harness_slug: HIVE, epoch: EPOCH, member_device_pubkey: device, wrapped_key: 'w' },
    ts,
    schema_version: 1,
    author_pubkey: '',
  };
}

function plainOps(n: number, ts0: number): PeerLogOp[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'put' as const,
    table: 'notes',
    hbKey: `N-${i}`,
    value: { n: i },
    ts: ts0 + i,
    schema_version: 1,
    author_pubkey: '',
  }));
}

/** An in-memory log that counts reads per position. */
function memLog(ops: PeerLogOp[]): AdmittedLog & { ops: PeerLogOp[]; reads: Map<number, number> } {
  const reads = new Map<number, number>();
  return {
    keyHex: 'a'.repeat(64),
    ops,
    reads,
    get length() {
      return ops.length;
    },
    async get(i: number) {
      reads.set(i, (reads.get(i) ?? 0) + 1);
      return ops[i] ?? null;
    },
  };
}

/**
 * The boot-shaped stack: gate(inner) where inner is the projection layer. A key row for
 * THIS device lands the key in the store (pot_epoch_keys) and fires the drain hook, as
 * the hive-epoch-keys projection does; every applied row is recorded in order.
 */
function joiner(opts: { maxPending: number; seek: boolean }) {
  const keys = new Map<number, EpochKey>();
  const applied: string[] = [];
  const drainQueue: DrainedEpoch[] = [];
  const pending = new PendingEpochContent(opts.maxPending);
  const resolveKey: EpochKeyResolver = async (potId, epoch) => {
    const k = keys.get(epoch);
    if (!k) throw new EpochKeyUnavailableError(potId, epoch);
    return k;
  };
  const inner = async (env: OpEnvelope): Promise<boolean> => {
    applied.push(`${env.table}::${env.hbKey}`);
    if (env.table === 'hive-epoch-keys') {
      const row = env.value as { epoch: number; member_device_pubkey: string };
      if (row.member_device_pubkey === DEVICE) keys.set(row.epoch, KEY);
      drainQueue.push({ potHomeSlug: HIVE, epoch: row.epoch });
    }
    return true;
  };
  const seeker = opts.seek ? buildEpochKeySeek(DEVICE) : null;
  const applyImpl = buildEpochDecryptGate({
    crypto: fakeCrypto(),
    resolveKey,
    potId: HIVE,
    pending,
    ...(seeker ? { onKeyMissing: seeker.onKeyMissing } : {}),
  })(inner);
  const contentApplied = () => applied.filter((a) => a.startsWith('work-items::')).length;
  const drain = () => drainQueuedEpochContent({ pending, drainQueue, applyImpl });
  return { applied, pending, applyImpl, drain, contentApplied, keySeek: seeker?.keySeek };
}

describe('P-524 key before content — a fresh joiner whose key row follows its content', () => {
  it('applies every content row on the first crossing, with no deferral eviction', async () => {
    const N = 60;
    const log = memLog([...(await contentOps('W', N, 1000)), keyRow(OTHER, 5000), keyRow(DEVICE, 5001)]);
    const j = joiner({ maxPending: 10, seek: true });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const cursor = createMergeCursor();
      const r = await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: j.applyImpl, keySeek: j.keySeek });

      // Only W-0 reached the gate before the key; the seek fetched the key, and every later
      // row decrypted on this first crossing.
      expect(j.contentApplied()).toBe(N - 1);
      expect(j.pending.size()).toBe(1);
      expect(j.pending.consumeEvictionSignal()).toBe(false);
      // The seek applied THIS device's key row and nothing else: the other member's row, and
      // every content row, still applied in log order.
      expect(j.applied.indexOf(`hive-epoch-keys::${EPOCH}:${DEVICE}`)).toBe(0);
      expect(j.applied.indexOf(`hive-epoch-keys::${EPOCH}:${OTHER}`)).toBe(N);
      // The content cursor was not moved by the seek: it ends where any pass ends.
      expect(r.caughtUp).toBe(true);
      expect(cursor.positions.get(log.keyHex)).toBe(log.length);
      expect(info.mock.calls.some((c) => String(c[0]).includes('P-524 key seek') && String(c[0]).includes('applied'))).toBe(true);

      // The one deferred row drains through the ordinary key-applied hook after the pass.
      await j.drain();
      expect(j.contentApplied()).toBe(N);
      expect(j.pending.size()).toBe(0);
    } finally {
      info.mockRestore();
    }
  });

  it('CONTROL — without the seek the same log defers every row and evicts past the buffer', async () => {
    const N = 60;
    const log = memLog([...(await contentOps('W', N, 1000)), keyRow(OTHER, 5000), keyRow(DEVICE, 5001)]);
    const j = joiner({ maxPending: 10, seek: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mergeAdmittedLogsIncremental([log], createMergeCursor(), { applyImpl: j.applyImpl });
      expect(j.contentApplied()).toBe(0);
      expect(j.pending.consumeEvictionSignal()).toBe(true);
      // The key arrives at the tail, but only what the buffer kept can drain.
      await j.drain();
      expect(j.contentApplied()).toBe(10);
    } finally {
      warn.mockRestore();
    }
  });

  it('finds the key row inside a snapshot set chunk above the fold position', async () => {
    const N = 20;
    const content = await contentOps('W', N, 1000);
    const chunk: PeerLogOp = {
      type: 'put',
      table: SNAPSHOT_TABLE_TAG,
      hbKey: 'snap-0',
      value: {
        coversUpTo: N,
        chunkIdx: 0,
        chunkCount: 1,
        rows: [
          { table: 'hive-epoch-keys', hbKey: `${EPOCH}:${DEVICE}`, value: keyRow(DEVICE, 900).value, ts: 900, schema_version: 1 },
          { table: 'notes', hbKey: 'N-0', value: { n: 0 }, ts: 901, schema_version: 1 },
        ],
      } satisfies SnapshotPayload,
      ts: 2000,
      schema_version: 1,
      author_pubkey: '',
    };
    const log = memLog([...content, chunk]);
    const j = joiner({ maxPending: 5, seek: true });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await mergeAdmittedLogsIncremental([log], createMergeCursor(), { applyImpl: j.applyImpl, keySeek: j.keySeek });
      expect(j.contentApplied()).toBe(N - 1);
      expect(j.pending.consumeEvictionSignal()).toBe(false);
      await j.drain();
      expect(j.contentApplied()).toBe(N);
    } finally {
      info.mockRestore();
    }
  });

  it('a seek that finds no key leaves the cursor and the deferral exactly as without it, and never re-reads', async () => {
    const N = 12;
    const ops = [...(await contentOps('W', N, 1000)), keyRow(OTHER, 5000)];
    const withSeek = joiner({ maxPending: 100, seek: true });
    const without = joiner({ maxPending: 100, seek: false });
    const seekLog = memLog([...ops]);
    const plainLog = memLog([...ops]);
    const seekCursor = createMergeCursor();
    const plainCursor = createMergeCursor();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await mergeAdmittedLogsIncremental([seekLog], seekCursor, { applyImpl: withSeek.applyImpl, keySeek: withSeek.keySeek });
      await mergeAdmittedLogsIncremental([plainLog], plainCursor, { applyImpl: without.applyImpl });
      expect(seekCursor.positions.get(seekLog.keyHex)).toBe(plainCursor.positions.get(plainLog.keyHex));
      expect(withSeek.pending.size()).toBe(without.pending.size());
      expect(withSeek.pending.size()).toBe(N);
      expect(withSeek.applied).toEqual(without.applied);

      // More content arrives, still without this device's key. The next seek reads only the
      // new tail: each earlier position was read once by the seek and once by the fold.
      const more = await contentOps('X', 4, 3000);
      seekLog.ops.push(...more);
      await mergeAdmittedLogsIncremental([seekLog], seekCursor, { applyImpl: withSeek.applyImpl, keySeek: withSeek.keySeek });
      for (let i = 0; i < seekLog.length; i++) expect(seekLog.reads.get(i)).toBe(2);
      expect(withSeek.pending.size()).toBe(N + 4);
    } finally {
      info.mockRestore();
    }
  });

  it('gives up at its budget, logs it, and a later pass resumes below what it already read', async () => {
    // Content, then the key at #20, then 25 plaintext filler ops: five 5-read seeks cover
    // the filler and the sixth reaches the key.
    const log = memLog([...(await contentOps('W', 20, 1000)), keyRow(DEVICE, 5000), ...plainOps(25, 6000)]);
    const j = joiner({ maxPending: 100, seek: true });
    const keySeek: EpochKeySeek = { ...j.keySeek!, maxOps: 5 };
    const cursor = createMergeCursor();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // Three ops per pass: the fold reaches W-15 on pass 6, well before the key at #20.
      for (let pass = 1; pass <= 6; pass++) {
        await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: j.applyImpl, keySeek, maxOpsPerPass: 3 });
      }
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('P-524 key seek') && String(c[0]).includes('GAVE UP'))).toHaveLength(5);
      expect(cursor.keySeeks?.get(`${log.keyHex}|${HIVE}|${EPOCH}`)?.found).toBe(true);
      // Found on pass 6 while folding W-15: W-16 and W-17 decrypted on arrival.
      expect(cursor.positions.get(log.keyHex)).toBe(18);
      expect(j.applied).toContain('work-items::W-16');
      expect(j.applied).toContain('work-items::W-17');
      // The resumed seeks never re-read a position an earlier seek had read.
      for (let i = 21; i < log.length; i++) expect(log.reads.get(i)).toBe(1);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});

describe('P-524 buildEpochKeySeek + the gate signal', () => {
  it('matches only this device’s key row for the missed epoch', () => {
    const { keySeek } = buildEpochKeySeek(DEVICE);
    const env = (table: string, hbKey: string) => ({ type: 'put', table, hbKey, ts: 0, schema_version: 1 }) as OpEnvelope;
    const miss = { potId: HIVE, epoch: EPOCH };
    expect(keySeek.suppliesKey(env('hive-epoch-keys', `${EPOCH}:${DEVICE}`), miss)).toBe(true);
    expect(keySeek.suppliesKey(env('hive-epoch-keys', `${EPOCH}:${OTHER}`), miss)).toBe(false);
    expect(keySeek.suppliesKey(env('hive-epoch-keys', `${EPOCH + 1}:${DEVICE}`), miss)).toBe(false);
    expect(keySeek.suppliesKey(env('work-items', `${EPOCH}:${DEVICE}`), miss)).toBe(false);
  });

  it('records each (pot, epoch) once until taken, and a take consumes them', () => {
    const { onKeyMissing, keySeek } = buildEpochKeySeek(DEVICE);
    expect(keySeek.takeMisses()).toEqual([]);
    onKeyMissing(HIVE, 1);
    onKeyMissing(HIVE, 1);
    onKeyMissing(HIVE, 2);
    expect(keySeek.takeMisses()).toEqual([
      { potId: HIVE, epoch: 1 },
      { potId: HIVE, epoch: 2 },
    ]);
    expect(keySeek.takeMisses()).toEqual([]);
  });

  it('the gate reports a genuine key absence, and never a transient resolve failure', async () => {
    const [sealed] = await contentOps('W', 1, 1000);
    const env: OpEnvelope = { ...sealed, writerPubkey: '', epoch: sealed.epoch };
    const onKeyMissing = vi.fn();
    const absent = buildEpochDecryptGate({
      crypto: fakeCrypto(),
      resolveKey: async (p, e) => {
        throw new EpochKeyUnavailableError(p, e);
      },
      potId: HIVE,
      pending: new PendingEpochContent(),
      onKeyMissing,
    })(async () => true);
    expect(await absent(env)).toBe(false);
    expect(onKeyMissing).toHaveBeenCalledWith(HIVE, EPOCH);

    const transient = vi.fn();
    const blip = buildEpochDecryptGate({
      crypto: fakeCrypto(),
      resolveKey: async () => {
        throw new Error('connection terminated unexpectedly');
      },
      potId: HIVE,
      pending: new PendingEpochContent(),
      onKeyMissing: transient,
    })(async () => true);
    await expect(blip(env)).rejects.toThrow('connection terminated');
    expect(transient).not.toHaveBeenCalled();
  });
});
