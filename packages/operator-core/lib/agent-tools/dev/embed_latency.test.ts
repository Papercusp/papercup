/**
 * dev:embed_latency — delivery tests for the process-local search sampler.
 *
 * The generic search package tests the ring arithmetic and writer wiring. This
 * suite proves the operator tool reads that same source and preserves the
 * process/cluster scope needed to keep a worker-local sample from being read
 * as a fleet-wide health claim.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observeEmbedLatency, resetEmbedLatency } from '@papercusp/search';
import tool from './embed_latency';

function sample(over: Partial<Parameters<typeof observeEmbedLatency>[0]> = {}) {
  return {
    atMs: Date.now(),
    caller: 'midturn:related-context',
    budgetMs: 1200,
    durationMs: 1900,
    outcome: 'timeout' as const,
    ...over,
  };
}

async function read(args: { windowMs?: number } = {}) {
  const result = (await tool.handler(args as never, {} as never)) as {
    data: Record<string, unknown>;
  };
  return result.data;
}

describe('dev:embed_latency', () => {
  const previousCluster = process.env.PAPERCUSP_CLUSTER;

  beforeEach(() => {
    resetEmbedLatency();
    delete process.env.PAPERCUSP_CLUSTER;
  });

  afterEach(() => {
    resetEmbedLatency();
    if (previousCluster === undefined) delete process.env.PAPERCUSP_CLUSTER;
    else process.env.PAPERCUSP_CLUSTER = previousCluster;
  });

  it('reads the actual @papercusp/search ring with caller budget and outcome', async () => {
    observeEmbedLatency(sample());
    const data = await read({ windowMs: 60_000 });

    expect(data).toMatchObject({
      ok: true,
      embeds: 1,
      observedCount: 1,
      capacity: expect.any(Number),
      callers: [
        expect.objectContaining({
          caller: 'midturn:related-context',
          n: 1,
          timeout: 1,
          budgetMs: 1200,
          p99Ms: 1900,
        }),
      ],
    });
  });

  it('survives an undefined args object from an empty optional-body call', async () => {
    observeEmbedLatency(sample());
    const result = (await tool.handler(undefined as never, {} as never)) as {
      data: Record<string, unknown>;
    };

    expect(result.data.ok).toBe(true);
    expect(result.data.embeds).toBe(1);
  });

  it('states the worker-local scope when the operator is clustered', async () => {
    process.env.PAPERCUSP_CLUSTER = '16';
    const data = await read();

    expect(data.clusterSize).toBe(16);
    expect(String(data.perWorkerCaveat)).toContain('16 workers');
    expect(data.pid).toBe(process.pid);
    expect(data.sampledWorkers).toBeGreaterThanOrEqual(1);
    expect(typeof data.uptimeSec).toBe('number');
  });

  it('reports an empty ring as measured zero samples, not a healthy verdict', async () => {
    const data = await read();

    expect(data.embeds).toBe(0);
    expect(data.callers).toEqual([]);
    expect(data.oldestSampleMs).toBeNull();
    expect(data.newestSampleMs).toBeNull();
  });
});
