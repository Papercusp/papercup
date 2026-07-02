/**
 * presence-wakeability.ts — the coord:presence "can a coordinator actually hand
 * this agent work right now?" signals (fleet-dispatch-wake-clarity-2026-06-22
 * P-001 / D-001).
 *
 * Two derived, near-free per-agent signals turn the roster from "who's alive"
 * (the misleading `active:17`-that's-really-6 count a coordinator can't act on)
 * into "who can take work":
 *
 *   - wakeable    — there is a LIVE `coord:inbox-wake:<id>` standing await, so an
 *                   events:emit / coord:dispatch WILL deliver a wake. This is the
 *                   authoritative woken:1-vs-woken:0 signal: a cleanly-ended or
 *                   reaped session has cancelled its await (cancelInboxWakeAwaits)
 *                   → not wakeable → a wake reaches nobody (relaunch only).
 *   - sessionState — live | parked | ended:
 *       ended  = NOT wakeable (no live await; the dead/zombie row — never wake it,
 *                it needs a relaunch).
 *       live   = wakeable AND a turn is running right now (fresh heartbeat AND a
 *                recent agent_activity turn with NO trailing '■ session ended').
 *       parked = wakeable but not running (process exited / between turns) — the
 *                IDEAL dispatch target: a wake resumes it.
 *
 * Why the live-vs-parked split needs the agent_activity end-marker (the crux of
 * D-001): heartbeat LAGS. An su session ENDS (its process exits) right after it
 * announces "ready", yet its `heartbeat_at` reads fresh for up to PRESENCE_STALE_MS
 * — so the heartbeat-only `stale` flag reports a just-ended session as "active"
 * (exactly the confusion this plan fixes). The `■ session ended` lifecycle marker
 * is the crisp instant signal that the turn is over even while the heartbeat is
 * still warm.
 *
 * STORE MAXIMAL, READ MINIMAL: two batch queries keyed by the roster's ownerIds
 * (a constant per read, never per-agent). `deriveSessionState` is pure (unit
 * tested); `fetchWakeability` is the IO seam. The caller treats it best-effort —
 * a query failure degrades the roster to today's behavior (no wakeable /
 * sessionState fields) and NEVER breaks the presence read.
 */

import { getOrgPg } from '@papercusp/db-org';
import { PRESENCE_STALE_MS } from './presence';
import { COORD_INBOX_WAKE_PREFIX } from './inbox-wake';
import { liveRecordedOwnerIds } from '../../adv-sessions';

/**
 * Coordinator-facing session state.
 *   live     — a turn is running now (wakeable + recent activity).
 *   parked   — wakeable but idle (the ideal coord:dispatch target).
 *   ended    — NOT wakeable, no authoritative liveness signal → dead, relaunch.
 *   recorded — authoritatively LIVE per the session log (`adv_sessions.ended_at
 *              IS NULL`) but not (yet) inbox-wake-dispatchable. The state of a
 *              session surfaced from the session log that has not self-registered
 *              a coord await — every console/autonomous agent, and any
 *              interactive session in its launch→first-await window. Distinct
 *              from `ended`: it is alive, just not coord-wakeable
 *              (presence-derive-from-session-log-2026-06-22 P-001).
 */
export type SessionState = 'live' | 'parked' | 'ended' | 'recorded';

/** The raw per-agent signals `deriveSessionState` consumes. */
export interface WakeabilitySignals {
  /** A live `coord:inbox-wake:<id>` standing await exists → emit will deliver a wake. */
  wakeable: boolean;
  /** A turn is running now: recent agent_activity with no trailing session-end marker. */
  liveTurn: boolean;
}

/** "Recent turn" window for the liveTurn signal — matches the presence stale
 *  window so the two liveness clocks stay aligned. */
export const LIVE_TURN_WINDOW_MS = PRESENCE_STALE_MS;

/**
 * PURE: the coordinator-facing session state from the three raw signals. Order
 * matters — wakeability is the authoritative gate (not wakeable ⇒ `ended`
 * regardless of a still-warm heartbeat), then a running turn ⇒ `live`, else
 * `parked` (wakeable but idle — the dispatch target). Injected inputs so the
 * boundary unit-tests without PG.
 */
export function deriveSessionState(input: {
  stale: boolean;
  wakeable: boolean;
  liveTurn: boolean;
}): SessionState {
  if (!input.wakeable) return 'ended';
  if (input.liveTurn && !input.stale) return 'live';
  return 'parked';
}

/**
 * IO seam: two batch queries keyed by `ownerIds` (the LOCAL roster — federated
 * `fed:…` ids never match these local tables, so passing them just wastes a
 * comparison; the caller omits them and treats federated rows as state-unknown).
 *
 *  1. wakeable — owners with a live standing `coord:inbox-wake:<id>` await. The
 *     await store keys these `event_key = COORD_INBOX_WAKE_PREFIX || subscriber_id`
 *     (one per agent, partial-unique index); a row that is unfired, uncancelled,
 *     and unexpired means a `{wake:true}` send / coord:dispatch will deliver.
 *  2. liveTurn — per owner, the most-recent activity within LIVE_TURN_WINDOW_MS is
 *     NOT (or is after) the most-recent `■ session ended` lifecycle marker. The
 *     recency window + the end-marker together separate a turn-in-flight from a
 *     just-ended-but-still-warm session.
 */
export async function fetchWakeability(
  ownerIds: string[],
): Promise<Map<string, WakeabilitySignals>> {
  const out = new Map<string, WakeabilitySignals>();
  if (ownerIds.length === 0) return out;
  const { sql } = getOrgPg();
  const windowSec = Math.max(1, Math.round(LIVE_TURN_WINDOW_MS / 1000));

  const [wake, turns] = await Promise.all([
    sql<{ subscriber_id: string }[]>`
      SELECT DISTINCT subscriber_id
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ANY(${ownerIds}::text[])
         AND event_key = ${COORD_INBOX_WAKE_PREFIX} || subscriber_id
         AND fired_at IS NULL AND cancelled_at IS NULL
         AND (expires_ts IS NULL OR expires_ts > now())`,
    sql<{ owner_id: string; last_any: string | null; last_end: string | null }[]>`
      SELECT owner_id,
             max(created_at) AS last_any,
             max(created_at) FILTER (WHERE kind = 'lifecycle' AND summary ILIKE '%end%') AS last_end
        FROM harness_shared.agent_activity
       WHERE owner_id = ANY(${ownerIds}::text[])
         AND created_at > now() - make_interval(secs => ${windowSec})
       GROUP BY owner_id`,
  ]);

  const wakeSet = new Set(wake.map((r) => r.subscriber_id));
  const turnByOwner = new Map(turns.map((r) => [r.owner_id, r]));
  for (const id of ownerIds) {
    const t = turnByOwner.get(id);
    const lastAny = t?.last_any ? Date.parse(t.last_any) : null;
    const lastEnd = t?.last_end ? Date.parse(t.last_end) : null;
    // A turn is in flight when there is recent activity AND it is not (only) the
    // trailing session-end marker — i.e. no end-marker, or activity after it.
    const liveTurn =
      lastAny != null && !Number.isNaN(lastAny) && (lastEnd == null || Number.isNaN(lastEnd) || lastAny > lastEnd);
    out.set(id, { wakeable: wakeSet.has(id), liveTurn });
  }
  return out;
}

/** A `fed:…` owner id is FEDERATED — it never matches the local wakeability /
 *  session-log tables, so its liveness is UNKNOWN here, not ended. */
export const FEDERATED_OWNER_PREFIX = 'fed:';

/**
 * PURE: given each owner's wakeability + whether it has a live recorded session,
 * return the owners that are AUTHORITATIVELY ENDED (dead, need a relaunch). This
 * is the {@link deriveSessionState} `ended` verdict distilled for a batch
 * liveness reader: an owner is ended iff it is NOT inbox-wakeable AND has NO live
 * recorded session (a launching / not-yet-registered session is `recorded`-live,
 * NOT dead). Federated owners are excluded upstream. Injected inputs so it
 * unit-tests without PG.
 */
export function selectEndedOwnerIds(
  ownerIds: readonly string[],
  wake: ReadonlyMap<string, WakeabilitySignals>,
  recordedLive: ReadonlySet<string>,
): Set<string> {
  const ended = new Set<string>();
  for (const id of ownerIds) {
    const wakeable = wake.get(id)?.wakeable ?? false;
    if (!wakeable && !recordedLive.has(id)) ended.add(id);
  }
  return ended;
}

/**
 * IO seam: batch-classify which of `ownerIds` are AUTHORITATIVELY ENDED — dead,
 * needing a relaunch — using the SAME two signals `coord:presence` derives its
 * `ended` sessionState from (EI-6374, the fleet-coverage liveness-drift): an
 * owner is `ended` iff it is NOT inbox-wakeable AND has NO live recorded session
 * (`adv_sessions.ended_at IS NULL`). The recorded-session guard is what keeps a
 * launching / not-yet-coord-registered (`recorded`-live) bee from being mistaken
 * for dead. Federated (`fed:…`) owners are dropped (unknown, not ended).
 *
 * Best-effort: on any query error it returns an EMPTY set — no owner is
 * downgraded — so the caller degrades to heartbeat-only liveness and never
 * over-reports death.
 */
export async function fetchEndedOwnerIds(ownerIds: string[]): Promise<Set<string>> {
  const local = [...new Set(ownerIds.filter((id) => !!id && !id.startsWith(FEDERATED_OWNER_PREFIX)))];
  if (local.length === 0) return new Set();
  try {
    const [wake, recordedLive] = await Promise.all([
      fetchWakeability(local),
      liveRecordedOwnerIds(local),
    ]);
    return selectEndedOwnerIds(local, wake, recordedLive);
  } catch (e) {
    console.warn('[presence-wakeability] fetchEndedOwnerIds failed:', (e as Error)?.message ?? e);
    return new Set();
  }
}
