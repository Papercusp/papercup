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

import { registerProjection } from '../projection';
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

export function registerAllHarnessProjections(opts: RegisterAllOpts): void {
  if (!opts.workspaceId) throw new Error('registerAllHarnessProjections: workspaceId required');
  if (!opts.harnessSlug) throw new Error('registerAllHarnessProjections: harnessSlug required');
  registerProjection(buildContributorsProjection(opts));
  registerProjection(buildFeatureClaimsProjection(opts));
  registerProjection(buildFeatureQueueProjection(opts));
  registerProjection(buildFeatureWorkingSetProjection(opts));
  registerProjection(buildHarnessFeaturesProjection(opts));
  registerProjection(buildIssuesProjection(opts));
  registerProjection(buildPresenceProjection(opts));
  registerProjection(buildPrsProjection(opts));
  registerProjection(buildUsageProjection(opts));
}
