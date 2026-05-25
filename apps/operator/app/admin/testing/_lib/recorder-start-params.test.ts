import { describe, expect, it } from 'vitest';
import { appendRecorderStartParams, readRecorderStartParams } from './recorder-start-params';

describe('recorder start params', () => {
  it('round-trips recorder startup data through URLSearchParams', () => {
    const url = new URL('http://localhost:3055/admin/testing?tab=test-runs&perf-block=stale');

    appendRecorderStartParams(url, {
      runId: 'run-123',
      durationMs: 10_000,
      dryRun: false,
      blocklist: ['delete', 'reset'],
    });

    expect(url.searchParams.get('perf-recorder')).toBe('1');
    expect(readRecorderStartParams(url.searchParams)).toEqual({
      type: 'start',
      runId: 'run-123',
      durationMs: 10_000,
      dryRun: false,
      blocklist: ['delete', 'reset'],
    });
  });

  it('preserves dry-run mode', () => {
    const url = new URL('http://localhost:3055/admin/testing');

    appendRecorderStartParams(url, {
      runId: 'run-dry',
      durationMs: 30_000,
      dryRun: true,
      blocklist: [],
    });

    expect(readRecorderStartParams(url.searchParams)).toMatchObject({
      runId: 'run-dry',
      durationMs: 30_000,
      dryRun: true,
      blocklist: [],
    });
  });

  it('rejects incomplete fallback data', () => {
    expect(readRecorderStartParams(new URLSearchParams('perf-duration-ms=10000'))).toBeNull();
    expect(readRecorderStartParams(new URLSearchParams('perf-run-id=run-1'))).toBeNull();
    expect(readRecorderStartParams(new URLSearchParams('perf-run-id=run-1&perf-duration-ms=not-a-number'))).toBeNull();
  });
});
