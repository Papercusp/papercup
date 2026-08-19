/**
 * cascade-core.ts — the ALWAYS-ADVANCE consult cascade (plan
 * consult-min-max-and-rubric-vetting-2026-08-17, P-013; owner ruling D-005).
 *
 * With max N selected responders, the chain advances after responder k
 * REPLIES (any kind), DECLINES, or EXPIRES unanswered: the next selected
 * responder is woken with the original question PLUS a bounded digest of the
 * feedback gathered so far — so each later reviewer builds on (or contests)
 * earlier reviews, and a consult with max 5 actually collects up to 5
 * perspectives. The chain ends at menu exhaustion (or max, which bounded the
 * menu at selection time). Advance is SERVER-driven from the reply/decline
 * verbs + the expiry sweep — a silent responder cannot stall the chain.
 *
 * Shared by consult-verbs-core (reply/decline) and consult-expiry-core (the
 * sweep) so the advance semantics cannot drift between the three triggers.
 * All responders reply into the ONE consult conversation — the thread IS the
 * accumulator; cascade_digest is the bounded rendering carried on each wake.
 *
 * Schema: migration 844 (cascade_cursor + cascade_digest on consult_state).
 */
import type { Sql } from 'postgres';
import { DEAD_RESPONDER_STATES, HARD_BLOCKED_EXPIRY_MS, PROCEED_EXPIRY_MS } from './get-feedback-core';

/** Chain events a digest entry can record: the responder reply kinds, plus
 * the two non-reply advance triggers. */
export type CascadeEventKind = 'answer' | 'clarifying_question' | 'new_fact' | 'decline' | 'expired';

export interface CascadeDigestEntry {
  ownerId: string;
  kind: CascadeEventKind;
  at: string;
  excerpt: string;
}

/** Per-entry excerpt bound — the digest is a pointer into the thread, never a
 * transcript copy (the wake body carries the conversation ref for the rest). */
export const CASCADE_EXCERPT_MAX = 400;
/** Digest entries kept (oldest dropped) — covers the widest tool-layer menu
 * (max_agents ≤ 8) with room for decline/expiry events alongside replies. */
export const CASCADE_DIGEST_MAX_ENTRIES = 16;

/** One selection.selected entry from the persisted routing snapshot
 * (relevance-router selectionSnapshot — the shape is migration-comment-owned). */
export interface CascadeSelectionEntry {
  ownerId: string;
  via: 'floor' | 'minimum';
  score: number;
  similarity: number;
  liveness: string;
  /** WI-39852: selectee entered via a carry-respawn revival (provenance only). */
  revived?: boolean;
  /** WI-39861: selectee entered on the ONE post-exhaustion refill round. */
  refill?: boolean;
}

/** The selected cascade menu from a persisted routing snapshot. Tolerant of
 * string jsonb (driver may hand it back unparsed) and of pre-min/max rows
 * (no selection block ⇒ empty menu ⇒ every advance exhausts). */
export function selectionFromRouting(routing: unknown): CascadeSelectionEntry[] {
  const snap = typeof routing === 'string' ? (JSON.parse(routing) as unknown) : routing;
  const selected = (snap as { selection?: { selected?: unknown } } | null)?.selection?.selected;
  if (!Array.isArray(selected)) return [];
  return selected.filter(
    (e): e is CascadeSelectionEntry => Boolean(e) && typeof (e as { ownerId?: unknown }).ownerId === 'string',
  );
}

/** Normalize a persisted cascade_digest column value. */
export function digestFromRow(raw: unknown): CascadeDigestEntry[] {
  const v = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is CascadeDigestEntry => Boolean(e) && typeof (e as { ownerId?: unknown }).ownerId === 'string',
  );
}

export function makeDigestEntry(ownerId: string, kind: CascadeEventKind, at: string, text: string): CascadeDigestEntry {
  const t = text.replace(/\s+/g, ' ').trim();
  return { ownerId, kind, at, excerpt: t.length <= CASCADE_EXCERPT_MAX ? t : `${t.slice(0, CASCADE_EXCERPT_MAX - 1)}…` };
}

/** The next selectee's wake body: why-them framing (honest for a minimum-fill
 * pick, mirroring get-feedback-core's D-002 body), the prior-feedback digest,
 * and the typed-reply protocol. */
export function cascadeWakeBody(input: {
  question: string;
  conversationId: string;
  position: number; // 1-based position in the menu of the responder being woken
  menuSize: number;
  next: CascadeSelectionEntry;
  digest: CascadeDigestEntry[];
}): string {
  const { next } = input;
  const why =
    next.via === 'minimum'
      ? `Selected as BEST-AVAILABLE reviewer (blended score ${next.score.toFixed(2)}, sim ${next.similarity.toFixed(2)} — BELOW the relevance floor). This is a FIRST-PRINCIPLES review request, not a claim your transcript covers it — do NOT decline solely for lack of context.`
      : `Routed to you by transcript relevance (blended score ${next.score.toFixed(2)}, sim ${next.similarity.toFixed(2)}). Validate relevance first; answer FROM your transcript, citing evidence.`;
  const digestLines =
    input.digest.length === 0
      ? '(none yet — every earlier selectee declined or expired unanswered)'
      : input.digest
          .map((e) => `- ${e.ownerId} (${e.kind}): ${e.excerpt}`)
          .join('\n');
  return (
    `Consult cascade — you are reviewer ${input.position}/${input.menuSize} (the chain advances after each reply, decline, or expiry; D-005).\n` +
    `QUESTION: ${input.question}\n` +
    `${why}\n` +
    `FEEDBACK SO FAR (build on it or contest it — the full thread is conversation ${input.conversationId}):\n` +
    `${digestLines}\n` +
    `Reply in conversation ${input.conversationId} with consult:reply { kind } (answer requires evidence; labeled first-principles reasoning is admissible for a best-available pick); ` +
    `consult:decline { reason } only if you genuinely cannot add value; consult:close { outcome } when settled. Untyped conversations:post is refused.`
  );
}

export interface AdvanceCascadeParams {
  workspaceId: string;
  conversationId: string;
  question: string;
  latencyContract: string;
  /** Persisted routing snapshot (selection.selected is the menu). */
  routing: unknown;
  /** Current cursor (index of the responder whose event triggered this). */
  cascadeCursor: number;
  /** Current persisted digest (row.cascade_digest). */
  digest: unknown;
  /** The chain event that triggered this advance — appended to the digest. */
  event: CascadeDigestEntry;
  /** Row state to leave on a successful advance: 'active' when triggered by a
   * reply (a responder engaged), 'awaiting_responder' for decline/expiry. */
  stateOnAdvance: 'awaiting_responder' | 'active';
  nowIso: string;
}

export interface AdvanceCascadeResult {
  advanced: boolean;
  /** True when the menu had no next entry — the caller owns the terminal
   * transition (decline-close / expire); this helper only records the event. */
  exhausted: boolean;
  /** True when the CAS guard matched no row — a concurrent actor (the other
   * verb, or the expiry sweep) advanced or closed the consult between the
   * caller's read and this write. NOTHING was written (no digest append, no
   * wake); the concurrent winner's advance stands and already did both. */
  raced: boolean;
  next: { ownerId: string; via: 'floor' | 'minimum' } | null;
  woke: number;
  /** WI-39861: this advance was the ONE bounded min-ANSWERS refill round — the
   * menu exhausted with fewer substantive answers than selection.min, so the
   * menu was extended from the untried route-time-live remainder of the
   * snapshot pool (selection.refill stamps the round; a second exhaustion is
   * terminal). */
  refilled?: boolean;
}

/**
 * Advance the cascade by one responder. On advance: cursor + responder_id +
 * state + a fresh latency-contract expiry window + digest append + wake (via
 * `reach`, when provided — prod binds notifyAgents, which subscribes + pings +
 * wakes, so a later selectee joins the conversation durably). On exhaustion:
 * appends the event to the digest and returns without touching
 * state/responder_id — terminal semantics stay with the caller.
 *
 * CAS-guarded: both writes require `cascade_cursor` to still equal the cursor
 * the caller READ (params.cascadeCursor) and the row to still be open. Three
 * concurrent triggers share these semantics (reply, decline, the expiry
 * sweep); the guard makes the loser's advance a clean no-op (`raced`) instead
 * of a duplicate cursor bump + duplicate wake.
 */
export async function advanceCascade(
  params: AdvanceCascadeParams,
  sql: Sql,
  reach?: (opts: { responder: string; conversationId: string; summary: string; body: string }) => Promise<{ woke: number }>,
): Promise<AdvanceCascadeResult> {
  const selected = selectionFromRouting(params.routing);
  const digest = [...digestFromRow(params.digest), params.event].slice(-CASCADE_DIGEST_MAX_ENTRIES);
  const nextIdx = params.cascadeCursor + 1;
  const next = nextIdx < selected.length ? selected[nextIdx] : null;

  if (!next) {
    const wrote = (await sql`
      UPDATE harness_shared.consult_state
         SET cascade_digest = ${JSON.stringify(digest)}::jsonb,
             updated_at = ${params.nowIso}::timestamptz
       WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
         AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
      RETURNING conversation_id
    `) as unknown as Array<{ conversation_id: string }>;
    if (wrote.length === 0) return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
    return { advanced: false, exhausted: true, raced: false, next: null, woke: 0 };
  }

  const expiresAt = new Date(
    Date.parse(params.nowIso) + (params.latencyContract === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS),
  ).toISOString();
  const willAttempt = Boolean(reach);
  const wrote = (await sql`
    UPDATE harness_shared.consult_state
       SET cascade_cursor = ${nextIdx},
           responder_id = ${next.ownerId},
           state = ${params.stateOnAdvance},
           expires_at = ${expiresAt}::timestamptz,
           wakes_used = wakes_used + ${willAttempt ? 1 : 0},
           cascade_digest = ${JSON.stringify(digest)}::jsonb,
           updated_at = ${params.nowIso}::timestamptz
     WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
       AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
    RETURNING conversation_id
  `) as unknown as Array<{ conversation_id: string }>;
  if (wrote.length === 0) return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };

  let woke = 0;
  if (reach) {
    const r = await reach({
      responder: next.ownerId,
      conversationId: params.conversationId,
      summary: `🧭 consult cascade (reviewer ${nextIdx + 1}/${selected.length}): ${params.question.replace(/\s+/g, ' ').slice(0, 72)}`,
      body: cascadeWakeBody({
        question: params.question,
        conversationId: params.conversationId,
        position: nextIdx + 1,
        menuSize: selected.length,
        next,
        digest,
      }),
    });
    woke = r.woke;
  }
  return { advanced: true, exhausted: false, raced: false, next: { ownerId: next.ownerId, via: next.via }, woke };
}
