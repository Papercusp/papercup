/**
 * inbox-wake.ts — the deliver-and-wake key convention + the single-target
 * wake fan (local-hive-orchestration-2026-06-06 Phase 4: P-040/P-041/P-042,
 * D-005).
 *
 * `coord:send` is inbox-inject by default (unify-watch D-002 — inject is cheap,
 * wake is the deliberate opt-in). When a sender passes `{ wake:true }` the
 * message still lands in the inbox AND we fire each addressed recipient's OWN
 * inbox-wake key through the shipped await-event pump (the floor + coalesce +
 * liveness-ladder built in unify-watch). We do NOT build a second wake pump —
 * this just composes `emitAwaitedEvent`.
 *
 * The wake-key convention is the per-recipient pair to the standing watch an
 * idle bee registers (P-041): a bee that ends a turn idle registers
 * `watch:create { pattern: inboxWakeKey(self), wake:true, once:false }` and
 * sleeps; a later `coord:send {wake:true, to:[bee]}` re-invokes exactly it.
 *
 * SINGLE-TARGET, NEVER A BROADCAST (P-042 / unify-watch P-008/D-005, the
 * lock-grant-bridge pattern): each wake is one `emitAwaitedEvent` on
 * `coord:inbox-wake:<ownerId>` — a key only THAT owner ever watches. We fan one
 * emit per addressed ownerId; we never emit on a wildcard/shared key, so the
 * pump only resumes the addressee(s), never the whole fleet (a wildcard would
 * thunder-herd N sleeping agents into N billable turns).
 */

import { emitAwaitedEvent } from '../../events/await/engine';

/** Prefix for the per-agent inbox-wake key. A bee watches `inboxWakeKey(self)`;
 *  a `{wake:true}` send to that bee fires exactly this key. */
export const COORD_INBOX_WAKE_PREFIX = 'coord:inbox-wake:';

/** The wake key for one recipient ownerId. The standing-watch pattern and the
 *  send-side fire MUST agree on this string — it is the rendezvous. */
export function inboxWakeKey(ownerId: string): string {
  return `${COORD_INBOX_WAKE_PREFIX}${ownerId}`;
}

/** Recover the ownerId from an inbox-wake key (null if it isn't one). */
export function ownerFromInboxWakeKey(key: string): string | null {
  return key.startsWith(COORD_INBOX_WAKE_PREFIX) ? key.slice(COORD_INBOX_WAKE_PREFIX.length) : null;
}

/** Addressees we never wake even when `wake:true`: the broadcast wildcard and
 *  the human inbox (the human is not a wake-resumable agent; '*' would be the
 *  exact thunder-herd P-042 forbids). Plain ownerIds pass through. */
const NON_WAKEABLE = new Set(['*', 'human', '']);

export interface WakeRecipientsResult {
  /** Concrete recipient ownerIds we fired a wake key for (post-filter). */
  targets: string[];
  /** The keys fired (one per target) — for assertions / debugging. */
  keys: string[];
  /** Total wake awaits actually fired (sum over targets; 0 if none asleep). */
  woken: number;
}

/**
 * Fire the inbox-wake key for each addressed recipient — one targeted emit per
 * ownerId, never a broadcast (P-042). `recipients` is the POST-expansion `to[]`
 * (audience selectors already resolved to concrete ownerIds by sendMessage), so
 * `*`/`human`/empty are filtered here and never reach the pump.
 *
 * Fail-soft: the inbox write is the durable truth; a wake fan that errors must
 * not fail the send. Each recipient's emit is independent (one bad key never
 * starves the others).
 */
export async function wakeRecipients(
  recipients: readonly string[],
  opts: { summary?: string; payload?: unknown; source?: string; workspaceId?: string } = {},
): Promise<WakeRecipientsResult> {
  const targets = [...new Set(recipients)].filter((r) => !NON_WAKEABLE.has(r));
  const keys: string[] = [];
  let woken = 0;
  for (const ownerId of targets) {
    const key = inboxWakeKey(ownerId);
    keys.push(key);
    try {
      const res = await emitAwaitedEvent({
        key,
        summary: opts.summary,
        payload: opts.payload,
        source: opts.source,
        workspaceId: opts.workspaceId,
      });
      woken += res.woken;
    } catch (e) {
      // Best-effort: the message already persisted to the inbox; a wake-fan
      // hiccup degrades to "seen on the recipient's next natural turn".
      console.warn(
        `[inbox-wake] wake fire for ${ownerId} failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return { targets, keys, woken };
}
