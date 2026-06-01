/**
 * messages.ts — operator host adapter for the L3 message + ack substrate.
 *
 * The envelope shapes + the inbox-filter / thread-fold logic live in
 * @papercusp/coordination/core; the per-sender-outbox I/O lives behind
 * the CoordEventLog seam (coordLog). This file keeps the original
 * function surface (sendMessage / appendAck / readInbox / readThread)
 * so every caller + test is unchanged.
 *
 * agent-coordination-architecture-v2 §6.4 (#6).
 */

import {
  newMsgId,
  filterInbox,
  foldThread,
  type CoordEnvelope,
  type CoordKind,
  type InboxOptions,
} from '@papercusp/coordination/core';
import { coordLog } from './log';
import type { AgentIdentity } from './identity';

export type { InboxOptions };

/** Options for sendMessage / generalised coord append. */
export interface SendOptions {
  /** Recipient ownerIds. Use ['*'] for broadcast, ['human'] for the human inbox. */
  to: string[];
  summary?: string;
  body?: string;
  files?: string[];
  plan_slug?: string;
  related_msg_id?: string;
  /** Originating harness slug, when the sender is a harness-scoped agent.
   *  Lets the human inbox open a chat scoped to the right harness (most
   *  agent→human messages are about a specific harness). Omitted for
   *  workspace-level senders (operator/oracle/SU broadcasts). */
  harnessSlug?: string;
  /** Default 'message'. Use other kinds for typed channel writes. */
  kind?: CoordKind;
}

/** Append a new envelope to the caller's outbox. */
export async function sendMessage(
  identity: AgentIdentity,
  opts: SendOptions,
): Promise<CoordEnvelope> {
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: opts.to,
    kind: opts.kind ?? 'message',
  };
  if (opts.summary !== undefined) env.summary = opts.summary;
  if (opts.body !== undefined) env.body = opts.body;
  if (opts.files !== undefined) env.files = opts.files;
  if (opts.plan_slug !== undefined) env.plan_slug = opts.plan_slug;
  if (opts.related_msg_id !== undefined) env.related_msg_id = opts.related_msg_id;
  if (opts.harnessSlug !== undefined) env.harnessSlug = opts.harnessSlug;
  await coordLog.appendLine('messages', identity.ownerId, env);
  return env;
}

/**
 * Append an ack for `targetMsgId`, addressed back to the message's
 * sender. The acker's own outbox is the writer.
 */
export async function appendAck(
  identity: AgentIdentity,
  targetMsgId: string,
  targetFrom: string,
): Promise<CoordEnvelope> {
  return sendMessage(identity, {
    to: [targetFrom],
    kind: 'ack',
    related_msg_id: targetMsgId,
  });
}

/**
 * Read everything addressed to `ownerId` (or to '*') across all outboxes.
 * Sorted by ts ascending; forgiving of malformed/missing files.
 */
export async function readInbox(
  ownerId: string,
  opts: InboxOptions = {},
): Promise<CoordEnvelope[]> {
  const lines = await coordLog.readLines('messages');
  return filterInbox(lines, ownerId, opts);
}

/**
 * Msg-ids that `ackerOwnerId` has acknowledged — the `related_msg_id` of every
 * `ack` envelope THEY authored. Acks were always written (appendAck) but never
 * folded out of any view, so a coord-message inbox "Acknowledge" had no visible
 * effect. The Planning inbox uses this to dismiss acked messages.
 *
 * SECURITY: scoped to the acker's own acks (`l.from === ackerOwnerId`) — never
 * global. A global set would let ANY agent's ack of a broadcast (to:['*'])
 * suppress that message from the human's inbox even though the human never
 * acked it (visibility suppression). Callers pass the principal whose inbox is
 * being rendered, so only that principal's own acks dismiss their view.
 */
export async function readAckedMsgIds(ackerOwnerId: string): Promise<Set<string>> {
  const acked = new Set<string>();
  if (!ackerOwnerId) return acked;
  const lines = await coordLog.readLines('messages');
  for (const l of lines) {
    if (l.kind === 'ack' && l.from === ackerOwnerId && typeof l.related_msg_id === 'string') {
      acked.add(l.related_msg_id);
    }
  }
  return acked;
}

/**
 * Reconstruct a thread rooted at `rootMsgId` by walking the
 * `related_msg_id` chain in both directions. Sorted by ts ascending.
 */
export async function readThread(rootMsgId: string): Promise<CoordEnvelope[]> {
  const all = await coordLog.readLines('messages');
  return foldThread(all, rootMsgId);
}
