/**
 * plans:items — item-level query across one or all plans.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 *
 *   actionable: true   → effectiveStatus === 'todo'
 *                        (stored todo with all blockers done)
 *   needsHuman: true   → storedStatus === 'needs-human'
 *                        (the human's inbox, §4.3)
 *   status: <token>    → filter by effectiveStatus (NOT storedStatus,
 *                        because the whole point of effectiveStatus
 *                        is it's the one callers should ask about)
 *
 * Legacy plans are excluded — they don't have parseable items.
 */

import { z } from "zod";
import { defineTool, SU_ROLES } from "@papercusp/agent-mcp";
import {
  listPlanRows,
  getPlanRow,
  planItemsForRow,
  type PlanRow,
} from "./source";
import { ctxToPlanSourceOpts } from "./_ctx-opts";
import { harnessArg, harnessScopedCtx } from "../_harness-scope";
import {
  resolveEffectiveStatusForItems,
  type ResolvedItem,
} from "./effective-status";
import {
  getAllBlockedPlanItems,
  applyPlanItemBlocks,
  planItemRef,
} from "../../issue-blocks-merge";
import {
  getAllPlanItemCoverage,
  compactCoverage,
  type CompactCoverage,
  type PlanItemCoverage,
} from "../../plan-item-coverage";
import { ITEM_STATUSES, IMPORTANCE_LEVELS, type Importance } from "./parser";
import { TERMINAL_PLAN_STATUSES } from "./plan-start-state";
import { shapePlansItems } from "./items-shape";
import { cachedRead, type CachedReadCtx } from "../../cache";

/**
 * SWR backstop for plans:items (cache-expensive-tool-reads-round2-2026-06-23 P-002).
 * Same family as plans:list/get: the plan tables (harness_plans/plan_revisions/plan_runs)
 * are trigger-covered so any plan write auto-invalidates via the cache-ECA; this short
 * soft TTL only bounds staleness for the un-triggered issue-block overlay (coord_links).
 */
const PLANS_ITEMS_SOFT_TTL_MS = 45_000;

/** Item statuses that are themselves terminal — the only item statuses worth
 *  surfacing from a terminal (shipped/superseded) plan in a cross-plan query. */
const TERMINAL_ITEM_STATUSES = new Set<string>(["done", "dropped"]);

/**
 * Cross-plan exclusion guard. A terminal-status plan (shipped/superseded) has no
 * pickable items and needs no human action — its non-terminal items are stale by
 * definition. So in a CROSS-plan query its items are hidden, which is what stops a
 * dead plan's `todo` item from being picked up: the fleet-federation-reanchor trap,
 * where the superseded plan's P-002 still surfaced in `plans:items actionable=true`
 * (EI-154). Two deliberate escapes keep it from over-hiding:
 *   - `args.slug` — an explicit single-plan query always returns that plan's items.
 *   - a terminal item-status filter (`status: 'done' | 'dropped'`) — e.g. auditing a
 *     shipped plan's completed items cross-plan.
 * Returns true when the plan's items should be EXCLUDED from the result.
 */
export function isTerminalPlanHiddenFromCrossPlan(
  planStatus: string | null,
  args: { slug?: string; status?: string },
): boolean {
  if (args.slug) return false;
  if (args.status && TERMINAL_ITEM_STATUSES.has(args.status)) return false;
  return (
    planStatus != null &&
    (TERMINAL_PLAN_STATUSES as readonly string[]).includes(planStatus)
  );
}

const argsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .optional()
    .describe("Restrict to one plan. Omit for cross-plan."),
  status: z
    .enum([...ITEM_STATUSES] as [string, ...string[]])
    .optional()
    .describe("Filter by effectiveStatus."),
  actionable: z
    .boolean()
    .optional()
    .describe('Return items pickable right now: effectiveStatus === "todo".'),
  needsHuman: z
    .boolean()
    .optional()
    .describe("Return items requiring a human decision (the human's inbox)."),
  includeArchived: z
    .boolean()
    .optional()
    .describe("Include items from plans under archive/. Default false."),
  harness: harnessArg,
});

interface ItemRow {
  plan: string;
  archived: boolean;
  item: ResolvedItem;
  /** Open engineer-issue ids blocking this item (coord_links rel='blocks'), if any. */
  blockedByIssues?: string[];
  /** "Is anyone working this?" rolled up from linked work-items + any direct claim
   *  (plan-item-coverage). Present only when there's a signal (a link or a claim);
   *  absent ⇒ genuinely unworked (coverage 'none'). */
  coverage?: CompactCoverage;
}

export default defineTool({
  name: "plans:items",
  description:
    'Cross-plan item query. actionable=true returns pickable items (effectiveStatus="todo"). needsHuman=true returns the human\'s inbox. status filters by effectiveStatus. Legacy plans excluded.',
  guidance: {
    when: 'You want to find items by status across all plans — "what can I pick up", "what needs the human", or filter one plan\'s items.',
    notWhen:
      "You want the full plan structure (Now block, decisions, prose) — use plans:get.",
    chaining:
      "plans:items { actionable: true } → plans:get { slug } for context on the picked item.",
  },
  capability: "plans:read",
  requirePrincipal: false,
  // + overwatch (overwatch-role-2026-06-15 B-01): reads plan items to detect stalled work.
  agentRoles: [...SU_ROLES, "overwatch"],
  modality: ["text"],
  args: argsSchema,
  // context-trimming-tiers P-021: trimmed/standard sessions get flattened,
  // row-capped item rows (see items-shape.ts). The cache stores the UNSHAPED
  // rows; the UI (HTTP/sync path, no ctx_tier) reads full.
  shape: {
    standard: (data) => shapePlansItems(data, "standard"),
    trimmed: (data) => shapePlansItems(data, "trimmed"),
  },
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const includeArchived = args.includeArchived === true;

    // Cache the cross-plan aggregation (cache-expensive-tool-reads-round2-2026-06-23
    // P-002). plans:items is the LARGEST read payload measured (37KB / p95 2s); its read
    // is PURE + non-principal (depends only on workspace+harness+args — `needsHuman` keys
    // on the DERIVED item band, not the caller). Same family + tags as plans:list/get; the
    // 45s SWR backstops the un-triggered coord_links issue-block overlay.
    const cached = await cachedRead(
      ctx as CachedReadCtx,
      {
        tool: "plans:items",
        key: {
          slug: args.slug ?? null,
          status: args.status ?? null,
          actionable: args.actionable === true,
          needsHuman: args.needsHuman === true,
          includeArchived,
          harness: opts.harnessSlug,
        },
        tags: ["harness_plans", "plan_revisions", "plan_runs"],
        softTtlMs: PLANS_ITEMS_SOFT_TTL_MS,
      },
      async () => {
        // PG-canonical: read the structured rows (no content-blob parse for plans that
        // carry the derived `items` index — Stage 3); planItemsForRow falls back to a
        // parse only when the index is absent.
        let planRows: PlanRow[] = [];

        if (args.slug) {
          const one = await getPlanRow(args.slug, opts);
          if (!one) return { notFound: true as const };
          if (!one.archived || includeArchived) {
            planRows = [one];
          }
        } else {
          planRows = await listPlanRows({ includeArchived, ...opts });
        }

        const rows: ItemRow[] = [];

        // engineer-issues D-005: one batch read of every open issue-block across all
        // plans (keyed '<slug>#<item>'), hoisted out of the plan loop. Overlaying it
        // onto effectiveStatus BEFORE the filters below means an item blocked by an
        // open issue correctly drops out of `actionable` (no longer `todo`) and is
        // found by `status:'blocked'`. Non-fatal — degrades to resolver-only on error.
        let allBlocked = new Map<string, string[]>();
        try {
          allBlocked = await getAllBlockedPlanItems();
        } catch {
          // Non-fatal — no issue-block overlay.
        }

        // Coverage rollup (work→plan_item edges + direct plan-item claim), hoisted out
        // of the loop like the issue-block overlay. Non-fatal — degrades to no overlay
        // so a coord_links/fleet outage never fails the read.
        let coverage = new Map<string, PlanItemCoverage>();
        try {
          coverage = await getAllPlanItemCoverage();
        } catch {
          // Non-fatal — no coverage overlay.
        }

        for (const row of planRows) {
          if (row.isLegacy) continue;
          if (isTerminalPlanHiddenFromCrossPlan(row.status, args)) continue;
          const { items: resolvedItems, blockingIssues } = applyPlanItemBlocks(
            resolveEffectiveStatusForItems(planItemsForRow(row)).items,
            (id) => allBlocked.get(planItemRef(row.planSlug, id)),
          );
          for (const item of resolvedItems) {
            if (args.actionable && item.effectiveStatus !== "todo") continue;
            // needsHuman keys on the DERIVED top band (B-12 / P-072), not the raw
            // stored token — so an authority=owner item gates the orchestrator DONE-gate
            // and, once the owner arms autonomy (P-092), a high-risk item above its
            // ceiling does too. Behavior-neutral today: `needsHuman` equals
            // `storedStatus === 'needs-human'` while unarmed (D-007).
            if (args.needsHuman && !item.needsHuman) continue;
            if (args.status && item.effectiveStatus !== args.status) continue;
            const cov = coverage.get(planItemRef(row.planSlug, item.id));
            rows.push({
              plan: row.planSlug,
              archived: row.archived,
              item,
              ...(blockingIssues[item.id]
                ? { blockedByIssues: blockingIssues[item.id] }
                : {}),
              ...(cov ? { coverage: compactCoverage(cov) } : {}),
            });
          }
        }

        // Sort by importance (urgent→low); the array index in IMPORTANCE_LEVELS
        // is the rank. Array.sort is stable, so equal-importance rows keep their
        // collection order (≈ age within a plan) — the "then age" tiebreaker.
        const normalRank = IMPORTANCE_LEVELS.indexOf("normal");
        const impRank = (it: ResolvedItem): number => {
          const r = IMPORTANCE_LEVELS.indexOf(it.importance);
          return r === -1 ? normalRank : r;
        };
        rows.sort((a, b) => impRank(a.item) - impRank(b.item));

        return { rows };
      },
    );

    // not_found (explicit single-slug query for a missing plan) — cached too, so a
    // plan-create write busts it via the harness_plans tag.
    if ("notFound" in cached) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "not_found", slug: args.slug }),
          },
        ],
        isError: true,
      };
    }
    const rows = cached.rows;

    ctxAny.metadata?.({
      count: rows.length,
      actionable: !!args.actionable,
      needsHuman: !!args.needsHuman,
      scope: args.slug ?? "all",
    });

    // {data} envelope so the payload-tier shapers apply; HTTP/sync consumers
    // still read identical `{"items":[...]}` JSON text.
    return { data: { items: rows } };
  },
});
