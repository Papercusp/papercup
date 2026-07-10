/**
 * await-event store — PG access for `event_awaits` + `event_wake_deliveries`
 * (migration 163; await-event-primitive-2026-06-05 P-001/P-002, D-009).
 *
 * Access mirrors attention/triage-store.ts: plain `getOrgPg().sql` with an
 * explicit `workspace_id` filter (the org handle connects as the table owner,
 * so RLS is enforced for the runtime app role and bypassed here, like every
 * other operator-state table).
 *
 * The one-shot guarantee (D-002) is the atomic
 *   `UPDATE … SET fired_at = now() WHERE fired_at IS NULL … RETURNING`
 * in `fireAwaitsForKey` — two concurrent emits of the same key can never
 * double-fire one await. Delivery is at-least-once on top (D-004): a claimed
 * row that the host crashes on is re-claimed by the sweeper's stuck-delivering
 * recovery; the wake itself is idempotent (re-invoking an agent that just woke
 * is a no-op turn).
 */

import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { keyMatchesPattern, payloadMatchesFilter } from './pattern';
import { WAKE_TURN_CHANNELS } from './types';
import type {
  AwaitPolicy,
  AwaitRow,
  DeliveryRow,
  DeliveryWork,
  TimeoutBehavior,
  WakeChannel,
  WakeHandle,
} from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Events are coordination-plane state: like coord_event_log / coord_links /
 * coord_entity_subscriptions, ALL rows live in the one coord workspace,
 * regardless of the caller's scoping. The live bug this fixes: an unscoped SU
 * shell's identity carries workspaceId '*', so its awaits registered under
 * '*' while a system source (work-items settle) emitted under the ACTIVE
 * workspace — the key never matched and the wake never fired. Event keys
 * embed globally-unique ids (ticket/run/item), so cross-workspace collision
 * is a non-issue; one namespace is the trap-free choice.
 *
 * WI-3575: this module therefore takes NO `workspaceId` input anywhere —
 * every exported function below writes/reads the single coord workspace,
 * full stop. An earlier revision accepted a `workspaceId?` field on most of
 * these functions and silently discarded it (self-consistent today since
 * every row landed under the same constant regardless, but a caller passing
 * a specific workspaceId reasonably believed it was scoping the row, which it
 * never was — a latent trap for a future multi-workspace deployment, where
 * awaits/wakes would cross workspace boundaries silently). The dead
 * parameter was removed everywhere rather than "honored", because honoring
 * it would resurrect the exact cross-workspace mismatch this design already
 * fixed once (see above). If events:await ever needs genuine per-workspace
 * isolation, it needs a new design, not a parameter that was never wired.
 */
const eventsWs = (): string => DEFAULT_COORD_WORKSPACE;

/** jsonb arrives parsed OR as text depending on the postgres-js client config
 *  (the repo's known sql.json quirk) — tolerate both. */
function parseJsonb<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function mapAwait(r: any): AwaitRow {
  return {
    id: Number(r.id),
    workspaceId: r.workspace_id,
    subscriberId: r.subscriber_id,
    eventKey: r.event_key,
    policy: r.policy,
    note: r.note ?? null,
    wakeHandle: parseJsonb<WakeHandle>(r.wake_handle),
    timeoutBehavior: r.timeout_behavior,
    expiresTs: r.expires_ts ? new Date(r.expires_ts).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    firedAt: r.fired_at ? new Date(r.fired_at).toISOString() : null,
    firedReason: r.fired_reason ?? null,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
    once: r.once ?? true,
    minSleepSec: r.min_sleep_sec != null ? Number(r.min_sleep_sec) : null,
    urgency: r.urgency ?? false,
    payloadFilter: parseJsonb(r.payload_filter),
    scopeKind: r.scope_kind ?? null,
    scopeRef: r.scope_ref ?? null,
  };
}

function mapDelivery(r: any): DeliveryRow {
  return {
    id: Number(r.id),
    workspaceId: r.workspace_id,
    awaitId: Number(r.await_id),
    subscriberId: r.subscriber_id,
    eventKey: r.event_key,
    payload: parseJsonb(r.payload),
    summary: r.summary ?? null,
    status: r.status,
    channel: (r.channel as WakeChannel | null) ?? null,
    attempts: Number(r.attempts),
    lastError: r.last_error ?? null,
    nextAttemptAt: new Date(r.next_attempt_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
    urgent: r.urgent ?? false,
    minSleepSec: r.min_sleep_sec != null ? Number(r.min_sleep_sec) : null,
    coalescedCount: r.coalesced_count != null ? Number(r.coalesced_count) : 1,
    source: r.source ?? null,
  };
}

function mapWork(r: any): DeliveryWork {
  return {
    ...mapDelivery(r),
    wakeHandle: parseJsonb<WakeHandle>(r.wake_handle),
    note: r.await_note ?? null,
  };
}

export async function registerAwait(input: {
  subscriberId: string;
  eventKey: string;
  policy?: AwaitPolicy;
  note?: string | null;
  wakeHandle?: WakeHandle | null;
  timeoutBehavior?: TimeoutBehavior;
  /** Seconds until the await lapses; null = no deadline. */
  timeoutSec?: number | null;
  /** Cardinality (unify-watch-primitive): false = standing watch. Default true (one-shot). */
  once?: boolean;
  /** Per-subscriber wake floor in seconds for this watch (null/0 = no floor). */
  minSleepSec?: number | null;
  /** This watch's wakes always bypass the floor (a human-message / escalation watch). */
  urgency?: boolean;
  /** EI-8998: optional predicate (a @papercusp/rules DataCondition) tested against the
   *  emitted payload at fire time, IN ADDITION to the key/pattern match. null/undefined =
   *  no payload predicate (today's fast-path behavior, unchanged). */
  payloadFilter?: unknown | null;
}): Promise<AwaitRow> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  // Safe-by-default (await-timeout-fallback-defaults-2026-07-03): a caller that sets a
  // deadline but names no behavior WAKEs at it (auto-woken to re-orient) rather than
  // lapsing silently. Every real caller (events:await / watch:create / the events sugar /
  // locks:acquire) passes 'wake' explicitly, so this changes no behavior today — it only
  // guards a future caller that forgets. The always-armed inbox-wake path is separate
  // (upsertInboxWakeAwait hardcodes 'expire' + no deadline), so it is unaffected.
  const timeoutBehavior: TimeoutBehavior = input.timeoutBehavior ?? 'wake';
  const rows = await sql`
    INSERT INTO harness_shared.event_awaits
      (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts, once, min_sleep_sec, urgency, payload_filter)
    VALUES
      (${ws}, ${input.subscriberId}, ${input.eventKey}, ${input.policy ?? 'wake'},
       ${input.note ?? null}, ${input.wakeHandle ? JSON.stringify(input.wakeHandle) : null}::text::jsonb,
       ${timeoutBehavior},
       ${
         // ISO text, not a raw Date — the live org postgres-js client throws on
         // Date binding (the repo's known quirk); PG casts text→timestamptz.
         input.timeoutSec != null ? new Date(Date.now() + input.timeoutSec * 1000).toISOString() : null
       },
       ${input.once ?? true}, ${input.minSleepSec ?? null}, ${input.urgency ?? false},
       ${input.payloadFilter != null ? JSON.stringify(input.payloadFilter) : null}::text::jsonb)
    RETURNING *
  `;
  return mapAwait(rows[0]);
}

/**
 * Upsert the ONE standing inbox-wake await for an agent (turn-lifecycle-control
 * D-002): re-arming REFRESHES the handle / floor / note in place instead of
 * piling a duplicate row, so the operator can safely (re-)arm on every
 * SessionStart. Relies on the partial unique index
 * `event_awaits_inbox_wake_one_per_agent` (migration 183) — its predicate and
 * the ON CONFLICT inference predicate below MUST stay byte-identical. A null
 * `wakeHandle` on re-arm KEEPS the previously-captured handle (the session's
 * native id may only land in adv_sessions a moment after the first arm).
 */
export async function upsertInboxWakeAwait(input: {
  subscriberId: string;
  eventKey: string;
  note?: string | null;
  wakeHandle?: WakeHandle | null;
  minSleepSec?: number | null;
}): Promise<AwaitRow> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    INSERT INTO harness_shared.event_awaits
      (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts, once, min_sleep_sec, urgency)
    VALUES
      (${ws}, ${input.subscriberId}, ${input.eventKey}, 'wake',
       ${input.note ?? null}, ${input.wakeHandle ? JSON.stringify(input.wakeHandle) : null}::text::jsonb,
       'expire', NULL, false, ${input.minSleepSec ?? null}, false)
    ON CONFLICT (workspace_id, subscriber_id, event_key)
      WHERE policy = 'wake' AND once = false AND cancelled_at IS NULL
            AND event_key LIKE 'coord:inbox-wake:%'
    DO UPDATE SET
      wake_handle = COALESCE(EXCLUDED.wake_handle, harness_shared.event_awaits.wake_handle),
      note = COALESCE(EXCLUDED.note, harness_shared.event_awaits.note),
      min_sleep_sec = EXCLUDED.min_sleep_sec
    RETURNING *
  `;
  return mapAwait(rows[0]);
}

/** Cancel an agent's standing inbox-wake await(s) — SessionEnd hygiene
 *  (turn-lifecycle-control D-003). Returns how many rows were cancelled. */
export async function cancelInboxWakeAwaits(subscriberId: string): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND subscriber_id = ${subscriberId}
       AND policy = 'wake' AND once = false AND fired_at IS NULL AND cancelled_at IS NULL
       AND event_key LIKE 'coord:inbox-wake:%'
    RETURNING id
  `;
  return rows.length;
}

/** Cancel one of MY awaits (subscriber-scoped — you cannot cancel a peer's). */
export async function cancelAwait(input: {
  awaitId: number;
  subscriberId: string;
}): Promise<boolean> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND id = ${input.awaitId}
       AND subscriber_id = ${input.subscriberId}
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/** Active awaits for a subscriber (events:status). */
export async function listActiveAwaits(subscriberId: string): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND subscriber_id = ${subscriberId}
       AND fired_at IS NULL AND cancelled_at IS NULL
     ORDER BY created_at DESC
     LIMIT 100
  `;
  return rows.map(mapAwait);
}

/** Active awaits whose key starts with a prefix — source-side reconciliation
 *  (e.g. the lock-grant bridge sweeping `lock:grant:%` against waiter status). */
export async function listActiveAwaitsByKeyPrefix(prefix: string): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND event_key LIKE ${prefix + '%'}
       AND fired_at IS NULL AND cancelled_at IS NULL
     ORDER BY created_at ASC
     LIMIT 200
  `;
  return rows.map(mapAwait);
}

/** The always-armed per-agent self-wake key prefix (turn-lifecycle-control) —
 *  every live agent holds one, so it signals liveness, NOT a deliberate bench. */
export const INBOX_WAKE_KEY_PREFIX = 'coord:inbox-wake:';

/**
 * P-001 (fleet-member-dx-improvements-2026-07-10, EI-9014): active NON-inbox-wake
 * awaits for MANY subscribers in ONE round-trip — the "parked-on-event" read that
 * fleet:assignments and the claim-discipline watch derive a member's deliberate
 * bench state from. An agent holding an active await on a real event key is
 * PARKED (benched awaiting a pushed event), not abandoned. Excludes the
 * always-armed `coord:inbox-wake:%` self-await (see INBOX_WAKE_KEY_PREFIX) and
 * rows already past their deadline (the sweeper may not have fired them yet).
 */
export async function listParkedAwaitsForSubscribers(
  subscriberIds: readonly string[],
): Promise<Array<Pick<AwaitRow, 'subscriberId' | 'eventKey' | 'note' | 'expiresTs' | 'createdAt'>>> {
  const ids = [...new Set(subscriberIds.filter((id) => !!id))];
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT subscriber_id, event_key, note, expires_ts, created_at
      FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws}
       AND subscriber_id = ANY(${ids as string[]}::text[])
       AND fired_at IS NULL AND cancelled_at IS NULL
       AND event_key NOT LIKE ${INBOX_WAKE_KEY_PREFIX + '%'}
       AND policy <> 'announce'
       AND (expires_ts IS NULL OR expires_ts > now())
     ORDER BY created_at DESC
     LIMIT 500
  `;
  return rows.map((r: any) => ({
    subscriberId: r.subscriber_id,
    eventKey: r.event_key,
    note: r.note ?? null,
    expiresTs: r.expires_ts ? new Date(r.expires_ts).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Active awaits matching an event key — peek without firing (sources may use
 *  this to decide whether anyone is waiting at all). */
export async function listActiveAwaitsForKey(eventKey: string): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND event_key = ${eventKey}
       AND fired_at IS NULL AND cancelled_at IS NULL
       AND policy <> 'announce'
     ORDER BY created_at ASC
  `;
  return rows.map(mapAwait);
}

/**
 * EI-9000 (fleet-reliability-verification-2026-07-10 P-005): count LIVE (unfired,
 * uncancelled) awaits per key-PREFIX, for MANY prefixes in one round trip — the
 * events:catalog "is anyone actually listening" read. A prefix with zero matches
 * comes back as 0 (not absent), so a caller can zip this 1:1 against its family
 * list without a presence check. Best-effort caller contract: this is a discovery
 * aid (events:catalog), not the emit-time source of truth (fireAwaitsForKey /
 * listActiveAwaitsForKey own that).
 */
export async function countActiveAwaitsByPrefixes(prefixes: readonly string[]): Promise<Map<string, number>> {
  const uniq = [...new Set(prefixes.filter((p) => p.length > 0))];
  const out = new Map<string, number>();
  if (uniq.length === 0) return out;
  for (const p of uniq) out.set(p, 0);
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT p.prefix AS prefix, count(a.id)::int AS n
      FROM unnest(${uniq}::text[]) AS p(prefix)
      LEFT JOIN harness_shared.event_awaits a
        ON a.workspace_id = ${ws}
       AND a.event_key LIKE p.prefix || '%'
       AND a.fired_at IS NULL AND a.cancelled_at IS NULL
       AND a.policy <> 'announce'
     GROUP BY p.prefix
  `;
  for (const r of rows as unknown as Array<{ prefix: string; n: number }>) {
    out.set(r.prefix, Number(r.n) || 0);
  }
  return out;
}

/**
 * Fire every active watch on a key, returning the rows fired BY THIS CALL.
 *
 * Cardinality is honored (unify-watch-primitive D-001/D-004):
 *  - **one-shot** watches (`once = true`, today's await) are claimed ATOMICALLY
 *    (`UPDATE … SET fired_at WHERE fired_at IS NULL`) — exactly-once, a concurrent emit
 *    gets the others, an await can never wake-loop.
 *  - **standing** watches (`once = false`, the pot-style recurring watch) are MATCHED but
 *    NOT consumed — they keep firing on every emit until cancelled or expired.
 */
export async function fireAwaitsForKey(input: {
  eventKey: string;
  reason?: 'event' | 'timeout';
  /** EI-8998: the emitted payload — tested against any active payload_filter before a
   *  matching row is allowed to fire. Rows with no payload_filter are unaffected. */
  payload?: unknown;
}): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();

  // One-shot, EXACT KEY, NO payload_filter: today's single-atomic-UPDATE fast path,
  // unchanged (D-002) — the overwhelmingly common case pays zero extra cost for EI-8998.
  const onceRows = await sql`
    UPDATE harness_shared.event_awaits
       SET fired_at = now(), fired_reason = ${input.reason ?? 'event'}
     WHERE workspace_id = ${ws} AND event_key = ${input.eventKey}
       AND once = true AND fired_at IS NULL AND cancelled_at IS NULL
       AND payload_filter IS NULL
       AND policy <> 'announce'
    RETURNING *
  `;

  // One-shot, EXACT KEY, WITH a payload_filter: can't be tested in SQL (it's an
  // arbitrary mingo DataCondition evaluated in JS), so this can't be one atomic
  // UPDATE — select the (tiny) candidate set, filter in JS, then atomic-claim by id
  // (mirrors the pattern-claim two-step below; a concurrent emit racing the SAME row
  // still can't double-fire it — the final UPDATE's `fired_at IS NULL` guard holds).
  const onceFilterCandidates = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND event_key = ${input.eventKey}
       AND once = true AND fired_at IS NULL AND cancelled_at IS NULL
       AND payload_filter IS NOT NULL
       AND policy <> 'announce'
  `;
  const onceFilterMatchedIds = onceFilterCandidates
    .filter((r: any) => payloadMatchesFilter(parseJsonb(r.payload_filter), input.payload))
    .map((r: any) => Number(r.id));
  const claimedOnceFilterRows =
    onceFilterMatchedIds.length > 0
      ? await sql`
          UPDATE harness_shared.event_awaits
             SET fired_at = now(), fired_reason = ${input.reason ?? 'event'}
           WHERE id = ANY(${onceFilterMatchedIds})
             AND fired_at IS NULL AND cancelled_at IS NULL
          RETURNING *
        `
      : [];

  // Standing watches (exact key): match without consuming (still active after this
  // fire), then apply any payload_filter in JS before including in the result.
  const standingCandidates = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND event_key = ${input.eventKey}
       AND once = false AND cancelled_at IS NULL
       AND (expires_ts IS NULL OR expires_ts > now())
       AND policy <> 'announce'
  `;
  const standingRows = standingCandidates.filter((r: any) =>
    payloadMatchesFilter(parseJsonb(r.payload_filter), input.payload),
  );

  // Pattern awaits (P-201): a stored event_key containing a literal `*` is a glob
  // (`work-item:done:*`, `fleet:*:<slug>`). Fetch the ACTIVE pattern rows — a tiny
  // set, index-backed by event_awaits_pattern_active (migration 480) — and fire the
  // ones whose pattern matches THIS exact fired key, reusing @papercusp/rules' mingo
  // matcher (keyMatchesPattern), THEN (EI-8998) any payload_filter on the same row.
  // One-shots keep the atomic exactly-once claim; standing pattern watches match
  // without consuming. `*` is a literal in SQL LIKE (% and _ are the wildcards), so
  // `LIKE '%*%'` = "event_key contains an asterisk".
  const patternCandidates = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws}
       AND event_key LIKE '%*%'
       AND fired_at IS NULL AND cancelled_at IS NULL
       AND (once = true OR expires_ts IS NULL OR expires_ts > now())
       AND policy <> 'announce'
  `;
  // WI-3309/EI-8413: `event_key` is schema NOT NULL in real Postgres (a NULL/undefined
  // value can never satisfy the `LIKE '%*%'` filter above either), so this guard only
  // ever trips on a malformed candidate row from a non-conforming caller (a test double
  // that stubs `sql` to answer every query with a canned, differently-shaped row was
  // hitting this — `keyMatchesPattern(undefined, ...)` threw `undefined.startsWith`,
  // which escaped as a console.warn via the emit's fire-and-forget .catch). A malformed
  // row can never usefully match a pattern, so skip it instead of crashing the emit.
  const matched = patternCandidates.filter(
    (r: any) =>
      typeof r.event_key === 'string' &&
      keyMatchesPattern(r.event_key, input.eventKey) &&
      payloadMatchesFilter(parseJsonb(r.payload_filter), input.payload),
  );
  const matchedOnceIds = matched.filter((r: any) => (r.once ?? true) === true).map((r: any) => Number(r.id));
  const matchedStanding = matched.filter((r: any) => (r.once ?? true) === false);
  // Atomic exactly-once claim of the matched one-shot patterns (mirrors onceRows: a
  // concurrent emit of a different key that also matches can never double-fire one row).
  const claimedPatternRows =
    matchedOnceIds.length > 0
      ? await sql`
          UPDATE harness_shared.event_awaits
             SET fired_at = now(), fired_reason = ${input.reason ?? 'event'}
           WHERE id = ANY(${matchedOnceIds})
             AND fired_at IS NULL AND cancelled_at IS NULL
          RETURNING *
        `
      : [];

  return [
    ...onceRows,
    ...claimedOnceFilterRows,
    ...standingRows,
    ...claimedPatternRows,
    ...matchedStanding,
  ].map(mapAwait);
}

/**
 * Atomically claim SPECIFIC once-awaits by id (same exactly-once `fired_at IS NULL`
 * guard as `fireAwaitsForKey`'s fast path), rather than sweeping every await on a key.
 * Used for a TARGETED delivery (EI-8998 predicate dedup join,
 * fleet-reliability-verification-2026-07-10 P-004): a subscriber that joins an
 * ALREADY-matched shared predicate row must be told directly, without re-firing every
 * OTHER standing subscriber already registered on that same key. Rows already
 * fired/cancelled are silently skipped (not in the result).
 */
export async function claimSpecificOnceAwaits(
  ids: number[],
  reason: 'event' | 'timeout' = 'event',
): Promise<AwaitRow[]> {
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET fired_at = now(), fired_reason = ${reason}
     WHERE workspace_id = ${ws} AND id = ANY(${ids})
       AND once = true AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING *
  `;
  return rows.map(mapAwait);
}

/** Queue wake deliveries for fired awaits (one row per recipient, D-004). Carries the
 *  per-watch floor (denormalized from each await) + the emit-time `urgent` bypass so the
 *  pump can apply the floor + coalesce without re-joining (unify-watch-primitive P-005). */
export async function insertDeliveries(input: {
  awaits: AwaitRow[];
  payload?: unknown;
  summary?: string | null;
  /** Emit-time urgency: bypass the per-subscriber floor for these deliveries. */
  urgent?: boolean;
  /** Emit-time attribution (migration 387) — persisted on the delivery so the async
   *  resume-turn-exit handler can attribute a turn death to its source (e.g. a loop fire's
   *  `loop:<routineId>`). */
  source?: string | null;
}): Promise<number> {
  if (input.awaits.length === 0) return 0;
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload);
  let n = 0;
  for (const a of input.awaits) {
    // The delivery is urgent if EITHER the emit declared it OR the watch is an
    // always-urgent watch (a.urgency) — either bypasses the floor.
    const urgent = (input.urgent ?? false) || a.urgency;
    await sql`
      INSERT INTO harness_shared.event_wake_deliveries
        (workspace_id, await_id, subscriber_id, event_key, payload, summary, urgent, min_sleep_sec, source)
      VALUES (${ws}, ${a.id}, ${a.subscriberId}, ${a.eventKey}, ${payloadJson}::text::jsonb,
              ${input.summary ?? null}, ${urgent}, ${a.minSleepSec ?? null}, ${input.source ?? null})
    `;
    n++;
  }
  return n;
}

/**
 * Claim due deliveries for the pump: flip pending/parked → delivering and
 * return them joined with their await's wake handle. `FOR UPDATE SKIP LOCKED`
 * keeps two hosts from double-claiming one row.
 */
export async function claimDueDeliveries(input: {
  limit?: number;
}): Promise<DeliveryWork[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    WITH due AS (
      SELECT id FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${ws}
         AND status IN ('pending', 'parked')
         AND next_attempt_at <= now()
       ORDER BY created_at ASC
       LIMIT ${input.limit ?? 10}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE harness_shared.event_wake_deliveries d
       SET status = 'delivering', attempts = d.attempts + 1
      FROM due
     WHERE d.id = due.id
    RETURNING d.*,
      (SELECT a.wake_handle FROM harness_shared.event_awaits a WHERE a.id = d.await_id) AS wake_handle,
      (SELECT a.note FROM harness_shared.event_awaits a WHERE a.id = d.await_id) AS await_note
  `;
  return rows.map(mapWork);
}

export async function markDeliveryDelivered(
  id: number,
  channel: WakeChannel,
  coalescedCount = 1,
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'delivered', channel = ${channel}, delivered_at = now(), last_error = NULL,
           coalesced_count = ${coalescedCount}
     WHERE id = ${id}
  `;
}

/**
 * Settle the deliveries that folded INTO another subscriber's wake (the coalesce siblings):
 * delivered, channel='coalesced', no turn spent. unify-watch-primitive P-005/D-003.
 */
export async function markDeliveriesCoalesced(ids: number[], intoDeliveryId: number): Promise<void> {
  if (ids.length === 0) return;
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'delivered', channel = 'coalesced', delivered_at = now(),
           last_error = ${`coalesced into wake #${intoDeliveryId}`}
     WHERE id = ANY(${ids})
  `;
}

/**
 * The most-recent ACTUAL wake (a turn-burning channel) per subscriber — the floor anchor
 * the pump uses to decide whether a subscriber may be re-woken yet (P-005). 'inbox' and
 * 'coalesced' deliveries are excluded (they spend no turn). Returns epoch ms per subscriber
 * (absent = never woken). Bounded by the handful of subscribers due this tick.
 */
export async function lastWokenAtForSubscribers(
  subscriberIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (subscriberIds.length === 0) return out;
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT subscriber_id, max(delivered_at) AS last_woken_at
      FROM harness_shared.event_wake_deliveries
     WHERE workspace_id = ${ws}
       AND subscriber_id = ANY(${subscriberIds})
       AND status = 'delivered'
       AND channel = ANY(${WAKE_TURN_CHANNELS as unknown as string[]})
       AND delivered_at IS NOT NULL
     GROUP BY subscriber_id
  `;
  for (const r of rows as any[]) {
    if (r.last_woken_at) out.set(r.subscriber_id, new Date(r.last_woken_at).getTime());
  }
  return out;
}

export async function markDeliveryParked(id: number, reason: string, recheckMs: number): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'parked', last_error = ${reason},
           next_attempt_at = now() + make_interval(secs => ${Math.ceil(recheckMs / 1000)})
     WHERE id = ${id}
  `;
}

export async function markDeliveryDropped(id: number, reason: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'dropped', last_error = ${reason}
     WHERE id = ${id}
  `;
}

/** Retry with backoff, or kill after `maxAttempts` (→ 'dead', loudly logged by the pump). */
export async function markDeliveryFailed(input: {
  id: number;
  error: string;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
}): Promise<'retrying' | 'dead'> {
  const { sql } = getOrgPg();
  if (input.attempts >= input.maxAttempts) {
    await sql`
      UPDATE harness_shared.event_wake_deliveries
         SET status = 'dead', last_error = ${input.error}
       WHERE id = ${input.id}
    `;
    return 'dead';
  }
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'pending', last_error = ${input.error},
           next_attempt_at = now() + make_interval(secs => ${Math.ceil(input.backoffMs / 1000)})
     WHERE id = ${input.id}
  `;
  return 'retrying';
}

/** Defer a claimed row without burning its attempt as a failure (pacing). */
export async function markDeliveryDeferred(id: number, deferMs: number): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'pending', attempts = greatest(attempts - 1, 0),
           next_attempt_at = now() + make_interval(secs => ${Math.ceil(deferMs / 1000)})
     WHERE id = ${id}
  `;
}

/** Sweep half 1: stuck 'delivering' rows (host crashed mid-attempt) → pending. */
export async function recoverStuckDeliveries(input: {
  olderThanMs: number;
}): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'pending'
     WHERE workspace_id = ${ws} AND status = 'delivering'
       AND next_attempt_at < now() - make_interval(secs => ${Math.ceil(input.olderThanMs / 1000)})
    RETURNING id
  `;
  return rows.length;
}

/** Sweep half 2a: timeout-behavior 'wake' awaits past deadline → fire as timeout. */
export async function fireTimedOutAwaits(): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET fired_at = now(), fired_reason = 'timeout'
     WHERE workspace_id = ${ws} AND timeout_behavior = 'wake'
       AND expires_ts IS NOT NULL AND expires_ts <= now()
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING *
  `;
  return rows.map(mapAwait);
}

/** Sweep half 2b: timeout-behavior 'expire' awaits past deadline → lapse (visible, no turn). */
export async function expireLapsedAwaits(): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET fired_at = now(), fired_reason = 'expired'
     WHERE workspace_id = ${ws} AND timeout_behavior = 'expire'
       AND expires_ts IS NOT NULL AND expires_ts <= now()
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/**
 * Acknowledge one of MY undelivered wakes (subscriber-scoped): "I saw the
 * parked nudge and acted — do not resume me." Settles the row as delivered
 * via the inbox channel (which is how it actually reached the acker). The
 * D-007 cost saver: an acked wake never burns a resume turn.
 */
export async function ackDelivery(input: {
  deliveryId: number;
  subscriberId: string;
}): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'delivered', channel = COALESCE(channel, 'inbox'), delivered_at = now(),
           last_error = 'acked by subscriber while awake'
     WHERE id = ${input.deliveryId} AND subscriber_id = ${input.subscriberId}
       AND status IN ('pending', 'parked', 'delivering')
    RETURNING id
  `;
  return rows.length > 0;
}

/** Recent deliveries for a subscriber (events:status). */
export async function listRecentDeliveries(subscriberId: string, limit = 10): Promise<DeliveryRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT * FROM harness_shared.event_wake_deliveries
     WHERE subscriber_id = ${subscriberId}
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows.map(mapDelivery);
}

/** The D-007 meter: wake counts by subscriber + channel over a window. */
export async function wakeMeter(input: {
  sinceHours?: number;
} = {}): Promise<Array<{ subscriberId: string; status: string; channel: string | null; count: number }>> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT subscriber_id, status, channel, count(*)::int AS count
      FROM harness_shared.event_wake_deliveries
     WHERE workspace_id = ${ws}
       AND created_at > now() - make_interval(hours => ${input.sinceHours ?? 24})
     GROUP BY subscriber_id, status, channel
     ORDER BY count DESC
     LIMIT 50
  `;
  return rows.map((r: any) => ({
    subscriberId: r.subscriber_id,
    status: r.status,
    channel: r.channel ?? null,
    count: Number(r.count),
  }));
}

// ── Announced gate events (EI-9270, fleet-member-native-guidance-2026-07-10 P-010) ──
// An announcement is a policy='announce' row in THIS table (no parallel surface):
// an emitter-side declaration "this key WILL fire — await it", discoverable via
// events:catalog / coord:orient, and LATCHED (fired_at stamped by the real emit)
// so a late registrant is told the gate already opened instead of sleeping forever.
// Every delivery path above excludes policy='announce'; only the functions below
// touch these rows.

/** Register (or refresh) the announcement for a key. One ACTIVE announcement per
 *  key: re-announcing updates note/scope/expiry in place instead of duplicating. */
export async function registerAnnouncement(input: {
  subscriberId: string;
  eventKey: string;
  note?: string | null;
  scopeKind: 'fleet' | 'plan' | 'harness' | 'global';
  scopeRef?: string | null;
  /** Seconds until the DECLARATION lapses (sweeper marks it fired_reason='expired'); null = standing. */
  expiresSec?: number | null;
}): Promise<AwaitRow> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const expiresTs = input.expiresSec != null ? new Date(Date.now() + input.expiresSec * 1000).toISOString() : null;
  const existing = await sql`
    SELECT id FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${input.eventKey}
       AND cancelled_at IS NULL AND fired_at IS NULL
     ORDER BY created_at DESC LIMIT 1
  `;
  if (existing.length > 0) {
    const rows = await sql`
      UPDATE harness_shared.event_awaits
         SET note = ${input.note ?? null}, scope_kind = ${input.scopeKind}, scope_ref = ${input.scopeRef ?? null},
             expires_ts = ${expiresTs}, subscriber_id = ${input.subscriberId}
       WHERE id = ${Number(existing[0].id)}
      RETURNING *
    `;
    return mapAwait(rows[0]);
  }
  const rows = await sql`
    INSERT INTO harness_shared.event_awaits
      (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts,
       once, min_sleep_sec, urgency, payload_filter, scope_kind, scope_ref)
    VALUES
      (${ws}, ${input.subscriberId}, ${input.eventKey}, 'announce', ${input.note ?? null}, NULL,
       'expire', ${expiresTs}, false, NULL, false, NULL, ${input.scopeKind}, ${input.scopeRef ?? null})
    RETURNING *
  `;
  return mapAwait(rows[0]);
}

/** Announcements (any state except cancelled) for one exact key — the events:await
 *  registration-time LATCH read. fired_reason='event' = the gate genuinely fired;
 *  'expired' = the declaration lapsed unfired (NOT a latch). */
export async function findAnnouncementsForKey(eventKey: string): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${eventKey}
       AND cancelled_at IS NULL
     ORDER BY created_at DESC
     LIMIT 5
  `;
  return rows.map(mapAwait);
}

/** Emit-time latch: stamp fired_at on the key's unfired announcement rows (kept,
 *  never consumed/delivered). Returns how many were latched. */
export async function stampAnnouncementsFired(eventKey: string): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET fired_at = now(), fired_reason = 'event'
     WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${eventKey}
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/** ACTIVE announcements (not cancelled, not lapsed) — the discovery read for
 *  events:catalog / coord:orient. The set is tiny (index-backed, migration 548);
 *  callers filter visibility in JS via announcementVisibleTo (announce-key.ts). */
export async function listActiveAnnouncements(input: {
  /** true (default) = only gates that have NOT fired yet; false includes latched ones. */
  unfiredOnly?: boolean;
  limit?: number;
} = {}): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const unfiredOnly = input.unfiredOnly !== false;
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND policy = 'announce'
       AND cancelled_at IS NULL
       AND (expires_ts IS NULL OR expires_ts > now())
       AND (${!unfiredOnly} OR fired_at IS NULL)
     ORDER BY created_at DESC
     LIMIT ${Math.min(input.limit ?? 100, 200)}
  `;
  return rows.map(mapAwait);
}
