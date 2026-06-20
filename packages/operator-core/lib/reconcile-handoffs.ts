/**
 * reconcile-handoffs — auto-expire coordination handoffs left pending past the TTL
 * (F-FIX-037 "coord invariant: handoffs stuck pending past 12h").
 *
 * A handoff (coord:handoff) is an offer of work from one agent to another. It is an
 * IMMUTABLE coord_event_log record (surface 'handoffs'); acceptance is a SIBLING
 * 'handoff_accepted' record, and `foldHandoffs` pairs them. When an agent opens a
 * handoff that no one ever accepts, it sits `open` forever: coord:handoffs and the
 * fleet views show it as live pending work, and a successor told "pick up the open
 * handoff" chases a stale offer. There is no mutable status column to flip — the data
 * model is append-only events (NOT a `coord_handoffs` table).
 *
 * So this sweep writes a sibling 'handoff_expired' record (the SAME immutable pattern
 * as acceptance — it NEVER mutates the original) for every still-open handoff older
 * than the TTL; the fold then drops it out of `status:'open'`. Idempotent: an expired
 * handoff is no longer `open`, so re-running skips it. Mirrors reconcile-escalations.
 */

import { listHandoffs, expireHandoff } from './agent-tools/coordination/handoffs';

/** Resolver identity stamped on auto-expired handoffs (audit trail). */
export const RECONCILE_HANDOFF_OWNER = 'system:handoff-reconcile';

/**
 * TTL for a pending handoff before auto-expiry: 12h (F-FIX-037). Override via
 * PAPERCUSP_STALE_HANDOFF_TTL_MS. A handoff still unaccepted after 12h is, in
 * practice, abandoned — the intended recipient has moved on or never woke to it;
 * keeping it `open` only misleads successors.
 */
export const STALE_HANDOFF_TTL_MS = (() => {
  const env = Number(process.env.PAPERCUSP_STALE_HANDOFF_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : 12 * 60 * 60 * 1000;
})();

/** Max handoffs expired per sweep tick — a safety bound; the pending volume is small. */
export const RECONCILE_HANDOFF_BATCH_LIMIT = 500;

export interface StalePendingHandoffInput {
  msg_id: string;
  /** ISO timestamp the handoff was opened. */
  ts: string;
}

export interface StalePendingHandoff {
  msg_id: string;
  ageHours: number;
}

/**
 * PURE: which OPEN handoffs are stale (opened older than `ttlMs`), oldest first so a
 * batch-limited sweep drains the longest-stale first. Input is the record side of
 * listHandoffs({status:'open'}) — already filtered to neither accepted nor expired,
 * so this only applies the age gate.
 */
export function selectStalePendingHandoffs(
  opens: readonly StalePendingHandoffInput[],
  ctx: { nowMs: number; ttlMs?: number },
): StalePendingHandoff[] {
  const ttl = ctx.ttlMs ?? STALE_HANDOFF_TTL_MS;
  const out: StalePendingHandoff[] = [];
  for (const h of opens) {
    const openedMs = Date.parse(h.ts);
    if (!Number.isFinite(openedMs)) continue;
    const ageMs = ctx.nowMs - openedMs;
    if (ageMs >= ttl) out.push({ msg_id: h.msg_id, ageHours: ageMs / 3_600_000 });
  }
  out.sort((a, b) => b.ageHours - a.ageHours);
  return out;
}

export interface ReconcileHandoffResult {
  scanned: number;
  stale: number;
  expired: number;
  /** True when the stale backlog exceeded the batch limit (more remain for next tick). */
  truncated: boolean;
}

/**
 * One reconciliation pass: load open handoffs, expire the stale ones (up to the batch
 * limit) by writing a sibling 'handoff_expired' record each. Idempotent — an
 * already-expired handoff drops out of `open`, so re-running is a no-op for it.
 */
export async function reconcileStalePendingHandoffsOnce(
  opts: { nowMs?: number; ttlMs?: number; limit?: number } = {},
): Promise<ReconcileHandoffResult> {
  const opens = await listHandoffs({ status: 'open' });
  const nowMs = opts.nowMs ?? Date.now();
  const inputs: StalePendingHandoffInput[] = opens.map((h) => ({ msg_id: h.record.msg_id, ts: h.record.ts }));
  const stale = selectStalePendingHandoffs(inputs, { nowMs, ttlMs: opts.ttlMs });
  const limit = opts.limit ?? RECONCILE_HANDOFF_BATCH_LIMIT;
  const batch = stale.slice(0, limit);

  let expired = 0;
  for (const s of batch) {
    const rec = await expireHandoff(s.msg_id, {
      by: RECONCILE_HANDOFF_OWNER,
      note: `auto-expired: handoff pending ${Math.round(s.ageHours)}h with no acceptance (F-FIX-037 coord invariant)`,
    });
    if (rec) expired += 1;
  }

  return { scanned: opens.length, stale: stale.length, expired, truncated: stale.length > batch.length };
}
