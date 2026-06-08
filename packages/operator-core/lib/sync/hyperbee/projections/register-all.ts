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
  type ApplyOpOpts,
} from '../projection';
import type { OpEnvelope } from '../op-envelope-types';
import { buildContributorsProjection } from './contributors';
import { buildFeatureClaimsProjection } from './feature-claims';
import { buildFeatureQueueProjection } from './feature-queue';
import { buildFeatureWorkingSetProjection } from './feature-working-set';
import { buildHarnessFeaturesProjection } from './harness-features';
import { buildHarnessPlansProjection } from './harness-plans';
import { buildIssuesProjection } from './issues';
import { buildPresenceProjection } from './presence';
import { buildPrsProjection } from './prs';
import { buildUsageProjection } from './usage';
import { buildCoordConversationProjection } from './coord-conversation';
import { buildCoordMessageProjection } from './coord-message';
import { buildCoordThreadProjection } from './coord-thread';
import { buildCoordThreadPostProjection } from './coord-thread-post';
import { buildPlanItemAssignmentsProjection } from './plan-item-assignments';
import { buildHiveSettingsProjection } from './hive-settings';

export interface RegisterAllOpts {
  workspaceId: string;
  harnessSlug: string;
  /**
   * Test/multi-peer seam — thread a specific postgres-js client into every
   * projection writer instead of the process-global `getOrgPg().sql`.
   * Production leaves this undefined. (p2p-perf projection-write-cost bench
   * + multi-peer integration tests.)
   */
  sql?: import('postgres').Sql;
  /**
   * G1 Provenance (P-002): the own log's hex keyHex. When provided,
   * `buildHarnessProjectionApply` threads it into `applyOpVia` so ops from
   * the own log are stamped `origin='local'` and ops from admitted remote
   * logs are stamped `origin='remote'`. The global-registry path
   * (`registerAllHarnessProjections`) does not use this field because it
   * dispatches through `applyHyperbeeOpToPg`, not the scoped apply.
   */
  ownLogKeyHex?: string;
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
  'plans-by-slug',
  'issues',
  'presence',
  'prs',
  'usage',
  // distributed-coordination-shared-harness-2026-06-04 (Track A): harness-scoped
  // coordination conversations federate over the peer-log.
  'coord-conversations',
  // distributed-coordination-shared-harness-2026-06-04 (Track A, surface #1):
  // harness-scoped coord messages/handoffs/escalations federate over the peer-log.
  'coord-messages',
  // distributed-coordination-shared-harness-2026-06-04 (Track A): conversation
  // reply timeline — thread header + posts.
  'coord-threads',
  'coord-thread-posts',
  // plan-item-assignment-claim-liveness-2026-06-04 (D-002): per-plan-item ASSIGNMENT
  // federates as content (the leased CLAIM is authority-mediated, never federated).
  'item-assignments',
  // shared-hive-federation-2026-06-08 (P-005): per-Hive settings federate as Hive
  // state, scoped to the Hive home harness slug (rides the Hive-pubkey topic, P-004).
  'hive-settings-by-key',
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
    buildHarnessPlansProjection(opts),
    buildIssuesProjection(opts),
    buildPresenceProjection(opts),
    buildPrsProjection(opts),
    buildUsageProjection(opts),
    buildCoordConversationProjection(opts),
    buildCoordMessageProjection(opts),
    buildCoordThreadProjection(opts),
    buildCoordThreadPostProjection(opts),
    buildPlanItemAssignmentsProjection(opts),
    buildHiveSettingsProjection(opts),
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
  // G1 Provenance (P-002): thread ownLogKeyHex so the apply path can determine
  // origin via log-source (own log → 'local', admitted remote log → 'remote').
  const applyOpts: ApplyOpOpts = opts.ownLogKeyHex ? { ownLogKeyHex: opts.ownLogKeyHex } : {};
  return (op: OpEnvelope) => applyOpVia(lookup, op, applyOpts);
}
