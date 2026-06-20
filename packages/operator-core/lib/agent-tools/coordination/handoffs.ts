/**
 * handoffs.ts — operator host adapter for agent → agent work handoffs.
 *
 * Record shapes + the open↔acceptance grouping fold live in
 * @papercusp/coordination/core; the per-event-file I/O lives behind the
 * CoordEventLog seam (coordLog). Original function surface preserved.
 *
 * agent-coordination-architecture-v2 §6.4 (#8). A handoff is an
 * immutable event; an acceptance is a sibling event with
 * kind 'handoff_accepted' + related_msg_id. No in-place mutation.
 */

import {
  newMsgId,
  foldHandoffs,
  isHandoffRecord,
  type HandoffRecord,
  type HandoffWithAcceptance,
  type OpenHandoffInput,
} from '@papercusp/coordination/core';
import { coordLog } from './log';
import type { AgentIdentity } from './identity';

export type { OpenHandoffInput, HandoffRecord, HandoffWithAcceptance };

/** Open a new handoff — writes the per-event record. */
export async function openHandoff(
  identity: AgentIdentity,
  input: OpenHandoffInput,
): Promise<HandoffRecord> {
  const env: HandoffRecord = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: input.to,
    kind: 'handoff',
    plan_slug: input.plan_slug,
    summary: input.summary,
  };
  if (input.body !== undefined) env.body = input.body;
  if (input.next_action !== undefined) env.next_action = input.next_action;
  if (input.files_modified !== undefined) env.files_modified = input.files_modified;
  if (input.commit !== undefined) env.commit = input.commit;
  await coordLog.putEvent('handoffs', env.msg_id, env);
  return env;
}

/**
 * Accept a handoff by msg_id — writes a sibling 'handoff_accepted'
 * record. Returns the new acceptance, or null when the target is absent.
 */
export async function acceptHandoff(
  identity: AgentIdentity,
  targetMsgId: string,
  note?: string,
): Promise<HandoffRecord | null> {
  const target = await getHandoff(targetMsgId);
  if (!target) return null;
  const env: HandoffRecord = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: [target.from],
    kind: 'handoff_accepted',
    related_msg_id: targetMsgId,
    plan_slug: target.plan_slug,
    summary: note ?? `accepted handoff from ${target.from}`,
  };
  await coordLog.putEvent('handoffs', env.msg_id, env);
  return env;
}

/**
 * Auto-expire a still-pending handoff by msg_id — writes a sibling
 * 'handoff_expired' record (the SAME immutable pattern as acceptHandoff; the
 * original handoff is never mutated). Used by the stale-handoff reconcile when a
 * handoff has sat pending past the TTL with no acceptance. Returns the new expiry
 * record, or null when the target handoff is absent. `by` is the system reconcile
 * owner; `to` notifies the handoff's opener that their offer lapsed.
 */
export async function expireHandoff(
  targetMsgId: string,
  opts: { by: string; note?: string },
): Promise<HandoffRecord | null> {
  const target = await getHandoff(targetMsgId);
  if (!target) return null;
  const env: HandoffRecord = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: opts.by,
    to: [target.from],
    kind: 'handoff_expired',
    related_msg_id: targetMsgId,
    plan_slug: target.plan_slug,
    summary: opts.note ?? 'auto-expired: handoff pending past the TTL with no acceptance',
  };
  await coordLog.putEvent('handoffs', env.msg_id, env);
  return env;
}

/** Read one handoff record by msg_id. */
export async function getHandoff(msgId: string): Promise<HandoffRecord | null> {
  const rec = await coordLog.getEvent('handoffs', msgId);
  return rec && isHandoffRecord(rec) ? rec : null;
}

/**
 * List handoffs (with acceptance/expiry status), optionally filtered to
 * open / accepted / expired.
 */
export async function listHandoffs(
  opts: { status?: 'open' | 'accepted' | 'expired' } = {},
): Promise<HandoffWithAcceptance[]> {
  const records = (await coordLog.readEvents('handoffs')).filter(isHandoffRecord);
  return foldHandoffs(records, opts);
}
