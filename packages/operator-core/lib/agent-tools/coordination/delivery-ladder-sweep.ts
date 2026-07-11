/**
 * delivery-ladder-sweep — the coord-delivery ESCALATION LADDER
 * (coord-delivery-residual-gaps-2026-07-11 P-004, WI-4160).
 *
 * The residual gap this closes: a DIRECTED message (explicit `to:[ownerId]`)
 * sent WITHOUT a wake lands durably in the recipient's inbox, but a recipient
 * that is live-and-heads-down (the mid-long-exec deafness window, a hook-
 * enrollment drift, a non-enrolled runtime) never reads it — the sender
 * assumes delivery, the recipient never sees it, and nobody is paged. The
 * ladder is ONE server-side rule:
 *
 *   a directed message unread past TTL (recipient's lastInboxReadAt < msg.ts,
 *   recipient sessionState LIVE) auto-fires that recipient's standing
 *   inbox-wake (`coord:inbox-wake:<ownerId>`, always-armed at SessionStart).
 *
 * Ratified defaults (self-ratified under AUTO 2026-07-11, disclosed to Avi):
 *   - TTL 5 min (env PAPERCUSP_COORD_LADDER_TTL_MS, clamped >=60s).
 *   - "Directed" = explicit ownerId sends ONLY — never a broadcast or
 *     `@audience` selector (no `audience` stamp; mirrors unanswered-directed's
 *     definition), sender != recipient, and never a `system:%` sender (system
 *     notices are periodic/bulk with their own delivery machinery, and the
 *     ladder's own marker message must not re-trigger the ladder).
 *   - Storm cap: 1 auto-wake per recipient per 10 min (env
 *     PAPERCUSP_COORD_LADDER_STORM_MS, clamped >=60s). The wake is never
 *     delivered MID-turn — wakeRecipients fires the standing await, which the
 *     harness delivers when the recipient's turn settles (and manual
 *     wake-mode STAGES it, honoring the hive pause gate).
 *   - Kill-switch flag `papercusp-coord-delivery-ladder`, DEFAULT ON —
 *     checked at the periodic tick (dbos/periodic-workflows.ts), not here.
 *
 * LIVE-only by design: a PARKED recipient's unread inject is the SENDER'S
 * choice (a plain inject means "seen next natural turn"); auto-waking parked
 * sessions would convert every inject into a delayed billable turn. A
 * deliberate must-land send already has `wake:'required'` with a loud
 * recipient_absent miss. The ladder only rescues mail the recipient WOULD be
 * reading if its delivery legs were working — i.e. a demonstrably live
 * session that is not reading.
 *
 * DATA MODEL (mirrors reply-deadline-sweep): the ladder's own marker message
 * (from `system:delivery-ladder`, directed to the recipient) is both the
 * audit trail the woken agent reads first AND the storm-cap record — the cap
 * query is "recipients this owner messaged within the window". No side-table.
 * The marker deliberately does NOT set `related_msg_id`: reply-deadline's
 * "does a reply exist" NOT-EXISTS check is author-agnostic, so relating the
 * marker to the unread message would silently suppress a legitimate
 * reply-deadline nudge on the same message.
 *
 * Termination: once woken, the recipient's next turn reads its inbox
 * (coord:orient / the coord hook) → lastInboxReadAt advances past every
 * pending message → the recipient stops classifying. A recipient that never
 * wakes is not `live` → skipped. So the ladder cannot loop forever, and the
 * storm cap bounds the worst case to 1 wake / 10 min while live+deaf.
 *
 * SQL is thin IO; the escalation verdict is a PURE function
 * (classifyLadderEscalations) so the boundary unit-tests without PG —
 * same split as inbox-read-freshness.ts (P-001) and unanswered-directed.ts.
 */

import { getOrgPg } from '@papercusp/db-org';
import { sendMessage } from './messages';
import { wakeRecipients } from './inbox-wake';
import { lastInboxReadAtBatch } from './inbox-read-freshness';
import { fetchWakeability, type WakeabilitySignals } from './presence-wakeability';
import type { AgentIdentity } from './identity';

/** Sender identity stamped on ladder marker messages + wake sources (audit). */
export const DELIVERY_LADDER_OWNER = 'system:delivery-ladder';

/** Coord identity for the ladder's own marker write (mirrors
 *  RECONCILE_REPLY_DEADLINE_OWNER — a system principal, never a fleet agent). */
const LADDER_IDENTITY: AgentIdentity = {
  ownerId: DELIVERY_LADDER_OWNER,
  ownerLabel: 'system · delivery-ladder',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Default TTL: a directed message unread this long (recipient live) escalates. */
export const LADDER_TTL_MS_DEFAULT = 5 * 60_000;
/** Default storm cap: at most one ladder wake per recipient per this window. */
export const LADDER_STORM_MS_DEFAULT = 10 * 60_000;
/** Candidate scan horizon — bounds the JSONB scan; anything older was either
 *  read long ago or belongs to a session the liveness gate excludes anyway. */
export const LADDER_LOOKBACK_MS = 6 * 3600_000;
/** Max recipients escalated per sweep tick (safety bound, under MAX_WAKE_FANOUT). */
export const LADDER_SWEEP_BATCH_LIMIT = 50;

function envMs(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const raw = env[name];
  const n = raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.max(60_000, Math.round(n)); // clamp >=1min — sub-minute TTLs are wake storms
}

export function ladderTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env, 'PAPERCUSP_COORD_LADDER_TTL_MS', LADDER_TTL_MS_DEFAULT);
}

export function ladderStormMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env, 'PAPERCUSP_COORD_LADDER_STORM_MS', LADDER_STORM_MS_DEFAULT);
}

/** One aggregated row per (workspace, recipient) with >=1 directed message
 *  older than TTL inside the lookback window. Read-side unfiltered — the
 *  unread + liveness + storm-cap verdicts happen in the pure classifier. */
export interface LadderCandidateRow {
  workspace_id: string;
  recipient: string;
  cnt: string | number;
  oldest_ts_ms: string | number;
  newest_ts_ms: string | number;
  newest_from: string | null;
  newest_summary: string | null;
}

export interface LadderEscalation {
  workspaceId: string;
  recipient: string;
  /** Directed candidate messages in the window (>=1 of them unread). */
  candidateCount: number;
  oldestAgeMs: number;
  newestFrom?: string;
  newestSummary?: string;
}

/**
 * PURE: fold candidate rows + the recipients' last-inbox-read map + liveness
 * signals + the storm-capped set into the escalation list. Skip-toward-null:
 * missing/unparseable signals never escalate (a wake is a billable turn — only
 * fire on an affirmative live+unread read). Longest-waiting first.
 */
export function classifyLadderEscalations(input: {
  rows: readonly LadderCandidateRow[];
  /** ownerId → last coord:inbox/orient read (ISO), from lastInboxReadAtBatch. */
  lastReadByOwner: ReadonlyMap<string, string>;
  /** ownerId → wakeability signals; live := wakeable && liveTurn. */
  signals: ReadonlyMap<string, WakeabilitySignals>;
  /** Recipients already woken by the ladder inside the storm window. */
  capped: ReadonlySet<string>;
  nowMs: number;
}): LadderEscalation[] {
  const out: LadderEscalation[] = [];
  for (const r of input.rows) {
    if (!r.recipient || input.capped.has(r.recipient)) continue;
    const s = input.signals.get(r.recipient);
    if (!s || !s.wakeable || !s.liveTurn) continue; // LIVE sessions only (see module docstring)
    const newestMs = Number(r.newest_ts_ms);
    const oldestMs = Number(r.oldest_ts_ms);
    if (!Number.isFinite(newestMs)) continue;
    const lastReadRaw = input.lastReadByOwner.get(r.recipient);
    const lastReadMs = lastReadRaw ? Date.parse(lastReadRaw) : NaN;
    // Read since the newest candidate landed ⇒ every candidate is read — no
    // escalation. Never-read (no coord:inbox/orient invocation on record) ⇒
    // everything is unread ⇒ escalate (the wake is exactly what makes a live
    // non-reading session finally read).
    if (Number.isFinite(lastReadMs) && lastReadMs >= newestMs) continue;
    const cnt = Number(r.cnt);
    out.push({
      workspaceId: r.workspace_id,
      recipient: r.recipient,
      candidateCount: Number.isFinite(cnt) && cnt > 0 ? cnt : 1,
      oldestAgeMs: Number.isFinite(oldestMs) ? Math.max(0, input.nowMs - oldestMs) : 0,
      ...(r.newest_from ? { newestFrom: r.newest_from } : {}),
      ...(r.newest_summary ? { newestSummary: r.newest_summary } : {}),
    });
  }
  return out.sort((a, b) => b.oldestAgeMs - a.oldestAgeMs);
}

/**
 * IO: one aggregated scan for directed-message candidates older than TTL
 * (mirrors reply-deadline-sweep's cross-workspace admin-connection scan —
 * append-only `messages` surface, JSONB predicates). Directedness filters
 * live in SQL (cheap set math); the per-recipient verdicts live in the
 * classifier above.
 */
async function findLadderCandidates(
  nowMs: number,
  ttlMs: number,
): Promise<LadderCandidateRow[]> {
  const { sql } = getOrgPg();
  const newestAllowedMs = nowMs - ttlMs;
  const sinceMs = nowMs - LADDER_LOOKBACK_MS;
  return sql<LadderCandidateRow[]>`
    WITH directed AS (
      SELECT
        e.workspace_id,
        r AS recipient,
        e.body->>'from' AS from_id,
        e.body->>'summary' AS summary,
        (extract(epoch FROM (e.body->>'ts')::timestamptz) * 1000)::bigint AS ts_ms
        FROM harness_shared.coord_event_log e
        CROSS JOIN LATERAL jsonb_array_elements_text(e.body->'to') AS r
       WHERE e.surface = 'messages'
         AND (e.body->>'kind' IS NULL OR e.body->>'kind' = 'message')
         AND NOT (e.body ? 'audience')
         AND jsonb_typeof(e.body->'to') = 'array'
         AND e.body->>'from' IS DISTINCT FROM r
         AND e.body->>'from' NOT LIKE 'system:%'
         AND r NOT IN ('*', 'human', '')
         AND r NOT LIKE '@%'
         AND (e.body->>'ts')::timestamptz >= to_timestamp(${sinceMs}::double precision / 1000)
         AND (e.body->>'ts')::timestamptz <= to_timestamp(${newestAllowedMs}::double precision / 1000)
    )
    SELECT workspace_id,
           recipient,
           count(*) AS cnt,
           min(ts_ms) AS oldest_ts_ms,
           max(ts_ms) AS newest_ts_ms,
           (array_agg(from_id ORDER BY ts_ms DESC))[1] AS newest_from,
           (array_agg(summary ORDER BY ts_ms DESC))[1] AS newest_summary
      FROM directed
     GROUP BY workspace_id, recipient
  `;
}

/** IO: recipients the ladder already woke inside the storm window — the
 *  marker messages ARE the record (see module docstring). */
async function findStormCappedRecipients(
  nowMs: number,
  stormMs: number,
): Promise<Set<string>> {
  const { sql } = getOrgPg();
  const sinceMs = nowMs - stormMs;
  const rows = await sql<{ recipient: string }[]>`
    SELECT DISTINCT r AS recipient
      FROM harness_shared.coord_event_log e
      CROSS JOIN LATERAL jsonb_array_elements_text(e.body->'to') AS r
     WHERE e.surface = 'messages'
       AND e.body->>'from' = ${DELIVERY_LADDER_OWNER}
       AND (e.body->>'ts')::timestamptz >= to_timestamp(${sinceMs}::double precision / 1000)
  `;
  return new Set(rows.map((r) => r.recipient));
}

export interface DeliveryLadderSweepResult {
  /** (workspace, recipient) candidate groups seen this pass (pre-filter). */
  candidates: number;
  /** Recipients that classified live+unread+uncapped. */
  escalations: number;
  /** Recipients actually woken (marker sent + wake fired without error). */
  woken: number;
  /** True when escalations exceeded the batch limit (more next tick). */
  truncated: boolean;
}

/**
 * One sweep pass. Injectable IO seams (`io`) so the whole pass unit-tests
 * without PG (same DI convention as decorateCoordDeafness's fetcher);
 * production callers pass nothing. Fully fail-soft per recipient — one bad
 * escalation never aborts the pass; the next tick retries (still unread,
 * still selectable) under the storm cap.
 */
export async function runDeliveryLadderSweepOnce(
  opts: {
    nowMs?: number;
    ttlMs?: number;
    stormMs?: number;
    limit?: number;
    io?: {
      fetchCandidates?: (nowMs: number, ttlMs: number) => Promise<LadderCandidateRow[]>;
      fetchReads?: (ownerIds: string[]) => Promise<Map<string, string>>;
      fetchSignals?: (ownerIds: string[]) => Promise<Map<string, WakeabilitySignals>>;
      fetchCapped?: (nowMs: number, stormMs: number) => Promise<Set<string>>;
      send?: typeof sendMessage;
      wake?: typeof wakeRecipients;
    };
  } = {},
): Promise<DeliveryLadderSweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const ttl = opts.ttlMs ?? ladderTtlMs();
  const storm = opts.stormMs ?? ladderStormMs();
  const limit = opts.limit ?? LADDER_SWEEP_BATCH_LIMIT;
  const io = opts.io ?? {};

  const rows = await (io.fetchCandidates ?? findLadderCandidates)(nowMs, ttl);
  if (rows.length === 0) return { candidates: 0, escalations: 0, woken: 0, truncated: false };

  const recipients = [...new Set(rows.map((r) => r.recipient))];
  const [lastReadByOwner, signals, capped] = await Promise.all([
    (io.fetchReads ?? lastInboxReadAtBatch)(recipients),
    (io.fetchSignals ?? fetchWakeability)(recipients),
    (io.fetchCapped ?? findStormCappedRecipients)(nowMs, storm),
  ]);

  const escalations = classifyLadderEscalations({ rows, lastReadByOwner, signals, capped, nowMs });
  const batch = escalations.slice(0, limit);

  const send = io.send ?? sendMessage;
  const wake = io.wake ?? wakeRecipients;
  const ttlMin = Math.round(ttl / 60_000);
  let woken = 0;
  for (const e of batch) {
    const oldestMin = Math.round(e.oldestAgeMs / 60_000);
    try {
      await send(LADDER_IDENTITY, {
        to: [e.recipient],
        summary:
          `📬 delivery-ladder: directed mail unread past ${ttlMin}m — waking you to read your inbox ` +
          `(${e.candidateCount} message(s), oldest ~${oldestMin}m${e.newestFrom ? `, newest from ${e.newestFrom}` : ''})`,
        body:
          `You have ${e.candidateCount} DIRECTED coord message(s) in the last ` +
          `${Math.round(LADDER_LOOKBACK_MS / 3600_000)}h that you have not read (oldest ~${oldestMin}m old` +
          `${e.newestSummary ? `; newest: "${e.newestSummary}"` : ''}). Your session is live but has not ` +
          `called coord:inbox/coord:orient since they landed — read your inbox now. This is the delivery ` +
          `escalation ladder (auto-fired, at most once per ${Math.round(storm / 60_000)}m); if you keep ` +
          `getting these, your coord delivery hooks may be broken — see the coord-mid-turn-delivery insight.`,
      });
      try {
        await wake([e.recipient], {
          summary: `delivery-ladder: directed mail unread past ${ttlMin}m (oldest ~${oldestMin}m)`,
          source: DELIVERY_LADDER_OWNER,
          workspaceId: e.workspaceId,
        });
        woken += 1;
      } catch (err) {
        console.warn(
          `[delivery-ladder] wake ${e.recipient} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    } catch (err) {
      // Marker send failed ⇒ no storm-cap record either ⇒ next tick retries.
      console.warn(
        `[delivery-ladder] escalation for ${e.recipient} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return {
    candidates: rows.length,
    escalations: escalations.length,
    woken,
    truncated: escalations.length > batch.length,
  };
}
