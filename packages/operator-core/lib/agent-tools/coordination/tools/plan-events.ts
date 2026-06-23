/**
 * coord:plan-events — read the plan-event history feed.
 *
 * agent-coordination-architecture-v2 §8. plan_event records live on the
 * `plan-events` surface of the CoordEventLog (Postgres), NOT the
 * `messages` surface — so coord:inbox does not surface them. This tool is the read surface the
 * OMP turn-start extension uses to assemble the "plans changed since
 * you last read" reminder section (scoped by the watermark's
 * plan_events_since_ts pointer).
 */

import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import { COORD_ROLES } from "../roles";
import { readPlanEvents } from "../plan-events";
import { cachedRead, type CachedReadCtx } from "../../../cache";

/**
 * SWR backstop for coord:plan-events (cache-expensive-tool-reads-round2-2026-06-23 P-003).
 * Caches the pure readPlanEvents derive (the rotation-file / coord_event_log scan). Tagged
 * with coord_event_log, whose per-event bump is DEBOUNCED (D-006) so the append storm can't
 * tank the hit-rate; this short soft TTL bounds worst-case staleness alongside the debounce.
 * Non-principal + workspace-scoped (the plan-events surface is read in the ALS-active
 * workspace; cachedRead namespaces by ctx.workspaceId). The hit-rate benefit concentrates on
 * BROAD calls (no / loose since_ts — the p95-heavy ones); the turn-start watermark caller
 * passes a per-agent advancing since_ts (high key cardinality) so those mostly MISS —
 * harmlessly: a miss just runs the factory exactly as before.
 */
const COORD_PLAN_EVENTS_SOFT_TTL_MS = 5_000;

export default defineTool({
  name: "coord:plan-events",
  description:
    "Read the plan-event history — created / now_updated / decision_added / item_added / item_status_changed / promoted events across all plans. Returns the most-recent events first-bounded (a no-arg call is always size-capped so it never overflows the result), newest kept. Widen with `since_ts` (events strictly later than that ISO timestamp), `plan_slug` (one plan), `files_back` (N rotation files), or `limit` (max events). Returns `{ events, total, truncated }`. Distinct from coord:inbox (which scans messages, not plan-events).",
  guidance: {
    when: "Turn start — the OMP coordination extension calls this to show which plans changed since the agent last read. Also ad-hoc, to review recent plan activity.",
    notWhen:
      "For messages / notifies / handoffs addressed to you — use coord:inbox.",
  },
  capability: "coord:read",
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    since_ts: z.string().optional(),
    plan_slug: z.string().optional(),
    files_back: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Read only the most-recent N monthly rotation files."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max events returned (newest kept). Default 100 — keeps a no-arg call from overflowing the result cap.",
      ),
  }),
  async handler(args, ctx) {
    const limit = args.limit ?? 100;
    // Cache the pure read, keyed on the READ dimensions only — `limit` is a presentation
    // bound applied below, so two calls differing only in limit share one entry. Debounced
    // coord_event_log tag + short SWR (see the constant above).
    const all = await cachedRead(
      ctx as CachedReadCtx,
      {
        tool: "coord:plan-events",
        key: {
          since_ts: args.since_ts ?? null,
          plan_slug: args.plan_slug ?? null,
          files_back: args.files_back ?? null,
        },
        tags: ["coord_event_log"],
        softTtlMs: COORD_PLAN_EVENTS_SOFT_TTL_MS,
      },
      () =>
        readPlanEvents({
          since_ts: args.since_ts,
          planSlugs: args.plan_slug ? [args.plan_slug] : undefined,
          filesBack: args.files_back,
        }),
    );
    // EI-1737: an unbounded plan-event history (a no-arg call) used to return multi-MB
    // that hard-fails the agent result cap. readPlanEvents returns ts-ASCENDING → keep
    // the NEWEST `limit` (slice the tail). This is a universal, backend-agnostic RESULT
    // bound; `total`/`truncated` tell the caller more exist so they can widen by
    // since_ts/plan_slug/files_back/limit. (Pushing the bound down to the PG read so it
    // also caps the I/O is a follow-up — tracked on EI-1737.)
    const events = all.length > limit ? all.slice(-limit) : all;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            events,
            total: all.length,
            truncated: all.length > events.length,
          }),
        },
      ],
    };
  },
});
