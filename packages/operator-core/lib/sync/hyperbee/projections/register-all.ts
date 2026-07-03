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
import type { PendingMembershipContent } from '../pending-membership-content';
import { buildContributorsProjection } from './contributors';
import { buildFeatureClaimsProjection } from './feature-claims';
import { buildFeatureQueueProjection } from './feature-queue';
import { buildFeatureWorkingSetProjection } from './feature-working-set';
import { buildHarnessFeaturesProjection } from './harness-features';
import { buildHarnessPlansProjection } from './harness-plans';
import { buildIssuesProjection } from './issues';
import { buildPresenceProjection } from './presence';
import { buildUsageProjection } from './usage';
import { buildCoordConversationProjection } from './coord-conversation';
import { buildCoordMessageProjection } from './coord-message';
import { buildCoordThreadProjection } from './coord-thread';
import { buildCoordThreadPostProjection } from './coord-thread-post';
import { buildPlanItemAssignmentsProjection } from './plan-item-assignments';
import { buildHiveSettingsProjection } from './hive-settings';
// F1-1 (federated-scout-gym-learning-2026-07-02): shareable standing facts.
import { buildAgentFactsProjection } from './agent-facts';
// F1-2/F1-5 (federated-scout-gym-learning-2026-07-02): foreign QD elites.
import { buildGymQdElitesProjection } from './gym-qd-elites';
import { buildBeeClaimSpecProjection } from './bee-claim-spec';
import { buildGateVerdictProjection } from './gate-verdicts';
import { buildHivePolicyProjection } from './hive-policy';
import { buildFleetDirectoryProjection } from './fleet-directory';
import { buildHiveReportsProjection } from './hive-reports';
import { buildHivePendingJoinsProjection } from './hive-pending-joins';
import { buildP2pPeerGrantsProjection } from './p2p-peer-grants';
import { buildP2pReceiptsProjection } from './p2p-receipts';
import { buildHiveMembersProjection } from './hive-members';
import { buildHiveEpochKeysProjection } from './hive-epoch-keys';
import { buildEngineerIssuesProjection } from './engineer-issues';
import { buildHarnessPlanPartsProjection } from './harness-plan-parts';

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
  /**
   * A-003 (shared-hive-release-testing Brief I): the HIVE-HOME slug to scope the
   * two hive-home-grained projections — `hive_members` + `hive_settings` — to,
   * INSTEAD of `harnessSlug`. The other ~16 projections always stay on
   * `harnessSlug`.
   *
   * Why: those two tables demux on the hive-HOME slug (the op carries
   * `hive_home_slug`/`harness_slug` = the Hive's home), but a JOINER boots a
   * MEMBER harness, so a member-slug-bound projection drops every hive-home-scoped
   * op the member's merge reads off the shared Hive topic — the member-list +
   * settings never reach the joiner, AND `loadRevokedHivePubkeys(<home>)` finds an
   * empty set so a revoked member is never refused by the joiner's admission union
   * (the revocation half). Binding ONLY these two to the home slug lets the
   * already-running member merge land them. Boot sets this iff the harness's Hive
   * home is a `remote_hive` (joined) view — the owner's home harness owns the
   * write side, so an owned-hive member must NOT rebind (it would double-apply the
   * owner's own rows as `origin='remote'`). Undefined ⇒ today's behavior
   * (member-slug binding for all projections).
   */
  hiveHomeSlug?: string;
  /**
   * shared-hive-rekey-2026-06-19 (drain hook): fired `(hiveHomeSlug, epoch)` when a
   * `hive_epoch_keys` row applies, so the apply loop can drain J's PendingEpochContent for
   * that `(hive, epoch)` + re-apply the deferred content (now decryptable). Boot wires this
   * when the re-key is active; undefined otherwise (no drain — the buffer just isn't fed).
   * Flows to `buildHiveEpochKeysProjection` via the `hiveScoped` spread (the other
   * projections ignore the extra field).
   */
  onEpochKeyApplied?: (hiveHomeSlug: string, epoch: number) => void;
  /**
   * WI-259 P-002 (membership-aware cross-member content apply): maps an op's
   * `sourceLogKeyHex` (the immutable, receiver-stamped source-log core key) → the
   * device-identity pubkey that was admission-VERIFIED for that log (∈ hive members at
   * admit). The 6 content projections' membership-aware writeToPg guard
   * (`shouldApplyMemberContentOp`) calls this with `op.sourceLogKeyHex` and re-checks the
   * device ∈ the CURRENT member set. Boot wires it from `admittedIdentities`; undefined
   * for non-hive / single-harness contexts (the guard then degrades to today's own-slug
   * drop). NOT keyed off `op.author_pubkey` — that field is caller-supplied / spoofable.
   */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /**
   * WI-259 P-004 (content-before-membership defer/replay): the per-apply-loop buffer for
   * cross-member content ops the P-002 guard would DROP only because the author's `hive_members`
   * row hasn't federated to this peer YET. Threaded into BOTH the 6 content projections (which
   * `defer` into it at the guard drop) AND the hive_members projection (which `drainForDevices`
   * + re-applies on a member apply — the onMemberApplied hook). Boot creates one per harness and
   * wires it here; undefined ⇒ today's drop (no buffer). The content projections receive it via
   * `opts`; hive_members receives it via the `hiveScoped` spread.
   */
  pendingMemberContent?: PendingMembershipContent;
}

/**
 * The table tags this helper registers. Kept here as a named
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
  // federated-scout-gym-learning-2026-07-02 (F1-1): shareable standing facts —
  // hive-home-grained, epoch-encrypted content, source-partitioned on apply (H6).
  'agent-facts-by-key',
  // federated-scout-gym-learning-2026-07-02 (F1-2/F1-5): foreign QD elites —
  // hive-home-grained, epoch-encrypted content; receive side writes ONLY the
  // provenance-keyed gym_qd_foreign_elites (mig 465), never the local archive.
  'gym-qd-elites-by-niche',
  'bee-claim-specs',
  // cross-machine-coord-parity-and-trust-2026-07-01 (P-044 DG-1): the distributed
  // test gate's device-signed verdict facts — hive-home-grained, content-addressed,
  // INSERT-only. The projection verifies sig + content address + signer membership.
  'gate-verdicts',
  // shared-hive-owner-enforcement-2026-06-19 (EN-1): the owner-SIGNED Hive policy
  // record federates as Hive state, scoped to the Hive home (like hive_settings). The
  // projection verifies the owner signature before applying.
  'hive-policy',
  // shared-hive-owner-enforcement-2026-06-19 (EN-3): the member→owner moderation report
  // queue (P-MOD) + the approval-mode pending-join queue (P-MEMBER) federate as Hive
  // state, scoped to the Hive home (like hive_settings/hive_policy).
  'hive-reports',
  'hive-pending-joins',
  // shared-hive-federation-2026-06-08 (P-006): per-Hive contributor/device admission
  // (hive_members) federates across the Hive's Swarms so a revocation propagates.
  'hive-members',
  // shared-hive-rekey-2026-06-19 (P-005): per-member WRAPPED epoch keys for the read-plane
  // re-key (hive-epoch-keys.ts). Hive-home-grained. DARK until papercusp-hive-rekey flips.
  'hive-epoch-keys',
  // fed-reanchor B5: the work-queue's issue/task family (engineer_issues, work_items
  // kind ∈ bug|change|task) federates over the Hive peer-log. The capture trigger
  // (mig 197) derives the federation slug from `scope` + stamps it as harness_slug.
  'engineer-issues',
  // plan-federation-regrain-2026-06-13 P-006: per-PART plan federation (tableTag
  // 'plan-parts'). Additive + DARK — receives nothing until papercusp-plan-part-federation
  // is on (capture is flag-gated) and its harness_plans recompose is itself flag-gated.
  'plan-parts',
  // p2p-work-distribution-2026-07-02 P-001: P2P capability grants — hive-home-grained,
  // receiver-enforced (author attestation == grantor). Inert until grants are authored.
  'p2p-peer-grants',
  // p2p-work-distribution-2026-07-02 P-004: loud-refusal receipt facts — hive-home-
  // grained, INSERT-only, receiver-enforced (author attestation == responder).
  'p2p-receipts',
  // p2p-work-distribution-2026-07-02 P-101 (D-006): the owner-SIGNED fleet directory —
  // hive-home-grained, receiver-verified (attested-device sig; hive key only for the
  // H10 force-archive). Inert until records are authored.
  'p2p-fleet-directory',
] as const;

export type RegisteredProjectionTag = (typeof REGISTERED_PROJECTION_TAGS)[number];

/**
 * Build this harness's projections as a fresh array. Single source of truth
 * for the per-harness projection SET — both the global-registry registration
 * (`registerAllHarnessProjections`) and the per-harness scoped apply
 * (`buildHarnessProjectionApply`) derive from it, so they never drift.
 */
export function buildHarnessProjections(opts: RegisterAllOpts): TableProjection<unknown>[] {
  // A-003: the two hive-home-grained projections scope to the HIVE-HOME slug when
  // boot supplies one (a joiner's member harness), else to this harness's own slug
  // (the home harness itself, or today's non-rebind default). Every OTHER
  // projection always stays on `harnessSlug` — the rebind is surgical to these two.
  const hiveScoped: RegisterAllOpts =
    opts.hiveHomeSlug && opts.hiveHomeSlug !== opts.harnessSlug
      ? { ...opts, harnessSlug: opts.hiveHomeSlug }
      : opts;
  return [
    buildContributorsProjection(opts),
    // WI-259 (MEMBERSHIP-AWARE — plan shared-hive-member-content-federation-2026-06-20;
    // supersedes the reverted "Option B" hive-home remap): a shared-hive MEMBER's
    // feature/plan/issue content stays under its OWN member slug (`opts`), NOT a re-keyed
    // hive-home slug — member slugs aren't peer-stable, and re-keying needed an unforgeable
    // origin discriminator we lack (author_pubkey is caller-supplied / spoofable). Instead
    // these 6 content projections keep member-slug scope, and each writeToPg's guard is
    // upgraded from the bare `harness_slug !== ownSlug` drop to a membership-aware check
    // (`shouldApplyMemberContentOp`): a cross-member op applies iff its VERIFIED source-log
    // device — `resolveAuthorDevice(op.sourceLogKeyHex)` (threaded via opts) — is in the
    // CURRENT hive member set. So a peer member's content federates + stays attributable
    // under its author's slug, and a removed member's writes stop applying, with no re-key.
    buildFeatureClaimsProjection(opts),
    buildFeatureQueueProjection(opts),
    buildFeatureWorkingSetProjection(opts),
    buildHarnessFeaturesProjection(opts),
    buildHarnessPlansProjection(opts),
    buildIssuesProjection(opts),
    buildPresenceProjection(opts),
    buildUsageProjection(opts),
    buildCoordConversationProjection(opts),
    buildCoordMessageProjection(opts),
    buildCoordThreadProjection(opts),
    buildCoordThreadPostProjection(opts),
    buildPlanItemAssignmentsProjection(opts),
    // A-003: hive_settings + hive_members demux on the hive-HOME slug — scope them
    // to `hiveScoped` so a joiner's member harness lands the home-grained ops.
    buildHiveSettingsProjection(hiveScoped),
    // F1-1 (federated-scout-gym): SHAREABLE standing facts, hive-home-grained
    // like hive_settings (the fact's harness_slug carries the hive home slug).
    buildAgentFactsProjection(hiveScoped),
    // F1-2/F1-5 (federated-scout-gym): foreign QD elites, hive-home-grained too
    // (the elite's harness_slug carries the hive home slug — mig 465 demux).
    buildGymQdElitesProjection(hiveScoped),
    buildBeeClaimSpecProjection(hiveScoped),
    // P-044 DG-1: verdict facts are hive-home-grained (the gate is a hive-wide
    // aggregate) — scope like hive_settings so a joiner receives + verifies them.
    buildGateVerdictProjection(hiveScoped),
    buildHiveMembersProjection(hiveScoped),
    // EN-1: hive_policy is hive-home-grained too (the owner-signed policy demuxes on
    // the Hive home) — scope it to `hiveScoped` so a joiner receives + verifies it.
    buildHivePolicyProjection(hiveScoped),
    // EN-3: hive_reports (member→owner moderation queue) + hive_pending_joins (approval-mode
    // admission queue) are hive-home-grained too — scope to `hiveScoped` so the bidirectional
    // request↔decision federation lands on both the owner's home and a joiner's member harness.
    buildHiveReportsProjection(hiveScoped),
    buildHivePendingJoinsProjection(hiveScoped),
    // shared-hive-rekey-2026-06-19 (P-005): hive_epoch_keys (per-member wrapped epoch keys
    // for the read-plane re-key) is hive-home-grained too — scope to `hiveScoped` so a
    // joiner's member harness lands the owner's epoch-key rows. DARK: the boundary trigger +
    // producer are flag-gated (papercusp-hive-rekey), so the table stays empty until cutover.
    buildHiveEpochKeysProjection(hiveScoped),
    buildEngineerIssuesProjection(opts),
    // plan-federation-regrain-2026-06-13 P-006: per-PART plan federation (tableTag
    // 'plan-parts'). Additive + DARK — receives nothing until papercusp-plan-part-federation
    // is on (capture is flag-gated) and its harness_plans recompose is itself flag-gated.
    buildHarnessPlanPartsProjection(opts),
    // p2p-work-distribution-2026-07-02 P-001: P2P capability grants are hive-home-
    // grained (a grant/revocation must land on every member machine, M19) — scope
    // like hive_settings. The projection RECEIVER-ENFORCES the op author's attested
    // identity == the row's grantor (M6/L9) before applying. Inert until grants are
    // authored (zero/empty by default — the P-005 structural-inertness pattern).
    buildP2pPeerGrantsProjection(hiveScoped),
    // P-004: receipts are hive-home-grained like grants (the requester's machines
    // must receive them) — scope to hiveScoped.
    buildP2pReceiptsProjection(hiveScoped),
    // P-101 (D-006): the fleet directory is hive-home-grained like hive_policy (the
    // record demuxes on the Hive home + its verify resolves attestations there) —
    // scope to hiveScoped so a joiner receives + verifies directory records.
    buildFleetDirectoryProjection(hiveScoped),
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
