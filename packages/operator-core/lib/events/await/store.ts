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
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { normalizeEventKey } from './announce-key';
import { keyMatchesPattern, payloadMatchesFilter, patternLiteralPrefix } from './pattern';
import { WAKE_TURN_CHANNELS } from './types';
import { withEffectiveDeadlines } from './effective-deadline';
import type {
  AwaitPolicy,
  AwaitRow,
  DeliveryStatus,
  DeliveryRow,
  DeliveryWork,
  KeyFireRow,
  TimeoutBehavior,
  WakeChannel,
  WakeHandle,
} from './types';
import type { ProducerHealthCertificate, VerifiedWaitTimeoutResult } from './verified-wait';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

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
    causalGeneration: r.causal_generation != null ? Number(r.causal_generation) : null,
    expectedCondition: parseJsonb(r.expected_condition),
    supersededAt: r.superseded_at ? new Date(r.superseded_at).toISOString() : null,
    firedBy: r.fired_by ?? null,
    firedPayload: parseJsonb(r.fired_payload),
    // composable-event-awaits-2026-07-11 (migration 572). A `SELECT *` on a DB predating the
    // migration returns these as undefined ⇒ null — so mapAwait is safe against the older
    // hand-rolled test DDLs, and the composed fire path (engine.ts) is inert until a row
    // actually carries a node_id.
    nodeId: r.node_id != null ? Number(r.node_id) : null,
    rootId: r.root_id != null ? Number(r.root_id) : null,
    memberFiredAt: r.member_fired_at ? new Date(r.member_fired_at).toISOString() : null,
    memberPayload: parseJsonb(r.member_payload),
    producerHealthCertificate: parseJsonb<ProducerHealthCertificate>(r.producer_health),
    timeoutVerification: parseJsonb<VerifiedWaitTimeoutResult>(r.timeout_verification),
    verificationClaimedAt: r.verification_claimed_at
      ? new Date(r.verification_claimed_at).toISOString()
      : null,
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
  /** Optional verified-wait producer certificate. Legacy awaits omit it. */
  producerHealthCertificate?: ProducerHealthCertificate | null;
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
      (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts, once, min_sleep_sec, urgency, payload_filter, producer_health)
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
       ${input.payloadFilter != null ? JSON.stringify(input.payloadFilter) : null}::text::jsonb,
       ${input.producerHealthCertificate ? JSON.stringify(input.producerHealthCertificate) : null}::text::jsonb)
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

/** Cancel a subscriber's standing `work-item:claimable` await(s) — called when the
 *  agent SUCCESSFULLY claims work (scheduler:get_next / work_items:claim_next). Holding a
 *  claim and waiting for claimable work are mutually exclusive: the documented idle model is
 *  serial (park ONE `work-item:claimable` await when a self-pull misses → wake → claim → work
 *  → re-park on the next miss), so a claimable await that outlives its claim is always stale.
 *  EI-10541: a pre-claim idle-park await that isn't cancelled when the agent later claims via a
 *  leader-fed spec bump keeps firing spurious ~30-min timeout wakes while the agent is busy,
 *  each costing a full re-orient turn. Subscriber-scoped (you can only cancel your own, like
 *  cancelInboxWakeAwaits); best-effort at the call site. Returns how many rows were cancelled. */
export async function cancelClaimableAwaits(subscriberId: string): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND subscriber_id = ${subscriberId}
       AND event_key = 'work-item:claimable'
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/**
 * Cancel PENDING (not yet fired/cancelled) awaits for the given subscribers on the
 * given EXACT event keys — the shared primitive behind two distinct EI-12457 uses:
 *
 * 1. SIBLING cancellation at FIRE time: a dual-outcome wait (checkpoint:await arms
 *    BOTH `release:green:<pipeline>` and `green-checkpoint:red:<pipeline>` so it wakes
 *    either way) leaves the OTHER key's registration alive until its own timeout once
 *    one outcome fires — for the resolved candidate it can now never legitimately fire.
 *    The caller (emitAwaitedEvent) passes the subscribers just woken by THIS fire plus
 *    the sibling key(s), so the dead registration is retired immediately instead of
 *    piling up (the "350 total registrations" noise release:trace was reporting).
 * 2. SUPERSEDED-wait retirement at REGISTRATION time: re-arming checkpoint:await for a
 *    pipeline (e.g. because the candidate moved) first cancels the SAME subscriber's
 *    own prior, still-pending checkpoint-family awaits for that pipeline — an old
 *    registration a caller has moved on from is exactly the "superseded" wait the
 *    ticket named; without this it lives on and can fire a stale/obsolete wake later.
 *
 * Subscriber-scoped (mirrors cancelClaimableAwaits — you can only cancel your own,
 * both directions). Best-effort at every call site; returns 0 rather than throwing
 * when there is nothing to cancel.
 */
export async function cancelAwaitsForSubscribersOnKeys(
  subscriberIds: readonly string[],
  eventKeys: readonly string[],
): Promise<number> {
  if (subscriberIds.length === 0 || eventKeys.length === 0) return 0;
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET cancelled_at = now()
     WHERE workspace_id = ${ws}
       AND subscriber_id = ANY(${sql.array([...subscriberIds])}::text[])
       AND event_key = ANY(${sql.array([...eventKeys])}::text[])
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/**
 * Cancel PENDING awaits by exact row id, regardless of subscriber (WI-4957) — for when
 * the CALLER has already identified specific dead registrations (e.g. every await whose
 * payload_filter is bound to a candidate sha a checkpoint run was just superseded/killed
 * for) and needs to retire exactly those rows. Unlike cancelAwaitsForSubscribersOnKeys
 * (subscriber+key scoped, so it can't distinguish two different payload-bound waits on
 * the SAME key for the SAME subscriber) or cancelAwait (subscriber-scoped, self-only),
 * this is a precise by-id cancel — safe here because the caller derived the id set from
 * a payload-filter match, never a guess. Best-effort shape: returns the count actually
 * cancelled (already-fired/cancelled rows are silently skipped, not an error).
 */
export async function cancelAwaitsByIds(ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND id = ANY(${[...ids]})
       AND fired_at IS NULL AND cancelled_at IS NULL
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
  // P-016: a composed LEAF carries no expires_ts of its own (the root node owns the
  // tree's deadline), and a NULL here reads as "waits forever" everywhere else in this
  // table. Resolve before the dossier/`events:status` renders it. No extra query when
  // the batch holds no composed awaits.
  return withEffectiveDeadlines(rows.map(mapAwait), { workspaceId: ws });
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
): Promise<Array<Pick<AwaitRow, 'subscriberId' | 'eventKey' | 'note' | 'expiresTs' | 'createdAt' | 'rootId'>>> {
  const ids = [...new Set(subscriberIds.filter((id) => !!id))];
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT subscriber_id, event_key, note, expires_ts, created_at, root_id
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
  const mapped = rows.map((r: any) => ({
    subscriberId: r.subscriber_id,
    eventKey: r.event_key,
    note: r.note ?? null,
    expiresTs: r.expires_ts ? new Date(r.expires_ts).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    rootId: r.root_id != null ? Number(r.root_id) : null,
  }));
  // P-016. This read IS the bench/park verdict behind fleet:assignments' `parkedOn`
  // and the claim-discipline watch, so both halves of the composed-leaf defect matter
  // here: a leaf's NULL expires_ts reads as an INDEFINITE park (the false-deadlock
  // reading), and the SQL filter above cannot see the root's deadline, so a leaf whose
  // TREE already lapsed survives it and reads as an ACTIVE park. `dropExpired` closes
  // the second — fixing only the first would trade one wrong verdict for another.
  return withEffectiveDeadlines(mapped, { workspaceId: ws, dropExpired: true });
}

/**
 * A verified wait that reached an authoritative stalled/absent verdict needs to
 * remain leader-legible after the one-shot await has fired.  The wake payload is
 * transient; this read projects the durable verdict stored on event_awaits.
 *
 * Keep the window bounded and return only the newest verdict per
 * subscriber/event pair.  This is an operational handoff signal, not an event
 * history API.
 */
export interface VerifiedWaitTakeoverAlert {
  subscriberId: string;
  eventKey: string;
  firedAt: string;
  classification: 'stalled' | 'absent';
  nextAction: 'wake-owner-or-takeover';
  producer: VerifiedWaitTimeoutResult['producer'];
  owner: VerifiedWaitTimeoutResult['owner'];
  checkedAtMs: number;
  verificationDeadlineMs: number;
  lastProgressAtMs: number | null;
  lastFireAtMs: number | null;
  evidence?: Record<string, unknown>;
  remedy: string;
}

export async function listVerifiedWaitTakeoversForSubscribers(
  subscriberIds: readonly string[],
  sinceHours = 24,
): Promise<VerifiedWaitTakeoverAlert[]> {
  const ids = [...new Set(subscriberIds.filter((id) => !!id))];
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const boundedHours = Math.min(Math.max(sinceHours, 1), 168);
  const rows = await sql`
    SELECT DISTINCT ON (subscriber_id, event_key)
           subscriber_id, event_key, fired_at, timeout_verification
      FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws}
       AND subscriber_id = ANY(${ids as string[]}::text[])
       AND fired_reason = 'verified-timeout'
       AND fired_at >= now() - make_interval(hours => ${boundedHours})
       AND timeout_verification IS NOT NULL
     ORDER BY subscriber_id, event_key, fired_at DESC
     LIMIT 500
  `;
  const alerts = rows.flatMap((row: any) => {
    const result = parseJsonb<VerifiedWaitTimeoutResult>(row.timeout_verification);
    if (
      !result ||
      (result.classification !== 'stalled' && result.classification !== 'absent') ||
      result.nextAction !== 'wake-owner-or-takeover'
    ) {
      return [];
    }
    const ownerTarget = result.owner.workItemId ?? result.owner.ownerId;
    return [{
      subscriberId: row.subscriber_id,
      eventKey: row.event_key,
      firedAt: new Date(row.fired_at).toISOString(),
      classification: result.classification,
      nextAction: result.nextAction,
      producer: result.producer,
      owner: result.owner,
      checkedAtMs: result.checkedAtMs,
      verificationDeadlineMs: result.verificationDeadlineMs,
      lastProgressAtMs: result.lastProgressAtMs,
      lastFireAtMs: result.lastFireAtMs,
      ...(result.evidence ? { evidence: result.evidence } : {}),
      remedy: ownerTarget
        ? `Wake the owner of ${ownerTarget}; if it does not resume promptly, claim/take over ${ownerTarget}.`
        : 'No owning work-item or agent was recorded; claim the producer repair before retrying this wait.',
    } satisfies VerifiedWaitTakeoverAlert];
  });
  if (alerts.length === 0) return alerts;
  // EI-20540454577146535: `timeout_verification` is a SNAPSHOT written once, when the
  // fallback verifier fired — it is never re-checked against the work item's CURRENT
  // state. Filed live: a checkpoint response recommended wake-owner-or-takeover for
  // WI-39333 forty-three minutes after that item had already closed (state=done), a
  // stale warning that can steer a monitor to seize completed work. Suppress rows
  // whose owning work item has since gone terminal.
  const terminalOwners = await terminalWorkItemIds(
    alerts.map((a) => a.owner.workItemId).filter((id): id is string => !!id),
  );
  if (terminalOwners.size === 0) return alerts;
  return alerts.filter((a) => !a.owner.workItemId || !terminalOwners.has(a.owner.workItemId));
}

/**
 * Which of these work-item ids are terminal RIGHT NOW — read fresh, never inferred
 * from the (possibly stale) certificate that produced the takeover alert.
 *
 * Best-effort and fails OPEN (empty set ⇒ nothing suppressed): a lookup failure, or
 * an id this read cannot resolve, must never hide a genuinely stalled producer just
 * because the freshness check itself broke — that would trade one wrong verdict for
 * another. A `feature_id` collision across workspaces (F-B3: a bare `WI-`/`F-` id is
 * unique only within a workspace+harness, not globally) is treated as terminal ONLY
 * when EVERY matching row is, for the same reason: suppressing could otherwise hide
 * the alert for the live namesake.
 */
async function terminalWorkItemIds(ids: readonly string[]): Promise<Set<string>> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT feature_id, status
        FROM harness_shared.work_items
       WHERE feature_id = ANY(${distinct}::text[])
    `;
    const statusesById = new Map<string, boolean[]>();
    for (const r of rows as any[]) {
      const list = statusesById.get(r.feature_id) ?? [];
      list.push(ANY_FAMILY_TERMINAL_STATES.includes(r.status ?? ''));
      statusesById.set(r.feature_id, list);
    }
    const terminal = new Set<string>();
    for (const [id, verdicts] of statusesById) {
      if (verdicts.length > 0 && verdicts.every(Boolean)) terminal.add(id);
    }
    return terminal;
  } catch {
    return new Set();
  }
}

/**
 * EI-19447204017443244: the caller's OWN live WAKE-capable awaits — the falsifier for
 * loop:arm's interval-cap sentence "nothing can push you a wake", which asserted that
 * as fact while consulting only `blockedOn.event`.
 *
 * Three filters carry the meaning, and each was measured rather than assumed:
 *
 *  • `policy = 'wake'` — NOT `<> 'announce'` like the bench read below. 'notify' rows
 *    inject into the inbox without waking, so counting one would answer "can anything
 *    WAKE you" with a row that cannot — re-committing the same over-claim in miniature.
 *  • `NOT LIKE INBOX_WAKE_KEY_PREFIX%` — every live agent holds exactly one standing
 *    inbox-wake row (measured 2026-08-03: 61 of the 64 live wake-awaits fleet-wide, and
 *    it is created at session start), so without this the caller ALWAYS looks like it
 *    holds a push channel. That would be strictly worse than the sentence it replaces:
 *    a rare false assertion swapped for a constant misleading one.
 *  • the liveness pair (`fired_at IS NULL AND cancelled_at IS NULL` + unexpired) is
 *    lifted verbatim from `listParkedAwaitsForSubscribers` so the two reads cannot
 *    drift on what "live" means; `withEffectiveDeadlines` then drops composed leaves
 *    whose TREE has lapsed (zero extra queries when none are composed).
 *
 * Bounded (see `listActiveAwaitsForKey`'s note): this runs on loop:arm's hot path and
 * is purely advisory, so a stall must fail fast rather than hang the arm. Callers treat
 * a rejection as "unknown" — deliberately NOT as "none", which would launder an
 * unmeasurable into a measurement and re-create this very defect.
 */
export async function listWakeAwaitsForSubscriber(
  subscriberId: string,
  limit = 5,
): Promise<Array<{ eventKey: string; expiresTs: string | null; rootId: number | null }>> {
  const ws = eventsWs();
  const rows = await boundedOrgTxn((tx) => tx`
    SELECT event_key, expires_ts, root_id
      FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws}
       AND subscriber_id = ${subscriberId}
       AND policy = 'wake'
       AND fired_at IS NULL AND cancelled_at IS NULL
       AND event_key NOT LIKE ${INBOX_WAKE_KEY_PREFIX + '%'}
       AND (expires_ts IS NULL OR expires_ts > now())
     ORDER BY created_at DESC
     LIMIT ${limit}
  `);
  const mapped = rows.map((r: any) => ({
    eventKey: r.event_key as string,
    expiresTs: r.expires_ts ? new Date(r.expires_ts).toISOString() : null,
    rootId: r.root_id != null ? Number(r.root_id) : null,
  }));
  return withEffectiveDeadlines(mapped, { workspaceId: ws, dropExpired: true });
}

/** Active awaits matching an event key — peek without firing (sources may use
 *  this to decide whether anyone is waiting at all).
 *
 *  EI-19284963139619048: this is one of the reads `loop:status`'s wake-reachability
 *  probe runs (gate 1, "is a standing await armed"). It used to run on the plain,
 *  unbounded `getOrgPg()` admin pool like the rest of this file — a deliberate
 *  convention for most of the file's traffic, per the module header — but a stall
 *  here (lock wait / slow scan under fleet load) hung `loop:status` itself until
 *  the client's own 300s idle-timeout killed the call blind (pg-bounded-txn.ts's
 *  header documents this exact symptom class, already fixed for `work_items:comment`).
 *  boundedOrgTxn sets a real statement_timeout so a stall now fails fast + typed
 *  instead — every caller here already treats a rejection as "no live await"
 *  (fail-soft), so a timeout degrades the same way a genuine empty result would. */
export async function listActiveAwaitsForKey(eventKey: string): Promise<AwaitRow[]> {
  const ws = eventsWs();
  const rows = await boundedOrgTxn((tx) => tx`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND event_key = ${eventKey}
       AND fired_at IS NULL AND cancelled_at IS NULL
       AND policy <> 'announce'
     ORDER BY created_at ASC
  `);
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
  reason: 'event' | 'timeout' | 'claim-spec-revision' = 'event',
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

/**
 * Re-open a delivery that was optimistically marked delivered when a detached
 * `resume-headless` process spawned, but whose turn later exited non-zero.
 *
 * This is deliberately separate from {@link markDeliveryFailed}: the
 * synchronous failure path owns `delivering` rows, while this asynchronous
 * capture-and-watch path may only revise a row that is still `delivered`.
 */
export async function reopenDeliveredAfterResumeDeath(input: {
  id: number;
  error: string;
  maxAttempts: number;
  backoffMs: number;
}): Promise<'retrying' | 'dead' | 'ignored'> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ status: DeliveryStatus }>>`
    UPDATE harness_shared.event_wake_deliveries
       SET status = CASE WHEN attempts >= ${input.maxAttempts} THEN 'dead' ELSE 'pending' END,
           channel = NULL,
           delivered_at = NULL,
           coalesced_count = 1,
           last_error = ${input.error},
           next_attempt_at = CASE
             WHEN attempts >= ${input.maxAttempts} THEN next_attempt_at
             ELSE now() + make_interval(secs => ${Math.ceil(input.backoffMs / 1000)})
           END
     WHERE id = ${input.id} AND status = 'delivered'
    RETURNING status
  `;
  const status = rows[0]?.status;
  if (status === 'dead') return 'dead';
  if (status === 'pending') return 'retrying';
  return 'ignored';
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
       AND producer_health IS NULL
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING *
  `;
  return rows.map(mapAwait);
}

/** Claim due verified waits without consuming them; stale verifier leases self-heal. */
export async function claimDueVerifiedAwaits(limit = 100): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    WITH due AS (
      SELECT id
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws}
         AND timeout_behavior = 'wake'
         AND producer_health IS NOT NULL
         AND expires_ts IS NOT NULL AND expires_ts <= now()
         AND fired_at IS NULL AND cancelled_at IS NULL
         AND (verification_claimed_at IS NULL OR verification_claimed_at < now() - interval '2 minutes')
       ORDER BY expires_ts ASC
       LIMIT ${Math.min(Math.max(limit, 1), 500)}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE harness_shared.event_awaits a
       SET verification_claimed_at = now()
      FROM due
     WHERE a.id = due.id
    RETURNING a.*
  `;
  return rows.map(mapAwait);
}

/**
 * Persist a verified timeout verdict. Progress extends the same one-shot await;
 * every other classification consumes it and returns the row for wake delivery.
 */
export async function settleVerifiedAwaitTimeout(input: {
  id: number;
  result: VerifiedWaitTimeoutResult;
  nextCertificate?: ProducerHealthCertificate;
}): Promise<AwaitRow | null> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  if (input.result.classification === 'progressing') {
    if (!input.nextCertificate) throw new Error('progressing verified wait requires nextCertificate');
    await sql`
      UPDATE harness_shared.event_awaits
         SET producer_health = ${JSON.stringify(input.nextCertificate)}::text::jsonb,
             expires_ts = to_timestamp(${input.nextCertificate.verificationDeadlineMs} / 1000.0),
             timeout_verification = ${JSON.stringify(input.result)}::text::jsonb,
             verification_claimed_at = NULL
       WHERE workspace_id = ${ws} AND id = ${input.id}
         AND fired_at IS NULL AND cancelled_at IS NULL
    `;
    return null;
  }
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET fired_at = now(), fired_reason = 'verified-timeout',
           timeout_verification = ${JSON.stringify(input.result)}::text::jsonb,
           verification_claimed_at = NULL
     WHERE workspace_id = ${ws} AND id = ${input.id}
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING *
  `;
  return rows[0] ? mapAwait(rows[0]) : null;
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

/**
 * Settle PENDING/PARKED deliveries on the caller's OWN standing inbox-wake key
 * that were queued at-or-before a cutoff the caller has now read past — the
 * turn-end-settle counterpart of `ackDelivery` (EI-9389). The standing
 * inbox-wake await (`once = false`) is matched but never consumed by
 * `fireAwaitsForKey`, so every `coord:send {wake:true}` while the recipient is
 * busy queues its OWN delivery row, independent of the recipient's inbox READ
 * cursor. A later bulk `coord:inbox` read already shows all of those messages,
 * but the queued delivery rows don't know that — each still fires a full
 * (billable) resume turn once the recipient goes idle, even for traffic
 * already seen and acted on. Settling them at the server-side turn-end cursor
 * settle (`turn-end-tracking-io.ts`, the canonical "I've now seen everything up
 * to X" signal — it moved there from the retired `coord:watermark-set` under
 * plan fleet-deltas-leader-primitives-2026-07-10 D-014) closes that gap
 * the same way `ackDelivery` does for a single delivery: `delivered`,
 * channel `'coalesced'` (no turn burned, WAKE_TURN_CHANNELS-excluded), never
 * touching another subscriber's rows (subscriber_id-scoped, like ackDelivery).
 * Deliveries created AFTER the cutoff are left alone — a message that arrived
 * mid-read must still wake normally next time. Returns rows settled.
 */
export async function settleCaughtUpInboxWakeDeliveries(input: {
  subscriberId: string;
  cutoffTs: string;
}): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const key = `${INBOX_WAKE_KEY_PREFIX}${input.subscriberId}`;
  const rows = await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'delivered', channel = 'coalesced', delivered_at = now(),
           last_error = 'caught up at turn-end cursor settle — already seen in a bulk coord:inbox read (EI-9389)'
     WHERE workspace_id = ${ws} AND subscriber_id = ${input.subscriberId}
       AND event_key = ${key}
       AND status IN ('pending', 'parked')
       AND created_at <= ${input.cutoffTs}
    RETURNING id
  `;
  return rows.length;
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
  /** Optional declared completion condition, normalized by events:emit. */
  expectedCondition?: unknown | null;
  /** Seconds until the DECLARATION lapses (sweeper marks it fired_reason='expired'); null = standing. */
  expiresSec?: number | null;
}): Promise<AwaitRow> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const expiresTs = input.expiresSec != null ? new Date(Date.now() + input.expiresSec * 1000).toISOString() : null;
  // P-018: every declaration is a durable causal generation.  The advisory
  // transaction lock closes max(generation) -> insert races for the same key;
  // older rows are marked superseded instead of mutated/erased.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + input.eventKey}, 0))`;
    const generationRows = await tx`
      SELECT COALESCE(MAX(causal_generation), 0)::bigint + 1 AS next_generation
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${input.eventKey}
    `;
    const generation = Number(generationRows[0]?.next_generation ?? 1);
    await tx`
      UPDATE harness_shared.event_awaits
         SET superseded_at = COALESCE(superseded_at, now())
       WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${input.eventKey}
         AND superseded_at IS NULL
    `;
    const rows = await tx`
      INSERT INTO harness_shared.event_awaits
        (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts,
         once, min_sleep_sec, urgency, payload_filter, scope_kind, scope_ref, causal_generation,
         expected_condition)
      VALUES
        (${ws}, ${input.subscriberId}, ${input.eventKey}, 'announce', ${input.note ?? null}, NULL,
         'expire', ${expiresTs}, false, NULL, false, NULL, ${input.scopeKind}, ${input.scopeRef ?? null},
         ${generation}, ${input.expectedCondition != null ? JSON.stringify(input.expectedCondition) : null}::text::jsonb)
      RETURNING *
    `;
    return mapAwait(rows[0]);
  }) as Promise<AwaitRow>;
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
       AND cancelled_at IS NULL AND superseded_at IS NULL
     ORDER BY causal_generation DESC NULLS LAST, created_at DESC
     LIMIT 1
  `;
  return rows.map(mapAwait);
}

/** A key that nearly matches one being emitted/awaited — the advisory
 *  near-miss read (event-key-nearmiss-guard-2026-07-10 P-003). */
export interface NearMissKey {
  eventKey: string;
  kind: 'await' | 'announce';
  /** Distinct subscribers holding active rows on that key. */
  holders: number;
}

/**
 * Advisory near-miss scan: ACTIVE rows (unfired, uncancelled, non-pattern)
 * whose NORMALIZED key equals the target's but whose raw key differs — the
 * `phase3-ready` vs `phase-3-ready` drift that never rendezvouses. Bounded
 * candidate read + in-process normalize compare; callers treat any failure
 * as "no near misses" (D-001: advisory, never blocking).
 */
export async function findNearMissKeys(
  eventKey: string,
  opts?: { excludeOwner?: string },
): Promise<NearMissKey[]> {
  const target = normalizeEventKey(eventKey);
  if (!target) return [];
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT event_key, policy, subscriber_id FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND cancelled_at IS NULL AND fired_at IS NULL
       AND event_key <> ${eventKey}
       AND position('*' in event_key) = 0
     ORDER BY created_at DESC
     LIMIT 200
  `;
  const byKey = new Map<string, { kind: 'await' | 'announce'; holders: Set<string> }>();
  for (const r of rows) {
    const key = String(r.event_key);
    const sub = String(r.subscriber_id);
    if (opts?.excludeOwner && sub === opts.excludeOwner) continue;
    if (normalizeEventKey(key) !== target) continue;
    const kind: 'await' | 'announce' = String(r.policy) === 'announce' ? 'announce' : 'await';
    const cur = byKey.get(key);
    if (cur) {
      cur.holders.add(sub);
      if (kind === 'announce') cur.kind = 'announce';
    } else {
      byKey.set(key, { kind, holders: new Set([sub]) });
    }
  }
  return [...byKey.entries()]
    .slice(0, 5)
    .map(([key, v]) => ({ eventKey: key, kind: v.kind, holders: v.holders.size }));
}

/** Emit-time latch: stamp fired_at on the key's unfired announcement rows (kept,
 *  never consumed/delivered). Returns how many were latched. */
export async function stampAnnouncementsFired(
  eventKey: string,
  meta: { firedBy?: string | null; payload?: unknown } = {},
): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  // P-018: share registerAnnouncement's per-key advisory transaction lock.
  // Without this, an emit can commit a fired latch while a newer declaration
  // is between superseding the old generation and inserting its replacement.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + eventKey}, 0))`;
    const rows = await tx`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'event', fired_by = ${meta.firedBy ?? null},
             fired_payload = ${meta.payload !== undefined ? JSON.stringify(meta.payload) : null}::text::jsonb
       WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${eventKey}
         AND fired_at IS NULL AND cancelled_at IS NULL AND superseded_at IS NULL
      RETURNING id
    `;
    return rows.length;
  }) as Promise<number>;
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
       AND cancelled_at IS NULL AND superseded_at IS NULL
       AND (expires_ts IS NULL OR expires_ts > now())
       AND (${!unfiredOnly} OR fired_at IS NULL)
     ORDER BY created_at DESC
     LIMIT ${Math.min(input.limit ?? 100, 200)}
  `;
  return rows.map(mapAwait);
}

function mapKeyFire(row: any): KeyFireRow {
  return {
    workspaceId: row.workspace_id,
    eventKey: row.event_key,
    firstFiredAt: row.first_fired_at,
    lastFiredAt: row.last_fired_at,
    lastFiredBy: row.last_fired_by ?? null,
    lastPayload: row.last_payload ?? null,
    fireCount: Number(row.fire_count) || 0,
  };
}

// ── unconditional per-key fire latch (EI-13705) ─────────────────────────────
// harness_shared.event_key_fires (migration 632): ONE row per (workspace, key),
// upserted on every real emitAwaitedEvent call — independent of announce and
// independent of whether any waiter/delivery row exists to remember it by. The
// announce/waiter machinery above is fire-once (rows get consumed/superseded/
// swept), so days later "did this key ever fire" can no longer be answered from
// it; this latch is the durable, always-cheap answer.

/** Record a real fire on `eventKey` — called unconditionally from
 *  `emitAwaitedEvent`'s non-announce path, regardless of waiters/`fired.length`.
 *  Best-effort at the call site (fail-soft): never blocks or breaks an emit. */
export async function recordKeyFire(input: {
  eventKey: string;
  firedBy?: string | null;
  payload?: unknown;
}): Promise<void> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  await sql`
    INSERT INTO harness_shared.event_key_fires
      (workspace_id, event_key, first_fired_at, last_fired_at, last_fired_by, last_payload, fire_count)
    VALUES
      (${ws}, ${input.eventKey}, now(), now(), ${input.firedBy ?? null},
       ${input.payload !== undefined ? JSON.stringify(input.payload) : null}::text::jsonb, 1)
    ON CONFLICT (workspace_id, event_key) DO UPDATE
       SET last_fired_at = now(),
           last_fired_by = ${input.firedBy ?? null},
           last_payload = ${input.payload !== undefined ? JSON.stringify(input.payload) : null}::text::jsonb,
           fire_count = harness_shared.event_key_fires.fire_count + 1
  `;
}

/** The latch row for one key, or null if it has never genuinely fired. */
export async function getKeyFireLatch(eventKey: string): Promise<KeyFireRow | null> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_key_fires
     WHERE workspace_id = ${ws} AND event_key = ${eventKey}
     LIMIT 1
  `;
  return rows.length > 0 ? mapKeyFire(rows[0]) : null;
}

/**
 * EI-18676056143796303 — EMITTER EVIDENCE for the EI-10870 orphan-await guard.
 *
 * The orphan guard can only check catalog MEMBERSHIP, but it phrased its verdict
 * as knowledge about EMITTERS ("nothing in this system will ever fire it"). When a
 * family is emitted but simply never got registered in the catalog, that verdict is
 * flatly false — and it tells the agent to abandon a VALID park. The live case was
 * `coord:inbox-wake:<ownerId>`, the single most-fired key in the system and the
 * mechanism that rescues a stranded agent.
 *
 * The fire latch (`harness_shared.event_key_fires`, EI-13705) is direct evidence an
 * emitter exists: a row means the key genuinely fired at least once. This reads it
 * two ways, strongest first:
 *   - EXACT: this precise key has fired before (`release:deployed:abc123`);
 *   - PREFIX/SIBLING: some key sharing this key's first two segments has fired
 *     (`coord:inbox-wake:su-NEW` has never fired, but 118 sibling owner keys have —
 *     so the SHAPE demonstrably has an emitter, which is what the warning claims
 *     does not exist).
 *
 * A genuine orphan (the EI-10870 case: `overwatch:surface-landed`, 0 fires ever,
 * appears nowhere in the tree) matches NEITHER, so the warning still fires for the
 * keys it was built for — this only removes the false positives.
 *
 * Two segments is the family granularity every builtin template uses before its
 * first placeholder (`coord:inbox-wake`, `work-item:done`, `release:deployed`), so
 * the prefix is the family, not a loose namespace match. A key with fewer than two
 * segments probes itself exactly.
 */
export interface KeyFireEvidence {
  /** The prefix the sibling probe used (the key's first two `:` segments). */
  prefix: string;
  /** This EXACT key has fired before. */
  exact: boolean;
  /** Distinct keys sharing the prefix that have ever fired (includes the exact key). */
  distinctKeys: number;
  /** Total fires across those keys. */
  fires: number;
  /** Most recent fire across those keys, ISO-ish timestamp, or null when none. */
  lastFiredAt: string | null;
}

/** The family prefix an evidence probe uses: the key's first two `:` segments. */
export function keyFireEvidencePrefix(eventKey: string): string {
  const parts = String(eventKey ?? '').trim().split(':');
  return parts.length <= 2 ? parts.join(':') : parts.slice(0, 2).join(':');
}

/**
 * Has anything ever fired this key — or a sibling of its family? Returns
 * `fires: 0` when there is no evidence at all (the genuine-orphan case).
 * Read-only and index-backed (the latch's PK is `(workspace_id, event_key)`, so
 * the prefix scan is a btree range read).
 */
export async function probeKeyFireEvidence(eventKey: string): Promise<KeyFireEvidence> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const key = String(eventKey ?? '').trim();
  const prefix = keyFireEvidencePrefix(key);
  const empty: KeyFireEvidence = { prefix, exact: false, distinctKeys: 0, fires: 0, lastFiredAt: null };
  if (!prefix) return empty;
  // `prefix` is a literal key segment, never a caller-supplied LIKE pattern —
  // escape the wildcards anyway so a key containing `%`/`_` cannot widen the scan.
  const escaped = prefix.replace(/([\\%_])/g, '\\$1');
  const rows = await sql`
    SELECT count(*)::int                                             AS distinct_keys,
           coalesce(sum(fire_count), 0)::bigint                      AS fires,
           max(last_fired_at)                                        AS last_fired_at,
           bool_or(event_key = ${key})                               AS exact
      FROM harness_shared.event_key_fires
     WHERE workspace_id = ${ws}
       AND (event_key = ${prefix} OR event_key LIKE ${`${escaped}:%`} ESCAPE '\\')
  `;
  const row = rows[0];
  if (!row) return empty;
  return {
    prefix,
    exact: row.exact === true,
    distinctKeys: Number(row.distinct_keys) || 0,
    fires: Number(row.fires) || 0,
    lastFiredAt: row.last_fired_at ? String(row.last_fired_at) : null,
  };
}

/**
 * EI-19332682533219755 — what a PATTERN await will ACTUALLY match, from observed
 * history rather than from the author's mental model of their own glob.
 *
 * The incident: an agent parked on `release:green:*` expecting "the gate went
 * green". It fired `satisfied: true` carrying `pipeline: "oddsmith"` — a
 * DIFFERENT project co-hosted on this box, whose sha is not even an object in
 * this repository. `*` is a plain glob over the rest of the key, and the pipeline
 * is a key SEGMENT (`release:green:<pipeline>`), so on a multi-pipeline host the
 * "obvious generalisation" of the catalogued template silently becomes a
 * CROSS-PROJECT subscription. Every affordance then reads as success: the key
 * family is literally named `release:green`, the wake says `satisfied: true`, and
 * the documented next step after green is to SHIP. Nothing in the wake discloses
 * that the pipeline is foreign — the incident was caught only by hand-checking
 * the sha against the repo.
 *
 * The glob is not broken; it does exactly what a glob does. What was missing is
 * DISCLOSURE, so this answers the one question the author cannot answer from the
 * pattern alone: which concrete keys does this actually cover? Purely
 * observational — it never narrows or rejects an await (a coordination primitive
 * the fleet parks on must not start dropping wakes to fix a reporting gap).
 *
 * Read-only and index-backed: the latch's PK is `(workspace_id, event_key)`, so
 * an anchored prefix is a btree range read. Bounded by `limit` in every branch —
 * a glob with no anchorable prefix (`*:papercusp`) degrades to a bounded
 * recency-ordered scan rather than an unbounded one.
 */
export interface PatternMatchScope {
  /** The literal prefix the scan anchored on; `''` when the glob leads with a wildcard. */
  prefix: string;
  /** Distinct concrete keys already observed that this pattern WOULD match, most-recent first. */
  matchedKeys: string[];
  /** The scan hit its row cap, so `matchedKeys` may be incomplete. */
  truncated: boolean;
}

export async function probePatternMatchScope(
  glob: string,
  opts?: { limit?: number },
): Promise<PatternMatchScope> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const pattern = String(glob ?? '').trim();
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 200));
  const prefix = patternLiteralPrefix(pattern);
  const empty: PatternMatchScope = { prefix, matchedKeys: [], truncated: false };
  if (!pattern.includes('*')) return empty;

  // `prefix` is derived from literal key text, never a caller-supplied LIKE
  // pattern — escape the wildcards anyway so a key containing `%`/`_` cannot
  // widen the scan (same defence as probeKeyFireEvidence).
  const rows = prefix
    ? await sql`
        SELECT event_key
          FROM harness_shared.event_key_fires
         WHERE workspace_id = ${ws}
           AND (event_key = ${prefix} OR event_key LIKE ${`${prefix.replace(/([\\%_])/g, '\\$1')}:%`} ESCAPE '\\')
         ORDER BY last_fired_at DESC
         LIMIT ${limit}
      `
    : await sql`
        SELECT event_key
          FROM harness_shared.event_key_fires
         WHERE workspace_id = ${ws}
         ORDER BY last_fired_at DESC
         LIMIT ${limit}
      `;

  // Narrow with the EXACT matcher the fire path uses, so this can never claim a
  // key that would not really wake the caller (or miss one that would).
  const matchedKeys: string[] = [];
  for (const r of rows) {
    const key = typeof r?.event_key === 'string' ? r.event_key : null;
    if (key && keyMatchesPattern(pattern, key)) matchedKeys.push(key);
  }
  return { prefix, matchedKeys, truncated: rows.length >= limit };
}

/** Exact-key event history for events:status.  One call returns declarations,
 * waiter registrations, wake outcomes, and the unconditional fire latch so an
 * agent does not have to stitch four partially ordered surfaces together by
 * hand. */
export async function inspectEventKey(eventKey: string): Promise<{
  announcements: AwaitRow[];
  waiters: AwaitRow[];
  deliveries: DeliveryRow[];
  fireLatch: KeyFireRow | null;
}> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  return sql.begin(async (tx) => {
    const announcementRows = await tx`
      SELECT * FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws} AND event_key = ${eventKey} AND policy = 'announce'
       ORDER BY causal_generation DESC NULLS LAST, created_at DESC
       LIMIT 50
    `;
    const waiterRows = await tx`
      SELECT * FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws} AND event_key = ${eventKey} AND policy <> 'announce'
       ORDER BY created_at DESC
       LIMIT 200
    `;
    const deliveryRows = await tx`
      SELECT * FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${ws} AND event_key = ${eventKey}
       ORDER BY created_at DESC
       LIMIT 200
    `;
    const fireLatchRows = await tx`
      SELECT * FROM harness_shared.event_key_fires
       WHERE workspace_id = ${ws} AND event_key = ${eventKey}
       LIMIT 1
    `;
    return {
      announcements: announcementRows.map(mapAwait),
      waiters: waiterRows.map(mapAwait),
      deliveries: deliveryRows.map(mapDelivery),
      fireLatch: fireLatchRows.length > 0 ? mapKeyFire(fireLatchRows[0]) : null,
    };
  }) as Promise<{ announcements: AwaitRow[]; waiters: AwaitRow[]; deliveries: DeliveryRow[]; fireLatch: KeyFireRow | null }>;
}
