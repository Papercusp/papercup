/**
 * consult-expiry-core.ts — the consult LIFECYCLE expiry sweep (plan
 * get-feedback-relevance-consults-2026-08-16, P-005; D-005), cascade-aware
 * since consult-min-max-and-rubric-vetting-2026-08-17 P-013.
 *
 * A past-due OPEN consult_state row (expires_at < now, closed_at IS NULL) is a
 * CHAIN EVENT, not automatically a terminal state (D-005 always-advance): when
 * the routing selection menu still has a next selectee, the sweep ADVANCES the
 * cascade — the silent responder's expiry is appended to the digest and the
 * next selectee is woken (via `reach`) with the question + the feedback so far,
 * under a fresh latency-contract window. Only when the menu is exhausted (or
 * the row never selected anyone) does the row terminally flip to
 * state='expired' + closed_at.
 *
 * The park-key emit mirrors decline semantics: a MID-CHAIN expiry does not
 * wake a hard-blocked parked requester (more feedback is still coming); only
 * the TERMINAL expiry emits the latched `consult:reply:<conversation_id>` key
 * — the requester parked on it (P-003 returns it; get-feedback-core parks
 * hard-blocked callers on exactly it) would otherwise sleep until their
 * await's own timeout. Terminal 'proceed' rows get no emit: the requester is
 * already proceeding and reconciles by reading state='expired'.
 *
 * Concurrency: no FOR UPDATE — advanceCascade's CAS guard (cursor unchanged +
 * row still open) and the guarded terminal flip make a raced row a clean
 * no-op here; the concurrent winner (a reply/decline verb, or another tick)
 * already did the advance. A backlog deeper than the bound drains over
 * successive ticks, riding migration 834's partial index
 * (consult_state_expiry_idx: expires_at IS NOT NULL AND closed_at IS NULL).
 *
 * Core/binding split mirrors get-feedback-core.ts: pure logic behind injected
 * deps (sql, emitReplyEvent, reach) so it integration-tests against the real
 * 834/844 tables; the prod binding is the `system:consult-expiry-sweep`
 * ephemeral routine action (harness/routines/consult-expiry-action.ts), which
 * MUST pass `reach` (notifyAgents under a per-row workspace system identity)
 * or mid-chain advances silently stop waking anyone.
 */
import type { Sql } from 'postgres';
import { consultParkKey } from './get-feedback-core';
import { advanceCascade, digestFromRow, makeDigestEntry } from './cascade-core';

/** Rows processed per tick — bounds one sweep's write + wake fan-out. A backlog
 * deeper than this simply drains over successive ticks. */
export const EXPIRY_SWEEP_LIMIT = 200;

/** A due row with the cascade columns the advance decision needs (844). */
export interface DueConsultRow {
  workspace_id: string;
  conversation_id: string;
  requester_id: string;
  responder_id: string | null;
  state: string;
  is_due: boolean;
  /** PostgreSQL returns timestamptz as Date under the normal postgres-js client. */
  updated_at: unknown;
  latency_contract: string;
  question: string;
  routing: unknown;
  cascade_cursor: number;
  cascade_digest: unknown;
}

/** Row-local evidence for a responder that woke after routing, re-parked, and
 * left the consult thread empty. `routedAt` is the current selection timestamp
 * (`updated_at`), not the whole-consult `created_at`. */
export interface SilentResponderCandidate {
  workspaceId: string;
  conversationId: string;
  responderId: string;
  routedAt: string;
}

export interface ExpirySweepDeps {
  getSql: () => Sql;
  /** Latched `consult:reply:<conv>` emit → the (possibly parked) requester.
   * Prod binds emitAwaitedEvent per-row-workspace; best-effort there. */
  emitReplyEvent: (input: {
    key: string;
    summary: string;
    payload: Record<string, unknown>;
    to: string[];
    workspaceId: string;
  }) => Promise<void>;
  /** D-005 cascade advance: wake the next selectee (prod binds notifyAgents —
   * subscribe + ping + wake — under a per-row workspace system identity;
   * consult_state is workspace-partitioned and ONE sweep serves them all, so
   * the workspace rides on each call rather than on the binding's scope).
   * Absent ⇒ the advance still happens (cursor/responder/digest move) but
   * nobody is woken — tests only; prod MUST bind it. */
  reach?: (opts: {
    responder: string;
    conversationId: string;
    summary: string;
    body: string;
    workspaceId: string;
  }) => Promise<{ woke: number }>;
  /** EI-20864690354207496 refill-exhaustion revival (per-row workspace, like
   * reach): carry-respawn a dead above-floor candidate when a due row's
   * cascade exhausts below selection.min with no live untried candidate left.
   * Prod binds the WI-39852 reviver; cascade-core enforces the persisted
   * one-per-consult budget. Absent ⇒ terminal expiry with the honest
   * under-filled label. */
  revive?: (opts: {
    ownerId: string;
    conversationId: string;
    brief: string;
    workspaceId: string;
  }) => Promise<{ spawned: boolean; verified: boolean | null; detail: string }>;
  /** Optional bounded detector for a responder that became active after
   * routing, re-parked, and left the row-workspace thread empty. Detector
   * failures fail closed for this early leg; due rows retain normal expiry. */
  findSilentResponders?: (
    rows: readonly SilentResponderCandidate[],
  ) => Promise<ReadonlySet<string>>;
  now?: () => Date;
  /** Override the per-tick bound (tests). */
  limit?: number;
}

export interface ExpirySweepResult {
  ok: true;
  /** Rows terminally flipped to 'expired' this tick (cascade menu exhausted,
   * or the row never selected anyone). */
  expired: number;
  /** Rows ADVANCED to the next selectee instead of expiring (D-005). */
  advanced: number;
  /** Conversation ids whose hard-blocked park key was emitted (terminal only —
   * a mid-chain advance never wakes the parked requester). */
  woke: string[];
  /** True when the tick hit the bound — more due rows likely remain. */
  saturated: boolean;
}

export async function sweepExpiredConsults(deps: ExpirySweepDeps): Promise<ExpirySweepResult> {
  const sql = deps.getSql();
  const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
  const limit = deps.limit ?? EXPIRY_SWEEP_LIMIT;

  // Read the due rows WITH their cascade columns — the advance-vs-expire
  // branch is per row, so the bulk single-statement flip is gone. The CAS
  // guards below stand in for row locks (see module doc).
  const due = (await sql`
    SELECT workspace_id, conversation_id, requester_id, responder_id,
           state, COALESCE(expires_at < ${nowIso}::timestamptz, false) AS is_due,
           updated_at, latency_contract, question, routing, cascade_cursor, cascade_digest
      FROM harness_shared.consult_state
     WHERE closed_at IS NULL
       AND (
         expires_at < ${nowIso}::timestamptz
         OR (state = 'awaiting_responder' AND responder_id IS NOT NULL)
       )
     ORDER BY expires_at
     LIMIT ${limit}
  `) as unknown as DueConsultRow[];

  // One bounded detector call covers every non-due awaiting row in this tick.
  // The detector receives each row's workspace because this sweep is shared
  // across workspaces; a failure fails closed for the early leg only.
  let silentResponderIds = new Set<string>();
  const earlyCandidates = due
    .filter((row) => row.is_due !== true && row.state === 'awaiting_responder' && row.responder_id != null)
    .map((row) => ({
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      responderId: row.responder_id!,
      routedAt: timestampToIso(row.updated_at),
    }));
  if (deps.findSilentResponders && earlyCandidates.length > 0) {
    try {
      silentResponderIds = new Set(await deps.findSilentResponders(earlyCandidates));
    } catch {
      silentResponderIds = new Set<string>();
    }
  }

  let advanced = 0;
  let expiredCount = 0;
  const woke: string[] = [];
  for (const row of due) {
    const isDue = row.is_due === true;
    const isSilentEarlyRow =
      !isDue && row.state === 'awaiting_responder' && row.responder_id != null && silentResponderIds.has(row.conversation_id);
    if (!isDue && !isSilentEarlyRow) continue;

    // Best-effort per row: one bad row (malformed routing jsonb, a wake seam
    // throwing) must not strand the rest of the batch.
    try {
      const adv = await advanceCascade(
        {
          workspaceId: row.workspace_id,
          conversationId: row.conversation_id,
          question: row.question,
          latencyContract: row.latency_contract,
          requesterId: row.requester_id,
          routing: row.routing,
          cascadeCursor: row.cascade_cursor,
          digest: row.cascade_digest,
          event: makeDigestEntry(
            row.responder_id ?? '(unrouted)',
            isDue ? 'expired' : 'wake_failed',
            nowIso,
            isDue
              ? `expired unanswered (${row.latency_contract} window elapsed)`
              : 'responder went active after routing, re-parked without posting (implicit decline)',
          ),
          stateOnAdvance: 'awaiting_responder',
          nowIso,
        },
        sql,
        deps.reach
          ? (opts) => deps.reach!({ ...opts, workspaceId: row.workspace_id })
          : undefined,
        deps.revive
          ? (opts) => deps.revive!({ ...opts, workspaceId: row.workspace_id })
          : undefined,
      );
      if (adv.raced) continue; // a verb / concurrent tick won — nothing to do
      if (adv.advanced) {
        advanced += 1;
        continue;
      }
    } catch {
      continue;
    }

    // Menu exhausted → terminal expire. Guarded like the advance: a concurrent
    // close between the digest write and this flip turns it into a no-op.
    //
    // WI-39862 honest expiry (EI-20824019943814803): "expired" used to conflate
    // "nobody answered" with "the cascade ended after collecting real answers".
    // Count substantive ANSWERS from the row's own digest (the pre-advance
    // in-memory copy — the final selectee's 'expired' event that advanceCascade
    // appended is kind 'expired', so it never inflates this): with ≥1 answer the
    // row still flips state='expired' (no enum widening) but its outcome
    // records an answered-flavored disposition, and the requester may still
    // record a real disposition late via consult:close (consult-verbs-core's
    // late-close gate).
    const priorDigest = digestFromRow(row.cascade_digest);
    const answerEvents = priorDigest.filter((e) => e.kind === 'answer');
    const answers = answerEvents.length;
    const answeredBy = [...new Set(answerEvents.map((e) => e.ownerId))];
    // The fine-grained terminal flip and its coarse parent projection are one
    // transaction. Otherwise a crash between these writes leaves the exact
    // split this sweep exists to repair: consult_state='expired' while
    // conversations:get/list still report state='open'. The parent predicate
    // is deliberately narrow: this row's workspace/id and consult kind must
    // match, and only an open parent may be projected. A concurrent typed close
    // or other terminal lifecycle is never overwritten.
    const flipped = await sql.begin(async (tx) => {
      const terminal = (await tx`
        UPDATE harness_shared.consult_state
           SET state = 'expired',
               outcome = COALESCE(${
                 answers > 0
                   ? tx.json({
                       disposition: 'cascade_exhausted_with_answers',
                       answers,
                       answered_by: answeredBy,
                     } as never)
                   : null
               }::jsonb, outcome),
               closed_at = ${nowIso}::timestamptz,
               updated_at = ${nowIso}::timestamptz
         WHERE workspace_id = ${row.workspace_id}
           AND conversation_id = ${row.conversation_id}
           AND closed_at IS NULL
        RETURNING conversation_id
      `) as unknown as Array<{ conversation_id: string }>;
      if (terminal.length === 0) return terminal;

      await tx`
        UPDATE harness_shared.coord_conversations c
           SET state = 'expired',
               updated_at = GREATEST(c.updated_at, ${nowIso}::timestamptz)
         WHERE c.workspace_id = ${row.workspace_id}
           AND c.id = ${row.conversation_id}
           AND c.kind = 'consult'
           AND c.state = 'open'
           AND EXISTS (
             SELECT 1
               FROM harness_shared.consult_state cs
              WHERE cs.workspace_id = c.workspace_id
                AND cs.conversation_id = c.id
                AND cs.state = 'expired'
           )
      `;
      return terminal;
    }) as unknown as Array<{ conversation_id: string }>;
    if (flipped.length === 0) continue;
    expiredCount += 1;

    // Wake the hard-blocked parked requester (the emit LATCHES, so a requester
    // who re-registers after the fire is told immediately). Best-effort: the
    // row is already flipped; the requester's own await timeout is the backstop.
    if (row.latency_contract !== 'hard-blocked') continue;
    try {
      await deps.emitReplyEvent({
        key: consultParkKey(row.conversation_id),
        summary:
          answers > 0
            ? `consult ${row.conversation_id}: cascade exhausted with ${answers} answer(s) collected — NOT unanswered; review the thread and record your disposition with consult:close`
            : `consult ${row.conversation_id}: EXPIRED unanswered (hard-blocked contract, cascade exhausted) — proceed on your own judgment`,
        payload: {
          conversation_id: row.conversation_id,
          responder: row.responder_id,
          kind: 'expired',
          ...(answers > 0 ? { answers } : {}),
        },
        to: [row.requester_id],
        workspaceId: row.workspace_id,
      });
      woke.push(row.conversation_id);
    } catch {
      // See best-effort note above.
    }
  }

  // Rows admitted solely for the early detector can fill the bound after all
  // due rows have drained. Report saturation only when the last admitted row
  // is itself due; otherwise the ordering guarantees no older due row was
  // hidden behind a non-due row.
  return {
    ok: true,
    expired: expiredCount,
    advanced,
    woke,
    saturated: due.length >= limit && due[limit - 1]?.is_due === true,
  };
}

function timestampToIso(value: unknown): string {
  if (value == null) return '';
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}
