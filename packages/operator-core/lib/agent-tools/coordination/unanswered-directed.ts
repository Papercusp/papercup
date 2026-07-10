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
 *   - "answered": a sibling row carrying `related_msg_id = <this msg_id>`
 *     AUTHORED BY the recipient — an explicit ack (kind='ack') or a genuine
 *     reply both satisfy it (mirrors reply-deadline-sweep's own NOT EXISTS
 *     check). A message is "unanswered" only while neither exists.
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
 */
export function rowsToUnansweredMap(
  rows: readonly UnansweredDirectedRow[],
  nowMs: number,
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
    for (let i = 0; i < ids.length && newest.length < UNANSWERED_NEWEST_CAP; i++) {
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
 */
export async function fetchUnansweredDirected(
  recipientIds: string[],
  opts: { nowMs?: number; lookbackMs?: number } = {},
): Promise<Map<string, UnansweredDirectedSummary>> {
  if (recipientIds.length === 0 || !coordHasPgFastPath()) return new Map();
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = nowMs - (opts.lookbackMs ?? UNANSWERED_LOOKBACK_MS);
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
           (array_agg(msg_id ORDER BY ts_ms DESC))[1:${UNANSWERED_NEWEST_CAP}] AS newest_ids,
           (array_agg(from_id ORDER BY ts_ms DESC))[1:${UNANSWERED_NEWEST_CAP}] AS newest_from,
           (array_agg(summary ORDER BY ts_ms DESC))[1:${UNANSWERED_NEWEST_CAP}] AS newest_summary,
           (array_agg(ts_ms ORDER BY ts_ms DESC))[1:${UNANSWERED_NEWEST_CAP}] AS newest_ts_ms
      FROM unanswered
     GROUP BY recipient
  `;
  return rowsToUnansweredMap(rows, nowMs);
}
