/**
 * presence-tier1.ts — the cheap per-agent "Tier-1" enrichment for coord:presence
 * (presence-v2-2026-06-14 P-003). These near-free scalars (~5-15 tokens/agent)
 * turn the roster from "who's alive" into "who's doing what, blocked on what,
 * safe to assign/wake":
 *   - lastActiveSecAgo — seconds since GENUINE activity (last_active_at, D-003),
 *     distinct from the keepalive-polluted heartbeat.
 *   - intentStale      — derived: TRUE when lastActiveSecAgo is past the staleness
 *     threshold, so a reader knows the agent's declared intent / lane is NOT being
 *     actively progressed even though its process still heartbeats (stale-ownership-
 *     activity-truth: the 60s supervisor beat keeps a parked/idle psu host "alive",
 *     so a heartbeat-only read makes peers/Queen think abandoned work is handled).
 *   - claimedItems     — the agent's plan-item lane (plan_item_claims).
 *   - model            — its model tier (spawned_agents.model_tier).
 *   - awaitingEvent(+key/note) — is it parked on an events:await (blocked-on)?
 *   - wakeMode         — auto/manual.
 *
 * STORE MAXIMAL, READ MINIMAL (D-001): each source is ONE batch query keyed by
 * the roster's ownerIds, so enriching N agents is a constant ~4 reads, not 4N.
 * agentRole + hive_slug already ride the coord_presence row (P-002), so they need
 * no join here. Heavier Tier-2/3 detail (lock queue, await bodies) stays behind
 * include_detail (P-011, Phase 5). The pure halves (computeLastActiveSecAgo /
 * mergeTier1) are unit-tested; fetchPresenceTier1 is the IO seam.
 */
import { getOrgPg } from '@papercusp/db-org';
import { getAllWakeModeOverrides, getDefaultWakeMode, type WakeMode } from './wake-mode';

export interface PresenceTier1 {
  /** Seconds since genuine activity (last_active_at), or null if never/unknown. */
  lastActiveSecAgo: number | null;
  /** Derived: TRUE when genuine activity is staler than INTENT_STALE_SEC, so the
   *  agent's declared intent / lane should be read as NOT actively progressing
   *  (its process may still heartbeat). null when activity is unknown. */
  intentStale: boolean | null;
  /** Plan-item ids the agent currently holds (its lane). */
  claimedItems: string[];
  /** Model tier the agent runs on (opus/sonnet/haiku…), or null. */
  model: string | null;
  /** True iff the agent is parked on an events:await (blocked-on). */
  awaitingEvent: boolean;
  /** The event key it awaits, if any. */
  awaitingEventKey: string | null;
  /** The await note (why it's blocked), if any. */
  awaitingNote: string | null;
  /** Effective wake mode (auto/manual). */
  wakeMode: WakeMode;
}

/** The join-derived half of the enrichment (everything except the record-derived
 *  lastActiveSecAgo + its derived intentStale). */
export type PresenceTier1Joins = Omit<PresenceTier1, 'lastActiveSecAgo' | 'intentStale'>;

/** Pure: seconds since lastActiveAt (clamped ≥0), or null when unset/unparseable. */
export function computeLastActiveSecAgo(lastActiveAt: string | null, nowMs: number): number | null {
  if (!lastActiveAt) return null;
  const t = Date.parse(lastActiveAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** Staleness threshold (seconds) past which a declared intent / lane is read as
 *  NOT actively progressing. A psu host's supervisor beat refreshes heartbeat_at
 *  every 60s while the OS process lives — independent of genuine work — so a
 *  parked/idle session reads as a live owner forever on a heartbeat-only check
 *  (stale-ownership-activity-truth). last_active_at (mig 277) bumps ONLY on real
 *  activity; this threshold is how stale that may get before "who's on what"
 *  stops trusting the declared intent. Default 30m; env-overridable. */
export const INTENT_STALE_SEC = (() => {
  const v = Number(process.env.PAPERCUSP_INTENT_STALE_SEC ?? 30 * 60);
  return Number.isFinite(v) && v > 0 ? v : 30 * 60;
})();

/** Pure: is a declared intent STALE — genuine activity older than the threshold?
 *  null when activity is unknown (lastActiveSecAgo null → can't judge). Exported so
 *  the boundary is unit-tested without PG. */
export function computeIntentStale(
  lastActiveSecAgo: number | null,
  thresholdSec: number = INTENT_STALE_SEC,
): boolean | null {
  if (lastActiveSecAgo == null) return null;
  return lastActiveSecAgo > thresholdSec;
}

/**
 * IO seam: one batch query each for claims / model / active-awaits + the
 * wake-mode overrides, all keyed by ownerId. Returns the join-derived
 * enrichment per owner. ownerIds should be the LOCAL roster (federated `fed:…`
 * ids never match these local tables, so passing them just wastes a comparison).
 */
export async function fetchPresenceTier1(
  ownerIds: string[],
): Promise<Map<string, PresenceTier1Joins>> {
  const out = new Map<string, PresenceTier1Joins>();
  if (ownerIds.length === 0) return out;
  const { sql } = getOrgPg();

  const [claims, models, awaits, wakeOverrides, wakeDefault] = await Promise.all([
    sql<{ owner: string; items: string[] }[]>`
      SELECT owner, array_agg(item_id ORDER BY item_id) AS items
        FROM harness_shared.plan_item_claims
       WHERE owner = ANY(${ownerIds}::text[]) AND expires_ts > now()
       GROUP BY owner`,
    sql<{ session_owner: string; model_tier: string | null }[]>`
      SELECT DISTINCT ON (session_owner) session_owner, model_tier
        FROM harness_shared.spawned_agents
       WHERE session_owner = ANY(${ownerIds}::text[])
         AND status IN ('running', 'restarting')
       ORDER BY session_owner, heartbeat_at DESC NULLS LAST`,
    sql<{ subscriber_id: string; event_key: string; note: string | null }[]>`
      SELECT DISTINCT ON (subscriber_id) subscriber_id, event_key, note
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ANY(${ownerIds}::text[])
         AND fired_at IS NULL AND cancelled_at IS NULL
         AND (expires_ts IS NULL OR expires_ts > now())
       ORDER BY subscriber_id, created_at DESC`,
    getAllWakeModeOverrides(),
    getDefaultWakeMode(),
  ]);

  const claimsByOwner = new Map(claims.map((r) => [r.owner, r.items ?? []]));
  const modelByOwner = new Map(models.map((r) => [r.session_owner, r.model_tier]));
  const awaitByOwner = new Map(awaits.map((r) => [r.subscriber_id, r]));

  for (const ownerId of ownerIds) {
    const aw = awaitByOwner.get(ownerId);
    out.set(ownerId, {
      claimedItems: claimsByOwner.get(ownerId) ?? [],
      model: modelByOwner.get(ownerId) ?? null,
      awaitingEvent: aw != null,
      awaitingEventKey: aw?.event_key ?? null,
      awaitingNote: aw?.note ?? null,
      wakeMode: wakeOverrides.get(ownerId) ?? wakeDefault,
    });
  }
  return out;
}

/**
 * Pure merge: attach the Tier-1 enrichment + derived lastActiveSecAgo to each
 * record. Records with no enrichment entry (e.g. federated peers) get
 * lastActiveSecAgo only; the join fields stay absent.
 */
export function mergeTier1<T extends { ownerId: string; lastActiveAt: string | null }>(
  records: T[],
  joins: Map<string, PresenceTier1Joins>,
  nowMs: number,
): Array<T & { lastActiveSecAgo: number | null; intentStale: boolean | null } & Partial<PresenceTier1Joins>> {
  return records.map((r) => {
    const lastActiveSecAgo = computeLastActiveSecAgo(r.lastActiveAt, nowMs);
    return {
      ...r,
      ...(joins.get(r.ownerId) ?? {}),
      // Derived AFTER the joins spread so neither the record nor a join can shadow it.
      lastActiveSecAgo,
      intentStale: computeIntentStale(lastActiveSecAgo),
    };
  });
}
