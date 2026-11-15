/**
 * fanout-deliveries — the per-subscriber fan-out delivery ledger
 * (shared-reference-system-2026-11-13 P-003, design D-030; migration 1639).
 *
 * The substrate_outbox drain fans one captured change out to every subscriber of
 * the changed object (fanout-projection.ts). A delivery that did not durably land
 * is recorded HERE, per subscriber, instead of on the outbox row:
 *
 *  - One subscriber's failure never costs another subscriber its delivery: the
 *    fan-out loop records the failure and moves on (R-9), and a retry re-delivers
 *    only the ledger rows still pending, never the whole fan-out (R-35).
 *  - Retries back off (fanoutRetryDelayMs) with NO attempt cap (R-9). At the
 *    FANOUT_MAX_ATTEMPTS-th unsuccessful attempt exactly one persistent-failure
 *    work-item is filed, keyed fanout-persistent:<subscriber>:outbox:<id>, and
 *    retries continue (R-27). The finding_ref column makes the filing one-shot.
 *  - The route follows the subscription's remaining reasons (P-002, D-029):
 *    explicit / blocker / contextual follows go back to the INBOX (R-26: the
 *    follower's first input of its next session flushes them); a follow held
 *    only by `held_item` goes to ITEM-READ: it is never pushed, and the
 *    follower's next read of that item carries it (R-33).
 *  - A context end with no other reason left fails the row (R-25).
 *  - A newer durable write for the same (subscriber, object) supersedes older
 *    pending rows in the SAME statement as that write (D-024).
 *
 * "Delivered" is derived, never written by the fan-out (R-24):
 * `readFanoutDeliveryState` reports `delivered` only once the recipient's
 * committed inbox read cursor (two-phase, ack-on-proof; read-cursors.ts) covers
 * the notification, or once an item read carried it.
 *
 * Every function takes an optional `sql` / `workspaceId` so the integration test
 * drives it against a throwaway database; production uses getOrgPg() and the
 * coord workspace, the same pool and scope coord_event_log is written through.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { resolvedSubscriberTarget, type ObjectRef, type ResolvedSubscriber } from '@papercusp/coordination/capabilities';
import { coordScopeWorkspace } from '../../agent-tools/coordination/log';
import { buildInjectEnvelope, type InjectEvent } from '../../agent-tools/coordination/fanout-delivery';

/** Base delay before the first fan-out retry; doubles per failed attempt. */
export const FANOUT_RETRY_BASE_MS = 30_000;
/** Cap on a single fan-out retry delay. */
export const FANOUT_RETRY_MAX_DELAY_MS = 60 * 60_000;
/** Unsuccessful attempts (first try included) at which the persistent-failure
 *  finding is filed (R-27). It is a filing threshold only: retries continue. */
export const FANOUT_MAX_ATTEMPTS = 8;
/** Rows one retry sweep handles. */
export const FANOUT_RETRY_BATCH = 25;
/** How long a claimed row stays out of other sweeps while it is attempted. */
export const FANOUT_CLAIM_LEASE_MS = 120_000;
const FANOUT_ERROR_MAX_CHARS = 2_000;

/** Delay before the retry that follows the given number of failed attempts. */
export function fanoutRetryDelayMs(failedAttempts: number): number {
  const exp = Math.max(0, failedAttempts - 1);
  return Math.min(FANOUT_RETRY_BASE_MS * 2 ** exp, FANOUT_RETRY_MAX_DELAY_MS);
}

export type FanoutRoute = 'inbox' | 'item-read';
export type FanoutLedgerState = 'pending' | 'written' | 'failed' | 'superseded';
/** The single delivery-state surface tests and tools read (R-24). */
export type FanoutDeliveryState = 'none' | FanoutLedgerState | 'delivered';
/** Outcome of one durable write attempt. `not-pending`: a ledger retry whose row
 *  was superseded or failed before it was attempted, so nothing was written. */
export type FanoutWriteOutcome = 'written' | 'duplicate' | 'subscription-gone' | 'not-pending';

/** What a retry needs to rebuild the notification (a retry stamps a fresh ts). */
export interface FanoutDeliveryPayload {
  sub: ResolvedSubscriber;
  ev: InjectEvent;
}

export interface FanoutLedgerOpts {
  sql?: Sql;
  workspaceId?: string;
  /** Epoch ms; defaults to Date.now(). */
  now?: number;
}

/** Files the R-27 persistent-failure work-item and returns its id. */
export type FanoutFindingFiler = (input: {
  watchdogKey: string;
  subscriberId: string;
  outboxId: string;
  attempts: number;
  lastError: string | null;
  object: ObjectRef;
}) => Promise<string | null>;

function sqlOf(opts: FanoutLedgerOpts): Sql {
  return opts.sql ?? (getOrgPg().sql as unknown as Sql);
}

function wsOf(opts: FanoutLedgerOpts): string {
  return opts.workspaceId ?? coordScopeWorkspace();
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, FANOUT_ERROR_MAX_CHARS);
}

/** The deterministic notification id every write of this delivery uses (mig 126). */
export function fanoutMsgId(outboxId: string, subscriberId: string): string {
  return `fan-${outboxId}-${subscriberId}`;
}

/** The R-27 finding key (D-024): notification id = outbox:<outbox_id>. */
export function persistentFindingKey(subscriberId: string, outboxId: string): string {
  return `fanout-persistent:${subscriberId}:outbox:${outboxId}`;
}

/**
 * Route by the subscription's remaining reasons (D-030 #5). A follow held only by
 * `held_item` (context aside, which ends with the context) is delivered on the
 * follower's next read of the item; every other follow goes to the inbox. A
 * legacy row with no recorded reasons is treated as explicit (migration 1638).
 */
export function routeForReasons(reasons: readonly string[] | null | undefined): FanoutRoute {
  if (reasons == null) return 'inbox';
  const durable = reasons.filter((r) => r !== 'context');
  return durable.length > 0 && durable.every((r) => r === 'held_item') ? 'item-read' : 'inbox';
}

/**
 * Write one fan-out notification durably, in ONE statement:
 *  1. re-check the subscription is live (FOR SHARE, so a concurrent cancel
 *     serializes with this write — P-002 / R-8);
 *  2. with `requirePending`, also lock the ledger row and require it pending, so
 *     a retry never writes a notification that was superseded or failed;
 *  3. insert into coord_event_log with the deterministic msg_id (dedupe, mig 126);
 *  4. mark this delivery's ledger row written;
 *  5. supersede older pending rows for the same (subscriber, object) — only when
 *     THIS statement inserted, so a newer delivery that is not durable supersedes
 *     nothing (D-024).
 */
export async function writeFanoutNotify(
  input: { outboxId: string; sub: ResolvedSubscriber; ev: InjectEvent; object: ObjectRef; requirePending?: boolean },
  opts: FanoutLedgerOpts = {},
): Promise<FanoutWriteOutcome> {
  const sql = sqlOf(opts);
  const ws = wsOf(opts);
  const { outboxId, sub, ev, object } = input;
  const requirePending = input.requirePending === true;
  const msgId = fanoutMsgId(outboxId, sub.subscriber_id);
  const env = buildInjectEnvelope(sub, ev, msgId);
  const { targetKind, targetRef } = resolvedSubscriberTarget(object, sub);
  const rows = await sql<{ inserted: number; prior: number; live: number; pend: number }[]>`
    WITH live AS (
      SELECT s.id FROM harness_shared.coord_entity_subscriptions AS s
       WHERE s.workspace_id = ${ws} AND s.subscriber_id = ${sub.subscriber_id}
         AND s.target_kind = ${targetKind} AND s.target_ref = ${targetRef}
         AND s.cancelled_at IS NULL AND (s.expires_ts IS NULL OR s.expires_ts > now())
       LIMIT 1
       FOR SHARE),
    pend AS (
      SELECT d.outbox_id FROM harness_shared.substrate_fanout_deliveries AS d
       WHERE d.workspace_id = ${ws} AND d.outbox_id = ${outboxId}::bigint
         AND d.subscriber_id = ${sub.subscriber_id} AND d.state = 'pending'
       FOR UPDATE),
    ins AS (
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body)
      SELECT ${ws}, 'messages', ${sub.subscriber_id}, ${msgId}, ${JSON.stringify(env)}::text::jsonb
       WHERE EXISTS (SELECT 1 FROM live)
         AND (NOT ${requirePending}::boolean OR EXISTS (SELECT 1 FROM pend))
      ON CONFLICT (workspace_id, msg_id) WHERE (surface = 'messages' AND (body ->> 'notify_kind') IS NOT NULL)
      DO NOTHING
      RETURNING id),
    prior AS (
      SELECT e.id FROM harness_shared.coord_event_log AS e
       WHERE e.workspace_id = ${ws} AND e.msg_id = ${msgId}
         AND e.surface = 'messages' AND (e.body ->> 'notify_kind') IS NOT NULL
       LIMIT 1),
    own AS (
      UPDATE harness_shared.substrate_fanout_deliveries AS d
         SET state = 'written', next_retry_at = NULL, last_error = NULL, updated_at = now()
       WHERE d.workspace_id = ${ws} AND d.outbox_id = ${outboxId}::bigint
         AND d.subscriber_id = ${sub.subscriber_id} AND d.state = 'pending'
         AND (EXISTS (SELECT 1 FROM ins) OR EXISTS (SELECT 1 FROM prior))
      RETURNING 1),
    sup AS (
      UPDATE harness_shared.substrate_fanout_deliveries AS d
         SET state = 'superseded', superseded_by_outbox_id = ${outboxId}::bigint,
             next_retry_at = NULL, updated_at = now()
       WHERE d.workspace_id = ${ws} AND d.subscriber_id = ${sub.subscriber_id}
         AND d.object_kind = ${object.kind} AND d.object_ref = ${object.ref}
         AND d.state = 'pending' AND d.outbox_id < ${outboxId}::bigint
         AND EXISTS (SELECT 1 FROM ins)
      RETURNING 1)
    SELECT (SELECT count(*) FROM ins)::int AS inserted,
           (SELECT count(*) FROM prior)::int AS prior,
           (SELECT count(*) FROM live)::int AS live,
           (SELECT count(*) FROM pend)::int AS pend,
           (SELECT count(*) FROM own)::int AS own,
           (SELECT count(*) FROM sup)::int AS superseded`;
  const r = rows[0];
  if (requirePending && Number(r?.pend ?? 0) === 0) return 'not-pending';
  if (Number(r?.inserted ?? 0) > 0) return 'written';
  if (Number(r?.prior ?? 0) > 0) return 'duplicate';
  if (Number(r?.live ?? 0) === 0) return 'subscription-gone';
  // Live, no insert and no visible prior row: a concurrent writer inserted the
  // same msg_id after this statement's snapshot. The notification exists.
  return 'duplicate';
}

interface LedgerKey {
  ws: string;
  outboxId: string;
  subscriberId: string;
}

async function markFailed(sql: Sql, key: LedgerKey, reason: string): Promise<void> {
  await sql`
    UPDATE harness_shared.substrate_fanout_deliveries
       SET state = 'failed', end_reason = ${reason}, next_retry_at = NULL, updated_at = now()
     WHERE workspace_id = ${key.ws} AND outbox_id = ${key.outboxId}::bigint
       AND subscriber_id = ${key.subscriberId} AND state = 'pending'`;
}

let defaultFilerImpl: FanoutFindingFiler | null = null;

/** Production R-27 filer: the shared dedupe-keyed improvement capture. */
const defaultFiler: FanoutFindingFiler = async (input) => {
  if (defaultFilerImpl) return defaultFilerImpl(input);
  const { captureImprovement } = await import('../../harness/improvements/capture-core');
  const r = await captureImprovement({
    title: `Fan-out notification to ${input.subscriberId} has failed ${input.attempts} times (outbox row ${input.outboxId})`,
    kind: 'bug',
    severity: 'major',
    body: [
      `The substrate fan-out could not deliver the notification for ${input.object.kind}:${input.object.ref} ` +
        `(outbox row ${input.outboxId}) to ${input.subscriberId} after ${input.attempts} attempts. Retries continue ` +
        `with backoff; this finding is filed once (shared-reference-system-2026-11-13 R-27).`,
      `Last error: ${input.lastError ?? 'unknown'}`,
      `Inspect: SELECT * FROM harness_shared.substrate_fanout_deliveries WHERE outbox_id = ${input.outboxId} AND subscriber_id = '${input.subscriberId}'.`,
    ].join('\n'),
    watchdogKey: input.watchdogKey,
    scope: 'harness:papercusp',
    sourceRole: 'system',
    filedByRole: 'fanout-retry',
    createdBy: 'system:fanout-retry',
    paths: ['packages/operator-core/lib/sync/hyperbee/fanout-deliveries.ts'],
  });
  const res = r as { issue?: { id?: string }; coalescedOnto?: { id?: string } };
  return res.issue?.id ?? res.coalescedOnto?.id ?? null;
};

/** Test seam: replace the production filer (null restores it). */
export function configureFanoutFindingFiler(filer: FanoutFindingFiler | null): void {
  defaultFilerImpl = filer;
}

/**
 * File the R-27 finding once a delivery reaches FANOUT_MAX_ATTEMPTS unsuccessful
 * attempts. One-shot by construction: the finding is filed only while the row's
 * finding_ref is NULL, and the ref is written back conditionally, so it is never
 * filed twice for the same (outbox row, subscriber) whatever state it later takes.
 */
async function maybeFilePersistentFinding(
  sql: Sql,
  key: LedgerKey,
  row: { attempts: number; finding_ref: string | null; last_error: string | null; object: ObjectRef },
  filer: FanoutFindingFiler | undefined,
): Promise<string | null> {
  if (row.finding_ref || row.attempts < FANOUT_MAX_ATTEMPTS) return row.finding_ref;
  const watchdogKey = persistentFindingKey(key.subscriberId, key.outboxId);
  // Claim the filing first so two concurrent sweeps cannot both file.
  const claimed = await sql<{ outbox_id: string }[]>`
    UPDATE harness_shared.substrate_fanout_deliveries
       SET finding_ref = ${`filing:${watchdogKey}`}, updated_at = now()
     WHERE workspace_id = ${key.ws} AND outbox_id = ${key.outboxId}::bigint
       AND subscriber_id = ${key.subscriberId} AND finding_ref IS NULL
    RETURNING outbox_id`;
  if (claimed.length === 0) return null;
  let ref: string | null = null;
  try {
    ref = await (filer ?? defaultFiler)({
      watchdogKey,
      subscriberId: key.subscriberId,
      outboxId: key.outboxId,
      attempts: row.attempts,
      lastError: row.last_error,
      object: row.object,
    });
  } catch (e) {
    // Release the claim so the next unsuccessful attempt files it.
    await sql`
      UPDATE harness_shared.substrate_fanout_deliveries SET finding_ref = NULL
       WHERE workspace_id = ${key.ws} AND outbox_id = ${key.outboxId}::bigint
         AND subscriber_id = ${key.subscriberId} AND finding_ref = ${`filing:${watchdogKey}`}`;
    console.error(`[fanout-deliveries] R-27 finding for ${watchdogKey} could not be filed (retried next attempt): ${errorText(e)}`);
    return null;
  }
  const finalRef = ref ?? watchdogKey;
  await sql`
    UPDATE harness_shared.substrate_fanout_deliveries SET finding_ref = ${finalRef}, updated_at = now()
     WHERE workspace_id = ${key.ws} AND outbox_id = ${key.outboxId}::bigint
       AND subscriber_id = ${key.subscriberId} AND finding_ref = ${`filing:${watchdogKey}`}`;
  return finalRef;
}

async function liveReasons(
  sql: Sql,
  ws: string,
  subscriberId: string,
  targetKind: string,
  targetRef: string,
): Promise<{ live: boolean; reasons: string[] | null }> {
  const rows = await sql<{ reasons: string[] | null }[]>`
    SELECT s.reasons FROM harness_shared.coord_entity_subscriptions AS s
     WHERE s.workspace_id = ${ws} AND s.subscriber_id = ${subscriberId}
       AND s.target_kind = ${targetKind} AND s.target_ref = ${targetRef}
       AND s.cancelled_at IS NULL AND (s.expires_ts IS NULL OR s.expires_ts > now())
     LIMIT 1`;
  return rows.length === 0 ? { live: false, reasons: null } : { live: true, reasons: rows[0].reasons ?? null };
}

/**
 * Record one subscriber's failed delivery (first pass, or a whole-row re-run after
 * a resolve-stage failure). Inserts the pending ledger row, or counts another
 * unsuccessful attempt on an existing pending one, and files the R-27 finding at
 * the threshold. Throws when the ledger itself cannot be written, so the caller
 * keeps the outbox row's own retry state and nothing is lost.
 */
export async function recordFanoutFailure(
  input: { outboxId: string; sub: ResolvedSubscriber; ev: InjectEvent; object: ObjectRef; error: unknown },
  opts: FanoutLedgerOpts & { fileFinding?: FanoutFindingFiler } = {},
): Promise<{ attempts: number; route: FanoutRoute }> {
  const sql = sqlOf(opts);
  const ws = wsOf(opts);
  const now = opts.now ?? Date.now();
  const { outboxId, sub, ev, object } = input;
  const { targetKind, targetRef } = resolvedSubscriberTarget(object, sub);
  const { reasons } = await liveReasons(sql, ws, sub.subscriber_id, targetKind, targetRef);
  const route = routeForReasons(reasons);
  const lastError = errorText(input.error);
  const payload: FanoutDeliveryPayload = { sub, ev };
  // An item-read row is never pushed; the sweep only re-evaluates its route
  // (a later explicit follow moves it to the inbox) at the longest interval.
  const firstRetryAt = route === 'item-read' ? now + FANOUT_RETRY_MAX_DELAY_MS : now + fanoutRetryDelayMs(1);
  const rows = await sql<{ attempts: number; finding_ref: string | null; state: string }[]>`
    INSERT INTO harness_shared.substrate_fanout_deliveries AS d
      (workspace_id, outbox_id, subscriber_id, msg_id, object_kind, object_ref, target_kind, target_ref,
       delivery, route, state, attempts, next_retry_at, last_error)
    VALUES (${ws}, ${outboxId}::bigint, ${sub.subscriber_id}, ${fanoutMsgId(outboxId, sub.subscriber_id)},
            ${object.kind}, ${object.ref}, ${targetKind}, ${targetRef},
            ${JSON.stringify(payload)}::text::jsonb, ${route}, 'pending', 1, ${firstRetryAt}, ${lastError})
    ON CONFLICT (workspace_id, outbox_id, subscriber_id) DO UPDATE
       SET attempts = d.attempts + 1,
           route = EXCLUDED.route,
           next_retry_at = CASE WHEN EXCLUDED.route = 'item-read' THEN ${now + FANOUT_RETRY_MAX_DELAY_MS}::bigint
                                ELSE ${now}::bigint + LEAST(${FANOUT_RETRY_BASE_MS}::bigint * power(2, d.attempts)::bigint,
                                                            ${FANOUT_RETRY_MAX_DELAY_MS}::bigint) END,
           last_error = EXCLUDED.last_error,
           updated_at = now()
     WHERE d.state = 'pending'
    RETURNING d.attempts, d.finding_ref, d.state`;
  const row = rows[0];
  const attempts = Number(row?.attempts ?? 1);
  if (row) {
    await maybeFilePersistentFinding(
      sql,
      { ws, outboxId, subscriberId: sub.subscriber_id },
      { attempts, finding_ref: row.finding_ref, last_error: lastError, object },
      opts.fileFinding,
    );
  }
  return { attempts, route };
}

export interface FanoutDeliveryRetryResult {
  claimed: number;
  written: number;
  /** Rows still pending after an unsuccessful attempt. */
  rescheduled: number;
  /** Rows failed because their subscription ended (R-25). */
  failed: number;
  /** Rows routed to item-read (held-item-only follow): not pushed. */
  parked: number;
  /** Rows superseded or failed after the claim, before the attempt. */
  skipped: number;
  findingsFiled: number;
}

interface ClaimedRow {
  outbox_id: string;
  subscriber_id: string;
  object_kind: string;
  object_ref: string;
  target_kind: string;
  target_ref: string;
  delivery: FanoutDeliveryPayload | string;
  route: FanoutRoute;
  attempts: number;
  finding_ref: string | null;
  last_error: string | null;
  live: boolean;
  reasons: string[] | null;
}

function parsePayload(v: FanoutDeliveryPayload | string): FanoutDeliveryPayload {
  return typeof v === 'string' ? (JSON.parse(v) as FanoutDeliveryPayload) : v;
}

/**
 * The retry sweep (R-9): re-deliver ONLY this ledger's due pending rows (R-35),
 * independently of federation, oldest due first and newest first per
 * (subscriber, object) so a durable newer write supersedes an older one before
 * it is attempted. Claims with FOR UPDATE SKIP LOCKED plus a short lease, so any
 * number of concurrent drain loops can run it safely. No attempt cap.
 *
 * `subscriberId` + `ignoreSchedule` is the first-input flush (R-26): every
 * pending inbox row of one subscriber, due or not.
 */
export async function retryPendingFanoutDeliveries(
  opts: FanoutLedgerOpts & {
    batch?: number;
    fileFinding?: FanoutFindingFiler;
    signal?: AbortSignal;
    subscriberId?: string;
    ignoreSchedule?: boolean;
  } = {},
): Promise<FanoutDeliveryRetryResult> {
  const sql = sqlOf(opts);
  const ws = wsOf(opts);
  const now = opts.now ?? Date.now();
  const batch = Math.max(1, opts.batch ?? FANOUT_RETRY_BATCH);
  const result: FanoutDeliveryRetryResult = { claimed: 0, written: 0, rescheduled: 0, failed: 0, parked: 0, skipped: 0, findingsFiled: 0 };
  const subscriberId = opts.subscriberId ?? null;
  const ignoreSchedule = opts.ignoreSchedule === true;
  const claimed = await sql<ClaimedRow[]>`
    WITH due AS (
      SELECT d.workspace_id, d.outbox_id, d.subscriber_id
        FROM harness_shared.substrate_fanout_deliveries AS d
       WHERE d.workspace_id = ${ws} AND d.state = 'pending'
         AND (${subscriberId}::text IS NULL OR d.subscriber_id = ${subscriberId}::text)
         AND (${ignoreSchedule}::boolean AND d.route = 'inbox' OR d.next_retry_at <= ${now}::bigint)
       ORDER BY d.next_retry_at, d.outbox_id DESC
       LIMIT ${batch}
       FOR UPDATE SKIP LOCKED)
    UPDATE harness_shared.substrate_fanout_deliveries AS d
       SET next_retry_at = ${now + FANOUT_CLAIM_LEASE_MS}::bigint, updated_at = now()
      FROM due
     WHERE d.workspace_id = due.workspace_id AND d.outbox_id = due.outbox_id AND d.subscriber_id = due.subscriber_id
    RETURNING d.outbox_id::text AS outbox_id, d.subscriber_id, d.object_kind, d.object_ref, d.target_kind, d.target_ref,
              d.delivery, d.route, d.attempts, d.finding_ref, d.last_error,
              EXISTS (
                SELECT 1 FROM harness_shared.coord_entity_subscriptions AS s
                 WHERE s.workspace_id = d.workspace_id AND s.subscriber_id = d.subscriber_id
                   AND s.target_kind = d.target_kind AND s.target_ref = d.target_ref
                   AND s.cancelled_at IS NULL AND (s.expires_ts IS NULL OR s.expires_ts > now())) AS live,
              (SELECT s.reasons FROM harness_shared.coord_entity_subscriptions AS s
                WHERE s.workspace_id = d.workspace_id AND s.subscriber_id = d.subscriber_id
                  AND s.target_kind = d.target_kind AND s.target_ref = d.target_ref
                  AND s.cancelled_at IS NULL AND (s.expires_ts IS NULL OR s.expires_ts > now())
                LIMIT 1) AS reasons`;
  result.claimed = claimed.length;
  // Newest first, so a durable newer write supersedes older rows of the same
  // (subscriber, object) before they are attempted.
  const ordered = [...claimed].sort((a, b) => {
    const x = BigInt(a.outbox_id);
    const y = BigInt(b.outbox_id);
    return x === y ? 0 : x > y ? -1 : 1;
  });
  for (const row of ordered) {
    if (opts.signal?.aborted) break;
    const key: LedgerKey = { ws, outboxId: row.outbox_id, subscriberId: row.subscriber_id };
    const object: ObjectRef = { kind: row.object_kind, ref: row.object_ref };
    try {
      if (!row.live) {
        await markFailed(sql, key, 'subscription-gone');
        result.failed += 1;
        continue;
      }
      const route = routeForReasons(row.reasons);
      if (route === 'item-read') {
        await sql`
          UPDATE harness_shared.substrate_fanout_deliveries
             SET route = 'item-read', next_retry_at = ${now + FANOUT_RETRY_MAX_DELAY_MS}::bigint, updated_at = now()
           WHERE workspace_id = ${ws} AND outbox_id = ${row.outbox_id}::bigint
             AND subscriber_id = ${row.subscriber_id} AND state = 'pending'`;
        result.parked += 1;
        continue;
      }
      const { sub, ev } = parsePayload(row.delivery);
      let outcome: FanoutWriteOutcome;
      try {
        outcome = await writeFanoutNotify({ outboxId: row.outbox_id, sub, ev, object, requirePending: true }, { sql, workspaceId: ws });
      } catch (e) {
        const lastError = errorText(e);
        const attempts = Number(row.attempts ?? 0) + 1;
        const up = await sql<{ attempts: number; finding_ref: string | null }[]>`
          UPDATE harness_shared.substrate_fanout_deliveries
             SET attempts = ${attempts}, route = 'inbox', last_error = ${lastError},
                 next_retry_at = ${now + fanoutRetryDelayMs(attempts)}::bigint, updated_at = now()
           WHERE workspace_id = ${ws} AND outbox_id = ${row.outbox_id}::bigint
             AND subscriber_id = ${row.subscriber_id} AND state = 'pending'
          RETURNING attempts, finding_ref`;
        result.rescheduled += 1;
        if (up[0]) {
          const ref = await maybeFilePersistentFinding(
            sql,
            key,
            { attempts: Number(up[0].attempts), finding_ref: up[0].finding_ref, last_error: lastError, object },
            opts.fileFinding,
          );
          if (ref && !up[0].finding_ref) result.findingsFiled += 1;
        }
        continue;
      }
      if (outcome === 'written' || outcome === 'duplicate') result.written += 1;
      else if (outcome === 'subscription-gone') {
        await markFailed(sql, key, 'subscription-gone');
        result.failed += 1;
      } else result.skipped += 1;
    } catch (e) {
      // A ledger write failed: the row keeps its lease-advanced next_retry_at and
      // comes due again after the lease. Never thrown, so one row cannot stall
      // the sweep or the drain pass that runs it.
      console.error(`[fanout-deliveries] retry of outbox row ${row.outbox_id} → ${row.subscriber_id} failed: ${errorText(e)}`);
    }
  }
  return result;
}

/** R-26: deliver every pending inbox notification of one subscriber now. Called
 *  on the first input of a session, before that input's inbox is read. */
export async function flushSubscriberFanout(
  subscriberId: string,
  opts: FanoutLedgerOpts & { batch?: number; fileFinding?: FanoutFindingFiler } = {},
): Promise<FanoutDeliveryRetryResult> {
  return retryPendingFanoutDeliveries({ ...opts, subscriberId, ignoreSchedule: true });
}

export interface ItemReadNotification {
  msgId: string;
  outboxId: string;
  subject: string;
  summary: string;
  notifyKind: string;
  object: ObjectRef;
  recordedAt: string;
}

/**
 * R-33: the follower's read of an item carries that item's pending held-item
 * notifications for that reader, and moves them to written (read_at stamps the
 * read that carried them, which is what makes them delivered). Only the reader's
 * own rows: another reader of the item receives nothing from this.
 */
export async function claimPendingItemReadDeliveries(
  input: { readerId: string; itemId: string },
  opts: FanoutLedgerOpts = {},
): Promise<ItemReadNotification[]> {
  const sql = sqlOf(opts);
  const ws = wsOf(opts);
  if (!input.readerId?.trim() || !input.itemId?.trim()) return [];
  const rows = await sql<{ outbox_id: string; msg_id: string; object_kind: string; object_ref: string; delivery: FanoutDeliveryPayload | string; created_at: Date }[]>`
    UPDATE harness_shared.substrate_fanout_deliveries
       SET state = 'written', read_at = now(), next_retry_at = NULL, updated_at = now()
     WHERE workspace_id = ${ws} AND subscriber_id = ${input.readerId} AND state = 'pending'
       AND route = 'item-read' AND object_ref = ${input.itemId}
    RETURNING outbox_id::text AS outbox_id, msg_id, object_kind, object_ref, delivery, created_at`;
  return rows
    .map((r) => {
      const { ev } = parsePayload(r.delivery);
      return {
        msgId: r.msg_id,
        outboxId: r.outbox_id,
        subject: ev.subject,
        summary: ev.summary,
        notifyKind: ev.notify_kind,
        object: { kind: r.object_kind, ref: r.object_ref },
        recordedAt: new Date(r.created_at).toISOString(),
      };
    })
    .sort((a, b) => (BigInt(a.outboxId) < BigInt(b.outboxId) ? -1 : 1));
}

/**
 * R-25: when a subscriber's context ends (any R-8 end event, via
 * endSubscriberContexts), fail its pending rows whose subscription is no longer
 * live — i.e. the context was the last reason holding it. A row whose
 * subscription survives (explicit, held-item, blocker, or a context re-added in
 * the new epoch) keeps retrying.
 */
export async function failEndedContextDeliveries(
  input: { subscriberId: string; cause: string },
  opts: FanoutLedgerOpts = {},
): Promise<number> {
  const sql = sqlOf(opts);
  const ws = wsOf(opts);
  const rows = await sql<{ outbox_id: string }[]>`
    UPDATE harness_shared.substrate_fanout_deliveries AS d
       SET state = 'failed', end_reason = ${`context-ended:${input.cause}`}, next_retry_at = NULL, updated_at = now()
     WHERE d.workspace_id = ${ws} AND d.subscriber_id = ${input.subscriberId} AND d.state = 'pending'
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.coord_entity_subscriptions AS s
          WHERE s.workspace_id = d.workspace_id AND s.subscriber_id = d.subscriber_id
            AND s.target_kind = d.target_kind AND s.target_ref = d.target_ref
            AND s.cancelled_at IS NULL AND (s.expires_ts IS NULL OR s.expires_ts > now()))
    RETURNING d.outbox_id::text AS outbox_id`;
  return rows.length;
}

/**
 * THE delivery-state reader (R-24). `delivered` is derived:
 *  - inbox route: the coord_event_log row exists AND the recipient's committed
 *    inbox read cursor (promoted only on the recipient's NEXT input, ack-on-proof)
 *    covers its timestamp — a written but not yet carried row is `written`;
 *  - item-read route: a read carried it (read_at set).
 * A pending, failed or superseded ledger row reports that state.
 */
export async function readFanoutDeliveryState(
  input: { outboxId: string; subscriberId: string },
  opts: FanoutLedgerOpts = {},
): Promise<FanoutDeliveryState> {
  const sql = sqlOf(opts);
  const ws = wsOf(opts);
  const msgId = fanoutMsgId(input.outboxId, input.subscriberId);
  const rows = await sql<{ state: FanoutLedgerState | null; route: FanoutRoute | null; read_at: Date | null; logged: boolean; covered: boolean }[]>`
    SELECT d.state, d.route, d.read_at,
           (e.id IS NOT NULL) AS logged,
           COALESCE((e.body ->> 'ts')::timestamptz <= (c.committed ->> 'since_ts')::timestamptz, false) AS covered
      FROM (SELECT 1) AS one
      LEFT JOIN harness_shared.substrate_fanout_deliveries AS d
        ON d.workspace_id = ${ws} AND d.outbox_id = ${input.outboxId}::bigint AND d.subscriber_id = ${input.subscriberId}
      LEFT JOIN LATERAL (
        SELECT e.id, e.body FROM harness_shared.coord_event_log AS e
         WHERE e.workspace_id = ${ws} AND e.msg_id = ${msgId} AND e.surface = 'messages'
         LIMIT 1) AS e ON true
      LEFT JOIN harness_shared.coord_read_cursors AS c
        ON c.workspace_id = ${ws} AND c.owner_id = ${input.subscriberId} AND c.surface = 'inbox'`;
  const r = rows[0];
  if (!r) return 'none';
  if (r.state === 'pending' || r.state === 'failed' || r.state === 'superseded') return r.state;
  if (r.state === 'written' && r.route === 'item-read') return r.read_at ? 'delivered' : 'written';
  if (r.logged) return r.covered ? 'delivered' : 'written';
  return r.state ?? 'none';
}
