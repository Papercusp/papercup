import { describe, expect, it, vi } from 'vitest';
import { refreshContextEstimateAtBoundary } from './context-estimate-verify';

describe('refreshContextEstimateAtBoundary (WI-4154 compaction fast path)', () => {
  it('re-derives + writes the fresh post-boundary value through to PG', async () => {
    const estimate = vi.fn(async () => 60_298);
    const writePgEstimate = vi.fn(async () => {});
    const out = await refreshContextEstimateAtBoundary('su-a', { estimate, writePgEstimate });
    expect(out).toBe(60_298);
    expect(estimate).toHaveBeenCalledWith('su-a');
    expect(writePgEstimate).toHaveBeenCalledWith('su-a', 60_298);
  });

  it('returns null (no write) when the estimator is blind', async () => {
    const writePgEstimate = vi.fn(async () => {});
    const out = await refreshContextEstimateAtBoundary('su-b', {
      estimate: async () => null,
      writePgEstimate,
    });
    expect(out).toBeNull();
    expect(writePgEstimate).not.toHaveBeenCalled();
  });

  it('never throws: estimator throw → null; PG-write throw → still returns fresh', async () => {
    expect(
      await refreshContextEstimateAtBoundary('su-c', {
        estimate: async () => {
          throw new Error('boom');
        },
      }),
    ).toBeNull();
    expect(
      await refreshContextEstimateAtBoundary('su-d', {
        estimate: async () => 42_000,
        writePgEstimate: async () => {
          throw new Error('pg down');
        },
      }),
    ).toBe(42_000);
  });
});
