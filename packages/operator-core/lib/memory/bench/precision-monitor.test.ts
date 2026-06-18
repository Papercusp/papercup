/**
 * precision-monitor — the memory-precision bench orchestration (relight P-033).
 * Dep-injected so no embedder/PG is needed: flag gate, the happy path
 * (bench → record → invalidate), and the non-fatal failure paths.
 */
import { describe, it, expect } from 'vitest';
import { runMemoryPrecisionMonitor } from './precision-monitor';
import type { MemoryPrecisionMetrics } from './precision-read';

const METRICS: MemoryPrecisionMetrics = {
  backend: 'hybrid',
  corpusVersion: 'v1',
  goldVersion: 'v1',
  corpusN: 114,
  goldN: 150,
  floorCosine: 0.45,
  floorLex: 0.4,
  fpAt5: 0.17,
  rAt10: 0.82,
  pAt5: 0.9,
  mrr: 0.7,
  medianTopScore: 0.6,
  latencyP50Ms: 12,
  byClass: {},
  costUsd: null,
  notes: null,
};

const silent = () => {};

describe('runMemoryPrecisionMonitor', () => {
  it('skips with flag-off and never benches when the flag is OFF', async () => {
    let benched = 0;
    const out = await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-1', installSlug: 'op' },
      {
        flag: async () => false,
        runBench: async () => {
          benched += 1;
          return METRICS;
        },
        record: async () => 1,
        log: silent,
      },
    );
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(benched).toBe(0);
  });

  it('runs the bench, records the row, fires invalidation', async () => {
    let recordedWs = '';
    let invalidated = 0;
    const out = await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-9', installSlug: 'op' },
      {
        flag: async () => true,
        runBench: async () => METRICS,
        record: async (ws) => {
          recordedWs = ws;
          return 7;
        },
        invalidate: () => {
          invalidated += 1;
        },
        log: silent,
      },
    );
    expect(out.ran).toBe(true);
    if (out.ran) {
      expect(out.rowId).toBe(7);
      expect(out.metrics.fpAt5).toBe(0.17);
    }
    expect(recordedWs).toBe('ws-9');
    expect(invalidated).toBe(1);
  });

  it('returns a non-fatal failed outcome when the bench throws (never wedges the tick)', async () => {
    const out = await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-1', installSlug: 'op' },
      {
        flag: async () => true,
        runBench: async () => {
          throw new Error('no embedder');
        },
        record: async () => 1,
        log: silent,
      },
    );
    expect(out.ran).toBe(false);
    if (!out.ran) {
      expect(out.skipReason).toBe('failed');
      expect('error' in out && out.error).toContain('no embedder');
    }
  });

  it('returns a non-fatal failed outcome when the record write throws', async () => {
    const out = await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-1', installSlug: 'op' },
      {
        flag: async () => true,
        runBench: async () => METRICS,
        record: async () => {
          throw new Error('pg down');
        },
        log: silent,
      },
    );
    expect(out.ran).toBe(false);
    if (!out.ran) expect(out.skipReason).toBe('failed');
  });
});
