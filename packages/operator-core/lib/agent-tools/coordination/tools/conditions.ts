/**
 * coord:conditions — the live "what is wrong RIGHT NOW" view (EI-6138).
 *
 * Severe system conditions (pipeline stalls, gate freezes) are broadcast as
 * condition-KEYED alarms and superseded by resolution broadcasts on recovery
 * (WI-1444: severe-event-broadcast.ts). That gives conditions a derivable
 * STATE — open vs resolved — but until this tool the only way to read it was
 * replaying message history. This folds the condition-keyed envelope stream
 * into current state: every key whose latest alarm is NEWER than its latest
 * resolution is OPEN; everything else is resolved.
 *
 * Read-only, low-tier (`coord:read`): the underlying rows are `to:['*']`
 * broadcasts every agent already sees in its inbox.
 */

import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import type { CoordEnvelope } from "@papercusp/coordination/core";
import { COORD_ROLES } from "../roles";
import { coordLog, coordSql, coordWorkspaceId, coordHasPgFastPath } from "../log";
import { MESSAGE_GC_RETENTION_DAYS } from "../message-log-gc";

/** EI-9447 (WI-3937/WI-3869 furnace class): hard backstop on rows scanned by
 *  `readConditionEnvelopes`'s PG fast path, applied even within the retention
 *  window — the one bound that holds regardless of any burst of condition
 *  traffic. Condition rows are a rare sliver of the `messages` surface (live
 *  observed ~774 rows/call), so this comfortably clears any legitimate read
 *  while still capping a genuinely pathological burst. Mirrors
 *  INBOX_FAST_PATH_ROW_CAP (messages.ts). */
export const CONDITIONS_FAST_PATH_ROW_CAP = 25_000;

/** One condition's folded state. */
export interface ConditionState {
  condition_key: string;
  /** open ⇔ the latest alarm is newer than the latest resolution. */
  open: boolean;
  /** sender of the latest alarm (usually 'system-watchdog'). */
  from: string;
  /** ambient category of the latest alarm (e.g. 'severe-event'). */
  category: string | null;
  /** ts of the FIRST alarm ever seen for this key. */
  first_seen: string;
  /** ts of the LATEST alarm. */
  last_seen: string;
  /** total alarm broadcasts for this key (re-alarms after flapping included). */
  alarm_count: number;
  /** the latest alarm's one-line summary. */
  latest_summary: string | null;
  /** ts of the latest resolution, when one exists. */
  resolved_at: string | null;
  /** the latest resolution's one-line summary, when one exists. */
  resolved_summary: string | null;
}

/**
 * Fold condition-keyed envelopes (ascending ts) into per-key state. An
 * envelope with `resolves_condition` is a RESOLUTION for that key; an envelope
 * with `condition_key` and no `resolves_condition` is an ALARM. A key is open
 * iff its latest alarm ts is strictly newer than its latest resolution ts
 * (a re-alarm after recovery re-opens it). Pure.
 */
export function computeConditionStates(
  envelopes: readonly Record<string, unknown>[],
): ConditionState[] {
  const byKey = new Map<string, ConditionState>();
  for (const e of envelopes) {
    const ts = typeof e["ts"] === "string" ? (e["ts"] as string) : null;
    if (!ts) continue;
    const resolves = e["resolves_condition"];
    if (typeof resolves === "string" && resolves) {
      const s = byKey.get(resolves);
      if (s) {
        if (!s.resolved_at || ts > s.resolved_at) {
          s.resolved_at = ts;
          s.resolved_summary =
            typeof e["summary"] === "string" ? (e["summary"] as string) : null;
        }
      } else {
        // A resolution for a key we never saw alarm (log GC ate the alarm, or
        // a partial window). Record it resolved so it never reads as open.
        byKey.set(resolves, {
          condition_key: resolves,
          open: false,
          from: typeof e["from"] === "string" ? (e["from"] as string) : "",
          category: null,
          first_seen: ts,
          last_seen: ts,
          alarm_count: 0,
          latest_summary: null,
          resolved_at: ts,
          resolved_summary:
            typeof e["summary"] === "string" ? (e["summary"] as string) : null,
        });
      }
      continue;
    }
    const key = e["condition_key"];
    if (typeof key !== "string" || !key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        condition_key: key,
        open: true, // provisional; finalized below against resolved_at
        from: typeof e["from"] === "string" ? (e["from"] as string) : "",
        category:
          typeof e["category"] === "string" ? (e["category"] as string) : null,
        first_seen: ts,
        last_seen: ts,
        alarm_count: 1,
        latest_summary:
          typeof e["summary"] === "string" ? (e["summary"] as string) : null,
        resolved_at: null,
        resolved_summary: null,
      });
    } else {
      prev.alarm_count += 1;
      if (ts < prev.first_seen) prev.first_seen = ts;
      if (ts >= prev.last_seen) {
        prev.last_seen = ts;
        prev.latest_summary =
          typeof e["summary"] === "string" ? (e["summary"] as string) : null;
        prev.from = typeof e["from"] === "string" ? (e["from"] as string) : prev.from;
        prev.category =
          typeof e["category"] === "string" ? (e["category"] as string) : prev.category;
      }
    }
  }
  const out = [...byKey.values()];
  for (const s of out) {
    s.open = s.alarm_count > 0 && (!s.resolved_at || s.last_seen > s.resolved_at);
  }
  // Open first, then most-recently-active first.
  out.sort((a, b) =>
    a.open !== b.open ? (a.open ? -1 : 1) : b.last_seen.localeCompare(a.last_seen),
  );
  return out;
}

/**
 * Load every condition-carrying envelope, cheapest available path. Exported
 * (WI-2965) so the coord:conditions staleness actor (system-health/
 * condition-staleness-alarm.ts) reads the SAME rows this tool's handler folds,
 * rather than re-deriving its own read path.
 */
export async function readConditionEnvelopes(): Promise<Record<string, unknown>[]> {
  // PG pushdown: condition rows are a tiny sliver of the messages surface —
  // filter server-side on the jsonb keys (mirrors readInbox's fast path,
  // including the fall-through to the seam on any error / non-PG backend).
  //
  // EI-9447 (WI-3937/WI-3869 furnace class): this was an UNBOUNDED scan of the
  // WHOLE `messages` surface — no ts/id lower bound, no LIMIT — averaging
  // 7.1s/call across 3,351 calls (the `body ? ...` jsonb-existence filter has
  // no supporting index, so every call walked the full surface, 774
  // rows/call). Two independent bounds, mirroring readInbox (WI-3825):
  //   (a) a `ts >=` lower bound at the message-log GC retention window
  //       (MESSAGE_GC_RETENTION_DAYS) — nothing older survives GC anyway, so
  //       this drops zero live state while giving the query a selective range
  //       to seek on;
  //   (b) a hard LIMIT backstop (CONDITIONS_FAST_PATH_ROW_CAP) regardless of
  //       the ts bound, so a pathological burst can never re-open the
  //       unbounded-scan hole.
  // Both are safe: a condition whose LATEST alarm/resolution both fall
  // outside the retention window is, by definition, not "wrong right now" —
  // GC would have already reaped it.
  if (coordHasPgFastPath()) {
    try {
      const sql = coordSql();
      const sinceBound = new Date(Date.now() - MESSAGE_GC_RETENTION_DAYS * 86_400_000).toISOString();
      const rows = await sql<{ body: unknown }[]>`
        SELECT body
          FROM harness_shared.coord_event_log
         WHERE workspace_id = ${coordWorkspaceId()}
           AND surface = 'messages'
           AND ts >= ${sinceBound}
           AND (body ? 'condition_key' OR body ? 'resolves_condition')
         ORDER BY id ASC
         LIMIT ${CONDITIONS_FAST_PATH_ROW_CAP}
      `;
      return rows.map(
        (r) =>
          (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as Record<
            string,
            unknown
          >,
      );
    } catch {
      // fall through to the seam read
    }
  }
  const lines = (await coordLog.readLines("messages")) as CoordEnvelope[];
  return (lines as unknown as Record<string, unknown>[]).filter(
    (l) => "condition_key" in l || "resolves_condition" in l,
  );
}

export default defineTool({
  name: "coord:conditions",
  description:
    'The live "what is wrong RIGHT NOW" view: folds condition-keyed severe-event broadcasts (git-sync stalls, green-gate freezes, …) into per-condition STATE instead of message history. Returns open conditions first (latest alarm newer than any resolution) with first_seen/last_seen/alarm_count/latest_summary, then recently-resolved ones (resolved_at + resolved_summary). An OPEN condition is claimable work; a resolved one needs no action.',
  guidance: {
    when:
      'Orienting on current system health — "is anything wrong right now?" — before claiming a stall/red-gate broadcast, or when an old severe-event alarm in your inbox needs a live open/resolved verdict.',
    notWhen:
      "For your addressed mail use coord:inbox (stale alarms there already carry resolved:true). For human-facing escalations use coord:escalations. For agent liveness use coord:presence.",
  },
  capability: "coord:read",
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    include_resolved: z
      .boolean()
      .optional()
      .describe(
        "Also return resolved conditions (default true, capped by resolved_limit). Pass false for open-only.",
      ),
    resolved_limit: z
      .number()
      .int()
      .min(0)
      .max(50)
      .optional()
      .describe("Max resolved conditions returned (most recent kept). Default 10."),
  }),
  async handler(args) {
    const states = computeConditionStates(await readConditionEnvelopes());
    const open = states.filter((s) => s.open);
    const resolvedLimit = args.resolved_limit ?? 10;
    const resolved =
      args.include_resolved === false
        ? []
        : states.filter((s) => !s.open).slice(0, resolvedLimit);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            open_count: open.length,
            open,
            resolved_count: states.length - open.length,
            resolved,
          }),
        },
      ],
    };
  },
});
