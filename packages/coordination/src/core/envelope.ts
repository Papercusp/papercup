/**
 * envelope.ts — the typed line shape every coordination channel shares,
 * plus the monotonic id minter. PURE: no filesystem, no database.
 *
 * The fs/PG read+write of these envelopes lives behind the
 * `CoordEventLog` seam (../event-log); this module is only the
 * vocabulary + id generation that both the seam and the host share.
 *
 * (Extracted from apps/operator/lib/agent-tools/coordination/envelope.ts
 * — agent-coordination-architecture-v2 §6.2/§6.3.)
 */

import { randomUUID } from 'node:crypto';

export type CoordKind =
  | 'message'
  | 'ack'
  | 'subscribe'
  | 'unsubscribe'
  | 'notify'
  | 'handoff'
  | 'handoff_accepted'
  | 'escalation'
  | 'escalation_resolved'
  | 'contract'
  | 'plan_event';

export interface CoordEnvelope {
  /** ISO-8601 UTC. */
  ts: string;
  /** Time-prefixed unique id; sortable lexicographically. */
  msg_id: string;
  /** Writer's stable owner id. */
  from: string;
  /** Recipients. ['*'] = broadcast; ownerIds otherwise; ['human'] = surface to the user. */
  to: string[];
  kind: CoordKind;
  summary?: string;
  body?: string;
  files?: string[];
  /** Head SHA at write time. */
  commit?: string;
  plan_slug?: string;
  /** For acks / replies / resolutions — points at the originating msg_id. */
  related_msg_id?: string;
  /** Kind-specific extras (e.g. subscribe.pattern, escalation.options). */
  [key: string]: unknown;
}

/**
 * Generate a coord msg_id. Format: `<ms-base36>-<seq-base36>-<hex>` —
 * lex-monotonic by construction within one process even across multiple
 * ids minted in the same millisecond, so a downstream sort by
 * (ts, msg_id) is deterministic.
 */
let _lastMs = 0;
let _seq = 0;
export function newMsgId(): string {
  const now = Date.now();
  if (now === _lastMs) {
    _seq += 1;
  } else {
    _lastMs = now;
    _seq = 0;
  }
  const ms = now.toString(36).padStart(8, '0');
  const seq = _seq.toString(36).padStart(4, '0');
  const rnd = randomUUID().replace(/-/g, '');
  return `${ms}-${seq}-${rnd}`;
}

/**
 * Stable (ts, msg_id) comparator — the canonical ordering for every
 * coordination surface. Both the fold helpers and the seam impls sort
 * by this so reads are deterministic regardless of file/row order.
 */
export function compareByTsThenId(a: CoordEnvelope, b: CoordEnvelope): number {
  return a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id);
}
