import { registerEvaluator } from './index';
import type { Violation } from '../types';

registerEvaluator('latency_under', (a, run) => {
  const v: Violation[] = [];
  const latencies = run.turns.map((t) => t.latencyMs).sort((x, y) => x - y);
  if (latencies.length === 0) return v;
  if (a.p50 !== undefined) {
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    if (p50 > a.p50) {
      v.push({
        assertKind: 'latency_under',
        severity: 'warn',
        claim: `p50 latency ${p50}ms exceeded budget ${a.p50}ms`,
      });
    }
  }
  if (a.p95 !== undefined) {
    const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
    if (p95 > a.p95) {
      v.push({
        assertKind: 'latency_under',
        severity: 'warn',
        claim: `p95 latency ${p95}ms exceeded budget ${a.p95}ms`,
      });
    }
  }
  return v;
});

registerEvaluator('cost_under', (a, run) => {
  if (run.totalCostUsd > a.usd) {
    return [{
      assertKind: 'cost_under',
      severity: 'warn',
      claim: `Total cost $${run.totalCostUsd.toFixed(4)} exceeded budget $${a.usd}`,
    }];
  }
  return [];
});

registerEvaluator('finish_reason_is', (a, run) => {
  const last = run.turns[run.turns.length - 1];
  if (!last) {
    return [{ assertKind: 'finish_reason_is', severity: 'error', claim: 'No turns to check finishReason on' }];
  }
  if (last.finishReason !== a.expected) {
    return [{
      assertKind: 'finish_reason_is',
      severity: 'error',
      claim: `Expected finishReason='${a.expected}', got '${last.finishReason}'`,
    }];
  }
  return [];
});

registerEvaluator('custom', (a, run) => {
  return a.eval(run);
});

// Stubs for remaining built-ins — implemented when Phase 1 lands a scenario that needs them.
registerEvaluator('mem0_wrote', () => []);
registerEvaluator('mem0_read', () => []);
registerEvaluator('spawn_dispatched', () => []);
