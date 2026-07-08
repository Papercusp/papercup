/**
 * read-merge.test.ts — unit tests for the LWW read-merge over admitted
 * per-peer logs (Model B substrate, Stage 2).
 *
 * The read-merge reads every op of every admitted log, maps each `PeerLogOp`
 * to a projection-layer `OpEnvelope` (carrying `writerPubkey = author_pubkey`
 * so the clobber-event hook attributes correctly), groups by `(table, hbKey)`,
 * resolves same-key conflicts last-writer-wins across authors via `lwwPick`,
 * and applies the winners through the existing projection layer.
 *
 * Pure over an injected `applyImpl` so it runs without PG or the network —
 * the `fakeLog` helper structurally satisfies `AdmittedLog`.
 */

import { describe, it, expect, vi } from 'vitest';
import type { OpEnvelope } from './op-envelope-types';
import { mergeAdmittedLogs, type AdmittedLog } from './read-merge';
import { buildSnapshotRows, SNAPSHOT_TABLE_TAG } from './log-snapshot';
import type { PeerLogOp } from './peer-log';

// Typed apply sink so `mock.calls[0][0]` resolves to the OpEnvelope argument
// (a bare `vi.fn(async () => true)` infers a zero-arg tuple → TS2493 on indexing).
const applyMock = () => vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);

function fakeLog(keyHex: string, ops: unknown[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i: number) => ops[i] as never };
}

describe('mergeAdmittedLogs', () => {
  it('resolves same-key conflicts last-writer-wins across authors, then applies', async () => {
    const apply = applyMock();
    const logs = [
      fakeLog('a'.repeat(64), [{ type:'put', table:'features_consolidated', hbKey:'F-1', value:{status:'todo'}, ts:100, schema_version:1, author_pubkey:'A' }]),
      fakeLog('b'.repeat(64), [{ type:'put', table:'features_consolidated', hbKey:'F-1', value:{status:'done'}, ts:200, schema_version:1, author_pubkey:'B' }]),
    ];
    const applied = await mergeAdmittedLogs(logs, { applyImpl: apply });
    expect(applied).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ value:{status:'done'}, ts:200, writerPubkey:'B' });
  });

  // WI-808 (REGRESSION GUARD): the hive-rekey `epoch` stamp MUST survive the
  // PeerLogOp→OpEnvelope merge so the apply-side decrypt-gate can resolve the key.
  // Before the fix `toEnvelope` dropped `epoch` (like `hlc` pre-P-010), so an
  // encrypted content op reached the gate with `epoch == null` → it was treated as
  // plaintext → the `{__rekey}` ciphertext hit scopedApply → SILENT DROP on every
  // joiner (zero decrypt-gate trace). This is the federation-blocking content bug.
  it('WI-808: carries `epoch` through the merge to applyImpl (encrypted content op)', async () => {
    const apply = applyMock();
    const logs = [ fakeLog('a'.repeat(64), [
      { type:'put', table:'harness_features_consolidated', hbKey:'F-1', value:{ __rekey:'YWJj' }, ts:100, schema_version:1, author_pubkey:'A', epoch:7 },
    ])];
    await mergeAdmittedLogs(logs, { applyImpl: apply });
    expect(apply.mock.calls[0][0].epoch).toBe(7); // was undefined before the fix
  });

  it('WI-808: a plaintext op (no epoch) still carries no `epoch` (byte-identical path)', async () => {
    const apply = applyMock();
    const logs = [ fakeLog('a'.repeat(64), [
      { type:'put', table:'contributors', hbKey:'C-1', value:{}, ts:1, schema_version:1, author_pubkey:'A' },
    ])];
    await mergeAdmittedLogs(logs, { applyImpl: apply });
    expect(apply.mock.calls[0][0].epoch).toBeUndefined();
  });

  it('WI-808: `epoch` survives compaction — buildSnapshotRows → snapshot merge carries it', async () => {
    const apply = applyMock();
    const ops: PeerLogOp[] = [
      { type:'put', table:'harness_features_consolidated', hbKey:'F-9', value:{ __rekey:'eHl6' }, ts:5, schema_version:1, author_pubkey:'A', epoch:3 },
    ];
    const rows = buildSnapshotRows(ops);
    expect(rows[0].epoch).toBe(3); // build seam preserves it
    const snapshotOp = {
      type:'put', table:SNAPSHOT_TABLE_TAG, hbKey:'__snap__',
      value:{ coversUpTo: 1, rows }, ts:5, schema_version:1, author_pubkey:'A',
    };
    await mergeAdmittedLogs([ fakeLog('a'.repeat(64), [snapshotOp]) ], { applyImpl: apply });
    expect(apply.mock.calls[0][0].epoch).toBe(3); // snapshotRowToEnvelope preserves it
  });

  // β (REGRESSION GUARD, seed 57-drop sibling): the ORIGINAL author_pubkey is bound into
  // the epoch-decrypt AAD (opId = sha256([table, hbKey, author_pubkey])). A snapshot-seeded
  // reader must reconstruct THAT author, not the snapshot op's author (its source-log key).
  // On the owner's single-writer log content ops carry author='' while the snapshot op
  // carries the core-log key — so substituting the snapshot author makes every encrypted
  // row's AAD diverge → silent decrypt-drop. (The old WI-808 test masked this by using the
  // SAME author 'A' for both the content op and the snapshot op.)
  it('β: a snapshot row reconstructs the ORIGINAL author (AAD opId), not the snapshot op author', async () => {
    const apply = applyMock();
    const ops: PeerLogOp[] = [
      { type:'put', table:'harness_features_consolidated', hbKey:'F-b', value:{ __rekey:'eHl6' }, ts:5, schema_version:1, author_pubkey:'', epoch:1 },
    ];
    const rows = buildSnapshotRows(ops);
    expect(rows[0].author_pubkey).toBe(''); // build seam preserves the original author (even '')
    const snapshotOp = {
      type:'put', table:SNAPSHOT_TABLE_TAG, hbKey:'__snap__',
      value:{ coversUpTo: 1, rows }, ts:5, schema_version:1, author_pubkey:'CORE-LOG-KEY',
    };
    await mergeAdmittedLogs([ fakeLog('a'.repeat(64), [snapshotOp]) ], { applyImpl: apply });
    // The ORIGINAL author '' — NOT the snapshot op's 'CORE-LOG-KEY'.
    expect(apply.mock.calls[0][0].writerPubkey).toBe('');
    expect(apply.mock.calls[0][0].epoch).toBe(1);
  });

  it("β / 57-drop: a LEGACY author-less snapshot row falls back to '' (owner single-writer convention), NOT the snapshot op's log key", async () => {
    const apply = applyMock();
    // A pre-β snapshot: rows carry NO author_pubkey. The shipped seed's 11308 encrypted
    // snapshot rows are ALL this shape; the ciphertext was sealed under the owner
    // single-writer author '' → the reader must feed '' (not the snapshot op's core-log
    // KEY, which decrypts 0 of them → the 57-drop). buildSnapshotRows now embeds the
    // author, so this legacy branch only fires for pre-β corestore snapshots.
    const legacyRows = [{ table:'harness_features_consolidated', hbKey:'F-legacy', value:{}, ts:5, schema_version:1 }];
    const snapshotOp = {
      type:'put', table:SNAPSHOT_TABLE_TAG, hbKey:'__snap__',
      value:{ coversUpTo: 1, rows: legacyRows }, ts:5, schema_version:1, author_pubkey:'CORE-LOG-KEY',
    };
    await mergeAdmittedLogs([ fakeLog('a'.repeat(64), [snapshotOp]) ], { applyImpl: apply });
    expect(apply.mock.calls[0][0].writerPubkey).toBe(''); // legacy fallback = owner-log author, not the log key
  });

  it('del beats put on a ts tie', async () => {
    const apply = applyMock();
    const logs = [
      fakeLog('a'.repeat(64), [{ type:'put', table:'features_consolidated', hbKey:'F-2', value:{}, ts:50, schema_version:1, author_pubkey:'A' }]),
      fakeLog('b'.repeat(64), [{ type:'del', table:'features_consolidated', hbKey:'F-2', ts:50, schema_version:1, author_pubkey:'B' }]),
    ];
    await mergeAdmittedLogs(logs, { applyImpl: apply });
    expect(apply.mock.calls[0][0]).toMatchObject({ type:'del', hbKey:'F-2' });
  });

  it('applies distinct keys/tables independently', async () => {
    const apply = applyMock();
    const logs = [ fakeLog('a'.repeat(64), [
      { type:'put', table:'features_consolidated', hbKey:'F-1', value:{}, ts:1, schema_version:1, author_pubkey:'A' },
      { type:'put', table:'contributors', hbKey:'C-1', value:{}, ts:1, schema_version:1, author_pubkey:'A' },
    ])];
    const applied = await mergeAdmittedLogs(logs, { applyImpl: apply });
    expect(applied).toBe(2);
  });

  it('returns 0 for empty logs (never calls apply)', async () => {
    const apply = applyMock();
    expect(await mergeAdmittedLogs([], { applyImpl: apply })).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('skips a null op (get returns null) and applies the real one', async () => {
    const apply = applyMock();
    // get() returns null for index 0, a real op for index 1.
    const logs = [ fakeLog('a'.repeat(64), [
      null,
      { type:'put', table:'features_consolidated', hbKey:'F-1', value:{status:'done'}, ts:100, schema_version:1, author_pubkey:'A' },
    ])];
    const applied = await mergeAdmittedLogs(logs, { applyImpl: apply });
    expect(applied).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ hbKey:'F-1', ts:100 });
  });

  it('LWW-folds multiple ops on one key WITHIN a single author log (ts:2 wins)', async () => {
    const apply = applyMock();
    const logs = [ fakeLog('a'.repeat(64), [
      { type:'put', table:'features_consolidated', hbKey:'F-1', value:{status:'todo'}, ts:1, schema_version:1, author_pubkey:'A' },
      { type:'put', table:'features_consolidated', hbKey:'F-1', value:{status:'done'}, ts:2, schema_version:1, author_pubkey:'A' },
    ])];
    const applied = await mergeAdmittedLogs(logs, { applyImpl: apply });
    expect(applied).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ value:{status:'done'}, ts:2 });
  });

  it('skips an op whose get() REJECTS (one bad read does not abort the pass)', async () => {
    const apply = applyMock();
    // index 0 rejects (e.g. peer stream closed / decode error); index 1 is fine.
    const rejectingLog: AdmittedLog = {
      keyHex: 'a'.repeat(64),
      length: 2,
      get: async (i: number) => {
        if (i === 0) throw new Error('peer stream closed');
        return {
          type: 'put', table: 'features_consolidated', hbKey: 'F-1',
          value: { status: 'done' }, ts: 100, schema_version: 1, author_pubkey: 'A',
        } as never;
      },
    };
    const applied = await mergeAdmittedLogs([rejectingLog], { applyImpl: apply });
    // The rejecting op is skipped; the good op still applies; the pass completes.
    expect(applied).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ hbKey: 'F-1', ts: 100 });
  });

  it('skips an op whose get() never resolves within getTimeoutMs (withholding peer)', async () => {
    const apply = applyMock();
    // index 0 hangs forever (a connected-but-withholding peer); index 1 resolves.
    const withholdingLog: AdmittedLog = {
      keyHex: 'b'.repeat(64),
      length: 2,
      get: (i: number) => {
        if (i === 0) return new Promise<never>(() => {}); // never resolves
        return Promise.resolve({
          type: 'put', table: 'features_consolidated', hbKey: 'F-2',
          value: { status: 'done' }, ts: 200, schema_version: 1, author_pubkey: 'B',
        } as never);
      },
    };
    // Tiny timeout so the test is fast; the hung op is skipped, the pass completes.
    const applied = await mergeAdmittedLogs([withholdingLog], {
      applyImpl: apply,
      getTimeoutMs: 10,
    });
    expect(applied).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ hbKey: 'F-2', ts: 200 });
  });

  it('a withholding peer does not starve a healthy peer in the same pass', async () => {
    const apply = applyMock();
    const withholdingPeer: AdmittedLog = {
      keyHex: 'c'.repeat(64),
      length: 1,
      get: () => new Promise<never>(() => {}), // never resolves
    };
    const healthyPeer = fakeLog('d'.repeat(64), [
      { type: 'put', table: 'contributors', hbKey: 'C-1', value: {}, ts: 5, schema_version: 1, author_pubkey: 'D' },
    ]);
    const applied = await mergeAdmittedLogs([withholdingPeer, healthyPeer], {
      applyImpl: apply,
      getTimeoutMs: 10,
    });
    // The healthy peer's op still applies despite the withholding peer.
    expect(applied).toBe(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ hbKey: 'C-1' });
  });

  // ── Stage 6: per-author ingest cap (DoS Phase-4 reshape) ──

  // A log whose declared length exceeds the cap: only the first `cap` ops are
  // read (we count get() calls), so a noisy author can't make the merge ingest
  // unbounded ops; `onCapped` fires once with (keyHex, length, cap).
  it('caps a too-long log to maxOpsPerAuthor ops and fires onCapped once', async () => {
    const apply = applyMock();
    const cap = 3;
    const keyHex = 'a'.repeat(64);
    let gets = 0;
    // 10 ops on distinct keys; reading all would apply 10. With cap=3 only the
    // first 3 keys are read/applied.
    const overLog: AdmittedLog = {
      keyHex,
      length: 10,
      get: async (i: number) => {
        gets++;
        return {
          type: 'put', table: 'features_consolidated', hbKey: `F-${i}`,
          value: {}, ts: 1, schema_version: 1, author_pubkey: 'A',
        } as never;
      },
    };
    const onCapped = vi.fn<(keyHex: string, totalLength: number, cap: number) => void>();
    const applied = await mergeAdmittedLogs([overLog], {
      applyImpl: apply,
      maxOpsPerAuthor: cap,
      onCapped,
    });
    // Only the first `cap` ops were read + applied.
    expect(gets).toBe(cap);
    expect(applied).toBe(cap);
    // onCapped fired exactly once with (keyHex, totalLength, cap).
    expect(onCapped).toHaveBeenCalledTimes(1);
    expect(onCapped).toHaveBeenCalledWith(keyHex, 10, cap);
  });

  it('does NOT fire onCapped for a log at/under the cap (reads all ops)', async () => {
    const apply = applyMock();
    const onCapped = vi.fn<(keyHex: string, totalLength: number, cap: number) => void>();
    // length 3 == cap → not over → no cap, all 3 read.
    const logs = [ fakeLog('b'.repeat(64), [
      { type:'put', table:'features_consolidated', hbKey:'F-1', value:{}, ts:1, schema_version:1, author_pubkey:'B' },
      { type:'put', table:'features_consolidated', hbKey:'F-2', value:{}, ts:1, schema_version:1, author_pubkey:'B' },
      { type:'put', table:'features_consolidated', hbKey:'F-3', value:{}, ts:1, schema_version:1, author_pubkey:'B' },
    ])];
    const applied = await mergeAdmittedLogs(logs, {
      applyImpl: apply,
      maxOpsPerAuthor: 3,
      onCapped,
    });
    expect(applied).toBe(3);
    expect(onCapped).not.toHaveBeenCalled();
  });

  it('maxOpsPerAuthor: 0 disables the cap (all ops read, onCapped never fires)', async () => {
    const apply = applyMock();
    const onCapped = vi.fn<(keyHex: string, totalLength: number, cap: number) => void>();
    const ops = Array.from({ length: 8 }, (_, i) => ({
      type: 'put', table: 'features_consolidated', hbKey: `F-${i}`,
      value: {}, ts: 1, schema_version: 1, author_pubkey: 'A',
    }));
    const applied = await mergeAdmittedLogs([fakeLog('c'.repeat(64), ops)], {
      applyImpl: apply,
      maxOpsPerAuthor: 0,
      onCapped,
    });
    // Cap disabled → all 8 distinct keys applied.
    expect(applied).toBe(8);
    expect(onCapped).not.toHaveBeenCalled();
  });
});
