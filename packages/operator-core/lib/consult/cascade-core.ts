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
import {
  DEAD_RESPONDER_STATES,
  HARD_BLOCKED_EXPIRY_MS,
  PROCEED_EXPIRY_MS,
  revivalBrief,
  revivalBudgetSpent,
} from './get-feedback-core';

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

/** The revival seam advanceCascade's refill-exhaustion leg calls
 * (EI-20864690354207496) — same contract as GetFeedbackDeps.revive: MUST
 * resolve, never throw; spawned:false on any failure. Prod binds the WI-39852
 * reviver (revive-responder.ts). */
export type CascadeRevive = (opts: {
  ownerId: string;
  conversationId: string;
  brief: string;
}) => Promise<{ spawned: boolean; verified: boolean | null; detail: string }>;

export interface AdvanceCascadeParams {
  workspaceId: string;
  conversationId: string;
  question: string;
  latencyContract: string;
  /** The consult's requester (row.requester_id) — named in the
   * refill-exhaustion revival brief (EI-20864690354207496). Optional only for
   * older fixtures; the brief falls back to a neutral phrase. */
  requesterId?: string;
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
   * snapshot pool (selection.refill stamps the round). */
  refilled?: boolean;
  /** EI-20864690354207496: a refill-exhaustion revival was ATTEMPTED this
   * advance — the menu exhausted below selection.min with no live untried
   * candidate left to fill it, and the persisted per-consult budget was
   * unspent. spawned:true ⇒ the revived entry HEADS the menu extension and
   * `next` points at them; spawned:false ⇒ see underFilled. */
  revival?: {
    ownerId: string;
    trigger: 'refill-exhaustion';
    spawned: boolean;
    verified: boolean | null;
    detail: string;
  };
  /** EI-20864690354207496 honest terminal: the cascade ended with fewer
   * substantive answers than selection.min and NO revival could close the gap
   * — `reason` names why. Mirrored durably onto the persisted snapshot as
   * selection.underFilled so the label survives the caller. */
  underFilled?: {
    answers: number;
    min: number;
    reason: 'no-revive-dep' | 'budget-spent' | 'no-revivable-candidate' | 'revival-failed';
  };
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
    // WI-39861 min-ANSWERS refill + EI-20864690354207496 revival: the menu is
    // exhausted. If fewer substantive ANSWERS than selection.min were
    // collected (counting the just-appended event), try to extend the menu
    // instead of going terminal — first from the snapshot pool's untried
    // route-time-LIVE remainder (ONE bounded round; the selection.refill
    // stamp is that round's guard), then, when min is still unreachable from
    // live untried candidates, by REVIVING one dead ABOVE-FLOOR untried
    // candidate if the persisted per-consult budget is unspent
    // (revivalBudgetSpent over the selection's `revived` stamps — the budget,
    // not the refill stamp, bounds revival, so the post-refill exhaustion is
    // covered too). When neither can fill the gap, the terminal state
    // honestly reports WHY the min stays unfilled (selection.underFilled).
    // It all lives HERE — shared by all three triggers (reply/decline/expiry)
    // — so the semantics cannot drift.
    const snap =
      typeof params.routing === 'string'
        ? (JSON.parse(params.routing) as Record<string, unknown> | null)
        : (params.routing as Record<string, unknown> | null);
    const sel = (snap?.selection ?? null) as
      | ({ min?: unknown; selected?: unknown; refill?: unknown } & Record<string, unknown>)
      | null;
    const answers = digest.filter((e) => e.kind === 'answer').length;
    const min = typeof sel?.min === 'number' ? sel.min : 0;
    if (snap && sel && min > 0 && answers < min) {
      const tried = new Set<string>([...selected.map((e) => e.ownerId), ...digest.map((e) => e.ownerId)]);
      const floor = typeof snap.floor === 'number' ? (snap.floor as number) : Number.POSITIVE_INFINITY;
      const simFloor = typeof snap.simFloor === 'number' ? (snap.simFloor as number) : Number.POSITIVE_INFINITY;
      const needed = Math.max(0, min - answers);
      type SnapCand = {
        ownerId: string;
        score?: number;
        signals?: { similarity?: number };
        liveness?: string;
        evidence?: unknown;
      };
      const untried = (Array.isArray(snap.candidates) ? snap.candidates : []).filter(
        (c): c is SnapCand =>
          Boolean(c) &&
          typeof (c as { ownerId?: unknown }).ownerId === 'string' &&
          !tried.has((c as { ownerId: string }).ownerId),
      );
      const entryOf = (c: SnapCand, extra: Partial<CascadeSelectionEntry>): CascadeSelectionEntry => {
        const score = typeof c.score === 'number' ? c.score : 0;
        const similarity = typeof c.signals?.similarity === 'number' ? c.signals.similarity : 0;
        return {
          ownerId: c.ownerId,
          // Honest floor-vs-minimum recomputed from the snapshot's own floors
          // (D-002: labeled, never silent) — a refill pick below them is a
          // best-available fill, not a costumed expert.
          via: similarity >= simFloor && score >= floor ? 'floor' : 'minimum',
          score,
          similarity,
          liveness: c.liveness ?? 'unknown',
          ...extra,
        };
      };
      // WI-39861 live refill (ONE bounded round — selection.refill guards it).
      const liveAdds: CascadeSelectionEntry[] = !sel.refill
        ? untried
            .filter((c) => !DEAD_RESPONDER_STATES.has(String(c.liveness ?? '')))
            .slice(0, needed)
            .map((c) => entryOf(c, { refill: true }))
        : [];

      // EI-20864690354207496 revival leg. Liveness here is the ROUTE-TIME
      // snapshot, up to PROCEED_EXPIRY_MS stale — an ACCEPTED bound, named
      // deliberately: a stale-DEAD candidate who respawned meanwhile is
      // refused by the reviver's live-collision rule (spawned:false, WI-3882),
      // and a stale-LIVE pick who died since expires via the sweep and the
      // cascade advances past them — both staleness directions recover
      // without a liveness re-read here.
      let revival: AdvanceCascadeResult['revival'];
      let revivedEntry: CascadeSelectionEntry | null = null;
      let underFilledReason: NonNullable<AdvanceCascadeResult['underFilled']>['reason'] | null = null;
      if (liveAdds.length < needed) {
        const revivable = untried.find(
          (c) =>
            DEAD_RESPONDER_STATES.has(String(c.liveness ?? '')) &&
            typeof c.score === 'number' &&
            c.score >= floor &&
            typeof c.signals?.similarity === 'number' &&
            c.signals.similarity >= simFloor,
        );
        if (!revive) underFilledReason = 'no-revive-dep';
        else if (revivalBudgetSpent(selected)) underFilledReason = 'budget-spent';
        else if (!revivable) underFilledReason = 'no-revivable-candidate';
        else {
          const r = await revive({
            ownerId: revivable.ownerId,
            conversationId: params.conversationId,
            brief: revivalBrief({
              requesterId: params.requesterId ?? 'the consult requester',
              question: params.question,
              conversationId: params.conversationId,
              candidate: {
                score: typeof revivable.score === 'number' ? revivable.score : 0,
                signals: {
                  similarity:
                    typeof revivable.signals?.similarity === 'number' ? revivable.signals.similarity : 0,
                },
                evidence: Array.isArray(revivable.evidence) ? (revivable.evidence as never) : [],
              },
            }),
          });
          revival = { ownerId: revivable.ownerId, trigger: 'refill-exhaustion', ...r };
          if (r.spawned) {
            // The revived entry HEADS the extension: the cursor must land on
            // them (their spawn brief says "reply now", and a non-cursor
            // selectee's reply is refused as not_the_responder) — mirroring
            // the creation site's revived-first menu.
            revivedEntry = entryOf(revivable, { revived: true });
          } else {
            underFilledReason = 'revival-failed';
          }
        }
      }
      const add: CascadeSelectionEntry[] = revivedEntry ? [revivedEntry, ...liveAdds] : liveAdds;
      if (add.length > 0) {
        const rawSelected = Array.isArray(sel.selected) ? (sel.selected as unknown[]) : [];
        const updatedSnap = {
          ...snap,
          selection: {
            ...sel,
            selected: [...rawSelected, ...add],
            refill: {
              at: params.nowIso,
              added: add.map((a) => a.ownerId),
              reason: `cascade exhausted with ${answers} answer(s) < min ${min}`,
            },
          },
        };
        // Cursor lands on the FIRST refill entry: in the selectionFromRouting
        // view the adds append after the `selected.length` well-formed entries.
        const cursorIdx = selected.length;
        const first = add[0]!;
        const expiresAt = new Date(
          Date.parse(params.nowIso) +
            (params.latencyContract === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS),
        ).toISOString();
        const willAttempt = Boolean(reach);
        const wrote = (await sql`
          UPDATE harness_shared.consult_state
             SET cascade_cursor = ${cursorIdx},
                 responder_id = ${first.ownerId},
                 state = ${params.stateOnAdvance},
                 expires_at = ${expiresAt}::timestamptz,
                 wakes_used = wakes_used + ${willAttempt ? 1 : 0},
                 cascade_digest = ${JSON.stringify(digest)}::jsonb,
                 routing = ${sql.json(updatedSnap as never)},
                 updated_at = ${params.nowIso}::timestamptz
           WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
             AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
          RETURNING conversation_id
        `) as unknown as Array<{ conversation_id: string }>;
        if (wrote.length === 0) return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
        let woke = 0;
        if (reach) {
          const menuSize = selected.length + add.length;
          const r = await reach({
            responder: first.ownerId,
            conversationId: params.conversationId,
            summary: `🧭 consult cascade (reviewer ${cursorIdx + 1}/${menuSize}, min-answers refill): ${params.question.replace(/\s+/g, ' ').slice(0, 72)}`,
            body: cascadeWakeBody({
              question: params.question,
              conversationId: params.conversationId,
              position: cursorIdx + 1,
              menuSize,
              next: first,
              digest,
            }),
          });
          woke = r.woke;
        }
        return {
          advanced: true,
          exhausted: false,
          raced: false,
          next: { ownerId: first.ownerId, via: first.via },
          woke,
          refilled: true,
        };
      }
    }
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
