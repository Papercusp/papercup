/**
 * plans:items — item-level query across one or all plans.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 *
 *   actionable: true   → effectiveStatus === 'todo' and no linked blocked work-item
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
import { isTerminalItemStatus } from "../../fleet-drained-events";
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
  isCoverageDivergent,
  type CompactCoverage,
  type PlanItemCoverage,
} from "../../plan-item-coverage";
import { ITEM_STATUSES, IMPORTANCE_LEVELS, type Importance } from "./parser";
import { TERMINAL_PLAN_STATUSES } from "./plan-start-state";
import { shapePlansItems } from "./items-shape";
import { cachedRead, type CachedReadCtx } from "../../cache";
import { specTriadGate, specTriadEpoch } from "./spec-triad-policy";
import type { SpecTriadLegName } from "@papercusp/plan-parser";
import { getFlag } from "@papercusp/flags/server";
import { FLAGS } from "@papercusp/flags";

/**
 * SWR backstop for plans:items (cache-expensive-tool-reads-round2-2026-06-23 P-002).
 * Same family as plans:list/get: the plan tables (harness_plans/plan_revisions/plan_runs)
 * are trigger-covered so any plan write auto-invalidates via the cache-ECA; this short
 * soft TTL only bounds staleness for the un-triggered issue-block overlay (coord_links).
 */
const PLANS_ITEMS_SOFT_TTL_MS = 45_000;

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
  if (args.status && isTerminalItemStatus(args.status)) return false;
  return (
    planStatus != null &&
    (TERMINAL_PLAN_STATUSES as readonly string[]).includes(planStatus)
  );
}

/**
 * A stale or standalone harness has no Hive plan scope. Read tools treat that
 * condition as an empty result with warning metadata; resolver failures for
 * unrelated causes must still propagate to the caller.
 */
export function isUnknownPlanScopeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /resolvePlanScope:\s+(?:harness .* is not registered|plans are Hive-scoped, but .* is not a Hive home)/i.test(
    message,
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
    .describe('Return items pickable right now: effectiveStatus === "todo" with no linked blocked work-item.'),
  needsHuman: z
    .boolean()
    .optional()
    .describe("Return items requiring a human decision (the human's inbox)."),
  includeArchived: z
    .boolean()
    .optional()
    .describe("Include items from plans under archive/. Default false."),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe(
      "Max items returned after importance ordering. Set this to keep a cross-plan read bounded; truncated:true reports when more matched.",
    ),
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
  /** EI-18679411140143743: every linked work-item is DONE (coverage 'complete')
   *  but this item's own status is still non-terminal — a silent divergence
   *  (completion never propagated, or propagated then the item reopened without
   *  its work-item following). Present only when true, so a leader burn-down
   *  read / monitor loop can flag it instead of silently under-counting. */
  coverageDivergence?: true;
  /** okf-frontmatter-adoption H(b): this item's PLAN owes the spec triad
   *  (`## Requirements` / `## Design` / items), so the item is held back from
   *  `actionable`. Present only when the plan is IN SCOPE for the requirement —
   *  i.e. created after the epoch, or opted in — and missing a leg. Never set
   *  for a plan that predates the requirement, which is what keeps the rule
   *  from freezing the existing corpus. See spec-triad-policy.ts. */
  specTriadMissing?: SpecTriadLegName[];
}

export default defineTool({
  name: "plans:items",
  description:
    'Cross-plan item query. actionable=true returns pickable items (effectiveStatus="todo"). needsHuman=true returns the human\'s inbox. status filters by effectiveStatus. Legacy plans excluded. ALWAYS pass `harness` on an operator/superuser-scoped call (a concrete slug, or \'all\' for cross-harness/Papercusp\'s-own-plans) — omitting it throws harness_required (a harness-scoped session supplies it automatically, so this only applies when calling from operator scope; EI-8823).',
  guidance: {
    when: 'You want to find items by status across all plans — "what can I pick up", "what needs the human", or filter one plan\'s items.',
    notWhen:
      "You want the full plan structure (Now block, decisions, prose) — use plans:get.",
    chaining:
      "plans:items { actionable: true } → plans:get { slug } for context on the picked item.",
  },
  capability: "plans:read",
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // + overwatch (overwatch-role-2026-06-15 B-01): reads plan items to detect stalled work.
  // + worker/cup (EI-939): a pipeline/hive worker needs a read path to a checkbox-style
  // roadmap plan's items before it can safely mark progress — see plans:get's ALL_ROLES
  // comment for the full rationale. Read-only (capability: plans:read).
  agentRoles: [...SU_ROLES, "kettle", "worker", "cup"],
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

    // okf-frontmatter-adoption H(b). Read OUTSIDE the cached closure so the flag
    // is part of the cache KEY — flipping the kill-switch must change the answer
    // on the next call, not 45s later. Fail-open on a flag-store error: a flags
    // outage must never gate items, because the failure it would produce
    // (everything non-actionable) is the exact fleet freeze this feature is
    // designed around.
    let specTriadFlag = false;
    try {
      specTriadFlag = await getFlag(FLAGS.SPEC_TRIAD_REQUIRED, "system:plans-items");
    } catch {
      specTriadFlag = false;
    }
    const specTriadOpts = { flagEnabled: specTriadFlag, epoch: specTriadEpoch() };

    // Cache the cross-plan plan/status aggregation (cache-expensive-reads-round2-2026-06-23
    // P-002). plans:items is the LARGEST read payload measured (37KB / p95 2s); its plan
    // projection is PURE + non-principal (depends only on workspace+harness+args —
    // `needsHuman` keys on the DERIVED item band, not the caller). The coverage overlay is
    // deliberately applied below, outside this cache: it folds fleet claims and liveness,
    // which change independently of the plan tables. Caching it made a stale
    // `held-not-live` verdict survive while coord:presence reported the holder live
    // (EI-20227161050679465).
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
          limit: args.limit ?? null,
          harness: opts.harnessSlug,
          specTriad: specTriadFlag,
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
          let one: PlanRow | null;
          try {
            one = await getPlanRow(args.slug, opts);
          } catch (error) {
            if (isUnknownPlanScopeError(error)) {
              return {
                rows: [] as ItemRow[],
                unknownHarnesses: [opts.harnessSlug],
              };
            }
            throw error;
          }
          if (!one) return { notFound: true as const, unknownHarnesses: [] };
          if (!one.archived || includeArchived) {
            planRows = [one];
          }
        } else {
          try {
            planRows = await listPlanRows({ includeArchived, ...opts });
          } catch (error) {
            if (isUnknownPlanScopeError(error)) {
              return {
                rows: [] as ItemRow[],
                unknownHarnesses: [opts.harnessSlug],
              };
            }
            throw error;
          }
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

        for (const row of planRows) {
          if (row.isLegacy) continue;
          if (isTerminalPlanHiddenFromCrossPlan(row.status, args)) continue;
          const planItems = planItemsForRow(row);
          const { items: resolvedItems, blockingIssues } = applyPlanItemBlocks(
            resolveEffectiveStatusForItems(planItems).items,
            (id) => allBlocked.get(planItemRef(row.planSlug, id)),
          );

          // okf-frontmatter-adoption H(b): a plan IN SCOPE for the spec triad and
          // missing a leg holds its items back from `actionable`.
          //
          // Deliberately NOT expressed by rewriting effectiveStatus to 'blocked'.
          // effectiveStatus is read by `system:plan-item-lane-sync`, which HOLDS a
          // linked work-item open on a non-terminal item — so a plan-level
          // authoring gap would have stranded real work-items in a state
          // `work_items:complete` refuses (the EI-19412899868617052 shape, one
          // level up). The gate belongs to the `actionable` QUESTION, which is
          // exactly what the design asked for; the item's own status is untouched
          // and every other consumer sees it unchanged.
          const triad = specTriadGate(
            {
              planSlug: row.planSlug,
              content: row.content,
              created: row.created,
              itemCount: planItems.length,
            },
            specTriadOpts,
          );

          for (const item of resolvedItems) {
            if (args.actionable && item.effectiveStatus !== "todo") continue;
            if (args.actionable && triad.gated) continue;
            // needsHuman keys on the DERIVED top band (B-12 / P-072), not the raw
            // stored token — so an authority=owner item gates the orchestrator DONE-gate
            // and, once the owner arms autonomy (P-092), a high-risk item above its
            // ceiling does too. Behavior-neutral today: `needsHuman` equals
            // `storedStatus === 'needs-human'` while unarmed (D-007).
            if (args.needsHuman && !item.needsHuman) continue;
            if (args.status && item.effectiveStatus !== args.status) continue;
            rows.push({
              plan: row.planSlug,
              archived: row.archived,
              item,
              ...(blockingIssues[item.id]
                ? { blockedByIssues: blockingIssues[item.id] }
                : {}),
              ...(triad.gated ? { specTriadMissing: triad.missing } : {}),
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

        return { rows, unknownHarnesses: [] };
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
    // Coverage rollup (work→plan_item edges + direct plan-item claim) is a live
    // coordination read, not plan content. Refresh it on every call so a plan-table
    // cache hit cannot replay a liveness verdict from before a claim or heartbeat
    // changed. This also strips coverage fields from an entry created by an older
    // handler version before applying the fresh overlay.
    let coverage = new Map<string, PlanItemCoverage>();
    try {
      coverage = await getAllPlanItemCoverage();
    } catch {
      // Non-fatal — no coverage overlay.
    }
    // The cached plan read can only filter the plan item's own effective status.
    // Linked work-item state is live coverage, so apply this claimability floor
    // after refreshing coverage; otherwise a todo plan item linked to a blocked
    // work-item is returned by actionable=true before the coverage overlay exists.
    const rows = cached.rows.flatMap((row) => {
      const cov = coverage.get(planItemRef(row.plan, row.item.id));
      if (args.actionable && cov?.links.some((link) => link.blocked === true)) return [];
      const freshRow = { ...row };
      delete freshRow.coverage;
      delete freshRow.coverageDivergence;
      return [{
        ...freshRow,
        ...(cov ? { coverage: compactCoverage(cov) } : {}),
        ...(cov && isCoverageDivergent(row.item.effectiveStatus, cov.level)
          ? { coverageDivergence: true as const }
          : {}),
      }];
    });

    const truncated = args.limit !== undefined && rows.length > args.limit;
    const limitedRows = truncated ? rows.slice(0, args.limit) : rows;

    ctxAny.metadata?.({
      count: limitedRows.length,
      totalCount: rows.length,
      actionable: !!args.actionable,
      needsHuman: !!args.needsHuman,
      scope: args.slug ?? "all",
      ...(cached.unknownHarnesses.length > 0
        ? { unknownHarnesses: cached.unknownHarnesses }
        : {}),
      ...(truncated ? { truncated: true } : {}),
    });

    // {data} envelope so the payload-tier shapers apply; HTTP/sync consumers
    // still read identical `{"items":[...]}` JSON text.
    return {
      data: {
        items: limitedRows,
        ...(truncated ? { truncated: true } : {}),
      },
    };
  },
});
