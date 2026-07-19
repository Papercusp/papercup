/**
 * reply-deadline-sweep — coord:send { replyDeadlineSec } backstop (EI-8986).
 *
 * wakeOnReply covers the reply-ARRIVES case (coord-wake-on-reply): the sender
 * is woken the moment a peer replies. Nothing covered the reply-NEVER-arrives
 * case — a leader hand-carrying "nudge X at HH:MMZ if silent" in a checkpoint/
 * carry-note is exactly the hand-rolled deadline-tracking this backstop
 * replaces, and it dies with compaction.
 *
 * `replyDeadlineSec` is stamped onto the envelope as a top-level
 * `replyDeadlineAt` (epoch ms) field — same shape as `wakeOnReply` (see
 * tools/send.ts's `extra.wakeOnReply` stamp). This sweep finds every message
 * whose deadline has passed with no reply yet, and nudges the ORIGINAL sender
 * once.
 *
 * DATA MODEL (mirrors reconcile-handoffs.ts's sibling-record idempotency —
 * coord_event_log's `messages` surface is append-only, no update-in-place):
 * the nudge itself IS the idempotency marker. It's sent with
 * `related_msg_id: <original msg_id>`, so it satisfies the exact same
 * "does a reply exist" check a genuine peer reply would — one nudge per
 * deadline, guaranteed by construction, no separate marker/side-table needed.
 *
 * SCOPE: `replyDeadlineAt` is a rare, explicit opt-in field, so this queries
 * `harness_shared.coord_event_log` directly (mirrors message-log-gc.ts's
 * `gcOldOperatorMessages` — a raw JSONB-predicate scan across ALL workspaces
 * via the admin connection) rather than extending the generic CoordEventLog
 * interface (`readLinesBounded` et al, in `@papercusp/coordination`) with a
 * one-off filter only this sweep needs.
 *
 * EI-13610: a reply is not the ONLY way an awaited recipient answers — su
 * agents habitually post their answer as a WORK-ITEM THREAD POST
 * (work_items:comment) rather than a coord reply with `related_msg_id`, since
 * that's where the evidence belongs. The sweep only watched coord replies, so
 * it fired a stale "no reply by deadline" false-alarm nudge (+ wake) even when
 * the awaited agent had already answered on the very work-item the original
 * message was about. Before alarming, this sweep now auto-detects WI-/EI- ids
 * mentioned in the original message's summary/body (the same P-008 auto-ref
 * detector `coord:send` uses for delivery hydration) and checks whether any
 * awaited recipient (`to`) has since posted on that item's thread. A hit
 * REPLACES the alarm with a quiet, non-waking auto-resolved note (still
 * carrying `related_msg_id` as the idempotency marker, so it is never
 * re-checked) instead of a false-alarm wake.
 */

import { getOrgPg } from '@papercusp/db-org';
import { sendMessage } from './messages';
import { wakeRecipients } from './inbox-wake';
import { detectBodyRefs } from './ref-hydrate';
import type { AgentIdentity } from './identity';

/** Resolver identity stamped on auto-fired deadline nudges (audit trail). */
export const RECONCILE_REPLY_DEADLINE_OWNER = 'system:reply-deadline-sweep';

/** Coord identity for the sweep's own nudge write. A system action runs
 *  in-process, so it attributes as a `principal` (mirrors
 *  RECONCILE_HANDOFF_OWNER / the coord-invariant-monitor's MONITOR_IDENTITY)
 *  — never a real fleet agent. */
const RECONCILE_IDENTITY: AgentIdentity = {
  ownerId: RECONCILE_REPLY_DEADLINE_OWNER,
  ownerLabel: 'system · reply-deadline-sweep',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Max deadline-missed messages nudged per sweep tick — a safety bound; the
 *  opt-in volume is expected to be small (mirrors RECONCILE_REPING_BATCH_LIMIT). */
export const REPLY_DEADLINE_SWEEP_BATCH_LIMIT = 200;

export interface DueReplyDeadline {
  workspaceId: string;
  msgId: string;
  from: string;
  to: string[];
  summary?: string;
  planSlug?: string;
  /** How overdue the deadline is, for the nudge prose. */
  overdueMinutes: number;
  /** The original message body text (EI-13610: fed into detectBodyRefs alongside
   *  `summary` to find WI-/EI- ids the reply-equivalent-activity check probes). */
  body?: string;
  /** When the original message was sent (epoch ms) — the reply-equivalent-activity
   *  check only counts a thread post AFTER this (EI-13610). */
  sentAtMs: number;
}

interface DueReplyDeadlineRow {
  workspace_id: string;
  msg_id: string;
  from_id: string;
  to_ids: unknown;
  summary: string | null;
  body: string | null;
  plan_slug: string | null;
  deadline_at: string; // bigint comes back as text over the pg driver
  sent_at_ms: string; // bigint comes back as text over the pg driver
}

/**
 * Every message whose `replyDeadlineAt` has passed with no reply yet
 * (NOT EXISTS a sibling row carrying `related_msg_id = <this msg_id>` — a
 * genuine peer reply OR a prior nudge both satisfy this, so a message is
 * selected at most once). Oldest-overdue first so a batch-limited sweep
 * drains the longest-waiting first.
 */
async function findDueReplyDeadlines(
  nowMs: number,
  limit: number,
): Promise<DueReplyDeadline[]> {
  const { sql } = getOrgPg();
  const rows = await sql<DueReplyDeadlineRow[]>`
    SELECT e1.workspace_id,
           e1.msg_id,
           e1.body->>'from' AS from_id,
           e1.body->'to' AS to_ids,
           e1.body->>'summary' AS summary,
           e1.body->>'body' AS body,
           e1.body->>'plan_slug' AS plan_slug,
           e1.body->>'replyDeadlineAt' AS deadline_at,
           (extract(epoch FROM e1.ts) * 1000)::bigint AS sent_at_ms
      FROM harness_shared.coord_event_log e1
     WHERE e1.surface = 'messages'
       AND e1.body ? 'replyDeadlineAt'
       AND (e1.body->>'replyDeadlineAt')::bigint <= ${nowMs}
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.coord_event_log e2
          WHERE e2.workspace_id = e1.workspace_id
            AND e2.surface = 'messages'
            AND e2.body->>'related_msg_id' = e1.msg_id
       )
     ORDER BY (e1.body->>'replyDeadlineAt')::bigint ASC
     LIMIT ${limit}
  `;
  return rows
    .filter((r) => typeof r.from_id === 'string' && r.from_id)
    .map((r) => {
      const deadlineMs = Number(r.deadline_at);
      const to = Array.isArray(r.to_ids) ? (r.to_ids as unknown[]).filter((t): t is string => typeof t === 'string') : [];
      const sentAtMs = Number(r.sent_at_ms);
      return {
        workspaceId: r.workspace_id,
        msgId: r.msg_id,
        from: r.from_id,
        to,
        summary: r.summary ?? undefined,
        body: r.body ?? undefined,
        planSlug: r.plan_slug ?? undefined,
        overdueMinutes: Number.isFinite(deadlineMs) ? (nowMs - deadlineMs) / 60_000 : 0,
        sentAtMs: Number.isFinite(sentAtMs) ? sentAtMs : 0,
      };
    });
}

export interface ReplyEquivalentActivity {
  /** The WI-/EI- id whose thread carries the answer. */
  workItemId: string;
  /** Which awaited recipient posted it. */
  authorId: string;
  /** When they posted (epoch ms). */
  postedAtMs: number;
}

/** issue-thread-<id> (issue-family: bug/change) or work-item-thread-<id>
 *  (feature-family) — mirrors threadId()/`work-item-thread-${id}` in
 *  issues-engineer.ts / work-items.ts. Checking both avoids a family lookup:
 *  a given id only ever has ONE of the two threads. */
function candidateThreadIds(workItemId: string): string[] {
  return [`issue-thread-${workItemId}`, `work-item-thread-${workItemId}`];
}

function workItemIdFromThreadId(threadId: string): string {
  return threadId.replace(/^issue-thread-/, '').replace(/^work-item-thread-/, '');
}

/**
 * EI-13610: has any AWAITED recipient (`authorIds`) posted on the thread of
 * any of the referenced work-items SINCE the original message was sent? This
 * is the "reply-equivalent activity" this sweep treats as answering the
 * deadline even though it never arrived as a coord reply. Returns the single
 * earliest such post (enough to annotate/suppress the nudge with), or `[]`
 * when nothing matches (the normal false-alarm-check-came-up-empty case).
 */
async function findReplyEquivalentActivity(
  workspaceId: string,
  workItemIds: string[],
  authorIds: string[],
  sinceMs: number,
): Promise<ReplyEquivalentActivity[]> {
  if (!workItemIds.length || !authorIds.length) return [];
  const { sql } = getOrgPg();
  const threadIds = workItemIds.flatMap(candidateThreadIds);
  const rows = await sql<{ thread_id: string; author_id: string; posted_at_ms: string }[]>`
    SELECT thread_id, author_id, (extract(epoch FROM created_at) * 1000)::bigint AS posted_at_ms
      FROM harness_shared.coord_thread_posts
     WHERE workspace_id = ${workspaceId}
       AND thread_id = ANY(${threadIds})
       AND author_id = ANY(${authorIds})
       AND created_at > to_timestamp(${sinceMs}::double precision / 1000)
     ORDER BY created_at ASC
     LIMIT 1
  `;
  // Defense-in-depth (mirrors findDueReplyDeadlines' own extra `.filter`): the
  // WHERE clause above already constrains author/thread/recency, but re-check
  // in JS too rather than trusting a single enforcement layer for something
  // that suppresses a false-alarm — a stray/irrelevant row must never be
  // mistaken for a genuine reply-equivalent answer.
  const authorSet = new Set(authorIds);
  const threadSet = new Set(threadIds);
  return rows
    .filter((r) => typeof r.author_id === 'string' && r.author_id && authorSet.has(r.author_id) && threadSet.has(r.thread_id))
    .map((r) => {
      const postedAtMs = Number(r.posted_at_ms);
      return {
        workItemId: workItemIdFromThreadId(r.thread_id),
        authorId: r.author_id,
        postedAtMs: Number.isFinite(postedAtMs) ? postedAtMs : sinceMs,
      };
    })
    .filter((a) => a.postedAtMs > sinceMs);
}

export interface ReplyDeadlineSweepResult {
  due: number;
  nudged: number;
  /** EI-13610: due deadlines auto-resolved by reply-equivalent thread activity
   *  (no alarm sent — a quiet, non-waking note instead). */
  autoResolved: number;
  /** True when the due backlog exceeded the batch limit (more remain next tick). */
  truncated: boolean;
}

/**
 * One sweep pass: find every message whose reply deadline has passed with no
 * reply yet (up to the batch limit). Before alarming, EI-13610: check whether
 * any awaited recipient has since posted on the thread of a WI-/EI- id
 * mentioned in the original message — reply-equivalent activity a coord-only
 * check would miss. If so, send a quiet auto-resolved note (still carrying
 * `related_msg_id` as the idempotency marker) instead of the alarm + wake.
 * Otherwise, nudge the ORIGINAL sender once — a visible coord message + a
 * fail-soft inbox-wake so an idle sender is re-invoked NOW. Fully fail-soft
 * per message: a failure on one message never aborts the pass.
 */
export async function runReplyDeadlineSweepOnce(
  opts: { nowMs?: number; limit?: number } = {},
): Promise<ReplyDeadlineSweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? REPLY_DEADLINE_SWEEP_BATCH_LIMIT;
  const due = await findDueReplyDeadlines(nowMs, limit + 1);
  const batch = due.slice(0, limit);

  let nudged = 0;
  let autoResolved = 0;
  for (const d of batch) {
    try {
      // EI-13610: probe for reply-equivalent thread activity BEFORE alarming.
      // Fail-soft by design — a probe failure just falls through to the
      // ordinary alarm path (never silently swallows a genuinely-overdue one).
      let activity: ReplyEquivalentActivity | null = null;
      // detectBodyRefs is narrow (WI-/EI- ids only, per its own docstring), so
      // every hit is already `kind: 'work-item'` — the filter+narrow is just
      // to satisfy the HydratableRef union's type, not a real runtime filter.
      const workItemIds = detectBodyRefs(`${d.summary ?? ''} ${d.body ?? ''}`)
        .filter((r): r is Extract<typeof r, { kind: 'work-item' }> => r.kind === 'work-item')
        .map((r) => r.id);
      if (workItemIds.length && d.to.length) {
        try {
          const hits = await findReplyEquivalentActivity(d.workspaceId, workItemIds, d.to, d.sentAtMs);
          activity = hits[0] ?? null;
        } catch (e) {
          console.warn(
            `[reply-deadline-sweep] reply-equivalent probe for ${d.msgId} failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      }

      if (activity) {
        // Quiet + non-waking: the recipient already answered, just not via a
        // coord reply — a "no reply" alarm here would be the false alarm this
        // bug reports. related_msg_id still lands so the idempotency NOT
        // EXISTS check retires this deadline permanently.
        await sendMessage(RECONCILE_IDENTITY, {
          to: [d.from],
          summary:
            `✅ reply deadline auto-resolved: ${activity.authorId} posted on ${activity.workItemId} at ` +
            `${new Date(activity.postedAtMs).toISOString()} — likely answered there (${d.summary ?? d.msgId})`,
          body:
            `Your message ${d.msgId}${d.to.length ? ` to ${d.to.join(', ')}` : ''}` +
            `${d.planSlug ? ` (plan ${d.planSlug})` : ''} had a reply deadline with no coord reply, but ` +
            `${activity.authorId} posted on ${activity.workItemId}'s thread at ${new Date(activity.postedAtMs).toISOString()} ` +
            '(after this message was sent) — likely the answer, delivered via the item thread instead of a coord reply. ' +
            'No action needed unless that post does not actually answer it.',
          plan_slug: d.planSlug,
          related_msg_id: d.msgId,
        });
        autoResolved += 1;
        continue;
      }

      await sendMessage(RECONCILE_IDENTITY, {
        to: [d.from],
        summary: `⏰ no reply by deadline (~${Math.round(d.overdueMinutes)}m overdue): ${d.summary ?? d.msgId}`,
        body:
          `Your message ${d.msgId}${d.to.length ? ` to ${d.to.join(', ')}` : ''}` +
          `${d.planSlug ? ` (plan ${d.planSlug})` : ''} had a reply deadline and no reply has landed ` +
          `~${Math.round(d.overdueMinutes)}m past it. Follow up, escalate, or move on — this is a one-shot nudge, ` +
          'not a recurring alarm.',
        plan_slug: d.planSlug,
        related_msg_id: d.msgId,
      });
      nudged += 1;

      try {
        await wakeRecipients([d.from], {
          summary: `reply deadline missed on ${d.msgId} (~${Math.round(d.overdueMinutes)}m overdue)`,
          source: RECONCILE_REPLY_DEADLINE_OWNER,
          workspaceId: d.workspaceId,
        });
      } catch (e) {
        console.warn(
          `[reply-deadline-sweep] wake sender ${d.from} for ${d.msgId} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    } catch (e) {
      // A nudge failure on one message must never abort the sweep — the next
      // tick will retry it (it is still unanswered, so it stays selectable).
      console.warn(
        `[reply-deadline-sweep] nudge for ${d.msgId} failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return { due: due.length, nudged, autoResolved, truncated: due.length > batch.length };
}
