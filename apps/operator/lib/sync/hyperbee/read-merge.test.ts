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
import type { OpEnvelope } from './autobase-setup';
import { mergeAdmittedLogs, type AdmittedLog } from './read-merge';

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
});
