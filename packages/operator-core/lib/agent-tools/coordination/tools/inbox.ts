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
 *  are high-volume status firehoses (service up/down, rate-limit pauses) that
 *  bury addressed work. Still `message`s (D-002); opt back in via include_ambient. */
const AMBIENT_CATEGORIES = new Set(["service-health", "agent-governor"]);

const DEFAULT_INBOX_LIMIT = 50;

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

export default defineTool({
  name: "coord:inbox",
  description:
    "Read your coordination inbox — messages, acks, handoffs etc. addressed to you (or broadcast). Returns a summary header (counts by kind) + the most-recent `limit` entries (default 50). Ambient system broadcasts (service-health, rate-limit pauses) are excluded by default — pass include_ambient to see them. `since_ts` filters strictly later than the given ISO timestamp; `kinds` narrows to specific entry kinds.",
  guidance: {
    when: "At turn start (the OMP hook will do this for you once it ships); whenever you suspect another agent contacted you.",
    notWhen:
      'For agent-presence ("who is active?") — use coord:presence. For file locks — use locks:queue.',
  },
  capability: "coord:read",
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    since_ts: z.string().optional(),
    kinds: z.array(z.enum(COORD_KINDS)).optional(),
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
        "Include ambient system broadcasts (service-health, agent-governor) excluded by default.",
      ),
    max_body_chars: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Truncate each entry's body to this many chars in the result (default 600) so a default read never overflows the agent result cap; truncated entries carry body_truncated:true and the full body is reachable via coord:thread. 0 = no truncation.",
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const limit = args.limit ?? DEFAULT_INBOX_LIMIT;
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
    // The watermark is read concurrently too — the P-010 re-bootstrap flag rides
    // it (snapshot_rebootstrap_pending), so the common no-flag path adds only one
    // cheap PK read and no extra latency.
    const [, all, wm] = await Promise.all([
      heartbeatPresence(identity).catch(() => {}),
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
    const filtered = args.include_ambient
      ? all
      : all.filter((e) => !isAmbient(e));

    // readInbox returns ascending by (ts, msg_id); keep the most-recent `limit`.
    const truncated = Math.max(0, filtered.length - limit);
    const entries =
      truncated > 0 ? filtered.slice(filtered.length - limit) : filtered;

    const byKind: Record<string, number> = {};
    for (const e of filtered) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

    const summary = {
      total: filtered.length,
      returned: entries.length,
      truncated,
      ambient_excluded: ambientExcluded,
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
    try {
      const pres = await getPresence(identity.ownerId);
      if (pres?.compactionLimit && pres.contextTokens != null) {
        const pct = Math.round((pres.contextTokens / pres.compactionLimit) * 100);
        usageLine = `context: ${pres.contextTokens}/${pres.compactionLimit} (${pct}%)`;
      }
    } catch {
      usageLine = null;
    }
    const injection = [usageLine, rebootstrap, coordInjection].filter(Boolean).join('\n');

    // EI-1752: bound each entry's large content fields so an inbox read can't overflow
    // the agent result cap. The `max_body_chars` schema arg existed but was NEVER
    // applied. Agents put the message in `summary` (optionally `body`) — both are bound;
    // full text stays reachable via coord:thread. The compact `injection` block agents
    // consume is left intact (coord-schema already clips it); only raw `entries` are bound.
    // su-707ed (EI-1752 review): an EXPLICIT max_body_chars is honored exactly, but the
    // DEFAULT scales with `limit` — a flat 600 × up-to-500 entries would still be ~300KB.
    // min(600, floor(BUDGET/n)) keeps the entries payload ~<=BUDGET at ANY limit; at the
    // default limit 50 it stays 600/entry (unchanged), only large limits tighten.
    const INBOX_ENTRY_BUDGET = 30_000;
    const effectiveCap =
      args.max_body_chars !== undefined
        ? args.max_body_chars
        : entries.length > 0
          ? Math.min(600, Math.floor(INBOX_ENTRY_BUDGET / entries.length))
          : 600;
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
          }),
        },
      ],
    };
  },
});
