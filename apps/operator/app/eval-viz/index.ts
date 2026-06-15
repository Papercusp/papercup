/**
 * eval-viz — shared, purely-presentational benchmark visualizations
 * (impartial-benchmark-suite-2026-06-15 P-021 / BRIEF 10).
 *
 * Lifted from the gym dashboard + realized for the Evaluation surface (D-007).
 * Consumed by the Evaluation dock-tab (operator-vite, via `@/app/eval-viz/*`)
 * and the gym `compare` tab (`apps/operator/app/gym`, relatively). These
 * components read NO data — callers feed props, keyed on the locked arm vocab.
 */
export { Frontier, paretoOptimal, projectFrontier } from './Frontier';
export type { FrontierPoint, FrontierProps } from './Frontier';
export { Compare, summarizeDeltas } from './Compare';
export type { ComparePerTaskRow, CompareSummary, CompareProps } from './Compare';
export { ARM_IDS, armLabel, armColor } from './arms';
export type { ArmId } from './arms';
