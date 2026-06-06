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
 */
const eventsWs = (_caller?: string): string => DEFAULT_COORD_WORKSPACE;

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
  workspaceId?: string;
}): Promise<AwaitRow> {
  const { sql } = getOrgPg();
  const ws = eventsWs(input.workspaceId);
  const rows = await sql`
    INSERT INTO harness_shared.event_awaits
      (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts, once, min_sleep_sec, urgency)
    VALUES
      (${ws}, ${input.subscriberId}, ${input.eventKey}, ${input.policy ?? 'wake'},
       ${input.note ?? null}, ${input.wakeHandle ? JSON.stringify(input.wakeHandle) : null}::jsonb,
       ${input.timeoutBehavior ?? 'expire'},
       ${
         // ISO text, not a raw Date — the live org postgres-js client throws on
         // Date binding (the repo's known quirk); PG casts text→timestamptz.
         input.timeoutSec != null ? new Date(Date.now() + input.timeoutSec * 1000).toISOString() : null
       },
       ${input.once ?? true}, ${input.minSleepSec ?? null}, ${input.urgency ?? false})
    RETURNING *
  `;
  return mapAwait(rows[0]);
}

/** Cancel one of MY awaits (subscriber-scoped — you cannot cancel a peer's). */
export async function cancelAwait(input: {
  awaitId: number;
  subscriberId: string;
  workspaceId?: string;
}): Promise<boolean> {
  const { sql } = getOrgPg();
  const ws = eventsWs(input.workspaceId);
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
export async function listActiveAwaits(subscriberId: string, workspaceId?: string): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs(workspaceId);
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
export async function listActiveAwaitsByKeyPrefix(prefix: string, workspaceId?: string): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs(workspaceId);
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND event_key LIKE ${prefix + '%'}
       AND fired_at IS NULL AND cancelled_at IS NULL
     ORDER BY created_at ASC
     LIMIT 200
  `;
  return rows.map(mapAwait);
}

/** Active awaits matching an event key — peek without firing (sources may use
 *  this to decide whether anyone is waiting at all). */
export async function listActiveAwaitsForKey(eventKey: string, workspaceId?: string): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs(workspaceId);
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND event_key = ${eventKey}
       AND fired_at IS NULL AND cancelled_at IS NULL
     ORDER BY created_at ASC
  `;
  return rows.map(mapAwait);
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
  workspaceId?: string;
}): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs(input.workspaceId);
  // One-shot watches: atomic claim (exactly-once, D-002).
  const onceRows = await sql`
    UPDATE harness_shared.event_awaits
       SET fired_at = now(), fired_reason = ${input.reason ?? 'event'}
     WHERE workspace_id = ${ws} AND event_key = ${input.eventKey}
       AND once = true AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING *
  `;
  // Standing watches: match without consuming (still active after this fire).
  const standingRows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND event_key = ${input.eventKey}
       AND once = false AND cancelled_at IS NULL
       AND (expires_ts IS NULL OR expires_ts > now())
  `;
  return [...onceRows, ...standingRows].map(mapAwait);
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
  workspaceId?: string;
}): Promise<number> {
  if (input.awaits.length === 0) return 0;
  const { sql } = getOrgPg();
  const ws = eventsWs(input.workspaceId);
  const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload);
  let n = 0;
  for (const a of input.awaits) {
    // The delivery is urgent if EITHER the emit declared it OR the watch is an
    // always-urgent watch (a.urgency) — either bypasses the floor.
    const urgent = (input.urgent ?? false) || a.urgency;
    await sql`
      INSERT INTO harness_shared.event_wake_deliveries
        (workspace_id, await_id, subscriber_id, event_key, payload, summary, urgent, min_sleep_sec)
      VALUES (${ws}, ${a.id}, ${a.subscriberId}, ${a.eventKey}, ${payloadJson}::jsonb,
              ${input.summary ?? null}, ${urgent}, ${a.minSleepSec ?? null})
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
  workspaceId?: string;
}): Promise<DeliveryWork[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs(input.workspaceId);
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
  workspaceId?: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (subscriberIds.length === 0) return out;
  const { sql } = getOrgPg();
  const ws = eventsWs(workspaceId);
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
  workspaceId?: string;
}): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs(input.workspaceId);
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
export async function fireTimedOutAwaits(workspaceId?: string): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs(workspaceId);
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
export async function expireLapsedAwaits(workspaceId?: string): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs(workspaceId);
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
  workspaceId?: string;
}): Promise<Array<{ subscriberId: string; status: string; channel: string | null; count: number }>> {
  const { sql } = getOrgPg();
  const ws = eventsWs(input.workspaceId);
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
