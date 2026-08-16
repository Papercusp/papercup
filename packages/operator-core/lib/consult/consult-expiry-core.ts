/**
 * consult-expiry-core.ts — the consult LIFECYCLE expiry sweep (plan
 * get-feedback-relevance-consults-2026-08-16, P-005; D-005).
 *
 * Flips past-due OPEN consult_state rows (expires_at < now, closed_at IS NULL)
 * to state='expired' + closed_at, bounded per tick, riding migration 834's
 * partial index (consult_state_expiry_idx: expires_at IS NOT NULL AND
 * closed_at IS NULL). For every expired row whose latency_contract is
 * 'hard-blocked' it EMITS the latched `consult:reply:<conversation_id>` park
 * key with an expired payload — the requester parked on that key (P-003
 * returns it; get-feedback-core parks hard-blocked callers on exactly it)
 * would otherwise sleep until their await's own timeout. 'proceed' rows get
 * no emit: the requester is already proceeding and reconciles by reading
 * state='expired'.
 *
 * Core/binding split mirrors get-feedback-core.ts: pure logic behind injected
 * deps (sql, emitReplyEvent) so it integration-tests against the real 834
 * tables; the prod binding is the `system:consult-expiry-sweep` ephemeral
 * routine action (harness/routines/consult-expiry-action.ts).
 */
import type { Sql } from 'postgres';
import { consultParkKey } from './get-feedback-core';

/** Rows flipped per tick — bounds one sweep's write + emit fan-out. A backlog
 * deeper than this simply drains over successive ticks. */
export const EXPIRY_SWEEP_LIMIT = 200;

export interface ExpiredConsultRow {
  workspace_id: string;
  conversation_id: string;
  requester_id: string;
  responder_id: string | null;
  latency_contract: string;
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
  now?: () => Date;
  /** Override the per-tick bound (tests). */
  limit?: number;
}

export interface ExpirySweepResult {
  ok: true;
  /** Rows flipped to 'expired' this tick. */
  expired: number;
  /** Conversation ids whose hard-blocked park key was emitted. */
  woke: string[];
  /** True when the tick hit the bound — more due rows likely remain. */
  saturated: boolean;
}

export async function sweepExpiredConsults(deps: ExpirySweepDeps): Promise<ExpirySweepResult> {
  const sql = deps.getSql();
  const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
  const limit = deps.limit ?? EXPIRY_SWEEP_LIMIT;

  // Bounded flip: the `due` CTE scans the partial expiry index; SKIP LOCKED
  // keeps concurrent ticks (or a verb closing the same consult mid-sweep)
  // from serializing on each other — a skipped row is the next tick's work.
  const expired = (await sql`
    WITH due AS (
      SELECT workspace_id, conversation_id
        FROM harness_shared.consult_state
       WHERE expires_at < ${nowIso}::timestamptz AND closed_at IS NULL
       ORDER BY expires_at
       LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
    )
    UPDATE harness_shared.consult_state c
       SET state = 'expired',
           closed_at = ${nowIso}::timestamptz,
           updated_at = ${nowIso}::timestamptz
      FROM due
     WHERE c.workspace_id = due.workspace_id
       AND c.conversation_id = due.conversation_id
    RETURNING c.workspace_id, c.conversation_id, c.requester_id, c.responder_id,
              c.latency_contract
  `) as unknown as ExpiredConsultRow[];

  // Wake the hard-blocked parked requesters (the emit LATCHES, so a requester
  // who re-registers after the fire is told immediately). Best-effort per row:
  // one failed emit must not strand the rest of the batch's wakes.
  const woke: string[] = [];
  for (const row of expired) {
    if (row.latency_contract !== 'hard-blocked') continue;
    try {
      await deps.emitReplyEvent({
        key: consultParkKey(row.conversation_id),
        summary: `consult ${row.conversation_id}: EXPIRED unanswered (hard-blocked contract) — proceed on your own judgment`,
        payload: {
          conversation_id: row.conversation_id,
          responder: row.responder_id,
          kind: 'expired',
        },
        to: [row.requester_id],
        workspaceId: row.workspace_id,
      });
      woke.push(row.conversation_id);
    } catch {
      // Row already flipped; the requester's own await timeout is the backstop.
    }
  }

  return { ok: true, expired: expired.length, woke, saturated: expired.length >= limit };
}
