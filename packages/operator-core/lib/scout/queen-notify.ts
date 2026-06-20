/**
 * queen-notify.ts — the Scout→Queen coord pings of the feedback loop
 * (queen-scout-feedback-loop-2026-06-20, D-003 #1 + D-001 step 3).
 *
 * Two pings, both Scout→Queen, both DURABLE INBOX (no forced wake — review is
 * idle-gated per D-003 #2; placement always wins, the Queen sees these on her next
 * idle wake):
 *
 *   1. {@link notifyQueenDraftRouted} — STARTS the loop: when Scout routes a NEW
 *      draft plan, ping the Queen so she reviews it (closes the "what prompts the
 *      Queen to review?" gap — D-003 #1). The Queen is fresh-per-wake, so the
 *      recipient is resolved dynamically (her newest session's coord owner, the
 *      same {@link ../hive/placement-watchdog.resolveQueenOwner} the overwatch
 *      nudges); when there is no recent Queen session the draft is still discoverable
 *      via the Planning surface / her draft survey, so the ping is simply skipped.
 *
 *   2. {@link notifyQueenRevised} — CONTINUES the loop: after a targeted revision
 *      (revise.ts), ping the Queen back per draft so she re-reviews (promote=ready
 *      or another round). The recipient is the EXACT Queen owner that sent the
 *      feedback (`fromOwnerId`), not a re-resolve — it threads back to her.
 *
 * Pure over an injected {@link QueenNotifyPorts} (the gym:judge / router-deps
 * pattern) so it unit-tests with fakes — no coord, no PG. register-scout-action.ts
 * binds the real send (`sendMessage` in the workspace ALS) + `resolveQueenOwner`.
 * Best-effort by contract: a notify failure must NEVER fail the Scout cycle (the
 * caller wraps these so a dead coord layer can't break ideation/revision).
 */

import type { RevisionOutcome } from './revise';

/** A coord message the Scout sends the Queen (the runner maps this onto sendMessage). */
export interface QueenNotifyMessage {
  to: string[];
  summary: string;
  body: string;
  planSlug: string;
}

export interface QueenNotifyPorts {
  /** Resolve the hive's current Queen coord owner (newest session), or null if none. */
  resolveQueenOwner: () => Promise<string | null>;
  /** Deliver one coord message Scout→Queen (sendMessage as `scout:<hive>`). */
  send: (msg: QueenNotifyMessage) => Promise<void>;
}

export interface DraftRoutedNotice {
  slug: string;
  title: string;
  /** The Scout's coord owner (`scout:<hive>`) — the address the Queen sends feedback to. */
  scoutOwner: string;
}

export interface DraftRoutedResult {
  notified: boolean;
  recipient: string | null;
  reason?: 'no-queen-session';
}

/**
 * Ping the Queen that Scout routed a NEW draft for review (D-003 #1). Resolves her
 * current owner; on null (no recent Queen session) skips — the draft is still in the
 * Planning surface for her next survey. Never throws (resolve/send errors degrade to
 * not-notified) so it can't break the routing path that called it.
 */
export async function notifyQueenDraftRouted(
  ports: QueenNotifyPorts,
  notice: DraftRoutedNotice,
): Promise<DraftRoutedResult> {
  let owner: string | null = null;
  try {
    owner = await ports.resolveQueenOwner();
  } catch {
    owner = null;
  }
  if (!owner) return { notified: false, recipient: null, reason: 'no-queen-session' };
  try {
    await ports.send({
      to: [owner],
      planSlug: notice.slug,
      summary: `Scout routed a new draft plan for review: ${notice.slug}`,
      body:
        `${notice.title}\n\n` +
        `Scout routed this DRAFT plan (queen-scout feedback loop). When you have idle capacity: review it and either\n` +
        `• promote it (= ready, its items become placeable), or\n` +
        `• coord:send feedback to \`${notice.scoutOwner}\` (set plan_slug=${notice.slug}) to iterate, or\n` +
        `• deprecate it if the premise is wrong (the deprecate emits a learnings observation, so it still feeds Scout).`,
    });
    return { notified: true, recipient: owner };
  } catch {
    return { notified: false, recipient: owner };
  }
}

/**
 * Ping the Queen back after a revision tick (D-001 step 3) — one message per draft,
 * to the EXACT owner that sent the feedback. Skips items with no recipient. Never
 * throws (per-item send errors are swallowed) so it can't fail the revision cycle.
 * Returns the count actually delivered.
 */
export async function notifyQueenRevised(
  ports: Pick<QueenNotifyPorts, 'send'>,
  outcomes: readonly RevisionOutcome[],
): Promise<{ delivered: number }> {
  let delivered = 0;
  for (const o of outcomes) {
    if (!o.fromOwnerId) continue;
    const { summary, body } = revisedMessage(o);
    try {
      await ports.send({ to: [o.fromOwnerId], planSlug: o.planSlug, summary, body });
      delivered += 1;
    } catch {
      /* best-effort per item */
    }
  }
  return { delivered };
}

/** The ping-back wording per revision outcome (status-aware). */
function revisedMessage(o: RevisionOutcome): { summary: string; body: string } {
  switch (o.status) {
    case 'revised':
      return {
        summary: `Scout revised draft ${o.planSlug} addressing your feedback — please re-review`,
        body:
          `I revised the draft to address your feedback. Re-review and either promote it (= ready), send another round of feedback (plan_slug=${o.planSlug}), or deprecate if the premise won't get there.`,
      };
    case 'unchanged':
      return {
        summary: `Scout: no change made to ${o.planSlug} (feedback didn't yield a revision)`,
        body: `Your feedback on ${o.planSlug} didn't produce a concrete revision (${o.note}). If it still needs work, send sharper guidance; otherwise consider promoting or deprecating.`,
      };
    case 'missing':
      return {
        summary: `Scout: draft ${o.planSlug} no longer exists`,
        body: `I couldn't revise ${o.planSlug} — it no longer exists (${o.note}).`,
      };
    case 'rejected':
      return {
        summary: `Scout: revision of ${o.planSlug} didn't produce a usable plan`,
        body: `My revision attempt on ${o.planSlug} didn't produce a usable plan (${o.note}), so the draft is unchanged. Send sharper guidance, or consider promoting / deprecating.`,
      };
    case 'error':
    default:
      return {
        summary: `Scout: couldn't revise ${o.planSlug} (${o.note})`,
        body: `I hit an error revising ${o.planSlug}: ${o.note}. Re-send your feedback if you still want a revision.`,
      };
  }
}
