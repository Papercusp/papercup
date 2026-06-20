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
 * author device-identity pubkey ∈ the hive's current member device set (D-002 — federated
 * hive_members, not a per-workspace slug lookup; resolveHiveMemberDeviceSet, P-003).
 *
 * `author_pubkey` (PeerLogOp / provenance.authorPubkey) IS the writer's device-identity pubkey
 * (peer-log.ts:42,57) — the same base64 grain hive_members.device_attestations carries and the
 * P-003 resolver set holds, so `set.has(authorPubkey)` is a direct identity match.
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
 * Should this op be applied to THIS harness's content projection?
 *   - own-slug op (rowHarnessSlug === harnessSlug) → ALWAYS apply (unchanged behavior), else
 *   - cross-member op → apply iff this harness is in a hive (hiveHomeSlug set) AND the op's
 *     author device-identity pubkey ∈ the hive's current member device set; else DROP.
 *
 * The own-slug fast path takes ZERO async work (the common case — a harness applying its own
 * ops), so the member-set resolve only runs for genuinely cross-member ops.
 */
export async function shouldApplyMemberContentOp(
  rowHarnessSlug: string,
  opts: MemberContentGuardOpts,
  authorPubkey: string | null | undefined,
  deps?: MemberDeviceSetDeps,
): Promise<boolean> {
  // Own slug — apply (today's behavior; no membership work on the hot common path).
  if (rowHarnessSlug === opts.harnessSlug) return true;
  // Cross-slug op on a NON-hive harness — there are no members to admit from → drop.
  if (!opts.hiveHomeSlug) return false;
  // Cross-member op with no verified author — cannot confirm membership → drop (fail-closed).
  if (!authorPubkey) return false;
  const memberSet = await resolveHiveMemberDeviceSet(opts.workspaceId, opts.hiveHomeSlug, opts.sql, deps);
  return memberSet.has(authorPubkey);
}
