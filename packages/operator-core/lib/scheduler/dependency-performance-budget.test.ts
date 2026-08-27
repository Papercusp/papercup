import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_GRAPH_BUDGET_MS,
  DEPENDENCY_GRAPH_SCALE_BASELINE,
  dependencyGraphPerformanceTelemetry,
} from './dependency-performance-budget';

describe('dependency graph performance budget', () => {
  it('pins the measured current-scale census budget and reports both verdicts structurally', () => {
    expect(DEPENDENCY_GRAPH_SCALE_BASELINE).toEqual({ nodes: 130_000, edges: 1_500 });
    expect(DEPENDENCY_GRAPH_BUDGET_MS.census).toBe(5_000);
    expect(
      dependencyGraphPerformanceTelemetry({ operation: 'census', durationMs: 3_211.24, nodes: 126_532, edges: 1_205 }),
    ).toMatchObject({ durationMs: 3_211.2, budgetStatus: 'within-budget', budgetMs: 5_000 });
    expect(
      dependencyGraphPerformanceTelemetry({ operation: 'mutation', durationMs: 2_001, nodes: 3, edges: 2 }),
    ).toMatchObject({ budgetStatus: 'over-budget', budgetMs: 2_000 });
  });
});
