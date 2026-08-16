/**
 * get-feedback-core.ts — the requester-side consult workflow (plan
 * get-feedback-relevance-consults-2026-08-16, P-003; decisions D-003/D-005/
 * D-007/D-008). Core/binding split mirrors conversations-core.ts: ALL consult
 * logic lives here behind injected deps (sql, router, conversation-opener,
 * reach/wake) so it is integration-tested against a real consult_state table
 * without the prod singletons; the `consult:get_feedback` tool
 * (agent-tools/consult/get-feedback.ts) binds the prod seams.
 *
 * What this module OWNS (and the router deliberately does not):
 *  - the LIVENESS GATE (D-008 §5): the router only annotates sessionState;
 *    v1 picks the top qualified candidate that is not 'ended'/'recorded'.
 *    All-qualified-dead is an honest no_qualified_responder with
 *    reason 'no_live_responder' + the evidence refs (retrieval fallback —
 *    the requester reads the cited turns via sessions:read).
 *  - the WAKE BUDGET (D-005): budget aggregates over every consult sharing
 *    origin_task_ref (recursion included — the column comment is the
 *    authority). Debited ON THE ATTEMPT (conservative for a spam guard);
 *    an exhausted budget still opens + persists + delivers via subscription,
 *    it just does not wake.
 *  - PERSISTENCE (D-008 §1): every call — routed or not — opens the
 *    kind='consult' conversation and writes the consult_state row with the
 *    routing snapshot VERBATIM (the D-003 honesty-metric feed needs persisted
 *    no_qualified_responder verdicts too; the PK needs the conversation row).
 *  - the LATENCY CONTRACT (D-005): 'proceed' (default — requester proceeds on
 *    assumption and reconciles) vs 'hard-blocked' (requester parks on the
 *    latched `consult:reply:<conversation_id>` event, emitted by the P-004
 *    reply verbs). expires_at derives from the contract.
 */
import type { Sql } from 'postgres';
import type { RouteResult, RoutingCandidate } from './relevance-router';

/** Mirrors consult_state.wake_budget DEFAULT (migration 834) — D-005. */
export const WAKE_BUDGET_PER_TASK = 4;
/** Latency-contract expiry defaults (D-005 'proceed-after-N'; the N is a
 * policy default here, not owner-pinned — P-005 lifecycle owns the expiry
 * sweep and may recalibrate). */
export const PROCEED_EXPIRY_MS = 4 * 3_600_000; // 4h
export const HARD_BLOCKED_EXPIRY_MS = 30 * 60_000; // 30m
/** sessionStates a v1 consult never wakes (D-008 §5 liveness gate). */
export const DEAD_RESPONDER_STATES: ReadonlySet<string> = new Set(['ended', 'recorded']);

export type LatencyContract = 'proceed' | 'hard-blocked';

export interface GetFeedbackRequest {
  workspaceId: string;
  requesterId: string;
  question: string;
  tried?: string;
  observed?: string;
  decisionAtStake?: string;
  latencyContract?: LatencyContract;
  /** Explicit origin task ref; undefined ⇒ default to the requester's most
   * recently progressed wip work-item (fail-soft: none ⇒ null). */
  originTaskRef?: string | null;
  /** D-007(7) manual cascade: exclude prior decliners on a re-call. */
  excludeOwners?: string[];
  topics?: string[];
  harnessSlug?: string;
}

export interface GetFeedbackDeps {
  getSql: () => Sql;
  route: (params: {
    workspaceId: string;
    requesterId: string;
    question: string;
    excludeOwners?: string[];
  }) => Promise<RouteResult>;
  /** Opens the kind='consult' conversation (bound to openConversation in prod). */
  open: (input: {
    kind: 'consult';
    title: string;
    body: string;
    topics?: string[];
    harness_slug?: string;
    direct_to: string[];
  }) => Promise<{ conversation_id: string; thread_id: string; delivered: number }>;
  /** Directed ping + wake on the conversation (bound to notifyAgents in prod). */
  reach: (opts: {
    responder: string;
    conversationId: string;
    summary: string;
    body: string;
  }) => Promise<{ woke: number }>;
  now?: () => Date;
}

export interface GetFeedbackResult {
  ok: true;
  verdict: 'routed' | 'no_qualified_responder';
  /** Only on no_qualified_responder — WHY, honestly (D-003: distinct causes
   * must stay distinguishable). */
  reason?: 'below_floor' | 'no_live_responder' | 'embed_unavailable';
  conversation_id: string;
  thread_id: string;
  state: 'awaiting_responder' | 'no_qualified_responder';
  responder: RoutingCandidate | null;
  /** Qualified-but-not-chosen, best first — the D-007(7) manual-cascade menu. */
  remaining_candidates: Array<{ ownerId: string; score: number; liveness: string }>;
  origin_task_ref: string | null;
  latency_contract: LatencyContract;
  expires_at: string | null;
  wake: {
    attempted: boolean;
    woke: number;
    budget_exhausted: boolean;
    wakes_used_for_task: number;
    wake_budget: number;
  };
  /** Latched park key for a hard-blocked requester (P-004 reply verbs emit). */
  park_key: string | null;
  degraded?: 'embed-unavailable';
  hint: string;
}

function consultTitle(question: string): string {
  const q = question.replace(/\s+/g, ' ').trim();
  return `consult: ${q.length > 90 ? `${q.slice(0, 90)}…` : q}`;
}

function consultBody(req: GetFeedbackRequest): string {
  const parts = [req.question.trim()];
  if (req.tried?.trim()) parts.push(`## Tried\n${req.tried.trim()}`);
  if (req.observed?.trim()) parts.push(`## Observed\n${req.observed.trim()}`);
  if (req.decisionAtStake?.trim()) parts.push(`## Decision at stake\n${req.decisionAtStake.trim()}`);
  parts.push(`_latency contract: ${req.latencyContract ?? 'proceed'}_`);
  return parts.join('\n\n');
}

/** Compact why-you-were-chosen evidence for the wake body (D-008 §5) — refs
 * resolvable via sessions:read, so relevance validation is a cheap check. */
function evidenceLine(c: RoutingCandidate): string {
  return c.evidence
    .map((e) => `${e.session_id}#${e.turn_idx} (sim ${e.sim.toFixed(2)})`)
    .join('; ');
}

export async function getFeedbackCore(
  req: GetFeedbackRequest,
  deps: GetFeedbackDeps,
): Promise<GetFeedbackResult> {
  const sql = deps.getSql();
  const now = deps.now ? deps.now() : new Date();
  const latency: LatencyContract = req.latencyContract ?? 'proceed';

  // 1) Origin task ref — explicit wins; undefined defaults to the requester's
  //    most recently progressed wip item (the D-005 budget aggregation key).
  let originRef: string | null = req.originTaskRef !== undefined ? req.originTaskRef : null;
  if (req.originTaskRef === undefined) {
    const rows = (await sql`
      SELECT feature_id FROM harness_shared.work_items
       WHERE taken_by = ${req.requesterId} AND status = 'wip'
    ORDER BY COALESCE(last_progress_at, taken_at) DESC NULLS LAST
       LIMIT 1
    `) as unknown as Array<{ feature_id: string }>;
    originRef = rows[0]?.feature_id ?? null;
  }

  // 2) Route (one embedding + bounded SQL; snapshot comes back for persisting).
  const route = await deps.route({
    workspaceId: req.workspaceId,
    requesterId: req.requesterId,
    question: req.question,
    ...(req.excludeOwners?.length ? { excludeOwners: req.excludeOwners } : {}),
  });

  // 3) Liveness gate (v1, D-008 §5): top qualified that is not dead.
  const liveQualified = route.qualified.filter((c) => !DEAD_RESPONDER_STATES.has(c.liveness));
  const chosen = route.verdict === 'routed' ? (liveQualified[0] ?? null) : null;
  const reason: GetFeedbackResult['reason'] = chosen
    ? undefined
    : route.snapshot.degraded === 'embed-unavailable'
      ? 'embed_unavailable'
      : route.verdict === 'routed'
        ? 'no_live_responder'
        : 'below_floor';

  // 4) Wake budget (D-005): aggregate wakes_used across consults sharing the
  //    origin ref. Only meaningful when there IS a ref to aggregate on.
  let usedForTask = 0;
  if (chosen && originRef) {
    const rows = (await sql`
      SELECT COALESCE(SUM(wakes_used), 0)::int AS used
        FROM harness_shared.consult_state
       WHERE workspace_id = ${req.workspaceId} AND origin_task_ref = ${originRef}
    `) as unknown as Array<{ used: number }>;
    usedForTask = rows[0]?.used ?? 0;
  }
  const budgetExhausted = Boolean(chosen && originRef && usedForTask >= WAKE_BUDGET_PER_TASK);
  const willWake = Boolean(chosen && !budgetExhausted);

  // 5) Open the conversation — ALWAYS (D-003 honesty feed + the PK row).
  const opened = await deps.open({
    kind: 'consult',
    title: consultTitle(req.question),
    body: consultBody(req),
    ...(req.topics?.length ? { topics: req.topics } : {}),
    ...(req.harnessSlug ? { harness_slug: req.harnessSlug } : {}),
    direct_to: chosen ? [chosen.ownerId] : [],
  });

  // 6) Persist consult_state (snapshot VERBATIM — D-008; never recomputed).
  const state: GetFeedbackResult['state'] = chosen ? 'awaiting_responder' : 'no_qualified_responder';
  const expiresAt = chosen
    ? new Date(now.getTime() + (latency === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS)).toISOString()
    : null;
  await sql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       latency_contract, origin_task_ref, routing, expires_at, wakes_used)
    VALUES
      (${req.workspaceId}, ${opened.conversation_id}, ${req.requesterId},
       ${chosen?.ownerId ?? null}, ${state}, ${req.question}, ${latency},
       ${originRef}, ${JSON.stringify(route.snapshot)}::jsonb, ${expiresAt},
       ${willWake ? 1 : 0})
  `;

  // 7) Wake the responder with why-you-were-chosen evidence (D-008 §5).
  let woke = 0;
  if (willWake && chosen) {
    const r = await deps.reach({
      responder: chosen.ownerId,
      conversationId: opened.conversation_id,
      summary: `🧭 consult from ${req.requesterId}: ${req.question.replace(/\s+/g, ' ').slice(0, 72)}`,
      body:
        `Routed to you by transcript relevance (score ${chosen.score.toFixed(2)}, sim ${chosen.signals.similarity.toFixed(2)}).\n` +
        `Why you: ${evidenceLine(chosen)} — sessions:read resolves the refs.\n` +
        `Validate relevance FIRST; decline cheaply if your context doesn't cover it. Answer FROM your transcript, citing evidence. ` +
        `Reply in conversation ${opened.conversation_id} with consult:reply { kind } (answer requires evidence); ` +
        `consult:decline { reason } if it's not your area; consult:close { outcome } when settled. Untyped conversations:post is refused.`,
    });
    woke = r.woke;
  }

  const parkKey = chosen && latency === 'hard-blocked' ? `consult:reply:${opened.conversation_id}` : null;
  const hint = chosen
    ? budgetExhausted
      ? `Routed to ${chosen.ownerId} but the wake budget for ${originRef} is exhausted (${usedForTask}/${WAKE_BUDGET_PER_TASK}) — delivered by subscription only; they see it on their next turn. Proceed meanwhile.`
      : latency === 'hard-blocked'
        ? `Routed + woke ${chosen.ownerId}. Park on events:await { event: '${parkKey}' } and end your turn — the reply wakes you (latched). Expires ${expiresAt}.`
        : `Routed + woke ${chosen.ownerId}; the reply lands in conversation ${opened.conversation_id}. PROCEED on your own judgment meanwhile and reconcile when it arrives. A decline returns the remaining candidates — re-call with exclude:['${chosen.ownerId}'].`
    : reason === 'embed_unavailable'
      ? 'The embedder is unavailable on this host — similarity could NOT be measured (cannot-measure ≠ measured-nothing). Proceed on your own judgment; retry later if the answer matters.'
      : reason === 'no_live_responder'
        ? 'Qualified experts exist but none is live — no wake possible. Their cited turns are in remaining_candidates[].evidence; read them via sessions:read (retrieval fallback) and proceed.'
        : 'No one’s transcript clears the relevance floor — no one knows more than you do. Proceed on your own judgment (first-class honest verdict, not an error).';

  return {
    ok: true,
    verdict: chosen ? 'routed' : 'no_qualified_responder',
    ...(reason ? { reason } : {}),
    conversation_id: opened.conversation_id,
    thread_id: opened.thread_id,
    state,
    responder: chosen,
    remaining_candidates: route.qualified
      .filter((c) => c !== chosen)
      .map((c) => ({ ownerId: c.ownerId, score: c.score, liveness: c.liveness })),
    origin_task_ref: originRef,
    latency_contract: latency,
    expires_at: expiresAt,
    wake: {
      attempted: willWake,
      woke,
      budget_exhausted: budgetExhausted,
      wakes_used_for_task: usedForTask + (willWake ? 1 : 0),
      wake_budget: WAKE_BUDGET_PER_TASK,
    },
    park_key: parkKey,
    ...(route.snapshot.degraded ? { degraded: route.snapshot.degraded } : {}),
    hint,
  };
}
