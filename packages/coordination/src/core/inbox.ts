/**
 * inbox.ts — the pure inbox filter predicate. PURE.
 *
 * Given every line loaded from the message surfaces, select the ones
 * addressed to `ownerId` (or broadcast), honouring the since/kind/
 * exclude-own options. The union-scan I/O lives behind the CoordEventLog
 * seam; this is the filter + sort over what was loaded.
 *
 * (Extracted from coordination/messages.ts:readInbox.)
 */

import { type CoordEnvelope, type CoordKind, compareByTsThenId } from './envelope';

export interface InboxOptions {
  /** Only return envelopes whose ts is strictly after this ISO timestamp. */
  since_ts?: string;
  /** Filter to one or more kinds. Omit for all kinds. */
  kinds?: CoordKind[];
  /** Filter out the caller's own outbox lines (default true). */
  excludeOwn?: boolean;
}

/**
 * Filter `lines` to those addressed to `ownerId` (or `'*'`), applying the
 * inbox options. Sorted ascending by (ts, msg_id).
 */
export function filterInbox(
  lines: CoordEnvelope[],
  ownerId: string,
  opts: InboxOptions = {},
): CoordEnvelope[] {
  const excludeOwn = opts.excludeOwn ?? true;
  const sinceMs = opts.since_ts ? new Date(opts.since_ts).getTime() : 0;
  const kindFilter = opts.kinds ? new Set<CoordKind>(opts.kinds) : null;
  const out: CoordEnvelope[] = [];
  for (const l of lines) {
    if (excludeOwn && l.from === ownerId) continue;
    if (!Array.isArray(l.to)) continue;
    if (!l.to.includes(ownerId) && !l.to.includes('*')) continue;
    if (sinceMs && new Date(l.ts).getTime() <= sinceMs) continue;
    if (kindFilter && !kindFilter.has(l.kind)) continue;
    out.push(l);
  }
  return out.sort(compareByTsThenId);
}
