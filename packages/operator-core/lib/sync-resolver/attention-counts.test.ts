import { describe, expect, it, vi } from 'vitest';
import {
  ATTENTION_COUNTS_FALLBACK_MS,
  withDeadlineFallback,
} from './attention-counts';

describe('attention-counts sync deadline', () => {
  it('stays below the outer 10s sync resolver deadline', () => {
    expect(ATTENTION_COUNTS_FALLBACK_MS).toBeLessThan(10_000);
  });

  it('returns the operation result before the deadline', async () => {
    await expect(withDeadlineFallback(Promise.resolve('fresh'), 8_000, () => 'fallback')).resolves.toBe(
      'fresh',
    );
  });

  it('returns the graceful fallback when the operation is still pending', async () => {
    vi.useFakeTimers();
    try {
      let resolveOperation!: (value: string) => void;
      const operation = new Promise<string>((resolve) => {
        resolveOperation = resolve;
      });
      const result = withDeadlineFallback(operation, 8_000, () => 'fallback');

      await vi.advanceTimersByTimeAsync(7_999);
      await expect(Promise.race([result.then(() => 'settled'), Promise.resolve('pending')])).resolves.toBe(
        'pending',
      );

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe('fallback');
      resolveOperation('late');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not turn a real operation error into a fallback', async () => {
    await expect(
      withDeadlineFallback(Promise.reject(new Error('read failed')), 8_000, () => 'fallback'),
    ).rejects.toThrow('read failed');
  });
});
