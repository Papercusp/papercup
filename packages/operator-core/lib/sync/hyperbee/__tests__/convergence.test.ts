/**
 * Model B read-merge convergence — projection-layer primitives.
 *
 * Stage 5 retired the two-writer Autobase merge-order model (the `autobase`
 * package dependency + the skipped two-writer convergence case are gone).
 * What survives is the Model B substrate: per-peer single-writer logs read
 * + LWW-folded by the read-merge into the projection layer. These cases
 * exercise that surface directly:
 *
 *   - the substrate modules import without throwing;
 *   - `lwwPick` resolves same-key conflicts (later `ts` wins; `del` beats
 *     `put` on a tie);
 *   - `applyHyperbeeOpToPg` dispatches put/del ops to the registered
 *     per-table projection (and drops unknown tables).
 */

import { describe, expect, it } from 'vitest';

describe('Hyperbee substrate — convergence', () => {
  it('placeholder: substrate modules import without throwing', async () => {
    const mod = await import('../index');
    expect(typeof mod.getHarnessStore).toBe('function');
    expect(typeof mod.registerProjection).toBe('function');
    expect(typeof mod.applyHyperbeeOpToPg).toBe('function');
    expect(typeof mod.lwwPick).toBe('function');
    expect(typeof mod.acceptOpVersion).toBe('function');
    expect(typeof mod.awaitEnsurePaths).toBe('function');
  });

  it('lwwPick: later ts wins', async () => {
    const { lwwPick } = await import('../projection');
    const a = { type: 'put' as const, ts: 100 };
    const b = { type: 'put' as const, ts: 200 };
    expect(lwwPick(a, b)).toBe(b);
    expect(lwwPick(b, a)).toBe(b);
  });

  it('lwwPick: tie → del beats put', async () => {
    const { lwwPick } = await import('../projection');
    const a = { type: 'put' as const, ts: 100 };
    const b = { type: 'del' as const, ts: 100 };
    expect(lwwPick(a, b)).toBe(b);
    expect(lwwPick(b, a)).toBe(b);
  });

  it('applyHyperbeeOpToPg: drops unknown table', async () => {
    const { applyHyperbeeOpToPg, _clearRegistryForTests } = await import('../projection');
    _clearRegistryForTests();
    const result = await applyHyperbeeOpToPg({ type: 'put', table: 'unknown-table', hbKey: 'k', value: {} });
    expect(result).toBe(false);
  });

  it('applyHyperbeeOpToPg: invokes the registered projection writer', async () => {
    const { applyHyperbeeOpToPg, registerProjection, _clearRegistryForTests } = await import('../projection');
    _clearRegistryForTests();
    interface FakeRow { id: string; n: number }
    let wrote: FakeRow | null = null;
    registerProjection<FakeRow>({
      tableTag: 'features-by-id',
      composeKey: (r) => r.id,
      decodeValue: (v) => v as FakeRow,
      writeToPg: async (r) => { wrote = r; },
      deleteFromPg: async () => {},
    });
    const r = await applyHyperbeeOpToPg({
      type: 'put',
      table: 'features-by-id',
      hbKey: 'F-001',
      value: { id: 'F-001', n: 42 },
    });
    expect(r).toBe(true);
    expect(wrote).toEqual({ id: 'F-001', n: 42 });
  });

  it('applyHyperbeeOpToPg: invokes the registered projection deleter', async () => {
    const { applyHyperbeeOpToPg, registerProjection, _clearRegistryForTests } = await import('../projection');
    _clearRegistryForTests();
    let deleted: string | null = null;
    registerProjection({
      tableTag: 'features-by-id',
      composeKey: (r: { id: string }) => r.id,
      decodeValue: (v) => v as { id: string },
      writeToPg: async () => {},
      deleteFromPg: async (k) => { deleted = k; },
    });
    const r = await applyHyperbeeOpToPg({
      type: 'del',
      table: 'features-by-id',
      hbKey: 'F-001',
    });
    expect(r).toBe(true);
    expect(deleted).toBe('F-001');
  });
});
