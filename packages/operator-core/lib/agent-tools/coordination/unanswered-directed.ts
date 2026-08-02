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
 *     check). EI-13819 / WI-5345: ALSO satisfied by an UN-THREADED directed
 *     message the recipient sent back to the same original sender after the
 *     ask — this fleet's agents overwhelmingly answer in fresh standalone
 *     messages rather than re-threading onto the exact msg_id that set
 *     `expectsReply`, so an exact-match-only rule left real, substantively
 *     answered exchanges stuck "unanswered" forever (see the EI-13819
 *     postmortem below). WI-6729 bounds that loose branch, which had grown
 *     wide enough to silently DROP live obligations: a reply threaded to a
 *     DIFFERENT message no longer counts (it is evidence the reply is about
 *     something else), and one loose reply clears at most ONE ask (a sender's
 *     open asks are ranked newest-first; the k-th needs k loose replies after
 *     it). See the WI-6729 note below for why the residual error is
 *     deliberately a false POSITIVE.
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
 * EI-13819 (leader-brief false-sticky postmortem, 2026-07-17): a leader sent a
 * lane offer with expectsReply:true; the member did the work, then sent a
 * FRESH "DONE, standing down" message (no `related_msg_id`) followed by a
 * separate `related_msg_id`-carrying ack of the leader's own later closing
 * message — a completely normal exchange, but NEITHER reply pointed at the
 * ORIGINAL lane-offer msg_id, so the strict exact-thread check left it
 * "unanswered" for good: every leader wake re-read a false "member hasn't
 * answered me" signal long after the member had visibly replied twice. Fixed
 * by ALSO accepting a reply the recipient sent back to the same sender after
 * the ask, without requiring it to be threaded onto the ask — see
 * `unanswered` below.
 *
 * WI-6729 (leader-brief false-ZERO postmortem, 2026-08-01) — the correction to
 * the above. EI-13819's fix, widened again by WI-5345, ended up accepting ANY
 * directed message back to the sender, threaded to anything or nothing. So a
 * single reply to a correspondent cleared EVERY outstanding ask from that
 * correspondent, on any topic. Observed live: a member sent a design fork it
 * was blocked on (expectsReply, 19:41Z); the leader replied ~6min later about
 * an unrelated work-item, threaded to a different message; every surface then
 * reported `unanswered_directed: 0`, twice, with `unanswered_lookup_failed:
 * false`. The leader acted on that zero and publicly retracted the commitment
 * as non-existent — only the member's pushback recovered it.
 *
 * Two properties made it critical rather than cosmetic: it is the SAME
 * primitive behind leader-brief, fleet:assignments AND
 * coord:inbox{unanswered_only}, so the "independent second check" could not
 * disagree; and the failure SCALES WITH RESPONSIVENESS — the more promptly a
 * leader answers a member, the more of that member's other asks it erases.
 * Note the direction each postmortem pushed: EI-13819/WI-5345 traded away
 * false positives (a counter stuck at 1 — annoying, visible, self-limiting)
 * and bought false negatives (a dropped commitment — silent, permanent,
 * unbounded). For a "what do I still owe?" counter that is the wrong trade,
 * and `unanswered` below now errs the other way on purpose.
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
    -- WI-6853 / P-017 — the LOOSE-REPLY set, materialized ONCE.
    --
    -- \`unanswered\` below needs, per open ask, "how many un-threaded replies did this
    -- recipient send back to that sender after the ask". Expressed as a correlated
    -- subquery over coord_event_log it was re-evaluated per open_ask row, and because
    -- PostgreSQL has NO STATISTICS for jsonb expressions it estimated 1 row for a filter
    -- that actually discards ~75k. Measured on the live workspace: 14 loops x 75,192 rows
    -- removed = ~1.05M rows examined, 129ms per loop, 76% of the statement's total runtime.
    --
    -- Indexes cannot fix that: two purpose-built partial indexes on (workspace_id,
    -- (body->>'from'), ts) and on the expectsReply predicate were trialled and the planner
    -- ignored both, because it already believed the scan returned one row. The estimate is
    -- the bug, so the fix is to remove the per-row correlation rather than to re-index.
    --
    -- Pre-filtering on \`from = ANY(recipientIds)\` is what makes this cheap — the reply must
    -- be authored BY one of the recipients we are asking about, which is highly selective —
    -- and the lookback bounds it further. AS MATERIALIZED is REQUIRED: with a single
    -- reference PG would inline the CTE and re-scan it per loop, reinstating the exact cost
    -- being removed.
    --
    -- DISTINCT on e3.id is a semantic guard, not a tidy-up. The predicate it replaces is
    -- \`body->'to' @> to_jsonb(ARRAY[o.from_id])\` — a per-MESSAGE containment test, so a
    -- message whose 'to' array lists the same id twice counts ONCE. Unnesting with LATERAL
    -- would count it twice and could silently clear an ask that is still open.
    --
    -- Verified equivalent against live data before landing: both EXCEPT directions empty,
    -- 8/8 recipients, 10/10 total count. 2,545ms -> 985ms on the real workspace.
    WITH loose_replies AS MATERIALIZED (
      SELECT DISTINCT e3.id,
             e3.workspace_id,
             e3.body->>'from' AS from_id,
             rt AS to_id,
             (extract(epoch FROM (e3.body->>'ts')::timestamptz) * 1000)::bigint AS ts_ms
        FROM harness_shared.coord_event_log e3
        CROSS JOIN LATERAL jsonb_array_elements_text(e3.body->'to') AS rt
       WHERE e3.workspace_id = ${workspaceId}
         AND e3.surface = 'messages'
         AND NOT (e3.body ? 'related_msg_id')
         AND jsonb_typeof(e3.body->'to') = 'array'
         AND e3.body->>'from' = ANY(${recipientIds}::text[])
         AND (e3.body->>'ts')::timestamptz >= to_timestamp(${sinceMs}::double precision / 1000)
    ),
    -- WI-6875 — the ROSTER-AUTHORED set, materialized ONCE. Serves the two remaining
    -- correlated scan sites below (the WI-4537(c) ACK-PING-PONG check inside \`directed\`, and
    -- the exact-threaded-reply NOT EXISTS in \`open_asks\`). Both asked the same question of the
    -- full 75k-row table once per candidate row: "is there a message authored by THIS recipient
    -- matching X". Measured on the live workspace: e2 seq-scanned 75,372 rows (~148ms) and e3_1
    -- seq-scanned 75,422 (~157ms), every call.
    --
    -- The roster pre-filter is what makes this cheap, and it is EXACTLY equivalence-preserving
    -- rather than a heuristic narrowing: e3_1 requires 'from' = r and e2 requires
    -- 'from' = d.recipient, and BOTH r and d.recipient are already constrained by the
    -- \`r = ANY(recipientIds)\` filter in \`directed\`. So a row authored by someone outside the
    -- roster could never have satisfied either predicate — dropping it cannot change a verdict.
    -- Live selectivity: 11,093 of 75,357 rows (6.8x), and only 1,283 of those carry a
    -- related_msg_id (59x for the e2 branch).
    --
    -- NOT time-bounded, deliberately: neither original subquery is, and a reply's 'ts' is
    -- SENDER-SUPPLIED in the body, so inferring "a reply must postdate its ask" would import an
    -- assumption the current semantics do not make.
    --
    -- NO DISTINCT, deliberately — and note this is the OPPOSITE of loose_replies above, which
    -- needs it. That set is COUNTED against ask_rank, where a duplicate would over-count and
    -- could silently clear a still-open ask. These two sites only test EXISTENCE, where
    -- duplicates cannot change the answer, so deduping would be pure cost.
    --
    -- Verified equivalent against live data before landing, at BOTH levels: the open_asks set
    -- itself (20 = 20 rows, EXCEPT empty both directions) and the end-to-end aggregate
    -- (9 = 9 recipients, 16 = 16 total). 872ms -> 367ms, mean of 3 paired runs.
    roster_authored AS MATERIALIZED (
      SELECT ra.workspace_id,
             ra.body->>'from'           AS from_id,
             ra.body->>'msg_id'         AS msg_id,
             ra.body->>'related_msg_id' AS related_msg_id
        FROM harness_shared.coord_event_log ra
       WHERE ra.workspace_id = ${workspaceId}
         AND ra.surface = 'messages'
         AND ra.body->>'from' = ANY(${recipientIds}::text[])
    ),
    directed AS (
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
         -- WI-6875: reads the pre-materialized \`roster_authored\` above instead of re-scanning
         -- coord_event_log (75,422 rows, ~157ms) per candidate row. Predicate set unchanged:
         -- same author, same msg_id match, same absence of a time bound.
         AND NOT (
           e.body ? 'related_msg_id'
           AND EXISTS (
             SELECT 1 FROM roster_authored ra
              WHERE ra.workspace_id = e.workspace_id
                AND ra.msg_id = e.body->>'related_msg_id'
                AND ra.from_id = r
           )
         )
    ),
    -- (1) An EXACT threaded reply/ack to THIS specific ask, authored by the
    -- recipient, answers it outright — no pairing, no ambiguity. Evaluated per
    -- (msg_id, recipient), never msg_id alone: one message fans out to N
    -- recipients, and recipient A replying must not clear B's obligation.
    open_asks AS (
      SELECT d.*,
             row_number() OVER (
               PARTITION BY d.recipient, d.from_id ORDER BY d.ts_ms DESC, d.msg_id DESC
             ) AS ask_rank
        FROM directed d
       -- WI-6875: reads the pre-materialized \`roster_authored\` above instead of re-scanning
       -- coord_event_log (75,372 rows, ~148ms) per candidate row. Comparing
       -- \`ra.related_msg_id = d.msg_id\` naturally excludes rows carrying no related_msg_id,
       -- since NULL never equals anything — matching the original's implicit requirement that
       -- the key be present.
       WHERE NOT EXISTS (
         SELECT 1 FROM roster_authored ra
          WHERE ra.workspace_id = d.workspace_id
            AND ra.from_id = d.recipient
            AND ra.related_msg_id = d.msg_id
       )
    ),
    unanswered AS (
      -- (2) WI-6729: the LOOSE branch, now NARROWED and PAIRED. An un-threaded
      -- directed message back to the original sender after the ask still counts
      -- as a reply (EI-13819 / WI-5345 — this fleet's agents overwhelmingly
      -- answer in fresh standalone messages rather than re-threading onto the
      -- exact msg_id that set expectsReply), but two rails stop it silently
      -- eating real obligations:
      --
      --   NARROWED — a reply carrying a related_msg_id that points at some
      --   OTHER message is positive evidence it is about something ELSE, so it
      --   is no longer loose evidence for this ask. (A reply threaded to THIS
      --   ask is already branch (1).) Previously ANY threaded reply to a sender
      --   cleared EVERY open ask from them, regardless of topic.
      --
      --   PAIRED — one reply may clear at most ONE ask. Ranking a sender's open
      --   asks newest-first, the k-th needs k loose replies after it. A single
      --   "on another note…" can no longer retire three distinct questions; the
      --   newest clears and the older ones stay open.
      --
      -- The direction of error is deliberate. This can leave open an ask that
      -- was in substance answered — a cheap, self-correcting extra nudge —
      -- rather than drop one that was not. The counter drives leader-brief,
      -- fleet:assignments and coord:inbox{unanswered_only}, where a false ZERO
      -- is indistinguishable from a true zero and loses the commitment
      -- silently and permanently. It cannot re-introduce EI-13819's stuck-at-1
      -- either: continued correspondence always converges (m loose replies
      -- clear the m newest open asks), so a live exchange never sticks.
      -- Reads from the pre-materialized \`loose_replies\` above rather than re-scanning
      -- coord_event_log per row (WI-6853). The predicate set is unchanged — same author,
      -- same addressee, same "after the ask" bound, same one-reply-clears-one-ask pairing
      -- against ask_rank.
      SELECT o.* FROM open_asks o
       WHERE (
         SELECT count(*) FROM loose_replies lr
          WHERE lr.workspace_id = o.workspace_id
            AND lr.from_id = o.recipient
            AND lr.to_id = o.from_id
            AND lr.ts_ms >= o.ts_ms
       ) < o.ask_rank
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
