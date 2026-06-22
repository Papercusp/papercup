/**
 * member-content-guard — the WI-259 P-002 MEMBERSHIP-AWARE projection apply guard
 * (plan shared-hive-member-content-federation-2026-06-20).
 *
 * The six shared-hive CONTENT projections (feature claims / queue / working-set, features,
 * plans, issues) federate a member's content across the hive. Today each one gates its apply
 * with the bare `if (row.harness_slug !== opts.harnessSlug) return;` — which drops every
 * op authored by a DIFFERENT member (their slug ≠ this harness's slug), so a joiner never
 * sees a peer member's features/plans/issues (the WI-259 repro).
 *
 * D-001 chose MEMBERSHIP-AWARE over the hive-home REMAP (which keyed all members' content
 * under one slug and needed a NULL-prone author_pubkey discriminator to avoid F-001 clobber).
 * Here each member's content stays under its OWN member slug (no clobber, no discriminator),
 * and this guard decides cross-member VISIBILITY by IDENTITY: apply a cross-member op iff its
 * VERIFIED SOURCE-LOG device pubkey ∈ the hive's CURRENT member device set (D-002 — federated
 * hive_members, not a per-workspace slug lookup; resolveHiveMemberDeviceSet, P-003).
 *
 * The identity grain is `op.sourceLogDevicePubkey` (D-005): the device pubkey that
 * cryptographically VOUCHED for the op's SOURCE LOG at admission — P-001 sig-checks the announce
 * against it AND verifies it ∈ members, then read-merge receiver-stamps it from the AdmittedLog.
 * It is UNFORGEABLE (the same provenance trust as `sourceLogKeyHex`, which lwwPick already treats
 * as peer-stable/unforgeable). It is deliberately NOT `op.author_pubkey`: that field is
 * CALLER-SUPPLIED (peer-log.ts:19), so keying on it would be a SECURITY HOLE — a member could
 * stamp any pubkey, and a removed member could spoof a still-member's pubkey to evade the
 * WRITE-cut. And we re-check against the CURRENT member set at apply, NOT a stale admission-time
 * flag — a member who LEAVES must immediately lose write access (ee7e9; ties D-004's removal cut).
 *
 * Apply order (ee7e9 review #2, ties plan D-003): a cross-member content op is ENCRYPTED under
 * the re-key, so the apply pipeline must DECRYPT (epochGate / Gate 3) BEFORE this guard runs —
 * the guard inspects a real op + a real harness_slug, never ciphertext. The two guards compose,
 * they do not race.
 */
import type { Sql } from 'postgres';
import { resolveHiveMemberDeviceSet, type MemberDeviceSetDeps } from './hive-member-identity-set';

export interface MemberContentGuardOpts {
  workspaceId: string;
  /** This projection's own bound slug (the harness it was built for). */
  harnessSlug: string;
  /** The hive-home slug when this harness is a hive MEMBER (a joined member harness); undefined
   *  for a non-hive / owned-home harness — in which case there is no cross-member content to
   *  admit and the guard reduces to today's own-slug-only behavior. */
  hiveHomeSlug?: string;
  sql?: Sql;
}

/**
 * The 3-way apply decision for a content op (WI-259 P-002 + P-004):
 *   - `'apply'` — own-slug op (ALWAYS), or a cross-member op whose author IS a current member.
 *   - `'drop'`  — a cross-slug op with NO membership grounds: a non-hive harness (no members to
 *                 admit from), or a cross-member op with no VERIFIED source-log identity (can't
 *                 confirm membership → fail-closed). These are dropped for good — NOT deferrable
 *                 (no author identity to wait on / no hive at all).
 *   - `'defer'` — a cross-member op whose author IS identified (source-log device resolved) but is
 *                 not YET in the current member set. This is the P-004 content-before-membership
 *                 race: the author may be a member whose `hive_members` row hasn't federated to
 *                 this peer yet, so the op is buffered (PendingMembershipContent) keyed on the
 *                 author device and re-applied when that member joins — rather than lost. A genuine
 *                 non-member's op also lands here, but the buffer's TTL evicts it (D-007 point 2).
 *
 * The own-slug fast path takes ZERO async work (the common case — a harness applying its own ops),
 * so the member-set resolve only runs for genuinely cross-member ops.
 */
export type MemberContentDecision = 'apply' | 'drop' | 'defer';

export async function decideMemberContentOp(
  rowHarnessSlug: string,
  opts: MemberContentGuardOpts,
  sourceLogDevicePubkey: string | null | undefined,
  deps?: MemberDeviceSetDeps,
): Promise<MemberContentDecision> {
  // Own slug — apply (today's behavior; no membership work on the hot common path).
  if (rowHarnessSlug === opts.harnessSlug) return 'apply';
  // Cross-slug op on a NON-hive harness — there are no members to admit from → drop (not deferrable).
  if (!opts.hiveHomeSlug) return 'drop';
  // Cross-member op with no VERIFIED source-log identity — cannot confirm membership, and there is
  // no author identity to key a deferral on → drop (fail-closed).
  if (!sourceLogDevicePubkey) return 'drop';
  // Membership lives in `harness_shared.hive_members` — WORKSPACE-shared, NOT per-harness content.
  // Read it from the workspace source (getOrgPg, sql omitted), the SAME seam STEP 1 admission uses
  // (boot.ts onAnnounce → resolveHiveMemberDeviceSet with no sql). Do NOT pass `opts.sql`: that is the
  // per-harness CONTENT-write connection (the projection's own DB), a different concern that merely
  // coincides with the workspace PG in production but diverges under a per-peer test topology. Passing
  // it sent the membership read at a content DB with no `hive_members` table (WI-259 close-gate repro).
  const memberSet = await resolveHiveMemberDeviceSet(opts.workspaceId, opts.hiveHomeSlug, undefined, deps);
  // Member NOW → apply. Author identified but not yet a member → DEFER (P-004): the member row may
  // simply not have federated to this peer yet (content-before-membership ordering).
  return memberSet.has(sourceLogDevicePubkey) ? 'apply' : 'defer';
}

/**
 * Should this op be applied to THIS harness's content projection? Thin wrapper over
 * `decideMemberContentOp` (`=== 'apply'`) — the legacy boolean seam the projections used before
 * P-004 introduced the defer branch. Kept for callers that don't buffer (and for the guard's own
 * unit tests). A projection that wires a PendingMembershipContent buffer uses the 3-way decision
 * directly so it can DEFER rather than drop the membership-not-yet-federated case.
 */
export async function shouldApplyMemberContentOp(
  rowHarnessSlug: string,
  opts: MemberContentGuardOpts,
  sourceLogDevicePubkey: string | null | undefined,
  deps?: MemberDeviceSetDeps,
): Promise<boolean> {
  return (await decideMemberContentOp(rowHarnessSlug, opts, sourceLogDevicePubkey, deps)) === 'apply';
}
