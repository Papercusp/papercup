/**
 * precision-monitor — the memory-precision bench orchestration (relight P-033).
 * Dep-injected so no embedder/PG is needed: flag gate, the happy path
 * (bench → record → invalidate), the non-fatal failure paths, and (EI-10047)
 * the recall-drop baseline read + escalation wiring on top of it.
 */
import { describe, it, expect } from 'vitest';
import { runMemoryPrecisionMonitor } from './precision-monitor';
import type { MemoryPrecisionMetrics } from './precision-read';
import type { RecallDropEvaluation } from './precision-alert';

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
// EI-10047: `history`/`escalateRecall` default to hitting real PG via getOrgPg()
// when not overridden (mirrors `record`'s own default) — every test below that
// doesn't specifically exercise the recall-canary wiring stays fully dep-injected
// (no embedder/PG) by supplying no-op stand-ins.
const noHistory = async () => [];
const noEscalate = async () => {};

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
        history: noHistory,
        escalateRecall: noEscalate,
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
        history: noHistory,
        escalateRecall: noEscalate,
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
        history: noHistory,
        escalateRecall: noEscalate,
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
        history: noHistory,
        escalateRecall: noEscalate,
        log: silent,
      },
    );
    expect(out.ran).toBe(false);
    if (!out.ran) expect(out.skipReason).toBe('failed');
  });

  describe('EI-10047: recall-drop baseline + escalation', () => {
    it('a healthy baseline + a healthy run: evaluates ok, escalated as a non-alert (resolve path)', async () => {
      let seen: { workspaceId: string; backend: string; rowId: number; evaluation: RecallDropEvaluation } | null = null;
      const out = await runMemoryPrecisionMonitor(
        { workspaceId: 'ws-1', installSlug: 'op' },
        {
          flag: async () => true,
          runBench: async () => METRICS, // rAt10 = 0.82
          record: async () => 5,
          history: async () => [0.8, 0.81, 0.83, 0.82, 0.8],
          escalateRecall: async (workspaceId, backend, rowId, evaluation) => {
            seen = { workspaceId, backend, rowId, evaluation };
          },
          log: silent,
        },
      );
      expect(out.ran).toBe(true);
      expect(seen).not.toBeNull();
      expect(seen!.evaluation.alert).toBe(false);
      expect(seen!.evaluation.reason).toBe('ok');
      expect(seen!.rowId).toBe(5);
      expect(seen!.workspaceId).toBe('ws-1');
    });

    it('a healthy baseline + a collapsed run (the motivating age A/B schema-drift incident): alerts', async () => {
      let seen: RecallDropEvaluation | null = null;
      const crashed: MemoryPrecisionMetrics = { ...METRICS, rAt10: 0 }; // degrade-never-throw → r@10 collapses to 0, not a thrown error
      const out = await runMemoryPrecisionMonitor(
        { workspaceId: 'ws-1', installSlug: 'op' },
        {
          flag: async () => true,
          runBench: async () => crashed,
          record: async () => 6,
          history: async () => [0.8, 0.81, 0.83, 0.82, 0.8],
          escalateRecall: async (_ws, _b, _row, evaluation) => {
            seen = evaluation;
          },
          log: silent,
        },
      );
      expect(out.ran).toBe(true); // the bench+record path succeeds — a bad METRIC is not a tool failure
      expect(seen).not.toBeNull();
      expect(seen!.alert).toBe(true);
      expect(seen!.reason).toBe('baseline-drop');
    });

    it('no history yet: never alerts on baseline-drop even with a mediocre run', async () => {
      let seen: RecallDropEvaluation | null = null;
      const out = await runMemoryPrecisionMonitor(
        { workspaceId: 'ws-1', installSlug: 'op' },
        {
          flag: async () => true,
          runBench: async () => ({ ...METRICS, rAt10: 0.6 }),
          record: async () => 1,
          history: async () => [],
          escalateRecall: async (_ws, _b, _row, evaluation) => {
            seen = evaluation;
          },
          log: silent,
        },
      );
      expect(out.ran).toBe(true);
      expect(seen!.reason).toBe('insufficient-history');
      expect(seen!.alert).toBe(false);
    });

    it('a history-read failure degrades to no-baseline (never wedges the run, never fails it)', async () => {
      let seen: RecallDropEvaluation | null = null;
      const out = await runMemoryPrecisionMonitor(
        { workspaceId: 'ws-1', installSlug: 'op' },
        {
          flag: async () => true,
          runBench: async () => METRICS,
          record: async () => 2,
          history: async () => {
            throw new Error('pg down');
          },
          escalateRecall: async (_ws, _b, _row, evaluation) => {
            seen = evaluation;
          },
          log: silent,
        },
      );
      expect(out.ran).toBe(true);
      expect(seen!.reason).toBe('insufficient-history');
    });

    it('an escalation failure never turns a good bench run into a failed outcome', async () => {
      const out = await runMemoryPrecisionMonitor(
        { workspaceId: 'ws-1', installSlug: 'op' },
        {
          flag: async () => true,
          runBench: async () => METRICS,
          record: async () => 3,
          history: noHistory,
          escalateRecall: async () => {
            throw new Error('EI create failed');
          },
          log: silent,
        },
      );
      expect(out.ran).toBe(true);
      if (out.ran) expect(out.rowId).toBe(3);
    });

    // Note: `history`/`escalateRecall`, left unset, fall back to real
    // getOrgPg()-backed defaults (mirroring `record`'s own existing default,
    // which is likewise never exercised without an override in this suite —
    // this file stays fully dep-injected/PG-free by convention).
  });
});
