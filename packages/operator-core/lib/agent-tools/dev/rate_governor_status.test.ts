/**
 * Gap 15 — dev:rate_governor_status wrapper (agent-tools/dev/rate_governor_status.ts).
 *
 * The tool is a thin wrapper over the shared `buildFleetRateStatus` read-model. It must:
 *   - convert `usageWindowMinutes` (?? 60) → ms (× 60_000) and pass that as the lookback;
 *   - default to 60 minutes when the arg is absent;
 *   - carry `bucketCount` (= buckets.length) on the JSON response.
 * `buildFleetRateStatus` is mocked so this is the wrapper's own arithmetic + shaping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  buildFleetRateStatus: vi.fn(),
}));

vi.mock('../../fleet-rate-status', () => ({ buildFleetRateStatus: h.buildFleetRateStatus }));

import tool from './rate_governor_status';

function fakeStatus(bucketCount: number) {
  return {
    ok: true as const,
    now: new Date().toISOString(),
    config: { maxSimultaneousAgents: 8, concurrencyFloor: 1 },
    fleet: { cap: 8, inFlight: 0, effective: 8, floor: 1 },
    buckets: Array.from({ length: bucketCount }, (_, i) => ({ key: `b${i}` })),
    usage: { windowMs: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, spendUsd: 0, buckets: [] },
  };
}

/** Run the tool handler and parse its JSON text payload. */
async function run(args: { usageWindowMinutes?: number }) {
  // The handler signature is (args, ctx) — ctx is unused here.
  const res = await (tool.handler as (a: unknown, c?: unknown) => Promise<{ content: { text: string }[] }>)(args, {});
  return JSON.parse(res.content[0].text) as { bucketCount: number; ok: boolean };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.buildFleetRateStatus.mockResolvedValue(fakeStatus(0));
});

describe('dev:rate_governor_status (Gap 15 — wrapper)', () => {
  it('passes 30 minutes through as 30 × 60_000 ms', async () => {
    await run({ usageWindowMinutes: 30 });
    expect(h.buildFleetRateStatus).toHaveBeenCalledWith(30 * 60_000);
  });

  it('defaults to 60 minutes (× 60_000) when usageWindowMinutes is absent', async () => {
    await run({});
    expect(h.buildFleetRateStatus).toHaveBeenCalledWith(60 * 60_000);
  });

  it('carries bucketCount (= buckets.length) on the response', async () => {
    h.buildFleetRateStatus.mockResolvedValue(fakeStatus(3));
    const out = await run({ usageWindowMinutes: 10 });
    expect(out.bucketCount).toBe(3);
    expect(out.ok).toBe(true);
  });
});
