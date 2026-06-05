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
import { coordLog } from './agent-tools/coordination/log';
import { readInbox, readAckedMsgIds, appendAck } from './agent-tools/coordination/messages';
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
}

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
