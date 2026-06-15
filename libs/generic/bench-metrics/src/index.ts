/**
 * `@papercusp/bench-metrics` — benchmark scoring + cost/Pareto metrics for the
 * impartial benchmark suite (BRIEF 7 / P-011). Owns the canonical run-result
 * schema (co-defined with P-010), the published price table, per-arm token/$
 * accounting with coordination overhead counted, iso-budget verification, the
 * cost/accuracy Pareto, and pass@1-over-seeds + CIs + a uniform pass@k/pass^k
 * protocol.
 *
 *   import { buildSuiteReport, type TaskRunResult } from '@papercusp/bench-metrics';
 *   const report = buildSuiteReport(rows);  // → SuiteReport (arms, frontier, deltas)
 *
 * The pure statistics cores (pass-k, intervals, pareto) are domain-free and
 * usable on their own; schema/pricing/cost/aggregate compose them into the
 * benchmark layer.
 */

// The canonical schema (input + output contracts) — the one type every consumer imports.
export * from './schema';

// Pure domain-free statistics cores.
export { passAtK, passHatK, meanPassAtK } from './pass-k';
export { wilsonInterval, bootstrapMeanCI, meanStderr, type Interval } from './intervals';
export { dominates, paretoFrontier, costAccuracyFrontier, type Direction } from './pareto';

// Benchmark cost layer.
export {
  PRICE_TABLE_V1,
  DEFAULT_PRICE_TABLE,
  priceRun,
  resolveModelPrice,
  type PriceTable,
  type ModelPrice,
  type RunTokens,
} from './pricing';
export { accountTokens, verifyIsoBudget, budgetExceeded, isScored, type IsoBudgetCheck, type IsoBudgetCap } from './cost';

// Report builder — the importable aggregation surface for the Evaluation UI (P-020).
export { aggregateArm, buildSuiteReport, type AggregateOpts } from './aggregate';
