/**
 * Caller-specified result projection (P-020 / D-041) — the reduction operators
 * bash gets from pipes, available on EVERY tool call at the dispatch layer.
 *
 * @see ./types.ts for the design contract (the two domains, the tier rationale,
 *      and why the regex flavor is declared rather than assumed).
 */

export { applyPick, applyResultProjection, parsePickPath } from './apply';
export type { ApplyProjectionOpts, ProjectableResult } from './apply';
export {
  MAX_PICK_PATHS,
  MAX_PIPELINE_STAGES,
  describeProjection,
  parseProjection,
} from './parse';
export type { ProjectionParseErr, ProjectionParseOk, ProjectionParseResult } from './parse';
export { PROJECTION_ARG } from './types';
export type { ProjectionReport, ProjectionSpec, ProjectionStage } from './types';
