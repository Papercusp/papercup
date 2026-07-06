/**
 * coord:inbox — read the caller's coordination inbox.
 *
 * Union scan of every agent's outbox in coord/messages/, filtered to
 * entries addressed to me (or to '*'). Sorted by ts ascending.
 * Forgiving of malformed lines.
 */

import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import { resolveAgentIdentity } from "../identity";
import { resolveActorIdentity, actorMailboxKeys } from "../actor-identity";
import { readInbox, drainAndDeliverUserMailbox } from "../messages";
import { heartbeatPresence, getPresence } from "../presence";
import { createPresenceBeatThrottle } from "../presence-beat-throttle";
import { readWatermark, writeWatermark } from "../watermarks";
import { emptyWatermark } from "@papercusp/coordination/core";
import {
  resolvePresenceScope,
  assemblePresenceSnapshot,
  renderPresenceRebootstrapBlock,
  consumePresenceRebootstrap,
} from "../presence-snapshot";
import { COORD_ROLES } from "../roles";
import { renderInjection, type CoordLineSource } from "../../../coord-schema";
import {
  renderContextUsageLine,
  contextUsagePct,
  renderBandedContextGauge,
  CONTEXT_GAUGE_LOUD_PCT,
} from "./inbox-context-usage";
import { classifyStaleClaims, renderFlushGateLine, FLUSH_GATE_PCT } from "./inbox-flush-gate";
import { listActiveClaimFreshnessForOwner } from "../../../work-item-claims";
import { activeWorkspaceId } from "../../../workspace-registry";
import { cachedRead, type CachedReadCtx } from "../../../cache";

/**
 * SWR backstop for the coord:inbox derive (cache-expensive-tool-reads-2026-06-22 P-008).
 * ONLY the pure readInbox() derive (the p95-heavy union-scan over coord_event_log) is
 * cached — every side effect (presence heartbeat, read-receipt watermark, offline-mailbox
 * drain, rebootstrap, injection render) stays OUTSIDE the cache and runs on every call, so
 * a cache HIT never drops coordination liveness (D-001 purity: cache only the pure part).
 * Tagged with coord_event_log, whose per-event bump is DEBOUNCED (D-006) so the storm can't
 * tank the hit-rate; this short soft TTL bounds worst-case staleness alongside the debounce.
 */
const COORD_INBOX_SOFT_TTL_MS = 5_000;

/**
 * EI-6797: per-owner throttle for the inbox liveness heartbeat. `coord:inbox`
 * (and `coord:orient`, which wraps it) fired the HEAVY `coord_presence`
 * `INSERT ... ON CONFLICT ... DO UPDATE` upsert on EVERY call — the dominant
 * lock-manager contention source when a busy fleet loops orient on a wake
 * cadence. Coalesce it to ≤1 upsert per window per owner (the discipline the
 * sibling dispatch beat already applies). Its own throttle Map so a no-op
 * dispatch beat never suppresses the row-minting inbox beat.
 */
const inboxHeartbeatThrottle = createPresenceBeatThrottle();

const COORD_KINDS = [
  "message",
  "ack",
  "subscribe",
  "unsubscribe",
  "notify",
  "handoff",
  "handoff_accepted",
  "escalation",
  "escalation_resolved",
  "contract",
  "plan_event",
] as const;

/** Ambient system-broadcast categories excluded from the default inbox — they
 *  are high-volume status firehoses (service up/down, rate-limit pauses, and the
 *  per-git-sync doc-freshness RE-VERIFY digest) that bury addressed work. Every
 *  one is broadcast to '*' and actionable to almost no single reader, so on a busy
 *  fleet they drown out directed messages (EI-2826/EI-2871: a doc-drift flood
 *  literally BURIED a peer's "details inside" build-blocker so it was never read).
 *  `doc-drift` earns its place here even though it's individually useful: the
 *  fan-out is to `*`, not to the doc's owner, so for ~every recipient it is pure
 *  noise — the right long-term fix is owner/subscriber targeting (EI-2826 opt c),
 *  but exclude-by-default (opt a) unburies the channel for the whole fleet NOW.
 *  Still `message`s (D-002); opt back in via include_ambient. */
const AMBIENT_CATEGORIES = new Set([
  "service-health",
  "agent-governor",
  "doc-drift",
]);

const DEFAULT_INBOX_LIMIT = 50;

/** context-trimming-tiers P-012: a trimmed/standard session gets TIGHTER
 *  DEFAULTS (fewer entries, shorter bodies) — explicit `limit`/`max_body_chars`
 *  args always win. coord:inbox deliberately keeps its hand-rolled JSON
 *  ToolResult instead of a `{data}` + shape conversion: the cc/omp PostToolUse
 *  hooks `json.loads` the text body (a `{data}` response could serve TOON on the
 *  MCP transport and silently break them), and the hooks call WITHOUT ctx_tier
 *  so they always read full-tier defaults. The `injection` block is already
 *  server-clipped by coord-schema and stays verbatim on every tier. */
const INBOX_TIER_DEFAULTS = {
  trimmed: { limit: 15, bodyChars: 250 },
  standard: { limit: 30, bodyChars: 400 },
  full: { limit: DEFAULT_INBOX_LIMIT, bodyChars: 600 },
} as const;

/** EI-1752: truncate an inbox entry's content-bearing string fields (`summary`,
 *  `body`) to `maxChars` so a default read can't overflow the agent result cap (a
 *  few long summaries/bodies = 80KB+ in one line). Truncated fields carry a
 *  `<field>_truncated` flag; the full text stays reachable via coord:thread.
 *  `maxChars <= 0` ⇒ no truncation. Pure. */
export function boundInboxEntries<T extends Record<string, unknown>>(
  entries: readonly T[],
  maxChars: number,
): Array<Record<string, unknown>> {
  if (!(maxChars > 0))
    return entries as unknown as Array<Record<string, unknown>>;
  return entries.map((e) => {
    let out: Record<string, unknown> = e;
    for (const field of ["summary", "body"] as const) {
      const v = e[field];
      if (typeof v === "string" && v.length > maxChars) {
        out = {
          ...out,
          [field]: v.slice(0, maxChars),
          [`${field}_truncated`]: true,
          [`${field}_full_chars`]: v.length,
        };
      }
    }
    return out;
  });
}

/** EI-6144 ambient/broadcast coalescing: collapse REPEATED categorized system
 *  broadcasts — same sender, kind, category, and verbatim summary, addressed to
 *  '*' — into ONE row (the newest of the group), annotated `repeat_count` +
 *  `first_seen_ts`. Watchdog/status firehoses re-emit the same line for hours;
 *  without this they fill the `limit` window with repetition and crowd distinct
 *  signal out. Only categorized broadcasts coalesce: direct messages (a peer
 *  legitimately saying the same thing twice) and uncategorized rows pass
 *  through untouched. Read-time only — the log keeps every row. Ascending
 *  order is preserved (each group's newest keeps its original position). Pure. */
export function coalesceRepeatedBroadcasts<T extends Record<string, unknown>>(
  entries: readonly T[],
): Array<Record<string, unknown>> {
  type Group = { lastIdx: number; count: number; firstTs: string };
  const groups = new Map<string, Group>();
  const keyOf = (e: Record<string, unknown>): string | null => {
    const category = e["category"];
    const summary = e["summary"];
    const to = e["to"];
    if (typeof category !== "string" || !category) return null;
    if (typeof summary !== "string" || !summary) return null;
    if (!Array.isArray(to) || !to.includes("*")) return null;
    return `${String(e["from"] ?? "")}\x00${String(e["kind"] ?? "")}\x00${category}\x00${summary}`;
  };
  entries.forEach((e, i) => {
    const key = keyOf(e);
    if (key === null) return;
    const ts = typeof e["ts"] === "string" ? (e["ts"] as string) : "";
    const g = groups.get(key);
    if (!g) groups.set(key, { lastIdx: i, count: 1, firstTs: ts });
    else {
      g.count += 1;
      g.lastIdx = i; // entries are ascending — the latest index is the newest
      if (ts && (!g.firstTs || ts < g.firstTs)) g.firstTs = ts;
    }
  });
  if (![...groups.values()].some((g) => g.count > 1))
    return entries as unknown as Array<Record<string, unknown>>;
  const out: Array<Record<string, unknown>> = [];
  entries.forEach((e, i) => {
    const key = keyOf(e);
    if (key === null) {
      out.push(e);
      return;
    }
    const g = groups.get(key)!;
    if (i !== g.lastIdx) return; // an older duplicate — folded into the newest
    out.push(
      g.count > 1 ? { ...e, repeat_count: g.count, first_seen_ts: g.firstTs } : e,
    );
  });
  return out;
}

/** WI-1444 severe-event condition lifecycle: annotate every entry whose
 *  `condition_key` has a STRICTLY-LATER resolution (`resolves_condition` on a
 *  later envelope — broadcastSevereEventResolved) with `resolved:true` +
 *  `resolved_at`, so an agent reading a stale stall alarm sees at a glance
 *  that the condition already cleared instead of burning a turn investigating
 *  it. Resolutions are scanned over the FULL inbox read (`all`, pre-limit) so
 *  a windowed view still resolves against everything the reader can see. Pure. */
export function annotateResolvedConditions<T extends Record<string, unknown>>(
  entries: readonly T[],
  all: readonly Record<string, unknown>[],
): Array<Record<string, unknown>> {
  // Latest resolution ts per condition key (ISO ts compare lexicographically).
  const resolvedAt = new Map<string, string>();
  for (const e of all) {
    const key = e["resolves_condition"];
    const ts = e["ts"];
    if (typeof key === "string" && key && typeof ts === "string") {
      const prev = resolvedAt.get(key);
      if (!prev || ts > prev) resolvedAt.set(key, ts);
    }
  }
  if (resolvedAt.size === 0)
    return entries as unknown as Array<Record<string, unknown>>;
  return entries.map((e) => {
    const key = e["condition_key"];
    const ts = e["ts"];
    if (typeof key === "string" && typeof ts === "string") {
      const rts = resolvedAt.get(key);
      if (rts && rts > ts) return { ...e, resolved: true, resolved_at: rts };
    }
    return e;
  });
}

/** EI-7018 sender filter: keep only entries SENT BY `from` (from === this ownerId). A
 *  nullish/empty `from` is a no-op (returns the input as-is). Extracted as a pure, exported
 *  helper — mirroring readCoordFeed's strict `from` filter — so the honored-not-silently-ignored
 *  behavior has a unit test. NB: the caller applies this to the DISPLAY set only; the full
 *  unfiltered read is kept for cross-entry scans (e.g. condition-resolution annotation). */
export function filterInboxBySender<T extends { from?: unknown }>(
  entries: readonly T[],
  from: string | undefined | null,
): readonly T[] {
  if (!from) return entries;
  return entries.filter((e) => e.from === from);
}

export default defineTool({
  name: "coord:inbox",
  description:
    "Read your coordination inbox — messages, acks, handoffs etc. addressed to you (or broadcast). Returns a summary header (counts by kind) + the most-recent `limit` entries (default 50). Ambient system broadcasts (service-health, rate-limit pauses, and the per-sync doc-freshness RE-VERIFY digest) are excluded by default — pass include_ambient to see them. Repeated categorized system broadcasts collapse to one row with `repeat_count` + `first_seen_ts`; a stale severe-event alarm whose condition later cleared carries `resolved:true` + `resolved_at` — do not investigate a resolved condition. `since_ts` filters strictly later than the given ISO timestamp; `kinds` narrows to specific entry kinds. CAUTION (WI-1600 since_ts gap): in a tail-poll, never seed since_ts to wall-clock now/poll-start — anything that landed earlier stays invisible to every later poll. Read once unfiltered, then advance the cursor to that read's `summary.newest_ts`; or skip polling via the push-based `coord:await-inbox`.",
  guidance: {
    when: "At turn start (the OMP hook will do this for you once it ships); whenever you suspect another agent contacted you.",
    notWhen:
      'For agent-presence ("who is active?") — use coord:presence. For file locks — use locks:queue. To WAIT for one specific message/handoff — prefer coord:await-inbox (push/wake) over a since_ts poll (see the WI-1600 CAUTION).',
  },
  capability: "coord:read",
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    since_ts: z.string().optional(),
    kinds: z.array(z.enum(COORD_KINDS)).optional(),
    from: z
      .string()
      .optional()
      .describe(
        "Restrict to entries SENT BY this ownerId (from === this) — e.g. filter to just your leader's messages amid broadcast/doc-drift noise, or confirm a specific peer wrote to you. Applied after the ambient filter; the summary counts reflect it. (EI-7018)",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        `Max entries returned (most-recent kept). Default ${DEFAULT_INBOX_LIMIT}.`,
      ),
    include_ambient: z
      .boolean()
      .optional()
      .describe(
        "Include ambient system broadcasts (service-health, agent-governor, doc-drift) excluded by default.",
      ),
    max_body_chars: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Truncate each entry's body to this many chars in the result (default dynamically budgets to roughly 15KB across entries) so a default read never overflows the agent result cap; truncated entries carry body_truncated:true and the full body is reachable via coord:thread. 0 = no truncation.",
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const sessionTier = (ctx as { contextTier?: keyof typeof INBOX_TIER_DEFAULTS })
      .contextTier;
    const tierDefaults =
      (sessionTier && INBOX_TIER_DEFAULTS[sessionTier]) ??
      INBOX_TIER_DEFAULTS.full;
    const limit = args.limit ?? tierDefaults.limit;
    // Offline-member mailbox (shared-hive-collaboration P-016): before the read,
    // deliver any `@user:`-parked assignment waiting for THIS member into their
    // live inbox, so a returning member sees it in this very response. The drain
    // matches the member's full actorUserKey ladder (resolveActorIdentity adds the
    // async gh id; cached). Best-effort — a drain hiccup must never break the read;
    // a fully-online member with no parked mail is a single cheap no-op UPDATE.
    await resolveActorIdentity(ctx)
      .then((actor) =>
        drainAndDeliverUserMailbox(actorMailboxKeys(actor), actor.ownerId),
      )
      .catch(() => {});
    // Piggyback liveness: reading your inbox IS a heartbeat. Keeps a fresh
    // coord:presence row for every active agent (the read hook runs every
    // tool call) without clobbering a declared intent. Best-effort, and run
    // concurrently with the read so it adds no latency.
    // EI-6797: coalesce the heavy heartbeat UPSERT to ≤1 per window per owner —
    // an inbox-per-tool-call storm was the dominant coord_presence lock-manager
    // contention source fleet-wide. Skipped calls stay fresh via the sibling
    // dispatch beat + the next past-window inbox read.
    // The watermark is read concurrently too — the P-010 re-bootstrap flag rides
    // it (snapshot_rebootstrap_pending), so the common no-flag path adds only one
    // cheap PK read and no extra latency.
    const [, all, wm] = await Promise.all([
      inboxHeartbeatThrottle.shouldBeat(identity.ownerId)
        ? heartbeatPresence(identity).catch(() => {})
        : Promise.resolve(),
      // Cache ONLY the pure derive (P-008). Keyed on the OWNER (principal-scoped — never
      // leak one agent's inbox to another), since_ts + kinds. The side effects above/below
      // run unconditionally. The VITEST bypass keeps existing coord:inbox tests unchanged.
      cachedRead(
        ctx as CachedReadCtx,
        {
          tool: "coord:inbox",
          key: {
            owner: identity.ownerId,
            since_ts: args.since_ts ?? null,
            kinds: args.kinds ?? null,
          },
          tags: ["coord_event_log"],
          softTtlMs: COORD_INBOX_SOFT_TTL_MS,
        },
        () =>
          readInbox(identity.ownerId, {
            since_ts: args.since_ts,
            kinds: args.kinds,
          }),
      ),
      readWatermark(identity.ownerId).catch(() => emptyWatermark()),
    ]);

    const isAmbient = (e: { category?: unknown }) =>
      typeof e.category === "string" && AMBIENT_CATEGORIES.has(e.category);
    const ambientExcluded = args.include_ambient
      ? 0
      : all.filter(isAmbient).length;
    const ambientFiltered = args.include_ambient
      ? all
      : all.filter((e) => !isAmbient(e));
    // EI-7018: honor a strict sender-only `from` filter instead of silently ignoring it (the
    // silent-ignore looked like a hit-less filtered read). Applied post-cache/in-memory so it
    // never collides with the owner-keyed derive cache; it scopes the returned window + the
    // summary counts (byKind/total below run on `filtered`). `all` stays unfiltered for the
    // resolution scan (annotateResolvedConditions).
    const filtered = filterInboxBySender(ambientFiltered, args.from);

    // EI-6144: fold repeated categorized broadcasts into one ×N row BEFORE the
    // limit slice, so the returned window carries distinct signal instead of a
    // watchdog line repeated `limit` times. Read-time only; ascending preserved.
    const coalesced = coalesceRepeatedBroadcasts(
      filtered as unknown as Array<Record<string, unknown>>,
    );
    const coalescedDupes = filtered.length - coalesced.length;

    // readInbox returns ascending by (ts, msg_id); keep the most-recent `limit`.
    const truncated = Math.max(0, coalesced.length - limit);
    const entries = (
      truncated > 0 ? coalesced.slice(coalesced.length - limit) : coalesced
    ) as unknown as typeof filtered;

    const byKind: Record<string, number> = {};
    for (const e of filtered) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

    const summary = {
      total: filtered.length,
      returned: entries.length,
      truncated,
      // P-012: mark a tier-tightened read so the cap is never silent (D-004) —
      // pass an explicit `limit`/`max_body_chars` (or payloadTier:"full") for more.
      ...(sessionTier && sessionTier !== "full"
        ? { payload_tier: sessionTier }
        : {}),
      ambient_excluded: ambientExcluded,
      // EI-6144: rows folded into a ×N representative (repeat_count on the row).
      coalesced_dupes: coalescedDupes,
      by_kind: byKind,
      oldest_returned_ts: entries.length ? (entries[0]?.ts ?? null) : null,
      newest_ts: entries.length
        ? (entries[entries.length - 1]?.ts ?? null)
        : null,
    };

    // EI-2042 READ-RECEIPT: advance this agent's `messages_shown_ts` cursor to the newest
    // entry just SHOWN to them — DETERMINISTICALLY here in tool code (the moment the
    // `[coord+N]` block is assembled for the agent), NOT via the LLM/turn-end hook. This
    // is the per-agent read-watermark a SENDER checks (surfaced as coord:presence
    // `read_through_ts`) to distinguish "read it + working" from "hasn't seen it yet" —
    // distinct from `messages_since_ts`, which advances at turn-END (so an aborted turn
    // re-delivers). Monotonic by guard (only ever forward — you can't un-see a message;
    // writeWatermark itself is last-write-wins, so the guard is what keeps shown_ts from
    // moving backward) + best-effort (a write failure must never break the inbox read).
    if (summary.newest_ts && summary.newest_ts > wm.messages_shown_ts) {
      await writeWatermark(identity.ownerId, {
        messages_shown_ts: summary.newest_ts,
      }).catch(() => {});
    }

    // Server-side injection render (token-efficient-coord-injection P-005): the
    // ready-to-inject positional `[coord+N]` block, computed ONCE here from the
    // single-source `coord-schema` so the cc + omp hooks are dumb pipes (they
    // echo `injection` + advance the cursor from `summary.newest_ts`). The
    // cursor/summary metadata stays OUT of the injection body, alongside it.
    const coordInjection = renderInjection(
      entries as unknown as CoordLineSource[],
    );

    // P-010 re-bootstrap-on-compaction (D-007): on the first read after a fresh
    // context / resume (a session-lifecycle start set snapshot_rebootstrap_pending),
    // the agent's cached roster baseline is gone but this cursor advanced — so
    // PREPEND a fresh presence snapshot to the injection ONCE (then the flag is
    // cleared), and the agent never coordinates off a stale baseline. Best-effort:
    // a failure leaves the flag set to retry and never breaks the inbox read. It
    // rides the same dumb-pipe `injection` echo, so no hook change is needed.
    let rebootstrap: string | null = null;
    try {
      const c = (ctx ?? {}) as {
        workspaceId?: string | null;
        harnessSlug?: string | null;
      };
      rebootstrap = await consumePresenceRebootstrap(
        identity.ownerId,
        wm,
        async () => {
          const resolved = await resolvePresenceScope(c);
          const snap = await assemblePresenceSnapshot(resolved);
          return renderPresenceRebootstrapBlock(snap);
        },
      );
    } catch {
      rebootstrap = null;
    }
    // agent-managed-compaction (P-007): prepend the cached context-usage signal so the
    // agent self-manages its own compaction. Cheap single-row PK read; best-effort — a
    // failure/absence just omits the line, never breaks the inbox. The watchdog (P-009)
    // refreshes context_tokens on a cadence, off this hot path.
    let usageLine: string | null = null;
    let flushLine: string | null = null;
    // agent-managed-compaction P-015: the LOUD-band (≥80%) banded gauge, server-rendered
    // so the PostToolUse hook stays a dumb pipe. Unlike `usageLine` (which rides the
    // `injection` echo only when new coord entries exist), the hook injects THIS even on an
    // empty inbox — closing the heads-down / zero-new-mail gap (EI-6597). One renderer
    // source (renderBandedContextGauge) shared with the P-013 result-annotator.
    let contextGauge: string | null = null;
    try {
      const pres = await getPresence(identity.ownerId);
      usageLine = renderContextUsageLine(pres?.contextTokens, pres?.compactionLimit);
      // flush-to-proceed-stretch-discipline-2026-07-04 P-002: near a compaction boundary,
      // surface any work-item claim whose checkpoint is stale (unflushed state) and NAME the
      // action (work_items:checkpoint) — the flush invariant enforced on the ONE surface in
      // front of the agent at the moment it matters. The claims read fires ONLY at/above the
      // gate pct, so normal low-% turns pay nothing extra. Best-effort: any failure omits the
      // line and never breaks the inbox read.
      const pct = contextUsagePct(pres?.contextTokens, pres?.compactionLimit);
      if (pct != null && pct >= CONTEXT_GAUGE_LOUD_PCT) {
        contextGauge = renderBandedContextGauge(pres?.contextTokens, pres?.compactionLimit);
      }
      if (pct != null && pct >= FLUSH_GATE_PCT) {
        try {
          const ws =
            (ctx as { workspaceId?: string | null } | undefined)?.workspaceId ??
            activeWorkspaceId();
          const fresh = await listActiveClaimFreshnessForOwner(ws, identity.ownerId);
          flushLine = renderFlushGateLine(pct, classifyStaleClaims(fresh, Date.now()));
        } catch {
          flushLine = null;
        }
      }
    } catch {
      usageLine = null;
    }
    const injection = [usageLine, flushLine, rebootstrap, coordInjection].filter(Boolean).join('\n');

    // EI-1752: bound each entry's large content fields so an inbox read can't overflow
    // the agent result cap. The `max_body_chars` schema arg existed but was NEVER
    // applied. Agents put the message in `summary` (optionally `body`) — both are bound;
    // full text stays reachable via coord:thread. The compact `injection` block agents
    // consume is left intact (coord-schema already clips it); only raw `entries` are bound.
    // su-707ed (EI-1752 review): an EXPLICIT max_body_chars is honored exactly, but the
    // DEFAULT scales with `limit` — a flat 600 × up-to-500 entries would still be ~300KB.
    // min(600, floor(BUDGET/n)) keeps the content-bearing part of the entries payload
    // bounded at ANY limit; at the default 50-row read this now caps fields at 300 chars.
    // context-trimming-tiers P-012: the per-entry default cap follows the
    // session tier (250/400/600); an explicit max_body_chars still wins.
    const INBOX_ENTRY_BUDGET = 15_000;
    const effectiveCap =
      args.max_body_chars !== undefined
        ? args.max_body_chars
        : entries.length > 0
          ? Math.min(
              tierDefaults.bodyChars,
              Math.floor(INBOX_ENTRY_BUDGET / entries.length),
            )
          : tierDefaults.bodyChars;
    // WI-1444: mark superseded condition alarms (resolved:true) before bounding,
    // scanning resolutions over the FULL read (`all`) so the annotation sees
    // resolutions even when the alarm+resolution straddle the `limit` window.
    const annotatedEntries = annotateResolvedConditions(
      entries as unknown as Array<Record<string, unknown>>,
      all as unknown as Array<Record<string, unknown>>,
    );
    const boundEntries = boundInboxEntries(annotatedEntries, effectiveCap);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            owner_id: identity.ownerId,
            summary,
            entries: boundEntries,
            injection,
            // P-015: the ≥80% loud gauge, exposed OUT of `injection` so the PostToolUse
            // hook can inject it even when there are no new entries (empty-inbox turns).
            context_gauge: contextGauge,
          }),
        },
      ],
    };
  },
});
