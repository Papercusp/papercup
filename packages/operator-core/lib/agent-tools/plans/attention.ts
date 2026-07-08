/**
 * plans:attention — the unified attention reader for the Planning tab
 * (planning-attention-importance-2026-05-31, P-011 / D-004, D-008).
 *
 * Fetches every "needs the human / pick this up" surface, maps each
 * through its AttentionItem adapter, and returns them grouped by plan
 * (+ a synthetic per-harness "Alerts" bucket for unattached items),
 * importance-sorted. Sources:
 *   - plan items (non-terminal)            → planItemToAttention
 *   - open coord escalations               → coordEscalationToAttention
 *   - coord messages addressed to 'human'  → coordMessageToAttention
 *   - failing smoke tests (harness_smoke_test)  → smokeFailToAttention
 *   - operator `<report>` turns (operator_turns.report) → reportTurnsToAttention
 *   - B-14/P-100 folded disposition channels (D-011), each filtered to the
 *     awaiting-human slice (never the execution backlog):
 *       · human-routed improvements (engineer_issues needsHuman) → improvementToAttention
 *       · standing-approval candidates                          → standingApprovalToAttention
 *       · open coord:ask questions                              → conversationToAttention
 *       · ungraded routed Scout ideas (one rollup)              → scoutGradeToAttention
 *     (report-cards-inbox-reconciliation-2026-06-05 — the operator's
 *     structured output routes to the Inbox, not the chat stream)
 *
 * Each source is best-effort: one source erroring (PG offline, no coord
 * log) degrades to fewer items, never a failed read. The orchestrator's
 * needs-human DONE-gate keeps using GET /api/admin/plans/items?needsHuman
 * (unchanged) — this is a separate, additive read (P-012).
 *
 * v1 takes a single optional `harnessSlug` filter (applied to the
 * harness-scoped sources); cross-harness fan-out via the UI selector is
 * wired in Phase 4 (P-016). coord escalations/messages are workspace-
 * level and always included.
 */

import { z } from "zod";
import { defineTool, SU_ROLES } from "@papercusp/agent-mcp";
import { readAllPlans } from "./source";
import { ctxToPlanSourceOpts } from "./_ctx-opts";
import { harnessArg, harnessScopedCtx } from "../_harness-scope";
import {
  coordEscalationToAttention,
  coordMessageToAttention,
  smokeFailToAttention,
  improvementToAttention,
  standingApprovalToAttention,
  conversationToAttention,
  scoutGradeToAttention,
} from "../../attention/adapters";
import {
  planItemsToAttention,
  reportTurnsToAttention,
  dropConvertedPlanItems,
} from "../../attention/sources";
import { buildAttentionGroups } from "../../attention/group";
import {
  applyTriage,
  deriveAuthorization,
  groupByTier,
  type AttentionItem,
} from "../../attention/types";
import { readTriageByWorkspace } from "../../attention/triage-store";
import { shapePlansAttention } from "./attention-shape";
import { cachedRead, type CachedReadCtx } from "../../cache";
import { conversationsScopeWorkspace } from "../coordination/conversations";
import { runWithWorkspace } from "../../workspace-als";

/**
 * SWR backstop for plans:attention (cache-expensive-tool-reads-2026-06-22 P-003 / D-001).
 * Shorter than plans:list's: the feed folds ~10 sources beyond the plan tables — several
 * append-heavy (coord_event_log: escalations + messages-to-human) — which are deliberately
 * NOT tagged (tagging an append-heavy source = ~0 hit-rate, the coord:inbox problem D-006).
 * The plan tables ARE tagged, so a plan-item change (the dominant attention change) busts
 * immediately; this short soft TTL bounds staleness for the un-tagged sources (a new
 * escalation/message/smoke-fail surfaces within the window).
 */
const PLANS_ATTENTION_SOFT_TTL_MS = 20_000;

const argsSchema = z.object({
  harnessSlug: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Restrict the harness-scoped sources (smoke-fails) to one harness. Omit for workspace-wide.",
    ),
  includeArchived: z
    .boolean()
    .optional()
    .describe("Include items from archived plans. Default false."),
  harness: harnessArg,
});

export default defineTool({
  name: "plans:attention",
  description:
    "The Planning tab's unified attention feed: plan items + coord escalations + coord messages-to-human + smoke-fails + operator <report> turns, mapped to a single AttentionItem shape, grouped by plan (+ per-harness Alerts bucket), importance-sorted. Each source best-effort.",
  guidance: {
    when: "You want everything awaiting the human / pickable, in one importance-sorted feed — the Planning tab inbox, or to find the single most-urgent open thing.",
    notWhen:
      "You only need plan items (use plans:items), or the full structure of one plan (plans:get). For the orchestrator DONE-gate use plans:items { needsHuman: true }.",
    chaining:
      "plans:attention → act on an item via its kind (plans:set-status for plan items, coord:resolve for escalations).",
  },
  capability: "plans:read",
  requirePrincipal: false,
  // Sentinel-as-Herald: the Herald reads "what needs the user's eye on the plans"
  // to suggest what to work on next (paired with its plans:read cap). It only
  // READS here — acting on an item is still file-a-work_item + nudge-the-Queen.
  agentRoles: [...SU_ROLES, "papercup"],
  modality: ["text"],
  args: argsSchema,
  // Freshness negotiation (agent-tool-delta-protocol-2026-06-22, P-013 — the first
  // exemplar). plans:attention is the strongest ROI target: ~9.6k tokens, ~19k
  // calls/6h, no `compact` escape. The diffable unit is the FLAT AttentionItem set,
  // extracted from the grouped response via `rows` (the response shape is untouched,
  // so the UI's `plans.attention` sync read is unaffected). No explicit `revision`
  // → the framework derives it from the item-set checksum (changed iff any item's
  // content changes / an item is added or removed); no `rowRevision` → per-item
  // content hash. An unchanged feed returns `not_modified` (no replay); a changed
  // feed returns added/updated/removed items, checksum-verified by the harness with
  // force-full-on-mismatch; first/stale/scope-change/over-age → a full snapshot.
  delta: {
    rows: (data) => {
      const groups = (
        data as { groups?: Array<{ items?: unknown[] }> } | null | undefined
      )?.groups;
      return Array.isArray(groups)
        ? groups.flatMap((g) => (Array.isArray(g.items) ? g.items : []))
        : null;
    },
    itemKey: (row) => (row as AttentionItem).id,
    itemKeyField: 'id',
    rowType: (row) => (row as AttentionItem).kind,
    orderKey: "importance",
    scope: (_args, ctx) => {
      const c = ctx as {
        workspaceId?: string;
        harnessSlug?: string | null;
        role?: string | null;
      };
      return `${c.workspaceId ?? ""}:${c.harnessSlug ?? "*"}:${c.role ?? ""}`;
    },
    schemaVersion: "attn-v1",
    // Periodic forced-full reconciliation: a cursor older than 5 min reconciles to a
    // full snapshot, bounding any drift the harness's incremental merge accumulates.
    maxDeltaAge: 5 * 60_000,
  },
  // context-trimming-tiers P-021: the fattest measured payload (avg 1.09MB).
  // Trimmed/standard sessions get group summaries + top-N items (see
  // attention-shape.ts); the UI (HTTP/sync path, no ctx_tier) reads full, and
  // the cache stores the UNSHAPED groups so one read serves every tier.
  shape: {
    standard: (data) => shapePlansAttention(data, "standard"),
    trimmed: (data) => shapePlansAttention(data, "trimmed"),
  },
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const harnessFilter = args.harnessSlug ?? null;
    const includeArchived = args.includeArchived === true;

    // WI-3348: which workspace partition the open-questions source (#9) reads.
    // coord:ask/ask-owner rows land under the ASKER's identity.workspaceId
    // (WI-1571), so an identity-less read here resolved 'default' and the feed
    // missed every current ask. Resolve the viewed workspace ONCE, up front:
    // the request's workspace (ctx.workspaceId — set for both UI and agent MCP
    // calls; same field the delta-read `scope` above keys on), else the ambient
    // request-ALS/env chain. Captured pre-cachedRead and closure-passed so an
    // SWR background refresh (which runs OUTSIDE the request ALS) still reads
    // the SAME partition the key names.
    const ctxWs = (ctx as { workspaceId?: string | null }).workspaceId?.trim();
    const conversationsWorkspace =
      ctxWs && ctxWs !== "*" ? ctxWs : conversationsScopeWorkspace();

    // Cache the expensive ~10-source attention aggregation (cache-expensive-tool-reads
    // P-003). The feed is NON-principal-scoped: it always builds the HUMAN's attention
    // view (readInbox('human'), workspace/harness-level escalations/smoke/reports/etc.),
    // never anything keyed to ctx.role/ctx.principal — so the key omits the caller
    // (D-001: no per-caller dimension exists to leak). The output-determining dims are
    // the resolved harness SCOPE (which harness's plans are read), the harnessFilter,
    // includeArchived, and the conversations workspace partition (WI-3348 — a
    // WORKSPACE dimension, not a caller one: two callers viewing the same workspace
    // share the entry; without it in the key one workspace's feed would be served to
    // another from cache). Tags are ONLY the trigger-covered plan tables; the other
    // sources (coord_event_log escalations/messages — append-heavy, the coord:inbox
    // D-006 problem) are deliberately un-tagged and bounded by the short SWR softTtl.
    const { groups, tierCounts, itemCount } = await cachedRead(
      ctx as CachedReadCtx,
      {
        tool: "plans:attention",
        key: {
          harnessScope: (opts as { harnessSlug?: string }).harnessSlug ?? null,
          harnessFilter,
          includeArchived,
          conversationsWorkspace,
        },
        tags: ["harness_plans", "plan_revisions", "plan_runs"],
        softTtlMs: PLANS_ATTENTION_SOFT_TTL_MS,
      },
      async () => {
        const items: AttentionItem[] = [];
        // plan-slug → harness, so coord escalations/messages that carry a plan_slug
        // but no recorded harness can still be scoped (backfills items raised before
        // coord:escalate/coord:send began recording the originating harness).
        const planHarness = new Map<string, string>();

        // 1. Plan items — non-terminal (todo/wip/blocked/needs-human).
        try {
          const plans = await readAllPlans({ includeArchived, ...opts });
          const planItems = planItemsToAttention(plans, harnessFilter);
          for (const it of planItems) {
            if (it.planSlug && it.harnessSlug)
              planHarness.set(it.planSlug, it.harnessSlug);
          }
          items.push(...planItems);
        } catch {
          /* best-effort */
        }

        // Resolve an attention item's harness: its own recorded harnessSlug (now
        // stamped by coord:escalate / coord:send for harness-scoped agents), else
        // derived from its plan_slug, else null — a genuinely workspace-level item
        // (operator/SU/oracle broadcast) where a per-harness chat doesn't apply.
        const resolveHarness = (
          recHarness: unknown,
          planSlug: string | null,
        ): string | null => {
          if (
            typeof recHarness === "string" &&
            recHarness &&
            recHarness !== "*"
          )
            return recHarness;
          return planSlug ? (planHarness.get(planSlug) ?? null) : null;
        };

        // 2–10 (infra-perf-robustness-audit-2026-06-18 P-005): these source reads are
        // mutually independent — each reads the already-populated `planHarness` +
        // `harnessFilter` (both finalized above) and appends to `items`. They ran
        // SEQUENTIALLY (plans:attention p50 ~2s, ~19k calls/6h — the audit's P2). Run them
        // CONCURRENTLY: output order is irrelevant — buildAttentionGroups re-groups and
        // deterministically re-sorts by importance (ties broken by key), so interleaved
        // pushes (safe in single-threaded JS) change nothing observable. Each stays
        // best-effort in its own try/catch, so one slow/failing source can neither block
        // nor fail the others.
        await Promise.all([
          // 2. Open coord escalations (workspace-level).
          (async () => {
            try {
              const { listEscalations } =
                await import("../coordination/escalations");
              const escs = await listEscalations({ status: "open" });
              for (const e of escs) {
                items.push(
                  coordEscalationToAttention({
                    msgId: e.msg_id,
                    severity: e.severity,
                    summary: typeof e.summary === "string" ? e.summary : "",
                    body: typeof e.body === "string" ? e.body : undefined,
                    planSlug:
                      typeof e.plan_slug === "string" ? e.plan_slug : null,
                    harnessSlug: resolveHarness(
                      e.harnessSlug,
                      typeof e.plan_slug === "string" ? e.plan_slug : null,
                    ),
                    options: Array.isArray(e.options) ? e.options : [],
                    // The escalating agent — drives the "Message owner" action (D-005).
                    from: typeof e.from === "string" ? e.from : null,
                  }),
                );
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 3. Coord messages addressed to the human (most recent, capped).
          //    Drop messages acked from the human's admin coord UI so "Acknowledge"
          //    dismisses. Scoped to ADMIN_COORD_UI_OWNER (the id those acks are
          //    authored as) — NOT a global ack-set, so an agent acking a broadcast
          //    can't suppress it from the human's inbox (security review).
          (async () => {
            try {
              const { readInbox, readAckedMsgIds } =
                await import("../coordination/messages");
              const { ADMIN_COORD_UI_OWNER } =
                await import("../coordination/identity");
              const [msgs, acked] = await Promise.all([
                readInbox("human", { kinds: ["message"] }),
                readAckedMsgIds(ADMIN_COORD_UI_OWNER),
              ]);
              for (const m of msgs.slice(-50)) {
                if (acked.has(m.msg_id)) continue;
                const mm = m as typeof m & {
                  auto?: unknown;
                  lifecycle?: unknown;
                };
                items.push(
                  coordMessageToAttention({
                    msgId: m.msg_id,
                    summary:
                      typeof m.summary === "string" ? m.summary : undefined,
                    body: typeof m.body === "string" ? m.body : undefined,
                    from: m.from,
                    planSlug:
                      typeof m.plan_slug === "string" ? m.plan_slug : null,
                    harnessSlug: resolveHarness(
                      m.harness_slug,
                      typeof m.plan_slug === "string" ? m.plan_slug : null,
                    ),
                    // Structured lifecycle markers coord:emit stamps (D-003) — classify
                    // an auto lifecycle broadcast as Activity, not a Decision.
                    auto: mm.auto === true,
                    lifecycle:
                      typeof mm.lifecycle === "string" ? mm.lifecycle : null,
                    // A message addressed DIRECTLY to the human (not solely a `*`
                    // broadcast) is a genuine ping → Decision.
                    directToOwner:
                      Array.isArray(m.to) && m.to.includes("human"),
                  }),
                );
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 4. Failing smoke tests (PG, workspace-scoped). (The plan-review source
          //    was retired by B-14/P-101 — needs-human plan items, a plan-governance
          //    Decision, are the review gate now; harness_plan_review had no live
          //    writer after the bash orchestrator was archived.)
          (async () => {
            try {
              const { getOrgPg } = await import("@papercusp/db-org");
              const { activeWorkspaceId } =
                await import("../../workspace-registry");
              const { sql } = getOrgPg();
              const wid = activeWorkspaceId();
              const hf = harnessFilter;

              const smoke = await sql<
                { harness_slug: string; failure_content: string | null }[]
              >`
            SELECT harness_slug, failure_content
              FROM harness_shared.harness_smoke_test
             WHERE workspace_id = ${wid}
               AND status = 'fail'
               AND (${hf}::text IS NULL OR harness_slug = ${hf})
          `;
              for (const r of smoke) {
                items.push(
                  smokeFailToAttention({
                    harnessSlug: r.harness_slug,
                    failureContent: r.failure_content,
                  }),
                );
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 6. Operator `<report>` turns — the operator's structured output is an
          //    inbox surface, not chat content (report-cards-inbox-reconciliation
          //    D-002). One item per report turn at the worst-of tier (D-003); the
          //    recent window + triage (resolve → handled) keep the feed clean (D-004).
          (async () => {
            try {
              const { readRecentOperatorReports } =
                await import("../../attention/operator-report-source");
              const reportTurns = await readRecentOperatorReports();
              items.push(...reportTurnsToAttention(reportTurns));
            } catch {
              /* best-effort */
            }
          })(),

          // ── B-14 / P-100 (D-011): the folded disposition channels. Each surfaces
          //    ONLY the genuinely-awaiting-human slice (never the execution backlog —
          //    work_items stay separate); the Queen auto-handles the rest once armed.

          // 7. Human-routed improvements — engineer_issues the auto-implement loop
          //    flagged `needsHuman` (NOT the whole open backlog; that stays pull on the
          //    Learning tab, operator-learning-tab D-001).
          (async () => {
            try {
              const { readImprovementItems } =
                await import("../../harness/improvements/read-items");
              const improvements = await readImprovementItems({
                state: "open",
                ...(harnessFilter ? { harnessSlug: harnessFilter } : {}),
              });
              for (const c of improvements) {
                if (c.needsHuman !== true) continue;
                const slug = c.scope?.startsWith("harness:")
                  ? c.scope.slice("harness:".length)
                  : null;
                items.push(
                  improvementToAttention({
                    issueId: c.id,
                    title: c.title,
                    body: c.body,
                    severity: c.severity,
                    harnessSlug: slug,
                  }),
                );
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 8. Standing-approval candidates awaiting the owner (≥3 silent dispatches
          //    in 24h). Cheap cached read — never re-queries audit_log here.
          (async () => {
            try {
              const { readCandidates } =
                await import("../../operator-standing-candidates");
              const cands = await readCandidates();
              for (const s of cands) {
                if (harnessFilter && s.targetHarness !== harnessFilter)
                  continue;
                items.push(
                  standingApprovalToAttention({
                    capability: s.capability,
                    targetHarness: s.targetHarness,
                    count: s.count,
                    lastSeenAt: s.lastSeenAt,
                  }),
                );
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 9. Open agent questions / coord:ask conversations awaiting an answer.
          (async () => {
            try {
              const { listConversationsWithTopics } =
                await import("../coordination/conversations");
              // Pinned to the workspace resolved up front (and named in the cache
              // key) — NOT the ambient ALS, which is absent on agent MCP calls and
              // on SWR background refreshes and would fall to 'default' (WI-3348).
              const convs = await runWithWorkspace(conversationsWorkspace, () =>
                listConversationsWithTopics({
                  kind: "question",
                  state: "open",
                  ...(harnessFilter ? { harness_slug: harnessFilter } : {}),
                }),
              );
              for (const c of convs as unknown as Array<
                Record<string, unknown>
              >) {
                // Already-answered (accepted) questions are not awaiting the human.
                const answered =
                  typeof c.accepted_answer === "string" &&
                  c.accepted_answer.trim().length > 0;
                if (answered) continue;
                const id = typeof c.id === "string" ? c.id : null;
                if (!id) continue;
                items.push(
                  conversationToAttention({
                    conversationId: id,
                    title:
                      typeof c.title === "string" ? c.title : "Open question",
                    body: typeof c.body === "string" ? c.body : null,
                    askerId: typeof c.asker_id === "string" ? c.asker_id : null,
                    harnessSlug: resolveHarness(c.harness_slug, null),
                  }),
                );
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 10. Scout grading — ONE rollup nudge if any routed idea is ungraded
          //     (optional feedback, never one item per idea — there can be thousands).
          (async () => {
            try {
              const { readRoutedIdeas } =
                await import("../../scout/routed-ledger");
              const routed = await readRoutedIdeas(
                harnessFilter ? { harnessSlug: harnessFilter } : {},
              );
              const ungraded = routed.filter(
                (r) => r.humanGrade === undefined,
              ).length;
              if (ungraded > 0)
                items.push(scoutGradeToAttention({ count: ungraded }));
            } catch {
              /* best-effort */
            }
          })(),
        ]);

        // 11. Decision↔execution dedup guard (B-14 / P-104 · D-013): drop any
        //     plan-item that has been CONVERTED to a work_item (an `implements`
        //     edge) — it executes in the Working tab now, so it must not ALSO show
        //     as a Queue decision/row. A needs-human DECISION always stays.
        //     Best-effort: a failed lookup leaves every item (no silent hiding).
        try {
          const { listConvertedPlanItemRefs } =
            await import("../../plan-items/convert");
          const convertedRefs = await listConvertedPlanItemRefs();
          if (convertedRefs.size > 0) {
            const kept = dropConvertedPlanItems(items, convertedRefs);
            items.length = 0;
            items.push(...kept);
          }
        } catch {
          /* best-effort */
        }

        // 12. Operator triage overlay (D-006): a downgrade/resolve moves the item to
        //    the auditable "Handled by operator" tier, an escalate/confirm keeps it
        //    a Decision — never a silent vanish. Best-effort: no triage table / PG
        //    offline degrades to "untriaged", never a failed feed.
        let triaged = items;
        try {
          const triage = await readTriageByWorkspace();
          if (triage.size > 0) {
            triaged = items.map((it) => {
              const rec = triage.get(it.id);
              return rec ? applyTriage(it, rec) : it;
            });
          }
        } catch {
          /* best-effort */
        }

        // 13. Authorizer split (queue-authorization-redesign P-002 / D-001): stamp WHO
        //     must sign off + WHY each Decision is gated, for the Queue's A1 grouping.
        //     One flag read; pure per-item derivation. Best-effort — on failure items
        //     keep undefined authorizer/whyGated and the UI falls back to the tier list.
        try {
          let armed = false;
          try {
            const { FLAGS } = await import("@papercusp/flags");
            const { getFlag } = await import("@papercusp/flags/server");
            const { activeWorkspaceId } =
              await import("../../workspace-registry");
            armed = await getFlag(
              FLAGS.QUEEN_AUTONOMY_ARMED,
              `autonomy:${activeWorkspaceId()}`,
            );
          } catch {
            /* fail-safe: treat as unarmed */
          }
          triaged = triaged.map((it) => ({
            ...it,
            ...deriveAuthorization(it, armed),
          }));
        } catch {
          /* best-effort */
        }

        const groups = buildAttentionGroups(triaged);
        const tierCounts = groupByTier(triaged).counts;
        return { groups, tierCounts, itemCount: triaged.length };
      },
    );

    ctxAny.metadata?.({
      itemCount,
      groupCount: groups.length,
      decisions: tierCounts.decision,
      scope: harnessFilter ?? "all",
    });

    // {data} envelope so the payload-tier shapers apply; HTTP/sync consumers
    // still read identical `{"groups":[...],"tierCounts":{...}}` JSON text.
    return { data: { groups, tierCounts } };
  },
});
