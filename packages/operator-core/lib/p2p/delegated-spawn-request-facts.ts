/**
 * WI-7042 — the PURE half of wiring `classifyDelegatedSpawnOutcome` into
 * `p2p:trace`: turn a stored `p2p_work_offers` row into the request facts the
 * classifier needs, and decide whether this host can see member evidence at all.
 *
 * Pure on purpose. The classifier reached 26/26 with no database precisely
 * because its inputs are plain data, and the two decisions that are easy to get
 * WRONG here — "is this a remote honor?" and "what does an unparseable record
 * mean?" — are exactly the ones worth pinning in unit tests rather than
 * discovering against live PG.
 *
 * The PG read that feeds this stays a thin caller (see `p2p:trace`), modelled on
 * `listP2pReceipts`.
 */
import { parseWorkOfferRecordJson } from './offer-store-schema';
import type { DelegatedSpawnRequestFacts } from './delegated-spawn-outcome';

/** The subset of a `harness_shared.p2p_work_offers` row this mapper needs. */
export interface SpawnRequestOfferRow {
  offer_id: string;
  record_json: string;
  /** Column fallback; the signed record's own fleetSlug wins when present. */
  fleet_slug?: string | null;
}

export interface SpawnRequestFactsResult {
  /** Ready to hand to `classifyDelegatedSpawnOutcome({ request })`. */
  facts: DelegatedSpawnRequestFacts;
  /** The seat-offer publisher this request targeted — the HONORING host. */
  targetPublisherGithubUserId: number;
  /** The requesting session's coord owner id (advisory, for display). */
  requesterOwnerId: string;
  planSlug: string;
}

/**
 * Map one stored offer row to spawn-request facts, or `null` when the row is
 * not a usable spawn request.
 *
 * `null` covers unparseable JSON, a non-`spawn_request` kind, and a missing
 * payload — deliberately collapsed, because every one of them means the same
 * thing to the caller ("no request facts here") and none of them is an error
 * worth throwing over a row that merely belongs to another offer lifecycle.
 * `parseWorkOfferRecordJson` is reused rather than hand-parsing the TEXT column:
 * it is the same closed-schema validator the honor path itself runs, so a record
 * this accepts is one the honoring side would also have accepted.
 */
export function spawnRequestFactsFromRow(row: SpawnRequestOfferRow): SpawnRequestFactsResult | null {
  const record = parseWorkOfferRecordJson(row.record_json);
  if (!record || record.kind !== 'spawn_request' || !record.spawnRequest) return null;

  // A spawn_request always carries a non-null fleetSlug on the signed record
  // (offer-store-schema), so prefer it — the column is a projection of it and
  // is nullable in the table's type. Refuse rather than invent one: the fleet
  // is what member attribution is scoped by, and guessing it would credit
  // another fleet's members to this request.
  const fleetSlug = record.fleetSlug ?? row.fleet_slug ?? null;
  if (!fleetSlug) return null;

  const p = record.spawnRequest;
  return {
    facts: {
      offerId: row.offer_id,
      fleetSlug,
      count: p.count,
      requestedAtMs: p.requestedAtMs,
    },
    targetPublisherGithubUserId: p.targetPublisherGithubUserId,
    requesterOwnerId: p.requesterOwnerId,
    planSlug: p.planSlug,
  };
}

/**
 * Can THIS host see member evidence (presence / fleet membership) for the host
 * that honored this request?
 *
 * TRUE only when this host IS the honoring host. For a REMOTE honor the answer
 * is FALSE and the classifier must be told so, because the requesting host holds
 * no trace of the member at all — measured 2026-08-02: a member joined fleet
 * `fed-drill` on the Win rig at 08:11:25Z and the tower had NO `coord_presence`
 * row (reaped) and NOTHING in the append-only `fleet_membership_events` (the
 * fleet registry is machine-local). Passing `true` there makes an uninformative
 * absence read as a confident `no-response` — "nobody honored it" — for every
 * remote request, which is worse than silence because it reads as a finding.
 *
 * ⚠ Do NOT substitute the row's `origin` column for this. `origin='local'` only
 * means WE published the request, which is equally true of every remote request
 * (verified: all live fed-drill spawn requests are origin='local'). The
 * discriminator is the TARGET, and this comparison mirrors the honor path's own
 * self-check (`payload.targetPublisherGithubUserId !== opts.selfGithubUserId`).
 */
export function memberEvidenceAvailableForHonor(args: {
  targetPublisherGithubUserId: number;
  selfGithubUserId: number | null | undefined;
}): boolean {
  const self = args.selfGithubUserId;
  // Unknown identity ⇒ we cannot claim visibility. Fail toward "indeterminate",
  // never toward a verdict we cannot support.
  if (typeof self !== 'number' || !Number.isInteger(self) || self <= 0) return false;
  return args.targetPublisherGithubUserId === self;
}

/**
 * Other spawn requests on the SAME fleet whose honor windows overlap this one.
 *
 * Presence rows carry no request id, so an overlapping request means a member
 * cannot be uniquely credited — the classifier downgrades attribution to
 * `ambiguous` and says so, instead of silently crediting a peer's member.
 */
export function countConcurrentRequests(args: {
  self: DelegatedSpawnRequestFacts;
  others: DelegatedSpawnRequestFacts[];
  honorWindowMs: number;
}): number {
  const { self, others, honorWindowMs } = args;
  const selfEnd = self.requestedAtMs + (self.honorWindowMs ?? honorWindowMs);
  return others.filter((o) => {
    if (o.offerId === self.offerId) return false;
    if (o.fleetSlug !== self.fleetSlug) return false;
    const end = o.requestedAtMs + (o.honorWindowMs ?? honorWindowMs);
    // Half-open overlap: touching endpoints do not contend.
    return o.requestedAtMs < selfEnd && self.requestedAtMs < end;
  }).length;
}
