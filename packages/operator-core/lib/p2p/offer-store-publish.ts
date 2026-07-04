/**
 * p2p/offer-store-publish.ts — the offer-store PUBLISH leg (WI-1935 production
 * caller; agent-allocation-framework-2026-07-03 P-007/D-005).
 *
 * WI-1935 landed the STORE (offer-store.ts putWorkOffer), the SCHEMA
 * (offer-store-schema.ts) and the member-side PROJECTION
 * (sync/hyperbee/projections/work-offers.ts) — this module is the production
 * AUTHOR. First caller (D-005): an agent_slot delegation on
 * resource:delegate publishes a STANDING SEAT-OFFER so the fleet owner's
 * operator sees "this machine: N model·effort seats, fleet X" across the wire.
 * Accounts/GPUs stay LOCAL (M19): the raw account string feeds only the
 * offer-id HASH (upsert stability per machine+trio), never the record body —
 * the record carries accountScope 'auto'|'pinned' only.
 *
 * Called (best-effort, never load-bearing) from the resource:delegate
 * agent_slot success path: set → status open/paused, remove → status
 * cancelled. Deliberately fail-soft (fleet-directory-publish.ts discipline) —
 * a delegation must land fine on a box with no shared hive, no gh identity, or
 * a locked keychain:
 *   • no EXACTLY-ONE shared hive  → skipped (the D-005 federation surface is
 *     the shared hive; zero/many = nothing to publish onto / ambiguous);
 *   • no resolvable gh identity   → skipped (the record's publisher is the X9
 *     numeric id; guessing one would forge authorship);
 *   • record already up to date   → ok, no version churn (re-delegating the
 *     same trio+count is an idempotent upsert at the allotment layer and must
 *     stay one at the offer layer — no re-federating a byte-identical card).
 */

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { Sql } from 'postgres';
import { resolveWorkspaceHiveScope } from '../agent-tools/coordination/federation-scope';
import { resolveUsageActor } from '../harness/usage-actor';
import { resolveDeviceKeychainId } from '../identity/device-keychain-id';
import { loadOrGenerateDeviceKeypair } from '../identity/attest';
import { signWithDeviceKey } from '../identity/sign-with-device-key';
import {
  getWorkOffer,
  putWorkOffer,
  type OfferRecordSigner,
  type StoredWorkOffer,
} from './offer-store';
import type { WorkOfferStoreRecord } from './offer-store-schema';

export type SeatOfferPublishOutcome =
  /** Published (or already current — `changed:false`). */
  | { ok: true; stored: StoredWorkOffer; changed: boolean }
  /** Benign non-publish (no shared hive / no identity / nothing to cancel). */
  | { ok: false; skipped: string }
  /** A real authoring failure (putWorkOffer refusal, keychain fault). */
  | { ok: false; error: string };

/** DI seams (fleet-directory-publish discipline) so unit tests run without
 *  PG/keychain/gh. */
export interface SeatOfferPublishDeps {
  resolveScope?: typeof resolveWorkspaceHiveScope;
  resolveActor?: typeof resolveUsageActor;
  getRecord?: typeof getWorkOffer;
  putRecord?: typeof putWorkOffer;
  buildSigner?: (githubUserId: number) => Promise<OfferRecordSigner>;
  /** The friendly host label the fleet owner's board shows ("B's machine"). */
  resolveHostLabel?: () => string | null;
}

async function defaultBuildSigner(githubUserId: number): Promise<OfferRecordSigner> {
  const keychainId = resolveDeviceKeychainId(githubUserId);
  const keypair = await loadOrGenerateDeviceKeypair(keychainId);
  return {
    pubkey: keypair.pubkeyBase64,
    sign: (bytes: Buffer) => signWithDeviceKey(keychainId, bytes),
  };
}

function defaultHostLabel(): string | null {
  try {
    const h = hostname().trim();
    return h ? h.slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** D-003: the gateway-auto account sentinel (mirrors resource/delegate.ts). */
const AUTO_ACCOUNT = 'AUTO';

/**
 * The deterministic seat-offer id for one (machine, fleet, trio): stable across
 * re-delegations so the allotment layer's idempotent upsert stays idempotent at
 * the offer layer, and machine-scoped (the device pubkey is in the hash) so two
 * machines of the SAME user never collide. The raw account string participates
 * in the hash ONLY — it never appears in the id or the record (D-005/M19).
 */
export function seatOfferId(args: {
  fleetSlug: string;
  model: string;
  effort: string;
  account: string;
  devicePubkey: string;
}): string {
  const digest = createHash('sha256')
    .update([args.fleetSlug, args.model, args.effort, args.account, args.devicePubkey].join('|'), 'utf8')
    .digest('hex');
  return `seat-${digest.slice(0, 16)}`;
}

export interface PublishSeatOfferOpts {
  workspaceId: string | null | undefined;
  fleetSlug: string;
  /** The agent_slot trio as delegated (account may be 'AUTO' or a concrete id —
   *  it feeds the offer-id hash only, never the wire). */
  model: string;
  effort: string;
  account: string;
  /** Seat count (ignored for `removed`). */
  count: number;
  /** The delegation is paused → the offer publishes status 'paused'. */
  paused?: boolean;
  /** The delegation was revoked → the offer publishes status 'cancelled'. */
  removed?: boolean;
  sql?: Sql;
}

/**
 * Publish/refresh/cancel THIS machine's standing seat-offer for one delegated
 * agent_slot trio. Composes the record fresh each time (the allotment is the
 * source of truth; only cancelReason carries over nothing), bumps
 * record_version only when bytes change.
 */
export async function publishSeatOfferForDelegation(
  opts: PublishSeatOfferOpts,
  deps: SeatOfferPublishDeps = {},
): Promise<SeatOfferPublishOutcome> {
  const resolveScope = deps.resolveScope ?? resolveWorkspaceHiveScope;
  const resolveActor = deps.resolveActor ?? resolveUsageActor;
  const getRecord = deps.getRecord ?? getWorkOffer;
  const putRecord = deps.putRecord ?? putWorkOffer;
  const buildSigner = deps.buildSigner ?? defaultBuildSigner;
  const resolveHostLabel = deps.resolveHostLabel ?? defaultHostLabel;

  if (!opts.workspaceId) return { ok: false, skipped: 'no_workspace' };
  const scope = await resolveScope(opts.workspaceId);
  if (scope.kind !== 'one') {
    return { ok: false, skipped: `no_single_shared_hive:${scope.kind}` };
  }
  const actor = await resolveActor();
  if (!actor) return { ok: false, skipped: 'no_github_identity' };

  // The signer is needed BEFORE composing (the offer id hashes the device
  // pubkey), unlike the directory-publish flow. A locked keychain is still a
  // loud error, not a skip.
  let signer: OfferRecordSigner;
  try {
    signer = await buildSigner(actor.githubUserId);
  } catch (e) {
    return { ok: false, error: `device signer unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  const offerId = seatOfferId({
    fleetSlug: opts.fleetSlug,
    model: opts.model,
    effort: opts.effort,
    account: opts.account || AUTO_ACCOUNT,
    devicePubkey: signer.pubkey,
  });
  const existing = await getRecord(
    opts.workspaceId,
    scope.homeSlug,
    actor.githubUserId,
    offerId,
    opts.sql,
  );

  if (opts.removed && !existing) {
    // Revoked a delegation that never had a federated offer — nothing to cancel.
    return { ok: false, skipped: 'no_offer_to_cancel' };
  }

  const record: WorkOfferStoreRecord = {
    offerId,
    publisherGithubUserId: actor.githubUserId,
    fleetSlug: opts.fleetSlug,
    kind: 'seat',
    status: opts.removed ? 'cancelled' : opts.paused ? 'paused' : 'open',
    cancelReason: opts.removed ? 'delegation-removed' : null,
    workOffer: null,
    authorship: null,
    spawnRequest: null,
    seat: opts.removed
      ? // Carry the last-published payload on cancel (the count no longer
        // matters; a junk existing record falls back to the caller's trio).
        (existing?.record?.seat ?? {
          model: opts.model,
          effort: opts.effort,
          count: Math.max(1, Math.min(1000, Math.trunc(opts.count) || 1)),
          accountScope: (opts.account || AUTO_ACCOUNT).toUpperCase() === AUTO_ACCOUNT ? 'auto' : 'pinned',
          hostLabel: resolveHostLabel(),
        })
      : {
          model: opts.model,
          effort: opts.effort,
          count: opts.count,
          accountScope: (opts.account || AUTO_ACCOUNT).toUpperCase() === AUTO_ACCOUNT ? 'auto' : 'pinned',
          hostLabel: resolveHostLabel(),
        },
    recordVersion: (existing?.recordVersion ?? 0) + 1,
  };

  // No-churn gate: identical record (all signed fields except the version bump)
  // ⇒ keep the stored row. Re-delegating the same trio+count is idempotent at
  // the allotment layer and must not re-federate a byte-identical offer.
  if (existing?.record) {
    const prev = { ...existing.record, recordVersion: record.recordVersion };
    if (JSON.stringify(prev) === JSON.stringify(record)) {
      return { ok: true, stored: existing, changed: false };
    }
  }

  const res = await putRecord({
    workspaceId: opts.workspaceId,
    hiveHomeSlug: scope.homeSlug,
    selfGithubUserId: actor.githubUserId,
    record,
    signer,
    sql: opts.sql,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, stored: res.stored, changed: true };
}

/**
 * The fire-and-forget wrapper the resource:delegate success path calls: never
 * throws, never blocks the delegation write it rides on. Kept here (not inline
 * in the tool) so the tool stays store-pure and the swallow is one audited place.
 */
export function publishSeatOfferForDelegationBestEffort(opts: PublishSeatOfferOpts): void {
  void publishSeatOfferForDelegation(opts).catch(() => {});
}
