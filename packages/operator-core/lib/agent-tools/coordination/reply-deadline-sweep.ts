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
 */

import { getOrgPg } from '@papercusp/db-org';
import { sendMessage } from './messages';
import { wakeRecipients } from './inbox-wake';
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
}

interface DueReplyDeadlineRow {
  workspace_id: string;
  msg_id: string;
  from_id: string;
  to_ids: unknown;
  summary: string | null;
  plan_slug: string | null;
  deadline_at: string; // bigint comes back as text over the pg driver
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
           e1.body->>'plan_slug' AS plan_slug,
           e1.body->>'replyDeadlineAt' AS deadline_at
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
      return {
        workspaceId: r.workspace_id,
        msgId: r.msg_id,
        from: r.from_id,
        to,
        summary: r.summary ?? undefined,
        planSlug: r.plan_slug ?? undefined,
        overdueMinutes: Number.isFinite(deadlineMs) ? (nowMs - deadlineMs) / 60_000 : 0,
      };
    });
}

export interface ReplyDeadlineSweepResult {
  due: number;
  nudged: number;
  /** True when the due backlog exceeded the batch limit (more remain next tick). */
  truncated: boolean;
}

/**
 * One sweep pass: find every message whose reply deadline has passed with no
 * reply yet (up to the batch limit), and nudge the ORIGINAL sender once — a
 * visible coord message (which doubles as the idempotency marker, see module
 * docstring) + a fail-soft inbox-wake so an idle sender is re-invoked NOW.
 * Fully fail-soft per message: a nudge failure on one message never aborts
 * the pass.
 */
export async function runReplyDeadlineSweepOnce(
  opts: { nowMs?: number; limit?: number } = {},
): Promise<ReplyDeadlineSweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? REPLY_DEADLINE_SWEEP_BATCH_LIMIT;
  const due = await findDueReplyDeadlines(nowMs, limit + 1);
  const batch = due.slice(0, limit);

  let nudged = 0;
  for (const d of batch) {
    try {
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

  return { due: due.length, nudged, truncated: due.length > batch.length };
}
