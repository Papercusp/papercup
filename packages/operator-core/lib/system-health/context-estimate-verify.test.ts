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

  it('writes only after the owner mapping reaches the exact successor native session', async () => {
    const estimate = vi.fn(async () => 12_000);
    const writePgEstimate = vi.fn(async () => {});
    const resolveSessionId = vi.fn(async () => 'new-native-id');

    await expect(
      refreshContextEstimateAtBoundary('su-new', {
        expectedSessionId: 'new-native-id',
        resolveSessionId,
        estimate,
        writePgEstimate,
      }),
    ).resolves.toBe(12_000);
    expect(resolveSessionId).toHaveBeenCalledWith('su-new');
    expect(writePgEstimate).toHaveBeenCalledWith('su-new', 12_000);
  });

  it('leaves PG unknown when the detached bridge still resolves the predecessor session', async () => {
    const estimate = vi.fn(async () => 190_000);
    const writePgEstimate = vi.fn(async () => {});

    await expect(
      refreshContextEstimateAtBoundary('su-race', {
        expectedSessionId: 'successor-id',
        resolveSessionId: async () => 'predecessor-id',
        estimate,
        writePgEstimate,
      }),
    ).resolves.toBeNull();
    expect(estimate).not.toHaveBeenCalled();
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
