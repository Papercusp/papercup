import { describe, expect, it } from 'vitest';
import { checkpointProof, judgeContinuation, verifyCheckpoint } from './bench-work-item-continuations';

describe('controlled live continuation evidence oracle', () => {
  const good = { wallMs: 10, successfulReadback: true, heldAtReadback: true, ordered: true,
    cancelledAbsent: true, rejectedNotForwarded: true, unknownReceipt: true,
    unknownPersisted: true, sourceStable: true };
  it('requires matching authoritative hash, verified receipt, and exact identity', () => {
    const receipt = { ok: true, results: [{ id: 'EI-1', ok: true, verified: true, contentHash: 'abc' }] };
    const read = { results: [{ id: 'EI-1', ok: true, checkpointContentHash: 'abc', checkpoint: 'marker' }] };
    expect(verifyCheckpoint(receipt, read, 'EI-1')).toBe(true);
    expect(verifyCheckpoint(receipt, read, 'EI-2')).toBe(false);
    expect(verifyCheckpoint(receipt, {}, 'EI-1')).toBe(false);
    expect(verifyCheckpoint(receipt, { results: [{ ...read.results[0], checkpointContentHash: 'def' }] }, 'EI-1')).toBe(false);
    expect(verifyCheckpoint({ ...receipt, ok: false }, read, 'EI-1')).toBe(false);
    expect(verifyCheckpoint({ results: [{ id: 'EI-1', ok: true, contentHash: 'abc' }] }, read, 'EI-1')).toBe(false);
  });
  it('fails slow, non-finite, unverified, or post-stall writes', () => {
    expect(judgeContinuation(good).every(row => row.passed)).toBe(true);
    for (const bad of [{ wallMs: 20_001 }, { wallMs: NaN }, { wallMs: -1 },
      { successfulReadback: false }, { heldAtReadback: false }]) {
      expect(judgeContinuation({ ...good, ...bad })[0]!.passed).toBe(false);
    }
  });
  it('preserves a committed verifier failure without copying checkpoint content', () => {
    const receipt = { ok: false, results: [{ id: 'WI-1', ok: false,
      errorCode: 'checkpoint_verify_failed', writeCommitted: true,
      storedContentHash: 'old-hash', error: 'private checkpoint narrative' }] };
    const readback = { results: [{ id: 'WI-1', checkpointContentHash: 'new-hash',
      checkpoint: 'private checkpoint narrative' }] };
    const proof = checkpointProof(receipt, readback, 'WI-1');
    expect(proof).toEqual({ id: 'WI-1', responseOk: false, itemOk: false,
      verified: false, errorCode: 'checkpoint_verify_failed', writeCommitted: true,
      contentHash: 'old-hash', readBackContentHash: 'new-hash' });
    expect(JSON.stringify(proof)).not.toContain('private checkpoint narrative');
  });
  it('cannot treat cancellation, missing ordering or lost acknowledgement as successful forwarding', () => {
    for (const key of ['ordered', 'cancelledAbsent', 'rejectedNotForwarded', 'unknownReceipt', 'unknownPersisted', 'sourceStable'] as const) {
      expect(judgeContinuation({ ...good, [key]: false }).every(row => row.passed)).toBe(false);
    }
  });
});
