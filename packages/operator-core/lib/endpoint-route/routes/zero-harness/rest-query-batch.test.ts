/**
 * Per-slot timeout in the sync batch endpoint
 * (precompute-derived-sync-reads-2026-07-19 P-006, WI-5460).
 *
 * The batch resolves with `Promise.all`, so before this the response waited for
 * its SLOWEST member: a 27s `learning.soakReport` made every other panel in the
 * same batch feel like a 27s panel. Per-slot ERROR handling already existed —
 * what was missing was a bound on per-slot SLOWNESS.
 */
import { describe, expect, it, vi } from 'vitest';
import { withSlotTimeout, SLOT_TIMEOUT_MS } from './rest-query-batch';

describe('withSlotTimeout', () => {
  it('passes a fast result straight through', async () => {
    await expect(withSlotTimeout('fast.query', Promise.resolve(['row']), 50)).resolves.toEqual(['row']);
  });

  it('rejects a slow slot instead of letting it hold the batch', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('too late'), 5_000));
    await expect(withSlotTimeout('slow.query', slow, 20)).rejects.toThrow(/slow\.query.*exceeded 20ms/);
  });

  it('names the offending query in the error so the slow one is identifiable', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5_000));
    await expect(withSlotTimeout('learning.soakReport', slow, 10)).rejects.toThrow(/learning\.soakReport/);
  });

  it('propagates an underlying rejection unchanged (not masked as a timeout)', async () => {
    const boom = Promise.reject(new Error('resolver blew up'));
    await expect(withSlotTimeout('bad.query', boom, 1_000)).rejects.toThrow('resolver blew up');
  });

  it('clears its timer on the fast path — an uncleared timer leaks a handle per query per poll', async () => {
    // The batch is polled ~every 3s with many queries; a leaked timer per slot
    // would accumulate handles and keep the event loop alive.
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await withSlotTimeout('fast.query', Promise.resolve('ok'), 1_000);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('defaults to a budget above every healthy resolver but below user-perceived hang', () => {
    // The audit's slowest NON-offender was 1.87s; the offenders were 13.8-27.3s.
    expect(SLOT_TIMEOUT_MS).toBeGreaterThan(2_000);
    expect(SLOT_TIMEOUT_MS).toBeLessThan(13_000);
  });
});
