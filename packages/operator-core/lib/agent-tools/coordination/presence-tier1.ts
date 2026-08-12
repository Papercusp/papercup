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
import { planItemRef } from '../../issue-blocks-merge';
import { ISSUE_TERMINAL_STATUSES } from '../../work-item-blocking';
import { TERMINAL_STATUSES as FEATURE_TERMINAL_STATUSES } from '../../dbos/frontier-readiness';

/**
 * A held work-item stops occupying its plan item once it is DONE — in either family.
 * The union of the two canonical terminal sets is deliberately family-agnostic: the
 * alternative is joining `item_kind` to pick a set, and the only rows that would
 * decide differently are cross-family impossibilities (an issue at `passed`, a
 * feature at `resolved`). Erring toward "terminal" there under-fires one coupling
 * edge; erring the other way FABRICATES one, which is the worse failure for a signal
 * whose whole point is that it be trustworthy when it speaks.
 *
 * ⚠ IMPORTED, NEVER RE-LITERALLED. A local `['resolved','closed']` copy of exactly
 * these sets is what made plan-item coverage read closed work as unworked for months
 * after the status unification (EI-18129037155166784) — the copy did not move when
 * the alias layer started persisting `done`/`dropped`.
 */
const WORK_ITEM_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  ...ISSUE_TERMINAL_STATUSES,
  ...FEATURE_TERMINAL_STATUSES,
]);

export interface PresenceTier1 {
  /** Seconds since genuine activity (last_active_at), or null if never/unknown. */
  lastActiveSecAgo: number | null;
  /** Derived: TRUE when genuine activity is staler than INTENT_STALE_SEC, so the
   *  agent's declared intent / lane should be read as NOT actively progressing
   *  (its process may still heartbeat). null when activity is unknown. */
  intentStale: boolean | null;
  /** Plan-item ids the agent currently holds (its lane). */
  claimedItems: string[];
  /** Unified work-item ids held by this owner; used only to classify a dead
   *  process as `suspect` until claim cleanup finishes. Not emitted in the
   *  compact presence payload. */
  workItemClaims?: string[];
  /** PLAN-QUALIFIED refs (`<plan_slug>#<item_id>`, {@link planItemRef}) of the plan
   *  items this owner occupies through a held, NON-TERMINAL work-item carrying a
   *  `payload.plan_item` stamp — the plan-item lane the fleet actually records
   *  (EI-20200393414409502).
   *
   *  ⚠ WHY THIS EXISTS BESIDE `claimedItems`, WHICH LOOKS LIKE IT ALREADY ANSWERS IT.
   *  `claimedItems` comes SOLELY from `plan_item_claims`, and that surface is ~6x less
   *  used here than work-item claims: measured 2026-08-11, 5 agents held a live
   *  plan-item claim while 31 held work-items, and ZERO plans had the two co-holders
   *  `blocks-me` needs — so the relation reported a permanent, error-free zero for the
   *  whole 14-day census window while 6 plans had co-located agents and blocked items.
   *  Deriving occupancy from the stamp is what makes that signal reachable at all.
   *
   *  OMITTED (not `[]`) when the owner occupies nothing, so `pick` drops it from the
   *  emitted row and the common case costs zero payload bytes.
   *
   *  Refs are FULLY QUALIFIED on purpose: a bare `P-003` is plan-local, so comparing
   *  one across plans couples two agents over an identifier collision. Qualifying them
   *  is also what lets a peer count as "on my plan" through work it holds there even
   *  when it declares a different `currentPlanSlug`. */
  claimedPlanItemRefs?: string[];
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

/** Re-exported from `../../format/relative-time`, where the pure formatters
 *  live. It moved because THIS module imports `getOrgPg`: a browser component
 *  needing the one pure function would otherwise have pulled Postgres into the
 *  SPA bundle. Re-exported rather than relocated-and-updated at every call site
 *  so existing importers (and this module's own test) stay untouched. */
export { formatIdleAge } from '../../format/relative-time';

/** How much older `intentAgeSec` may run past `lastActiveSecAgo` before the gap
 *  itself counts as drift (EI-8988) — a busy agent (fresh lastActiveSecAgo) whose
 *  declared intent TEXT hasn't been touched in a while. Deliberately smaller than
 *  INTENT_STALE_SEC: intentStale answers "is this agent idle"; intentDivergent
 *  answers "is this agent active but possibly on undeclared work" — a narrower,
 *  earlier-firing signal. Default 15m; env-overridable. */
export const INTENT_DIVERGENCE_SEC = (() => {
  const v = Number(process.env.PAPERCUSP_INTENT_DIVERGENCE_SEC ?? 15 * 60);
  return Number.isFinite(v) && v > 0 ? v : 15 * 60;
})();

/**
 * Pure: does the declared intent TEXT look stale relative to the agent's own
 * genuine activity — i.e. it's doing real work (lastActiveSecAgo fresh) but the
 * intent string hasn't been re-declared in a while (intentAgeSec old)? This is
 * the "declared-vs-derived divergence" EI-8988 asks for: a useful drift signal
 * distinct from intentStale (which only fires when the agent is ALSO idle).
 * null when either side is unknown (can't judge a federated/never-active peer).
 */
export function computeIntentDivergent(
  intentAgeSec: number | null,
  lastActiveSecAgo: number | null,
  thresholdSec: number = INTENT_DIVERGENCE_SEC,
): boolean | null {
  if (intentAgeSec == null || lastActiveSecAgo == null) return null;
  return intentAgeSec - lastActiveSecAgo > thresholdSec;
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

  const [claims, workItemClaims, models, awaits, wakeOverrides, wakeDefault] = await Promise.all([
    sql<{ owner: string; items: string[] }[]>`
      SELECT owner, array_agg(item_id ORDER BY item_id) AS items
        FROM harness_shared.plan_item_claims
       WHERE owner = ANY(${ownerIds}::text[]) AND expires_ts > now()
        GROUP BY owner`,
    // UNGROUPED on purpose (it used to `array_agg … GROUP BY taken_by`): the rows
    // now carry the `payload.plan_item` stamp too, and the ref is built in TS with
    // `planItemRef` rather than concatenated in SQL. That is the single-sourcing
    // that matters here — the consumer (coupling-derivation) parses the same
    // format, and a `'#'` literal in this query would be a second definition of it
    // free to drift. Roster-bounded and tiny: 63 rows across 36 owners fleet-wide
    // at the time of writing, max 7 per owner.
    sql<
      {
        taken_by: string;
        feature_id: string;
        status: string | null;
        plan_slug: string | null;
        item_id: string | null;
      }[]
    >`
      SELECT taken_by, feature_id, status,
             payload->'plan_item'->>'plan_slug' AS plan_slug,
             payload->'plan_item'->>'item_id'   AS item_id
        FROM harness_shared.work_items
       WHERE taken_by = ANY(${ownerIds}::text[])`,
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
  const workItemClaimsByOwner = new Map<string, string[]>();
  const planItemRefsByOwner = new Map<string, Set<string>>();
  for (const r of workItemClaims) {
    const held = workItemClaimsByOwner.get(r.taken_by);
    if (held) held.push(r.feature_id);
    else workItemClaimsByOwner.set(r.taken_by, [r.feature_id]);
    if (!r.plan_slug || !r.item_id) continue;
    if (r.status != null && WORK_ITEM_TERMINAL_STATUSES.has(r.status)) continue;
    const refs = planItemRefsByOwner.get(r.taken_by);
    if (refs) refs.add(planItemRef(r.plan_slug, r.item_id));
    else planItemRefsByOwner.set(r.taken_by, new Set([planItemRef(r.plan_slug, r.item_id)]));
  }
  // Sorted so the emitted STATE field is byte-stable across reads of an unchanged
  // agent — the delta/etag contract (D-005/D-006) the whole state lane rests on.
  for (const items of workItemClaimsByOwner.values()) items.sort();
  const modelByOwner = new Map(models.map((r) => [r.session_owner, r.model_tier]));
  const awaitByOwner = new Map(awaits.map((r) => [r.subscriber_id, r]));

  for (const ownerId of ownerIds) {
    const aw = awaitByOwner.get(ownerId);
    const planItemRefs = planItemRefsByOwner.get(ownerId);
    out.set(ownerId, {
      claimedItems: claimsByOwner.get(ownerId) ?? [],
      workItemClaims: workItemClaimsByOwner.get(ownerId) ?? [],
      // Omitted rather than `[]` when empty: `pick` drops undefined, so a roster of
      // agents occupying nothing pays no payload for the field at all.
      ...(planItemRefs && planItemRefs.size > 0
        ? { claimedPlanItemRefs: [...planItemRefs].sort() }
        : {}),
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
export function mergeTier1<
  T extends { ownerId: string; lastActiveAt: string | null; intentDeclaredAt?: string | null },
>(
  records: T[],
  joins: Map<string, PresenceTier1Joins>,
  nowMs: number,
): Array<
  T & {
    lastActiveSecAgo: number | null;
    intentStale: boolean | null;
    intentAgeSec: number | null;
    intentDivergent: boolean | null;
  } & Partial<PresenceTier1Joins>
> {
  return records.map((r) => {
    const lastActiveSecAgo = computeLastActiveSecAgo(r.lastActiveAt, nowMs);
    const intentAgeSec = computeLastActiveSecAgo(r.intentDeclaredAt ?? null, nowMs);
    return {
      ...r,
      ...(joins.get(r.ownerId) ?? {}),
      // Derived AFTER the joins spread so neither the record nor a join can shadow it.
      lastActiveSecAgo,
      intentStale: computeIntentStale(lastActiveSecAgo),
      intentAgeSec,
      intentDivergent: computeIntentDivergent(intentAgeSec, lastActiveSecAgo),
    };
  });
}
