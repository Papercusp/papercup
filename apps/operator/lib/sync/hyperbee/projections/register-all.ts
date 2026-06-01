/**
 * Single-call wire-up for all 8 per-harness Hyperbee projections.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * Production call site (when instrumentation-node.ts boot wiring lands):
 *
 *   for (const harness of resolvedHarnesses) {
 *     registerAllHarnessProjections({
 *       workspaceId,
 *       harnessSlug: harness.slug,
 *     });
 *   }
 *
 * The substrate's `applyHyperbeeOpToPg(op)` then dispatches each
 * Hyperbee op to the right per-table writer/deleter.
 *
 * Decoupled from boot wiring so it can be tested in isolation and so
 * the boot path stays small.
 */

import {
  registerProjection,
  applyOpVia,
  type TableProjection,
  type ProjectionLookup,
} from '../projection';
import type { OpEnvelope } from '../op-envelope-types';
import { buildContributorsProjection } from './contributors';
import { buildFeatureClaimsProjection } from './feature-claims';
import { buildFeatureQueueProjection } from './feature-queue';
import { buildFeatureWorkingSetProjection } from './feature-working-set';
import { buildHarnessFeaturesProjection } from './harness-features';
import { buildIssuesProjection } from './issues';
import { buildPresenceProjection } from './presence';
import { buildPrsProjection } from './prs';
import { buildUsageProjection } from './usage';

export interface RegisterAllOpts {
  workspaceId: string;
  harnessSlug: string;
}

/**
 * The 8 table tags this helper registers. Kept here as a named
 * constant so callers + tests can assert coverage without hard-
 * coding the literal list.
 */
export const REGISTERED_PROJECTION_TAGS = [
  'contributors',
  'claims',
  'queue',
  'working-set',
  'features-by-id',
  'issues',
  'presence',
  'prs',
  'usage',
] as const;

export type RegisteredProjectionTag = (typeof REGISTERED_PROJECTION_TAGS)[number];

/**
 * Build this harness's 9 projections as a fresh array. Single source of truth
 * for the per-harness projection SET — both the global-registry registration
 * (`registerAllHarnessProjections`) and the per-harness scoped apply
 * (`buildHarnessProjectionApply`) derive from it, so they never drift.
 */
function buildHarnessProjections(opts: RegisterAllOpts): TableProjection<unknown>[] {
  return [
    buildContributorsProjection(opts),
    buildFeatureClaimsProjection(opts),
    buildFeatureQueueProjection(opts),
    buildFeatureWorkingSetProjection(opts),
    buildHarnessFeaturesProjection(opts),
    buildIssuesProjection(opts),
    buildPresenceProjection(opts),
    buildPrsProjection(opts),
    buildUsageProjection(opts),
  ] as TableProjection<unknown>[];
}

export function registerAllHarnessProjections(opts: RegisterAllOpts): void {
  if (!opts.workspaceId) throw new Error('registerAllHarnessProjections: workspaceId required');
  if (!opts.harnessSlug) throw new Error('registerAllHarnessProjections: harnessSlug required');
  for (const p of buildHarnessProjections(opts)) registerProjection(p);
}

/**
 * Build a PER-HARNESS scoped op-apply bound to THIS harness's own projection
 * set — the fix for the global-registry collision (Model B D-021). The global
 * `registry` is keyed by `tableTag`, so two booted harnesses registering the
 * same tag overwrite each other and `applyHyperbeeOpToPg` dispatches to whoever
 * registered LAST → the other harness's ops are silently dropped by the
 * projections' own `harness_slug` guard. Boot wires its `mergeNow` to call THIS
 * scoped apply instead, so each harness applies its own ops to its own
 * projections with no cross-harness interference.
 *
 * The returned `apply` reuses the shared `applyOpVia` dispatch core (the same
 * put/del/decode/clobber logic the global path uses) with a lookup bound to a
 * private per-harness `Map<tableTag, projection>`.
 */
export function buildHarnessProjectionApply(
  opts: RegisterAllOpts,
): (op: OpEnvelope) => Promise<boolean> {
  if (!opts.workspaceId) throw new Error('buildHarnessProjectionApply: workspaceId required');
  if (!opts.harnessSlug) throw new Error('buildHarnessProjectionApply: harnessSlug required');
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of buildHarnessProjections(opts)) scoped.set(p.tableTag, p);
  const lookup: ProjectionLookup = (tableTag) => scoped.get(tableTag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op);
}
