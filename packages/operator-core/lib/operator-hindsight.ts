/**
 * operator-hindsight — the "while you were away" channel on the coord substrate
 * (plan collapse-delegate-into-workitems-2026-06-04, D-003).
 *
 * Replaces the bespoke harness_shared.delegate_inbox poll. A hindsight notification
 * (an async delegate finished, a scan surfaced suggestions) is a coord `notify`
 * addressed to the operator owner — subscribe→inject, push not poll. The voice
 * surface drains the operator's coord inbox on connect and speaks a "[While you were
 * away]" briefing.
 *
 * Non-destructive drain: rather than a DELETE/delivered-flag, the voice surface ACKS
 * each notify it surfaces (the existing coord ack mechanism, scoped to the voice
 * owner so it never suppresses the message from the operator's own curation view).
 * A re-drain excludes already-acked notifies.
 */
import { coordLog, coordSql, coordWorkspaceId, coordHasPgFastPath } from './agent-tools/coordination/log';
import { readInbox, readAckedMsgIds, appendAck } from './agent-tools/coordination/messages';
import { collectRetractedIds, suppressRetracted } from './agent-tools/coordination/retraction';
import { OPERATOR_COORD_OWNER } from './delegated-tasks';
import { newMsgId, type CoordEnvelope } from '@papercusp/coordination/core';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** The notify_kind that marks a "while you were away" briefing line. */
export const HINDSIGHT_NOTIFY_KIND = 'operator_hindsight';

/** The ack-owner the voice surface acks AS when it drains the hindsight channel.
 *  Scoped acks (readAckedMsgIds) mean this never hides the notify from the operator. */
export const VOICE_HINDSIGHT_OWNER = 'voice-hindsight';

const VOICE_IDENTITY: AgentIdentity = {
  ownerId: VOICE_HINDSIGHT_OWNER,
  ownerLabel: 'voice',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface HindsightItem {
  headline: string;
  kind: string;
}

/**
 * Push one hindsight notification into the operator's coord inbox. Used when a live
 * voice session was NOT available to receive it directly (async delegate completion,
 * scan completion). `kind` is a free-form sub-tag for the rendering side.
 *
 * TWO deliveries per notification (operator-chat-sidebar-revival-2026-07-13 P-008):
 *   1. The coord `notify` — the voice surface drains + speaks it on connect
 *      ("[While you were away] …"). Unchanged.
 *   2. A `system` turn appended to the SHARED operator conversation — the thread the
 *      desktop chat sidebar / phone / TUI all render live. Before this, hindsight was
 *      voice-drain-ONLY: with the native dock testing-gated dark (D-004) and voice
 *      off, a settled deep-dive answer or handoff landing sat invisibly in the coord
 *      inbox and the typed-turn user never saw it. The thread append makes the answer
 *      land where the user actually asked the question. Fail-soft both ways: a
 *      thread-append failure never loses the coord notify (and vice versa).
 */
export async function notifyOperatorHindsight(headline: string, kind = 'delegate-complete'): Promise<void> {
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: 'substrate',
    to: [OPERATOR_COORD_OWNER],
    kind: 'notify',
    summary: headline,
    notify_kind: HINDSIGHT_NOTIFY_KIND,
    hindsight_kind: kind,
  };
  await coordLog.appendLine('messages', OPERATOR_COORD_OWNER, env).catch(() => {});
  // Leg 2: land it in the shared conversation thread. Dynamic imports — this module
  // is coord-substrate-level; PG conversations must not become a static dep of it.
  try {
    const [{ getOrCreateActiveConversation, appendTurn }, { notifySyncInvalidate }] =
      await Promise.all([import('./operator-conversations'), import('./sync-sse')]);
    const conversation = await getOrCreateActiveConversation();
    await appendTurn({
      conversationId: conversation.id,
      role: 'system',
      text: `[While you were away] ${headline}`,
      source: 'system',
    });
    void notifySyncInvalidate('operatorTurns.page', {
      conversationId: conversation.id,
    }).catch(() => {});
  } catch (err) {
    console.warn(
      '[operator-hindsight] shared-thread append failed (coord notify still delivered):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/*
 * EI-19323045109346905 — these two readInbox callers are DELIBERATELY NOT converted
 * to the bounded `window` read, and this comment exists so the next person working
 * that item does not "finish the job" and make them slower. Measured 2026-08-02.
 *
 * A `window` stopping rule is POST-FILTER: readInboxWindow pages until
 * `enough(visible(rows))` returns true, and that is its ONLY early exit
 * (messages.ts, `satisfied:`). So a bounded window is a win only when the
 * caller's filter matches DENSELY enough to hit the threshold in the first page
 * or two. When the filter matches RARELY, `enough` never fires and the pager
 * walks the whole history anyway — in up to INBOX_MAX_PAGES (25) round-trips
 * instead of the single INBOX_FAST_PATH_ROW_CAP query it replaced. That is
 * strictly worse, and it degrades silently (only warnOnPageBudgetExhausted
 * notices).
 *
 * This filter is the sparse case, by construction and in fact:
 *   - it selects one notify_kind (HINDSIGHT_NOTIFY_KIND) that is ALSO unacked, and
 *   - live count of `operator_hindsight` rows in coord_event_log: 0, against 1,296
 *     notify rows overall (the channel is dormant — `notifyOperatorHindsight` has
 *     production callers, but the read side currently has none outside tests).
 * Zero matches is the pathological input for a post-filter rule: it can never be
 * satisfied, so it always pays the maximum.
 *
 * If these ever need bounding, the right lever is a `since_ts` lower bound (which
 * IS pushed into SQL — unlike `kinds`, which filterInbox applies in JS afterwards),
 * or a targeted COUNT for peek. Not `enough`.
 */

/**
 * Drain the operator's pending hindsight notifications (those not yet acked by the
 * voice surface), acking each so it does not replay on the next connect. Returns the
 * headlines for the "[While you were away]" briefing.
 */
export async function drainOperatorHindsight(): Promise<HindsightItem[]> {
  const [inbox, acked] = await Promise.all([
    readInbox(OPERATOR_COORD_OWNER, { kinds: ['notify'] }),
    readAckedMsgIds(VOICE_HINDSIGHT_OWNER),
  ]);
  const fresh = inbox.filter(
    (m) => m.kind === 'notify' && m.notify_kind === HINDSIGHT_NOTIFY_KIND && !acked.has(m.msg_id),
  );
  for (const m of fresh) {
    const from = typeof m.from === 'string' ? m.from : 'substrate';
    await appendAck(VOICE_IDENTITY, m.msg_id, from).catch(() => {});
  }
  return fresh.map((m) => ({
    headline: typeof m.summary === 'string' ? m.summary : '',
    kind: typeof m.hindsight_kind === 'string' ? m.hindsight_kind : 'delegate-complete',
  })).filter((x) => x.headline);
}

/** Count of undrained hindsight notifications (peek). */
export async function peekOperatorHindsight(): Promise<{ pending: number }> {
  const [inbox, acked] = await Promise.all([
    readInbox(OPERATOR_COORD_OWNER, { kinds: ['notify'] }),
    readAckedMsgIds(VOICE_HINDSIGHT_OWNER),
  ]);
  const pending = inbox.filter(
    (m) => m.kind === 'notify' && m.notify_kind === HINDSIGHT_NOTIFY_KIND && !acked.has(m.msg_id),
  ).length;
  return { pending };
}
