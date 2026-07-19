/**
 * unanswered-directed.ts — per-recipient UNANSWERED DIRECTED MESSAGE aggregate
 * (fleet-reliability-verification-2026-07-10 P-007, the fleet:leader-brief primitive).
 *
 * Night-shift lesson (2026-07-10 outage review): the leader hand-tracked "who
 * hasn't answered me yet" from memory across ~45 monitor wakes — nothing
 * surfaced it mechanically. reply-deadline-sweep already nudges the rare
 * message that opts into an explicit `replyDeadlineSec`; this is the general
 * per-member READ a leader's fleet-health check needs for EVERY directed
 * message, deadline or not.
 *
 * Definitions:
 *   - "directed": kind='message' (or unset, the default), addressed via
 *     explicit ownerId(s) — never a broadcast/audience-selector send (no
 *     `audience` key stamped; see sendMessage's deriveAudienceKey — '*' and
 *     every `@selector` both stamp one). Sender != recipient (never counts a
 *     message against its own author, e.g. a fanout that lists the sender).
 *   - "expects reply": the sender explicitly sets `expectsReply:true`, or
 *     uses the coord:send ergonomic `wake:'required'` + `replyDeadlineSec`
 *     combination (which stamps the same field). FYI/status reports are
 *     intentionally absent from this aggregate.
 *   - "answered": a sibling row carrying `related_msg_id = <this msg_id>`
 *     AUTHORED BY the recipient — an explicit ack (kind='ack') or a genuine
 *     reply both satisfy it (mirrors reply-deadline-sweep's own NOT EXISTS
 *     check). A message is "unanswered" only while neither exists.
 *
 * WI-4537 — what this counter must NOT count. It is wired to PREEMPT an agent's
 * work ("a directed message awaiting YOUR answer OUTRANKS your own work"), so a
 * false positive costs a real interruption. Measured live, 2791 "unanswered"
 * rows fleet-wide were mostly things nobody was waiting on:
 *   (a) auto:true machine lifecycle chatter (work-item:done, hold_open_clear…);
 *   (b) machine SENDERS that never carried the flag — claim-discipline-watch
 *       (390!), plan-clobber-watch, system:delivery-ladder (the sweep whose job
 *       is to nag you about unread directed mail, itself generating unread
 *       directed mail), … — see machine-authored.ts, whose pattern is shared
 *       with sendMessage's new write-time stamp so the two cannot drift;
 *   (c) the ACK-PING-PONG: a message that is itself a REPLY to something the
 *       RECIPIENT sent. An answer arriving was counted as a question landing,
 *       clearable only by acking the ack — forever (184 rows).
 * All three are excluded below. What remains is what the name promises: a
 * message from a real correspondent, still awaiting this recipient's reply.
 *
 * Batched: ONE query for the whole roster (mirrors fetchContextPressure /
 * fetchWakeability) — enriching N members costs one read, not N. Bounded to a
 * recent lookback window (default 3d) so an ancient backlog from a long-idle
 * member doesn't bloat every fleet-health read forever; each recipient's
 * `newest` list is capped even when its unanswered count is large.
 *
 * The SQL aggregation is thin IO (fetchUnansweredDirected); the row→summary
 * fold is a PURE function (rowsToUnansweredMap) so it unit-tests without PG.
 */
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';
import { MACHINE_SENDER_PATTERN } from './machine-authored';

export interface UnansweredDirectedEntry {
  msgId: string;
  from: string;
  summary?: string;
  ageMs: number;
}

export interface UnansweredDirectedSummary {
  count: number;
  oldestAgeMs: number;
  /** Newest-first, capped at NEWEST_CAP even when `count` is larger. */
  newest: UnansweredDirectedEntry[];
}

/** A message older than this is dropped from the read entirely — an ancient,
 *  long-abandoned thread isn't "fleet health" signal, it's noise. */
export const UNANSWERED_LOOKBACK_MS = 3 * 24 * 3600 * 1000;
/** Per-recipient cap on the `newest` list (the count itself is never capped). */
export const UNANSWERED_NEWEST_CAP = 3;

export interface UnansweredDirectedRow {
  recipient: string;
  cnt: string | number;
  oldest_ts_ms: string | number;
  newest_ids: (string | null)[] | null;
  newest_from: (string | null)[] | null;
  newest_summary: (string | null)[] | null;
  newest_ts_ms: (string | number | null)[] | null;
}

/**
 * PURE: fold the aggregated SQL rows (one row per recipient with >=1
 * unanswered directed message) into the per-recipient summary map.
 * Unit-testable with hand-built rows — no PG required.
 *
 * `cap` bounds how many of each recipient's `newest` entries are kept —
 * default {@link UNANSWERED_NEWEST_CAP} (the fleet-health display cap). A
 * caller reading for exactly ONE recipient (e.g. coord:inbox's
 * `unanswered_only` filter, EI-13159) passes a larger cap so it can recover
 * every unanswered message's msg_id, not just the newest 3 — `count` was
 * always exact; only `newest` was ever capped.
 */
export function rowsToUnansweredMap(
  rows: readonly UnansweredDirectedRow[],
  nowMs: number,
  cap: number = UNANSWERED_NEWEST_CAP,
): Map<string, UnansweredDirectedSummary> {
  const out = new Map<string, UnansweredDirectedSummary>();
  for (const r of rows) {
    const cnt = Number(r.cnt);
    if (!Number.isFinite(cnt) || cnt <= 0) continue;
    const oldestTs = Number(r.oldest_ts_ms);
    const ids = r.newest_ids ?? [];
    const froms = r.newest_from ?? [];
    const summaries = r.newest_summary ?? [];
    const timestamps = r.newest_ts_ms ?? [];
    const newest: UnansweredDirectedEntry[] = [];
    for (let i = 0; i < ids.length && newest.length < cap; i++) {
      const msgId = ids[i];
      const from = froms[i];
      if (!msgId || !from) continue;
      const ts = Number(timestamps[i]);
      newest.push({
        msgId,
        from,
        ...(summaries[i] ? { summary: summaries[i] as string } : {}),
        ageMs: Number.isFinite(ts) ? Math.max(0, nowMs - ts) : 0,
      });
    }
    out.set(r.recipient, {
      count: cnt,
      oldestAgeMs: Number.isFinite(oldestTs) ? Math.max(0, nowMs - oldestTs) : 0,
      newest,
    });
  }
  return out;
}

/**
 * IO seam: batch-read unanswered directed messages for a set of ownerIds.
 * Only recipients with >=1 unanswered message come back (absent ⇒ zero,
 * mirroring fetchContextPressure's "absent ⇒ default" contract).
 *
 * Runs on the SAME handle + workspace the coordLog seam reads/writes (mirrors
 * readAckedMsgIds/readInbox's fast-path convention) — gated on
 * `coordHasPgFastPath()` so a swapped seam (tests, an in-memory double) never
 * queries an unrelated store; it resolves to an empty map instead (this is a
 * fleet-health NICE-TO-HAVE decoration, best-effort like its siblings
 * decorateContextPressure/decorateParkedOn — never worth a slow full-scan
 * fallback).
 *
 * `opts.perRecipientCap` overrides {@link UNANSWERED_NEWEST_CAP} for both the
 * SQL array slice and the fold — pass a larger value for a single-recipient
 * read that needs every unanswered msg_id (EI-13159), not just the newest 3.
 */
export async function fetchUnansweredDirected(
  recipientIds: string[],
  opts: { nowMs?: number; lookbackMs?: number; perRecipientCap?: number } = {},
): Promise<Map<string, UnansweredDirectedSummary>> {
  if (recipientIds.length === 0 || !coordHasPgFastPath()) return new Map();
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = nowMs - (opts.lookbackMs ?? UNANSWERED_LOOKBACK_MS);
  const cap = opts.perRecipientCap ?? UNANSWERED_NEWEST_CAP;
  const sql = coordSql();
  const workspaceId = coordWorkspaceId();
  const rows = await sql<UnansweredDirectedRow[]>`
    WITH directed AS (
      SELECT
        e.workspace_id,
        e.body->>'msg_id' AS msg_id,
        e.body->>'from' AS from_id,
        e.body->>'summary' AS summary,
        (extract(epoch FROM (e.body->>'ts')::timestamptz) * 1000)::bigint AS ts_ms,
        r AS recipient
        FROM harness_shared.coord_event_log e
        CROSS JOIN LATERAL jsonb_array_elements_text(e.body->'to') AS r
       WHERE e.workspace_id = ${workspaceId}
         AND e.surface = 'messages'
         AND (e.body->>'kind' IS NULL OR e.body->>'kind' = 'message')
         AND NOT (e.body ? 'audience')
         AND jsonb_typeof(e.body->'to') = 'array'
         AND r = ANY(${recipientIds}::text[])
         AND e.body->>'from' IS DISTINCT FROM r
         AND (e.body->>'ts')::timestamptz >= to_timestamp(${sinceMs}::double precision / 1000)
         -- WI-4553: only the SENDER can distinguish a question from an FYI.
         -- Missing/false is the backwards-compatible non-obligation default.
         AND (e.body->>'expectsReply') = 'true'
         -- WI-4537 (a): machine LIFECYCLE chatter is not an obligation. sendMessage now
         -- auto-stamps this for every machine sender (messages.ts), so it is reliable going
         -- forward.
         AND (e.body->>'auto') IS DISTINCT FROM 'true'
         -- WI-4537 (b): …and the SAME machine-sender rule again, structurally — because the
         -- write-time stamp cannot reach the rows ALREADY written without it, and those are the
         -- bulk of the noise today (~490 unflagged robot rows vs ~314 flagged). Shared pattern,
         -- so this and the stamp can never disagree.
         AND NOT (e.body->>'from' ~ ${MACHINE_SENDER_PATTERN})
         -- WI-4537 (c): the ACK-PING-PONG. A message that is itself a REPLY to something the
         -- RECIPIENT sent is an ANSWER arriving, not a question landing — yet it was counted as
         -- a fresh obligation on the recipient, who could only clear it by acking the ack (whose
         -- ack the peer would then owe…). 184 of 2791 unanswered rows fleet-wide were exactly
         -- this: peers' "done ✓" / "Ack — confirmed" replies, logged forever as mail the asker
         -- still owes an answer to.
         AND NOT (
           e.body ? 'related_msg_id'
           AND EXISTS (
             SELECT 1 FROM harness_shared.coord_event_log e3
              WHERE e3.workspace_id = e.workspace_id
                AND e3.surface = 'messages'
                AND e3.body->>'msg_id' = e.body->>'related_msg_id'
                AND e3.body->>'from' = r
           )
         )
    ),
    unanswered AS (
      SELECT d.* FROM directed d
       WHERE NOT EXISTS (
         SELECT 1 FROM harness_shared.coord_event_log e2
          WHERE e2.workspace_id = d.workspace_id
            AND e2.surface = 'messages'
            AND e2.body->>'related_msg_id' = d.msg_id
            AND e2.body->>'from' = d.recipient
       )
    )
    SELECT recipient,
           count(*) AS cnt,
           min(ts_ms) AS oldest_ts_ms,
           (array_agg(msg_id ORDER BY ts_ms DESC))[1:${cap}] AS newest_ids,
           (array_agg(from_id ORDER BY ts_ms DESC))[1:${cap}] AS newest_from,
           (array_agg(summary ORDER BY ts_ms DESC))[1:${cap}] AS newest_summary,
           (array_agg(ts_ms ORDER BY ts_ms DESC))[1:${cap}] AS newest_ts_ms
      FROM unanswered
     GROUP BY recipient
  `;
  return rowsToUnansweredMap(rows, nowMs, cap);
}
