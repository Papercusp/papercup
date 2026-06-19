/**
 * hive-epoch-boundary — the BOUNDARY-TRIGGER CORE for the read-plane re-key (Brief
 * RE-KEY / C-001 / E-001 / Move 2, K's lane: P2). The pure composition that turns a
 * membership/visibility boundary (member-remove / go-private) into a real read cut-off:
 *
 *   advance the epoch (P1) → mint the new epoch key (ed300 deriveEpochKey) →
 *   wrap it to EACH REMAINING member (ed300 wrapKeyToMember).
 *
 * The removed member (or anyone going-private excludes) is simply NOT in
 * `remainingMemberPubkeys`, so it gets no wrapped row → it can replicate future
 * ciphertext but can never unwrap the new epoch key → cut off. That is the C-001 cut.
 *
 * This is PURE + side-effect-light: it advances the epoch (a hive_settings write via P1)
 * and returns the per-member wrapped rows for the CALLER (the wiring) to persist into
 * `hive_epoch_keys` (P3/P-005) + federate. The wiring into `revokeHiveContributor` /
 * `setHiveListing` + the `hive_epoch_keys` capture are the GATED parts (ride d2230's
 * A-003 (a′) federation seam); this core composes my P1 epoch model + ed300's stable
 * crypto, so it is testable end-to-end NOW with zero collision against the in-flight
 * federation work.
 */
import type { Sql } from 'postgres';
import type { HiveEpochCrypto } from './hive-epoch-crypto';
import { advanceHiveEpoch } from './hive-epoch-state';

/** One per-member wrapped epoch key, to be persisted as a `hive_epoch_keys` row (P-005). */
export interface WrappedEpochKeyRow {
  /** The remaining member's raw Ed25519 device pubkey (base64). */
  memberDevicePubkey: string;
  /** The epoch key sealed to that member's device key — only they can unwrap it. */
  wrappedKey: Uint8Array;
}

export interface AdvanceEpochResult {
  /** The new (advanced) epoch. */
  newEpoch: number;
  /** One wrapped row per UNIQUE remaining member (the removed member is absent). */
  wrapped: WrappedEpochKeyRow[];
}

export interface HiveBoundaryCtx {
  workspaceId: string;
  /** The hive's home_slug — the hive_settings / federation scope. */
  hiveHomeSlug: string;
  /** The hive's crypto identity id (deriveEpochKey / keychain key id). */
  hiveId: string;
}

/**
 * Advance the hive epoch and wrap the new epoch key to each remaining member.
 *
 * @param remainingMemberPubkeys raw Ed25519 device pubkeys (base64) of the members who
 *   KEEP access — the removed/excluded member(s) must NOT appear here. Deduped.
 * @returns the new epoch + the per-member wrapped rows for the caller to persist + federate.
 */
export async function advanceEpochAndWrap(
  crypto: HiveEpochCrypto,
  ctx: HiveBoundaryCtx,
  remainingMemberPubkeys: readonly string[],
  sql?: Sql,
): Promise<AdvanceEpochResult> {
  const newEpoch = await advanceHiveEpoch(ctx.workspaceId, ctx.hiveHomeSlug, sql);
  const key = await crypto.deriveEpochKey(ctx.hiveId, newEpoch);

  const seen = new Set<string>();
  const wrapped: WrappedEpochKeyRow[] = [];
  for (const pk of remainingMemberPubkeys) {
    if (!pk || seen.has(pk)) continue; // skip empties + dedupe
    seen.add(pk);
    wrapped.push({ memberDevicePubkey: pk, wrappedKey: await crypto.wrapKeyToMember(key, pk) });
  }
  return { newEpoch, wrapped };
}
