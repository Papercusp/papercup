/**
 * handoffs.ts — handoff record shapes + the open↔acceptance grouping
 * fold. PURE.
 *
 * agent-coordination-architecture-v2 §6.4 (#8). A handoff is an
 * immutable event; an acceptance is a SIBLING event with
 * kind 'handoff_accepted' + related_msg_id pointing at the original.
 * `foldHandoffs` pairs each handoff with its acceptance (if any). The
 * per-event-file I/O lives behind the CoordEventLog seam.
 */

import { type CoordEnvelope, compareByTsThenId } from './envelope';

export interface OpenHandoffInput {
  to: string[];
  plan_slug: string;
  summary: string;
  body?: string;
  next_action?: string;
  files_modified?: string[];
  commit?: string;
}

export interface HandoffRecord extends CoordEnvelope {
  kind: 'handoff' | 'handoff_accepted' | 'handoff_expired';
  next_action?: string;
  files_modified?: string[];
}

export interface HandoffWithAcceptance {
  record: HandoffRecord;
  accepted_by?: HandoffRecord;
  /**
   * The sibling 'handoff_expired' record, if a reconcile auto-expired this
   * handoff after it sat pending past the TTL (no acceptance). Acceptance
   * dominates expiry: a handoff that is both accepted and expired counts as
   * accepted, never open/expired.
   */
  expired_by?: HandoffRecord;
}

/** True if an arbitrary envelope is a handoff, acceptance, or expiry record. */
export function isHandoffRecord(rec: CoordEnvelope): rec is HandoffRecord {
  return rec.kind === 'handoff' || rec.kind === 'handoff_accepted' || rec.kind === 'handoff_expired';
}

/**
 * Group handoff records: each `handoff` paired with its matching
 * `handoff_accepted` and/or `handoff_expired` sibling (by related_msg_id). A
 * `handoff_expired` is written by the stale-handoff reconcile when a handoff
 * sat pending past the TTL (no acceptance). Optionally filter to:
 *   - open     — neither accepted NOR expired (still genuinely pending)
 *   - accepted — has an acceptance
 *   - expired  — auto-expired and not accepted
 * Acceptance DOMINATES expiry: an accepted handoff is never open/expired, even
 * if a reconcile also wrote an expiry for it (a benign race). Sorted ascending
 * by (ts, msg_id).
 */
export function foldHandoffs(
  records: HandoffRecord[],
  opts: { status?: 'open' | 'accepted' | 'expired' } = {},
): HandoffWithAcceptance[] {
  const handoffs = records.filter((r) => r.kind === 'handoff');
  const acceptsByTarget = new Map<string, HandoffRecord>();
  const expiresByTarget = new Map<string, HandoffRecord>();
  for (const r of records) {
    if (!r.related_msg_id) continue;
    if (r.kind === 'handoff_accepted') acceptsByTarget.set(r.related_msg_id, r);
    else if (r.kind === 'handoff_expired') expiresByTarget.set(r.related_msg_id, r);
  }
  const out: HandoffWithAcceptance[] = handoffs
    .sort(compareByTsThenId)
    .map((h) => {
      const item: HandoffWithAcceptance = { record: h };
      const acc = acceptsByTarget.get(h.msg_id);
      if (acc) item.accepted_by = acc;
      const exp = expiresByTarget.get(h.msg_id);
      if (exp) item.expired_by = exp;
      return item;
    });
  if (opts.status === 'open') return out.filter((x) => !x.accepted_by && !x.expired_by);
  if (opts.status === 'accepted') return out.filter((x) => !!x.accepted_by);
  if (opts.status === 'expired') return out.filter((x) => !!x.expired_by && !x.accepted_by);
  return out;
}
