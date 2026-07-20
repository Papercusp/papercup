// P-005 resolver GATES (whole-app-sync-payload-audit phase2): learning.observations
// (default view → precomputed snapshot; state/limit filter → live inline compute)
// and learning.releaseReadiness (no args → unconditional snapshot SELECT). Both
// are filled by the `system:precompute-derived-reads` routine (see
// derived-reads/producers.ts). Mirrors the dev.* / coord-history gate tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';

const { readDerivedSnapshotRowsMock, registerDerivedReadMock, computeObservationsMock } = vi.hoisted(() => ({
  readDerivedSnapshotRowsMock: vi.fn(async (_key: string) => [] as unknown[]),
  registerDerivedReadMock: vi.fn(),
  computeObservationsMock: vi.fn(async (_a: unknown) => [] as unknown[]),
}));

vi.mock('../derived-reads/registry', () => ({
  readDerivedSnapshotRows: readDerivedSnapshotRowsMock,
  registerDerivedRead: registerDerivedReadMock,
}));
vi.mock('./learning-observations-read', () => ({ computeLearningObservations: computeObservationsMock }));

describe('P-005 resolver gates', () => {
  it('registers both query names', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('learning.observations');
    expect(names).toContain('learning.releaseReadiness');
  });

  describe('routing', () => {
    beforeEach(() => {
      vi.resetModules();
      readDerivedSnapshotRowsMock.mockClear();
      computeObservationsMock.mockClear();
    });
    afterEach(() => vi.resetModules());

    it('learning.observations DEFAULT view (limit 200) reads the snapshot — never the inline compute', async () => {
      const snap = [{ id: 'EI-1', body: 'x' }];
      readDerivedSnapshotRowsMock.mockImplementation(async () => snap);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.observations', { limit: 200 })) as unknown[];
      expect(rows).toBe(snap);
      expect(readDerivedSnapshotRowsMock).toHaveBeenCalledWith('learning.observations');
      expect(computeObservationsMock).not.toHaveBeenCalled();
    });

    it('learning.observations with a state filter falls through to the inline compute', async () => {
      computeObservationsMock.mockImplementation(async () => [{ id: 'EI-9' }]);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.observations', { state: 'resolved', limit: 200 })) as unknown[];
      expect(rows).toHaveLength(1);
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(computeObservationsMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'resolved' }));
    });

    it('learning.releaseReadiness (no args) reads the snapshot', async () => {
      const snap = [{ ready: true }];
      readDerivedSnapshotRowsMock.mockImplementation(async () => snap);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.releaseReadiness', {})) as unknown[];
      expect(rows).toBe(snap);
      expect(readDerivedSnapshotRowsMock).toHaveBeenCalledWith('learning.releaseReadiness');
    });
  });
});
