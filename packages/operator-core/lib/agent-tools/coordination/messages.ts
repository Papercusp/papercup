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
import { coordLog, coordWorkspaceId, coordSql } from './log';
import { hasAudienceSelector, expandAudience } from './audience';
import { hostAudienceResolvers, audienceMode } from './audience-host';
import { slotSelectorsIn, parseSlotSelector } from './slot-selector';
import { parkSlotMessage, drainUserMailbox } from './slot-parked-store';
import type { AgentIdentity } from './identity';
import { resolveBestEffortAgainstRoster } from './recipient-resolve';

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
  /** Ambient-classification tag (e.g. 'service-health'). A categorised message
   *  is still a message, but coord:inbox default-excludes ambient categories. */
  category?: string;
  /** Extra envelope keys merged verbatim (e.g. the auto-lifecycle markers
   *  `auto:true` + `lifecycle:'<category>'` that `coord:emit` stamps so the
   *  inbox can distinguish system-emitted lifecycle from human-authored
   *  coord:send — coord-lifecycle-automation-2026-06-04). Reserved envelope
   *  fields (ts/msg_id/from/to/kind) are NOT overridable. */
  extra?: Record<string, unknown>;
}

/** Append a new envelope to the caller's outbox. */
export async function sendMessage(
  identity: AgentIdentity,
  opts: SendOptions,
): Promise<CoordEnvelope> {
  // Audience-selector expansion (coord-emit-subscription-scoping-2026-06-05): a
  // `to[]` carrying `@plan:`/`@topic:`/`@object:`/`@file:` selectors resolves to
  // the concrete ownerIds watching that plan/topic/work-item. Zero-overhead when
  // no selector is present (the overwhelmingly common case). The EXPANDED set is
  // stored on the envelope so the inbox filter + federation projection are
  // unchanged (D-001/D-003); an empty resolution → empty `to` → no inbox
  // delivery, but the row still persists (D-004).
  // B2 / park-for-slot: @role:/@wave:/@feature: entries address a SLOT that may
  // have no agent yet — split them off so they PARK (below) instead of resolving
  // to live ownerIds; only the non-slot addressees are delivered now.
  const slots = slotSelectorsIn(opts.to);
  const liveAddrs = slots.length
    ? opts.to.filter((t) => parseSlotSelector(t) === null)
    : opts.to;
  const toExpanded = hasAudienceSelector(liveAddrs)
    ? await expandAudience(liveAddrs, hostAudienceResolvers, audienceMode())
    : liveAddrs;
  // owner-2026-06-17: resolve short ownerId PREFIXES to full ids so inbox delivery
  // + any inbox-wake hit the right recipient. Best-effort + fail-soft; an
  // all-selector/broadcast `to` skips the roster read entirely.
  const to = await resolveBestEffortAgainstRoster(toExpanded, identity.workspaceId);
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to,
    kind: opts.kind ?? 'message',
  };
  if (opts.summary !== undefined) env.summary = opts.summary;
  if (opts.body !== undefined) env.body = opts.body;
  if (opts.category !== undefined) env.category = opts.category;
  if (opts.files !== undefined) env.files = opts.files;
  if (opts.plan_slug !== undefined) env.plan_slug = opts.plan_slug;
  if (opts.related_msg_id !== undefined) env.related_msg_id = opts.related_msg_id;
  // Canonical snake_case envelope field (matches plan_slug/msg_id/related_msg_id
  // and the coord_event_log.harness_slug column PgCoordLog projects it to for
  // federation — distributed-coordination-shared-harness-2026-06-04 Track A).
  if (opts.harnessSlug !== undefined) env.harness_slug = opts.harnessSlug;
  // Merge caller-supplied extra keys LAST, but never let them clobber the
  // reserved envelope fields (identity + addressing integrity).
  if (opts.extra) {
    const RESERVED = new Set(['ts', 'msg_id', 'from', 'to', 'kind']);
    for (const [k, v] of Object.entries(opts.extra)) {
      if (!RESERVED.has(k) && v !== undefined) env[k] = v;
    }
  }
  // Park the envelope durably for each addressed slot (./slot-parked-store) —
  // drained into the spawnee's handoff when an agent spawns into the slot (P-023).
  if (slots.length) {
    // Use the coord seam's handle + workspace (NOT getOrgPg()+'default') so the
    // parked rows live on the SAME DB/workspace as the coord messages this
    // sendMessage writes — a swapped seam (tests, non-default workspace) would
    // otherwise split them. Mirrors readAckedMsgIds.
    const sql = coordSql();
    const ws = coordWorkspaceId();
    const nowMs = Date.now();
    for (const slot of slots) {
      await parkSlotMessage(sql, { slot, harnessSlug: opts.harnessSlug ?? null, envelope: env, nowMs, workspaceId: ws });
    }
  }
  // Deliver to the live inbox when there's a live audience — or when there were
  // no slots at all (preserve the legacy "audience resolved to nobody still
  // persists the row" behaviour, ./audience D-004). A purely-slot send is
  // delivered by the park alone.
  if (liveAddrs.length > 0 || slots.length === 0) {
    await coordLog.appendLine('messages', identity.ownerId, env);
  }
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
 * Deliver any `@user:`-parked messages waiting for a returning member into their
 * live inbox — the offline-member-assign mailbox (shared-hive-collaboration P-016).
 *
 * An assignment to an absent member is parked under `@user:<actorUserKey>`
 * (slot-parked-store) and writes NO coord_event_log row (a purely-slot send is
 * delivered by the park alone — see sendMessage). When that member's session
 * RETURNS, this drains (claim-once) every pending row matching one of their
 * candidate `keys` (actorMailboxKeys) and re-appends each envelope to the message
 * log addressed to their live `ownerId`, so it surfaces as a normal inbox card —
 * the same envelope, so the original assigner (`from`) + summary/body/plan_slug are
 * preserved. The claim-once UPDATE makes a second session a no-op, so re-delivery
 * is never a duplicate. Returns the delivered envelopes (the caller may fire an
 * optimistic inbox-wake on a presence-arrival edge).
 *
 * This is the `@user:` analog of the spawn-path deliver-on-spawn (P-023) — same
 * store, a presence/inbox-read trigger instead of a spawn trigger.
 */
export async function drainAndDeliverUserMailbox(
  keys: readonly string[],
  ownerId: string,
): Promise<CoordEnvelope[]> {
  if (!ownerId || keys.length === 0) return [];
  const sql = coordSql();
  const ws = coordWorkspaceId();
  const drained = await drainUserMailbox(sql, {
    keys,
    toOwner: ownerId,
    nowMs: Date.now(),
    workspaceId: ws,
  });
  for (const env of drained) {
    await coordLog.appendLine('messages', env.from, { ...env, to: [ownerId] });
  }
  return drained;
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
 *
 * Optimized to query database directly (EI-401): avoid loading all messages
 * when table is large; use WHERE kind='ack' AND from=? filter at DB level.
 */
export async function readAckedMsgIds(ackerOwnerId: string): Promise<Set<string>> {
  const acked = new Set<string>();
  if (!ackerOwnerId) return acked;
  try {
    // Run on the SAME handle + workspace the coordLog seam reads/writes (NOT
    // getOrgPg()+'default'): the acks were written through the seam, so a swapped
    // seam (tests, non-default workspace) would otherwise query the wrong DB /
    // scope and find nothing. Matches readInbox exactly.
    const sql = coordSql();
    const rows = await sql<{ related_msg_id: string | null }[]>`
      SELECT body->>'related_msg_id' AS related_msg_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND body->>'kind' = 'ack'
         AND body->>'from' = ${ackerOwnerId}
    `;
    for (const row of rows) {
      if (typeof row.related_msg_id === 'string') {
        acked.add(row.related_msg_id);
      }
    }
  } catch {
    // Fallback to the slow path if the query fails
    const lines = await coordLog.readLines('messages');
    for (const l of lines) {
      if (l.kind === 'ack' && l.from === ackerOwnerId && typeof l.related_msg_id === 'string') {
        acked.add(l.related_msg_id);
      }
    }
  }
  return acked;
}

/**
 * Read everything `ownerId` SENT — every envelope whose `from === ownerId`,
 * across the whole message log. The outbox half of the per-bee mail view
 * (pui-bee-dossier-pane-2026-06-06). Sorted by ts ascending; `since_ts` filters
 * strictly later than the given ISO timestamp.
 */
export async function readOutbox(
  ownerId: string,
  opts: { since_ts?: string } = {},
): Promise<CoordEnvelope[]> {
  const lines = await coordLog.readLines('messages');
  const sinceMs = opts.since_ts ? new Date(opts.since_ts).getTime() : 0;
  return lines
    .filter((l) => l.from === ownerId)
    .filter((l) => !sinceMs || new Date(l.ts).getTime() > sinceMs)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
}

/**
 * Reconstruct a thread rooted at `rootMsgId` by walking the
 * `related_msg_id` chain in both directions. Sorted by ts ascending.
 */
export async function readThread(rootMsgId: string): Promise<CoordEnvelope[]> {
  const all = await coordLog.readLines('messages');
  return foldThread(all, rootMsgId);
}
