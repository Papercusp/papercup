/**
 * consult-verbs-core.ts — the responder-side consult workflow (plan
 * get-feedback-relevance-consults-2026-08-16, P-004; decisions D-001/D-004/
 * D-005/D-007/D-008). Core/binding split mirrors get-feedback-core.ts: ALL
 * verb logic lives here behind injected deps (sql, post, emitReplyEvent,
 * reach) so it is integration-tested against the real migration-834 tables
 * without the prod singletons; the consult:reply / consult:decline /
 * consult:close tools (agent-tools/consult/*.ts) bind the prod seams.
 *
 * The enforcement chokepoint (D-008 §2): each verb VALIDATES {kind, caps,
 * budget} against consult_state, then WRITES THROUGH into the existing
 * conversation thread via deps.post (bound to conversations.postReply with
 * the internal via_consult_verb flag — the appendPost kind gate refuses every
 * untyped route), stamping consult_post_meta with the post's typed overlay.
 *
 * What this module OWNS:
 *  - KIND RULES (D-001): responder posts ∈ {answer, clarifying_question,
 *    new_fact}; requester follow-ups ∈ {question, new_fact}. A post that is
 *    neither a question nor a new fact has no valid kind — termination is
 *    structural, the enum IS the rule. An answer REQUIRES evidence (D-004:
 *    answers cite transcript refs — that is the grounding enforcement).
 *  - THE EXCHANGE CAP: exchanges_used debits per reply; at the cap a reply is
 *    refused with the close-with-what-you-have nudge (D-001). decline/close
 *    are terminal moves and stay available AT the cap — that is the point.
 *  - STATE TRANSITIONS: awaiting_responder→active (first responder post);
 *    active→declined (decline w/ reason; remaining candidates from the
 *    routing snapshot feed the D-007(7) manual cascade);
 *    active→closed_answered|closed_cant_help (close w/ structured outcome —
 *    the outcome column comment is the authority). Sweeps to expired /
 *    graduated are P-005's, not here.
 *  - THE PARK-KEY EMIT (D-005/D-008): every responder post (reply, decline,
 *    close) emits the latched `consult:reply:<conversation_id>` event to the
 *    requester — the hard-blocked requester's park key (P-003 returns it).
 *  - THE WAKE BUDGET on requester follow-ups (D-005): aggregate wakes_used
 *    over origin_task_ref (same aggregation as get-feedback-core); exhausted
 *    ⇒ the follow-up still posts + delivers by subscription, it just does
 *    not wake the responder. Debited ON THE ATTEMPT.
 */
import type { Sql } from 'postgres';
import type { PostResult } from '../agent-tools/coordination/conversations-core';
import { DEAD_RESPONDER_STATES, consultParkKey as parkKey } from './get-feedback-core';

export const RESPONDER_REPLY_KINDS = ['answer', 'clarifying_question', 'new_fact'] as const;
export const REQUESTER_REPLY_KINDS = ['question', 'new_fact'] as const;
export type ConsultReplyKind = 'question' | 'answer' | 'clarifying_question' | 'new_fact';

export interface ConsultEvidenceRef {
  session_id: string;
  turn_idx: number;
  note?: string;
}

/** consult_state columns the verbs read (migration 834). */
interface ConsultStateRow {
  workspace_id: string;
  conversation_id: string;
  requester_id: string;
  responder_id: string | null;
  state: string;
  question: string;
  latency_contract: string;
  max_exchanges: number;
  exchanges_used: number;
  wake_budget: number;
  wakes_used: number;
  origin_task_ref: string | null;
  routing: unknown;
  outcome: unknown;
  closed_at: string | null;
}

/** Routing-snapshot candidate shape (consult_state.routing column comment). */
interface SnapshotCandidate {
  ownerId: string;
  score: number;
  liveness?: string;
}

export interface ConsultVerbDeps {
  getSql: () => Sql;
  /** Write-through into the conversation thread — bound to
   * conversations.postReply WITH via_consult_verb (the kind-gate opt-in). */
  post: (input: {
    conversation_id: string;
    body: string;
    mentions?: string[];
    via_consult_verb: true;
  }) => Promise<PostResult | { error: string }>;
  /** Latched `consult:reply:<conv>` emit → the (possibly parked) requester.
   * Prod binds emitAwaitedEvent; best-effort there (never breaks the verb). */
  emitReplyEvent: (input: {
    key: string;
    summary: string;
    payload: Record<string, unknown>;
    to: string[];
  }) => Promise<void>;
  /** Directed ping + wake (requester follow-up → responder), bound to
   * notifyAgents in prod. Absent ⇒ deliver-by-subscription only, no wake. */
  reach?: (opts: {
    responder: string;
    conversationId: string;
    summary: string;
    body: string;
  }) => Promise<{ woke: number }>;
  /** P-005 graduation (D-004): mint the shared work item a 'graduate' close
   * hands off to — bound in prod (consult:close) to createWorkItem +
   * subscribe-both-participants + a rel:'relates' link to the conversation.
   * Optional because only the close verb needs it; a graduate close without
   * it is refused structurally (graduate_unavailable). */
  mintGraduationWorkItem?: (input: {
    workspaceId: string;
    conversationId: string;
    question: string;
    requesterId: string;
    responderId: string | null;
    closedBy: string;
    reason: string;
  }) => Promise<{ id: string }>;
  now?: () => Date;
}

export type ConsultVerbError =
  | { error: 'not_a_consult' }
  | { error: 'not_a_participant' }
  | { error: 'not_the_responder' }
  | { error: 'consult_not_open'; state: string; hint: string }
  | { error: 'invalid_kind'; role: 'requester' | 'responder'; allowed: readonly string[]; hint: string }
  | { error: 'evidence_required'; hint: string }
  | { error: 'exchange_cap'; exchanges_used: number; max_exchanges: number; hint: string }
  | { error: 'answer_required' }
  | { error: 'reason_required' }
  | { error: 'post_failed'; cause: string }
  | { error: 'graduate_unavailable'; hint: string }
  | { error: 'graduate_failed'; cause: string };

const POSTABLE_STATES = new Set(['awaiting_responder', 'active']);

function oneLine(s: string, n = 96): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

async function readState(
  sql: Sql,
  workspaceId: string,
  conversationId: string,
): Promise<ConsultStateRow | null> {
  const rows = (await sql`
    SELECT workspace_id, conversation_id, requester_id, responder_id, state,
           question, latency_contract, max_exchanges, exchanges_used, wake_budget,
           wakes_used, origin_task_ref, routing, outcome, closed_at
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
  `) as unknown as ConsultStateRow[];
  return rows[0] ?? null;
}

/** The routing snapshot's qualified-but-not-chosen menu after a decline —
 * decliner excluded, route-time-dead candidates filtered (D-007(7)). The
 * driver may hand jsonb back unparsed; normalize before reading. */
function remainingFromSnapshot(routing: unknown, excludeOwnerId: string): Array<{ ownerId: string; score: number; liveness: string }> {
  const snap = typeof routing === 'string' ? (JSON.parse(routing) as unknown) : routing;
  const candidates = (snap as { candidates?: SnapshotCandidate[] } | null)?.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((c) => c && typeof c.ownerId === 'string' && c.ownerId !== excludeOwnerId)
    .filter((c) => !DEAD_RESPONDER_STATES.has(c.liveness ?? ''))
    .map((c) => ({ ownerId: c.ownerId, score: c.score, liveness: c.liveness ?? 'unknown' }));
}

function gateCommon(
  row: ConsultStateRow | null,
): ConsultVerbError | { row: ConsultStateRow } {
  if (!row) return { error: 'not_a_consult' };
  if (!POSTABLE_STATES.has(row.state)) {
    return {
      error: 'consult_not_open',
      state: row.state,
      hint:
        row.state === 'declined'
          ? 'This consult was declined — re-call consult:get_feedback with exclude:[the decliner] for the manual cascade.'
          : `This consult is '${row.state}' and takes no further posts.`,
    };
  }
  return { row };
}

// ── consult:reply ────────────────────────────────────────────────────────────

export interface ConsultReplyRequest {
  workspaceId: string;
  authorId: string;
  conversationId: string;
  kind: ConsultReplyKind;
  body: string;
  evidence?: ConsultEvidenceRef[];
}

export interface ConsultReplyResult {
  ok: true;
  post_id: number;
  role: 'requester' | 'responder';
  state: string;
  exchanges_used: number;
  max_exchanges: number;
  /** Present on a requester follow-up (the D-005 budget report). */
  wake?: {
    attempted: boolean;
    woke: number;
    budget_exhausted: boolean;
    wakes_used_for_task: number;
    wake_budget: number;
  };
  hint: string;
}

export async function consultReplyCore(
  req: ConsultReplyRequest,
  deps: ConsultVerbDeps,
): Promise<ConsultReplyResult | ConsultVerbError> {
  const sql = deps.getSql();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  const gated = gateCommon(await readState(sql, req.workspaceId, req.conversationId));
  if ('error' in gated) return gated;
  const row = gated.row;

  if (req.authorId !== row.responder_id && req.authorId !== row.requester_id) {
    return { error: 'not_a_participant' };
  }
  const role: 'requester' | 'responder' = req.authorId === row.responder_id ? 'responder' : 'requester';

  // Kind rules (D-001): the enum is the structural termination — untyped prose
  // ("ok thanks") has no valid kind and cannot enter the thread.
  const allowed: readonly string[] = role === 'responder' ? RESPONDER_REPLY_KINDS : REQUESTER_REPLY_KINDS;
  if (!allowed.includes(req.kind)) {
    return {
      error: 'invalid_kind',
      role,
      allowed,
      hint: `A ${role} reply must be one of {${allowed.join(', ')}}. To end the consult, use consult:close (structured outcome) or consult:decline (responder).`,
    };
  }
  // D-004 grounding: an answer cites transcript evidence, always.
  if (req.kind === 'answer' && !(req.evidence && req.evidence.length > 0)) {
    return {
      error: 'evidence_required',
      hint: 'kind=answer requires evidence: [{ session_id, turn_idx, note? }] — cite the transcript turns the answer rests on (sessions:read resolves them).',
    };
  }
  // The exchange cap (D-001): a reply past the cap is refused; close/decline stay open.
  if (row.exchanges_used + 1 > row.max_exchanges) {
    return {
      error: 'exchange_cap',
      exchanges_used: row.exchanges_used,
      max_exchanges: row.max_exchanges,
      hint: `Exchange cap reached (${row.exchanges_used}/${row.max_exchanges}) — close with what you have (consult:close { outcome: 'answered' | 'cant_help' }), or if you are both still deliberating, graduate it: consult:close { outcome: 'graduate', reason } mints a shared work item that carries the question forward (D-004).`,
    };
  }

  // Wake budget (D-005) — requester follow-ups only. Same aggregation as
  // get-feedback-core: SUM(wakes_used) over consults sharing origin_task_ref;
  // no ref ⇒ nothing to aggregate ⇒ the wake is allowed.
  let usedForTask = 0;
  let budgetExhausted = false;
  const wantWake = role === 'requester' && row.responder_id != null && Boolean(deps.reach);
  if (wantWake && row.origin_task_ref) {
    const rows = (await sql`
      SELECT COALESCE(SUM(wakes_used), 0)::int AS used
        FROM harness_shared.consult_state
       WHERE workspace_id = ${req.workspaceId} AND origin_task_ref = ${row.origin_task_ref}
    `) as unknown as Array<{ used: number }>;
    usedForTask = rows[0]?.used ?? 0;
    budgetExhausted = usedForTask >= row.wake_budget;
  }
  const willWake = wantWake && !budgetExhausted;

  // Write-through: post (the substrate commit) → meta overlay → state debit.
  // Sequential by house style (no txn across the substrate binding); the meta
  // INSERT lands only after the post committed, so an orphan meta row is
  // impossible — the reverse (post without meta) is the crash window and is
  // repaired by P-006 backfill semantics.
  const posted = await deps.post({ conversation_id: req.conversationId, body: req.body, via_consult_verb: true });
  if ('error' in posted) return { error: 'post_failed', cause: posted.error };
  const postId = posted.post.id;

  await sql`
    INSERT INTO harness_shared.consult_post_meta
      (workspace_id, post_id, conversation_id, author_id, kind, evidence)
    VALUES
      (${req.workspaceId}, ${postId}, ${req.conversationId}, ${req.authorId},
       ${req.kind}, ${req.evidence ? JSON.stringify(req.evidence) : null}::jsonb)
  `;

  const nextState = role === 'responder' && row.state === 'awaiting_responder' ? 'active' : row.state;
  const exchangesUsed = row.exchanges_used + 1;
  await sql`
    UPDATE harness_shared.consult_state
       SET state = ${nextState},
           exchanges_used = ${exchangesUsed},
           wakes_used = wakes_used + ${willWake ? 1 : 0},
           updated_at = ${now}::timestamptz
     WHERE workspace_id = ${req.workspaceId} AND conversation_id = ${req.conversationId}
  `;

  // The park-key emit (D-005/D-008): every responder post signals the requester
  // — a hard-blocked requester parked on the latched key wakes NOW.
  if (role === 'responder') {
    await deps.emitReplyEvent({
      key: parkKey(req.conversationId),
      summary: `consult ${req.conversationId}: ${req.kind} from ${req.authorId} — ${oneLine(req.body)}`,
      payload: { conversation_id: req.conversationId, responder: req.authorId, kind: req.kind, post_id: postId },
      to: [row.requester_id],
    });
  }

  let woke = 0;
  if (willWake && deps.reach && row.responder_id) {
    const r = await deps.reach({
      responder: row.responder_id,
      conversationId: req.conversationId,
      summary: `🧭 consult follow-up from ${req.authorId}: ${oneLine(req.body, 72)}`,
      body: `Follow-up (${req.kind}) on consult ${req.conversationId} (exchange ${exchangesUsed}/${row.max_exchanges}). Reply with consult:reply, or close with consult:close.`,
    });
    woke = r.woke;
  }

  const capNow = exchangesUsed >= row.max_exchanges;
  const hint =
    role === 'responder'
      ? capNow
        ? `Posted (exchange ${exchangesUsed}/${row.max_exchanges} — cap reached). Further replies are refused; settle with consult:close { outcome: 'answered' | 'cant_help' } — or still deliberating? consult:close { outcome: 'graduate', reason } mints a shared work item that carries it forward (D-004).`
        : req.kind === 'answer'
          ? `Answer posted (exchange ${exchangesUsed}/${row.max_exchanges}); the requester was signaled via ${parkKey(req.conversationId)}. When the thread is settled, close it: consult:close { outcome: 'answered' }.`
          : `Posted (exchange ${exchangesUsed}/${row.max_exchanges}); the requester was signaled via ${parkKey(req.conversationId)}.`
      : budgetExhausted
        ? `Follow-up posted (exchange ${exchangesUsed}/${row.max_exchanges}) but the wake budget for ${row.origin_task_ref} is exhausted (${usedForTask}/${row.wake_budget}) — delivered by subscription only; the responder sees it on their next turn.`
        : `Follow-up posted (exchange ${exchangesUsed}/${row.max_exchanges})${willWake ? `; responder ${woke > 0 ? 'woken' : 'pinged'}` : ''}.`;

  return {
    ok: true,
    post_id: postId,
    role,
    state: nextState,
    exchanges_used: exchangesUsed,
    max_exchanges: row.max_exchanges,
    ...(role === 'requester'
      ? {
          wake: {
            attempted: willWake,
            woke,
            budget_exhausted: budgetExhausted,
            wakes_used_for_task: usedForTask + (willWake ? 1 : 0),
            wake_budget: row.wake_budget,
          },
        }
      : {}),
    hint,
  };
}

// ── consult:decline ──────────────────────────────────────────────────────────

export interface ConsultDeclineRequest {
  workspaceId: string;
  authorId: string;
  conversationId: string;
  reason: string;
}

export interface ConsultDeclineResult {
  ok: true;
  post_id: number;
  state: 'declined';
  /** The D-007(7) manual-cascade menu — from the persisted routing snapshot,
   * decliner excluded, route-time-dead filtered. */
  remaining_candidates: Array<{ ownerId: string; score: number; liveness: string }>;
  hint: string;
}

export async function consultDeclineCore(
  req: ConsultDeclineRequest,
  deps: ConsultVerbDeps,
): Promise<ConsultDeclineResult | ConsultVerbError> {
  const sql = deps.getSql();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  const gated = gateCommon(await readState(sql, req.workspaceId, req.conversationId));
  if ('error' in gated) return gated;
  const row = gated.row;

  if (req.authorId !== row.responder_id) return { error: 'not_the_responder' };
  const reason = req.reason.trim();
  if (!reason) return { error: 'reason_required' };

  const posted = await deps.post({
    conversation_id: req.conversationId,
    body: `Declined: ${reason}`,
    via_consult_verb: true,
  });
  if ('error' in posted) return { error: 'post_failed', cause: posted.error };
  const postId = posted.post.id;

  await sql`
    INSERT INTO harness_shared.consult_post_meta
      (workspace_id, post_id, conversation_id, author_id, kind, evidence)
    VALUES (${req.workspaceId}, ${postId}, ${req.conversationId}, ${req.authorId}, 'decline', NULL)
  `;
  await sql`
    UPDATE harness_shared.consult_state
       SET state = 'declined',
           outcome = ${JSON.stringify({ reason })}::jsonb,
           closed_at = ${now}::timestamptz,
           updated_at = ${now}::timestamptz
     WHERE workspace_id = ${req.workspaceId} AND conversation_id = ${req.conversationId}
  `;

  // A decline IS the reply a parked requester is waiting for — emit the key.
  await deps.emitReplyEvent({
    key: parkKey(req.conversationId),
    summary: `consult ${req.conversationId}: declined by ${req.authorId} — ${oneLine(reason)}`,
    payload: { conversation_id: req.conversationId, responder: req.authorId, kind: 'decline', post_id: postId },
    to: [row.requester_id],
  });

  const remaining = remainingFromSnapshot(row.routing, req.authorId);
  return {
    ok: true,
    post_id: postId,
    state: 'declined',
    remaining_candidates: remaining,
    hint: remaining.length
      ? `Declined. The requester can cascade manually: consult:get_feedback with exclude:['${req.authorId}'] — next candidates: ${remaining
          .slice(0, 3)
          .map((c) => c.ownerId)
          .join(', ')}.`
      : `Declined. No further route-time candidates remain — the requester proceeds on their own judgment.`,
  };
}

// ── consult:close ────────────────────────────────────────────────────────────

export interface ConsultCloseRequest {
  workspaceId: string;
  authorId: string;
  conversationId: string;
  /** 'graduate' (P-005, D-004): the consult outgrew its bounds (canonically:
   * cap hit while still deliberating) — closes as state='graduated' and mints
   * a shared work item both participants follow. Requires `reason`. Either
   * participant may graduate (close symmetry). */
  outcome: 'answered' | 'cant_help' | 'graduate';
  answer?: string;
  /** Responder's confidence in the answer, 0..1 (outcome jsonb, D-001). */
  confidence?: number;
  evidence?: ConsultEvidenceRef[];
  reason?: string;
}

export interface ConsultCloseResult {
  ok: true;
  post_id: number;
  state: 'closed_answered' | 'closed_cant_help' | 'graduated';
  /** The minted shared work item (graduate closes only). */
  work_item_id?: string;
  hint: string;
}

export async function consultCloseCore(
  req: ConsultCloseRequest,
  deps: ConsultVerbDeps,
): Promise<ConsultCloseResult | ConsultVerbError> {
  const sql = deps.getSql();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  const gated = gateCommon(await readState(sql, req.workspaceId, req.conversationId));
  if ('error' in gated) return gated;
  const row = gated.row;

  if (req.authorId !== row.responder_id && req.authorId !== row.requester_id) {
    return { error: 'not_a_participant' };
  }

  // Structured outcome (D-001 — the outcome column comment is the authority):
  // closed_answered carries the answer; closed_cant_help/graduated carry the reason.
  const answer = req.answer?.trim();
  const reason = req.reason?.trim();
  if (req.outcome === 'answered' && !answer) return { error: 'answer_required' };
  if ((req.outcome === 'cant_help' || req.outcome === 'graduate') && !reason) return { error: 'reason_required' };

  // P-005 graduation (D-004): mint the shared work item FIRST — a mint failure
  // is a clean refusal (nothing written), and the closing post can then name
  // the minted id. The rare mint-then-post-fail crash window leaves a visible,
  // conversation-linked work item and an OPEN consult (retryable), which is
  // strictly more repairable than a closed consult with no work item.
  let graduatedWorkItemId: string | null = null;
  if (req.outcome === 'graduate') {
    if (!deps.mintGraduationWorkItem) {
      return {
        error: 'graduate_unavailable',
        hint: "This surface has no graduation work-item seam bound — close with outcome 'answered' | 'cant_help', or file the shared work item by hand and reference it in the close.",
      };
    }
    try {
      const minted = await deps.mintGraduationWorkItem({
        workspaceId: req.workspaceId,
        conversationId: req.conversationId,
        question: row.question,
        requesterId: row.requester_id,
        responderId: row.responder_id,
        closedBy: req.authorId,
        reason: reason as string,
      });
      graduatedWorkItemId = minted.id;
    } catch (e) {
      return { error: 'graduate_failed', cause: e instanceof Error ? e.message : String(e) };
    }
  }

  const state: ConsultCloseResult['state'] =
    req.outcome === 'answered' ? 'closed_answered' : req.outcome === 'graduate' ? 'graduated' : 'closed_cant_help';
  const body =
    req.outcome === 'answered'
      ? `Closed (answered): ${answer}`
      : req.outcome === 'graduate'
        ? `Graduated to shared work item ${graduatedWorkItemId}: ${reason}`
        : `Closed (can't help): ${reason}`;

  const posted = await deps.post({ conversation_id: req.conversationId, body, via_consult_verb: true });
  if ('error' in posted) return { error: 'post_failed', cause: posted.error };
  const postId = posted.post.id;

  await sql`
    INSERT INTO harness_shared.consult_post_meta
      (workspace_id, post_id, conversation_id, author_id, kind, evidence)
    VALUES
      (${req.workspaceId}, ${postId}, ${req.conversationId}, ${req.authorId},
       'close', ${req.evidence ? JSON.stringify(req.evidence) : null}::jsonb)
  `;
  const outcome = {
    ...(answer ? { answer } : {}),
    ...(req.confidence != null ? { confidence: req.confidence } : {}),
    ...(req.evidence?.length ? { evidence: req.evidence } : {}),
    ...(reason ? { reason } : {}),
    ...(graduatedWorkItemId ? { work_item_id: graduatedWorkItemId } : {}),
  };
  await sql`
    UPDATE harness_shared.consult_state
       SET state = ${state},
           outcome = ${JSON.stringify(outcome)}::jsonb,
           closed_at = ${now}::timestamptz,
           updated_at = ${now}::timestamptz
     WHERE workspace_id = ${req.workspaceId} AND conversation_id = ${req.conversationId}
  `;

  // A responder close is the terminal reply — wake the parked requester. A
  // requester closing their own consult has nobody parked on the key.
  if (req.authorId === row.responder_id) {
    await deps.emitReplyEvent({
      key: parkKey(req.conversationId),
      summary: `consult ${req.conversationId}: ${state} by ${req.authorId} — ${oneLine(body)}`,
      payload: { conversation_id: req.conversationId, responder: req.authorId, kind: 'close', post_id: postId, state },
      to: [row.requester_id],
    });
  }

  return {
    ok: true,
    post_id: postId,
    state,
    ...(graduatedWorkItemId ? { work_item_id: graduatedWorkItemId } : {}),
    hint:
      state === 'closed_answered'
        ? `Closed with a structured answer${req.confidence != null ? ` (confidence ${req.confidence})` : ''}. The outcome is on consult_state (the D-003 honesty-metric feed).`
        : state === 'graduated'
          ? `Graduated (D-004): the consult outgrew its bounds — shared work item ${graduatedWorkItemId} carries it forward and both participants are subscribed. The consult takes no further posts.`
          : `Closed as can't-help — an honest terminal outcome (D-003), not a failure. The requester proceeds on their own judgment.`,
  };
}
