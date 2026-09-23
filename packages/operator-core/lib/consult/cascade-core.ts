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
import { snapshotCandidateQualifies } from './relevance-router';
import { consultResponderVerbMenu } from './responder-verb-menu';
import { gradingCascadeMetaFromRouting, gradingCascadeWakeCopy, sourceAuditCascadeMetaFromRouting, sourceAuditWakeCopy } from './grading-cascade';

/** Chain events a digest entry can record: the responder reply kinds, plus
 * the two non-reply advance triggers. */
export type CascadeEventKind = 'answer' | 'clarifying_question' | 'new_fact' | 'decline' | 'expired' | 'wake_failed';

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
  /** Stage-2 comparison score (relevance × freshness) — the ORDERING number. */
  score: number;
  /** Stage-1 qualification score. Recorded beside `via` because `via` is
   * DERIVED from it: a record carrying only the comparison score cannot be
   * audited against the floors it claims to have cleared. */
  relevance: number;
  similarity: number;
  liveness: string;
  /** WI-39852: selectee entered via a carry-respawn revival (provenance only). */
  revived?: boolean;
  /** EI-21809454835305750: revival spawn is in flight; counts against the
   * one-revival budget until it resolves. */
  revivalPending?: boolean;
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

/**
 * Everything a wake-copy writer is entitled to know about the advance it is
 * announcing. Deliberately data-only: the copy seam decides WORDS, never who is
 * woken, when, or under what CAS guard.
 */
export interface CascadeWakeContext {
  question: string;
  conversationId: string;
  /** 1-based position in the menu of the responder being woken. */
  position: number;
  menuSize: number;
  next: CascadeSelectionEntry;
  digest: CascadeDigestEntry[];
  /** Set when this wake is the ONE post-exhaustion menu extension, naming which
   * kind — the copy may want to say so; the mechanism does not change. */
  extension?: 'min-answers refill' | 'refill-exhaustion revival';
}

/** Notification summary + body for one cascade advance. */
export interface CascadeWakeCopy {
  summary: string;
  body: string;
}

/**
 * The wake-copy seam (unified-responder-selection-critique-and-grading-2026-08-30
 * D-005). ONE advance path serves every cascading flow, but not every flow is a
 * consult: acceptance grading advances through this same CAS-guarded cursor and
 * must wake its next grader with grading instructions, not a consult verb menu.
 * Copy is the ONLY thing that legitimately differs between them, so copy is the
 * only thing that varies — a second advance loop for grading is exactly what
 * D-005 forbids.
 */
export type CascadeWakeCopyWriter = (ctx: CascadeWakeContext) => CascadeWakeCopy;

/** The next selectee's wake body: why-them framing (honest for a minimum-fill
 * pick, mirroring get-feedback-core's D-002 body), the prior-feedback digest,
 * and the typed-reply protocol. */
export function cascadeWakeBody(input: CascadeWakeContext): string {
  const { next } = input;
  const why =
    next.via === 'minimum'
      ? `Selected as BEST-AVAILABLE reviewer (relevance ${next.relevance.toFixed(2)}, sim ${next.similarity.toFixed(2)} — BELOW the relevance floor). This is a FIRST-PRINCIPLES review request, not a claim your transcript covers it — do NOT decline solely for lack of context.`
      : `Routed to you by transcript relevance (relevance ${next.relevance.toFixed(2)}, sim ${next.similarity.toFixed(2)}). Validate relevance first; answer FROM your transcript, citing evidence.`;
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
    consultResponderVerbMenu({
      conversationId: input.conversationId,
      evidenceNote:
        'answer requires evidence; labeled first-principles reasoning is admissible for a best-available pick',
    })
  );
}

/** The DEFAULT copy writer — the consult cascade's own. Every pre-existing
 * caller gets exactly the summary and body it got before the seam existed. */
export const consultCascadeWakeCopy: CascadeWakeCopyWriter = (ctx) => ({
  summary:
    `🧭 consult cascade (reviewer ${ctx.position}/${ctx.menuSize}` +
    `${ctx.extension ? `, ${ctx.extension}` : ''}): ${ctx.question.replace(/\s+/g, ' ').slice(0, 72)}`,
  body: cascadeWakeBody(ctx),
});

/**
 * Resolve the copy writer FROM THE ROW, not from the caller.
 *
 * Deliberately derived rather than passed as a parameter. Three of the four
 * advance triggers are generic — the decline verb, the expiry sweep and a
 * failed-wake advance all move whatever cursor they find, and none of them has
 * any way to know it is holding an acceptance-grading cascade. A `wakeCopy`
 * argument would therefore have been correct only on the triggers that happen to
 * know, and a grader woken by an expiry would silently receive consult copy
 * telling them to answer from their transcript. Reading the flavour off the
 * snapshot the advance is already parsing makes that unrepresentable.
 */
export function cascadeWakeCopyForRouting(routing: unknown): CascadeWakeCopyWriter {
  const audit = sourceAuditCascadeMetaFromRouting(routing);
  if (audit) return (ctx) => sourceAuditWakeCopy(audit, ctx.conversationId);
  const grading = gradingCascadeMetaFromRouting(routing);
  return grading ? gradingCascadeWakeCopy(grading) : consultCascadeWakeCopy;
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
  revive?: CascadeRevive,
): Promise<AdvanceCascadeResult> {
  const sourceAudit = sourceAuditCascadeMetaFromRouting(params.routing);
  if (sourceAudit) {
    // Repair a missed post-emit cleanup before any decline/expiry/refill wake.
    // The settled source card is authoritative even when its closer failed.
    const settled = await sql<{ state: string }[]>`
      SELECT payload->'observation'->'gradingAudit'->>'state' AS state
      FROM harness_shared.work_items
      WHERE workspace_id = ${params.workspaceId} AND feature_id = ${sourceAudit.issueId}`;
    if (settled[0]?.state === 'passed' || settled[0]?.state === 'failed') {
      await sql`
        UPDATE harness_shared.consult_state
        SET state = 'closed_answered', closed_at = ${params.nowIso}::timestamptz,
            updated_at = ${params.nowIso}::timestamptz,
            outcome = jsonb_build_object('source', 'grading-integrity', 'issueId', ${sourceAudit.issueId}::text)
        WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
          AND state IN ('awaiting_responder', 'active')`;
      return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
    }
  }
  const selected = selectionFromRouting(params.routing);
  const digest = [...digestFromRow(params.digest), params.event].slice(-CASCADE_DIGEST_MAX_ENTRIES);
  const nextIdx = params.cascadeCursor + 1;
  const next = nextIdx < selected.length ? selected[nextIdx] : null;
  // A refill-exhaustion revival reserves the next cursor before spawning so
  // the spawned first turn can claim it. Other advance triggers must not
  // consume that provisional head or send a second wake while the reviver is
  // still resolving.
  if (selected[params.cascadeCursor]?.revivalPending) {
    return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
  }

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
      const needed = Math.max(0, min - answers);
      type SnapCand = {
        ownerId: string;
        score?: number;
        relevance?: number;
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
        const relevance = typeof c.relevance === 'number' ? c.relevance : 0;
        const similarity = typeof c.signals?.similarity === 'number' ? c.signals.similarity : 0;
        return {
          ownerId: c.ownerId,
          // Honest floor-vs-minimum recomputed from the snapshot's own floors
          // (D-002: labeled, never silent) — a refill pick below them is a
          // best-available fill, not a costumed expert. Delegated rather than
          // re-implemented: this predicate has ONE home in relevance-router, so
          // a refill cannot be labeled by a rule the route itself no longer
          // uses. It also reads the snapshot's OWN generation, which matters
          // here because this column holds pre-D-001 records whose `floor`
          // gated a recency-bearing score.
          via: snapshotCandidateQualifies(snap, c) ? 'floor' : 'minimum',
          score,
          relevance,
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
      // Ordering: reserve the revived entry BEFORE the revive spawn. The
      // spawned session can issue its first consult:reply before the reviver
      // returns, so the reservation must be durable at the current cursor;
      // otherwise the first turn sees the old responder (or a terminal
      // no_qualified_responder state) and is refused. Finalization/fallback
      // below are CAS-guarded on that reservation so a first-turn reply can
      // claim and advance it without being overwritten by the reviver.
      let revival: AdvanceCascadeResult['revival'];
      let revivedEntry: CascadeSelectionEntry | null = null;
      let pendingRevivalOwner: string | null = null;
      let underFilledReason: NonNullable<AdvanceCascadeResult['underFilled']>['reason'] | null = null;
      const rawSelected = Array.isArray(sel.selected) ? (sel.selected as unknown[]) : [];
      const cursorIdx = selected.length;
      if (liveAdds.length < needed) {
        const revivable = untried.find(
          (c) => DEAD_RESPONDER_STATES.has(String(c.liveness ?? '')) && snapshotCandidateQualifies(snap, c),
        );
        if (!revive) underFilledReason = 'no-revive-dep';
        else if (revivalBudgetSpent(selected)) underFilledReason = 'budget-spent';
        else if (!revivable) underFilledReason = 'no-revivable-candidate';
        else {
          const pendingEntry = entryOf(revivable, { revivalPending: true });
          const pendingSnap = {
            ...snap,
            selection: {
              ...sel,
              selected: [...rawSelected, pendingEntry, ...liveAdds],
              // Reserve the same one-shot refill stamp that finalization will
              // write. If the pending owner replies before revive resolves,
              // advanceCascade must see the live fallback entries behind it.
              ...(!sel.refill
                ? {
                    refill: {
                      at: params.nowIso,
                      added: liveAdds.map((a) => a.ownerId),
                      reason: `cascade exhausted with ${answers} answer(s) < min ${min}`,
                    },
                  }
                : {}),
            },
          };
          const pendingExpiresAt = new Date(
            Date.parse(params.nowIso) +
              (params.latencyContract === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS),
          ).toISOString();
          const pendingWrote = (await sql`
            UPDATE harness_shared.consult_state
               SET cascade_cursor = ${cursorIdx},
                   responder_id = ${pendingEntry.ownerId},
                   state = ${params.stateOnAdvance},
                   expires_at = ${pendingExpiresAt}::timestamptz,
                   wakes_used = wakes_used + ${reach ? 1 : 0},
                   cascade_digest = ${sql.json(digest as never)},
                   routing = ${sql.json(pendingSnap as never)},
                   updated_at = ${params.nowIso}::timestamptz
             WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
               AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
               AND routing = ${sql.json(snap as never)}
            RETURNING conversation_id
          `) as unknown as Array<{ conversation_id: string }>;
          if (pendingWrote.length === 0) {
            return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
          }
          pendingRevivalOwner = revivable.ownerId;
          const r = await revive({
            ownerId: revivable.ownerId,
            conversationId: params.conversationId,
            brief: revivalBrief({
              routing: params.routing,
              requesterId: params.requesterId ?? 'the consult requester',
              question: params.question,
              conversationId: params.conversationId,
              candidate: {
                score: typeof revivable.score === 'number' ? revivable.score : 0,
                relevance: typeof revivable.relevance === 'number' ? revivable.relevance : 0,
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
        const updatedSnap = {
          ...snap,
          selection: {
            ...sel,
            selected: [...rawSelected, ...add],
            // The refill stamp guards the ONE live round (WI-39861) — stamped
            // whenever that round ran, even when it found nothing live (the
            // snapshot pool is static, so a later re-scan cannot do better).
            // A revival-only extension after the round keeps the old stamp.
            ...(!sel.refill
              ? {
                  refill: {
                    at: params.nowIso,
                    added: liveAdds.map((a) => a.ownerId),
                    reason: `cascade exhausted with ${answers} answer(s) < min ${min}`,
                  },
                }
              : {}),
          },
        };
        // Cursor lands on the FIRST refill entry: in the selectionFromRouting
        // view the adds append after the `selected.length` well-formed entries.
        const first = add[0]!;
        const expiresAt = new Date(
          Date.parse(params.nowIso) +
            (params.latencyContract === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS),
        ).toISOString();
        const willAttempt = Boolean(reach);
        const wrote = pendingRevivalOwner
          ? ((await sql`
              UPDATE harness_shared.consult_state
                 SET cascade_cursor = ${cursorIdx},
                     responder_id = ${first.ownerId},
                     state = ${params.stateOnAdvance},
                     expires_at = ${expiresAt}::timestamptz,
                     wakes_used = wakes_used + ${willAttempt ? 1 : 0},
                     cascade_digest = ${sql.json(digest as never)},
                     routing = ${sql.json(updatedSnap as never)},
                     updated_at = ${params.nowIso}::timestamptz
               WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
                 AND cascade_cursor = ${cursorIdx}
                 AND responder_id = ${pendingRevivalOwner}
                 AND closed_at IS NULL
                 AND routing #>> ARRAY['selection', 'selected', ${cursorIdx}::text, 'revivalPending'] = 'true'
              RETURNING conversation_id
            `) as unknown as Array<{ conversation_id: string }> )
          : ((await sql`
              UPDATE harness_shared.consult_state
                 SET cascade_cursor = ${cursorIdx},
                     responder_id = ${first.ownerId},
                     state = ${params.stateOnAdvance},
                     expires_at = ${expiresAt}::timestamptz,
                     wakes_used = wakes_used + ${willAttempt ? 1 : 0},
                     cascade_digest = ${sql.json(digest as never)},
                     routing = ${sql.json(updatedSnap as never)},
                     updated_at = ${params.nowIso}::timestamptz
               WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
                 AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
              RETURNING conversation_id
            `) as unknown as Array<{ conversation_id: string }>);
        if (wrote.length === 0) return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
        let woke = 0;
        if (reach) {
          const menuSize = selected.length + add.length;
          const copy = cascadeWakeCopyForRouting(params.routing)({
            question: params.question,
            conversationId: params.conversationId,
            position: cursorIdx + 1,
            menuSize,
            next: first,
            digest,
            extension: revivedEntry ? 'refill-exhaustion revival' : 'min-answers refill',
          });
          const r = await reach({
            responder: first.ownerId,
            conversationId: params.conversationId,
            summary: copy.summary,
            body: copy.body,
          });
          woke = r.woke;
        }
        return {
          advanced: true,
          exhausted: false,
          raced: false,
          next: { ownerId: first.ownerId, via: first.via },
          woke,
          ...(sel.refill ? {} : { refilled: true }),
          ...(revival ? { revival } : {}),
        };
      }
      // Nothing addable — HONEST terminal (EI-20864690354207496): the min
      // stays unfilled and the persisted snapshot says WHY, so "exhausted"
      // can never silently paper over a revivable-but-unrevived expert. The
      // caller still owns the terminal state transition. Written as a full
      // rewrite of the parsed snapshot (same style as the extension write
      // above, same CAS guard) — NOT jsonb_set on the column, which raises
      // "cannot set path in scalar" when the row's routing round-tripped as
      // a jsonb string scalar (the documented driver quirk
      // selectionFromRouting tolerates on the read side).
      const underFilled = {
        answers,
        min,
        reason: underFilledReason ?? 'no-revivable-candidate',
      };
      const terminalSnap = {
        ...snap,
        selection: { ...sel, underFilled: { at: params.nowIso, ...underFilled } },
      };
      const wroteTerminal = pendingRevivalOwner
        ? ((await sql`
            UPDATE harness_shared.consult_state
               SET cascade_digest = ${sql.json(digest as never)},
                   routing = ${sql.json(terminalSnap as never)},
                   updated_at = ${params.nowIso}::timestamptz
             WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
               AND cascade_cursor = ${cursorIdx}
               AND responder_id = ${pendingRevivalOwner}
               AND closed_at IS NULL
               AND routing #>> ARRAY['selection', 'selected', ${cursorIdx}::text, 'revivalPending'] = 'true'
            RETURNING conversation_id
          `) as unknown as Array<{ conversation_id: string }> )
        : ((await sql`
            UPDATE harness_shared.consult_state
               SET cascade_digest = ${sql.json(digest as never)},
                   routing = ${sql.json(terminalSnap as never)},
                   updated_at = ${params.nowIso}::timestamptz
             WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
               AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
            RETURNING conversation_id
          `) as unknown as Array<{ conversation_id: string }>);
      if (wroteTerminal.length === 0) return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
      return {
        advanced: false,
        exhausted: true,
        raced: false,
        next: null,
        woke: 0,
        underFilled,
        ...(revival ? { revival } : {}),
      };
    }
    const wrote = (await sql`
      UPDATE harness_shared.consult_state
         SET cascade_digest = ${sql.json(digest as never)},
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
           cascade_digest = ${sql.json(digest as never)},
           updated_at = ${params.nowIso}::timestamptz
     WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
       AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
    RETURNING conversation_id
  `) as unknown as Array<{ conversation_id: string }>;
  if (wrote.length === 0) return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };

  let woke = 0;
  if (reach) {
    const copy = cascadeWakeCopyForRouting(params.routing)({
      question: params.question,
      conversationId: params.conversationId,
      position: nextIdx + 1,
      menuSize: selected.length,
      next,
      digest,
    });
    const r = await reach({
      responder: next.ownerId,
      conversationId: params.conversationId,
      summary: copy.summary,
      body: copy.body,
    });
    woke = r.woke;
  }
  return { advanced: true, exhausted: false, raced: false, next: { ownerId: next.ownerId, via: next.via }, woke };
}
