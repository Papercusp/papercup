/**
 * Flag-gate unit tests — injected flag reader, no PostHog / PG.
 */
import { describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import { assertExternalBenchEnabled, isExternalBenchEnabled } from './gate';

describe('external-bench gate', () => {
  it('reads the papercusp-external-bench flag for the given scope', async () => {
    const read = vi.fn(async () => true);
    expect(await isExternalBenchEnabled('system', read)).toBe(true);
    expect(read).toHaveBeenCalledWith(FLAGS.EXTERNAL_BENCH, 'system');
  });

  it('assert passes when enabled', async () => {
    await expect(assertExternalBenchEnabled('system', async () => true)).resolves.toBeUndefined();
  });

  it('assert throws a clear error when gated off', async () => {
    await expect(assertExternalBenchEnabled('system', async () => false)).rejects.toThrow(/papercusp-external-bench/);
  });
});
