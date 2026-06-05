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
  kind: 'handoff' | 'handoff_accepted';
  next_action?: string;
  files_modified?: string[];
}

export interface HandoffWithAcceptance {
  record: HandoffRecord;
  accepted_by?: HandoffRecord;
}

/** True if an arbitrary envelope is a handoff or acceptance record. */
export function isHandoffRecord(rec: CoordEnvelope): rec is HandoffRecord {
  return rec.kind === 'handoff' || rec.kind === 'handoff_accepted';
}

/**
 * Group handoff records: each `handoff` paired with its matching
 * `handoff_accepted` (by related_msg_id). Optionally filter to
 * open (no acceptance) / accepted. Sorted ascending by (ts, msg_id).
 */
export function foldHandoffs(
  records: HandoffRecord[],
  opts: { status?: 'open' | 'accepted' } = {},
): HandoffWithAcceptance[] {
  const handoffs = records.filter((r) => r.kind === 'handoff');
  const acceptsByTarget = new Map<string, HandoffRecord>();
  for (const r of records) {
    if (r.kind === 'handoff_accepted' && r.related_msg_id) {
      acceptsByTarget.set(r.related_msg_id, r);
    }
  }
  const out: HandoffWithAcceptance[] = handoffs
    .sort(compareByTsThenId)
    .map((h) => {
      const item: HandoffWithAcceptance = { record: h };
      const acc = acceptsByTarget.get(h.msg_id);
      if (acc) item.accepted_by = acc;
      return item;
    });
  if (opts.status === 'open') return out.filter((x) => !x.accepted_by);
  if (opts.status === 'accepted') return out.filter((x) => !!x.accepted_by);
  return out;
}
