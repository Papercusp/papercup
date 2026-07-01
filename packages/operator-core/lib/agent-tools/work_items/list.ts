/**
 * work_items:list — cross-kind list over the unified surface (unify-work-items,
 * D-007). Default = top-level items only; chunks surface under their parent (D-004,
 * pass `parent` or includeChildren). Filter by harness / kind / state.
 */
import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import { COORD_ROLES } from "../coordination/roles";
import {
  listWorkItems,
  type WorkItemKind,
} from "../../work-items";
import { boundRowField } from "../_bound-output";
import { cachedRead, type CachedReadCtx } from "../../cache";

/**
 * SWR backstop for work_items:list (cache-expensive-tool-reads-2026-06-22 P-005).
 * The unified work-item table (harness_features_consolidated) carries the generic
 * .changed trigger, so any work-item write auto-invalidates the entry via the
 * cache-ECA (table tag below) — this short soft TTL only bounds staleness for any
 * dependency dimension a trigger doesn't cover. work_items:list is an OVERVIEW read,
 * decoupled from the scheduler claim hot path (claim_next), so caching it does NOT
 * touch the maintained readiness floor (D-004).
 */
const WORK_ITEMS_LIST_SOFT_TTL_MS = 20_000;

/**
 * Output `data` schema (token-efficient-tool-result-formats P-011). The result
 * is the bare WorkItem array — the row count rides in TOON's self-describing
 * `[N]{…}:` header, so the old `{ ok, count, items }` wrapper is redundant. This
 * unlocks the compact format for a high-traffic list tool (≈ −32% tokens for
 * agents). `payload` is `unknown`, so the schema proves TOON-eligibility but not
 * CSV; rows that happen to have a null payload still serialize as CSV on an
 * explicit request via the serializer's runtime flatness check.
 */
const WORK_ITEM_ROW = z.object({
  id: z.string(),
  kind: z.string(),
  family: z.string(),
  harness: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  /** EI-1597: in list rows the summary is EXCERPTED (budget-aware) so a large backlog
   *  can't overflow the agent result cap; these flag a cut row. Full body via work_items:get. */
  summary_truncated: z.literal(true).optional(),
  summary_full_chars: z.number().optional(),
  state: z.string(),
  assignee: z.string().nullable(),
  assignedBy: z.string().nullable(),
  severity: z.string().nullable(),
  parent: z.string().nullable(),
  payload: z.unknown(),
  /** Shared backlog priority (feature_order) — LOWER = claimed sooner; null = unprioritized.
   *  Feature-family only (the Queen's steer lever, B7); issue-family is always null. */
  priority: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// EI-1597: bound each list row's summary so a large backlog can't overflow the agent
// result cap (work_items:list returns the full WorkItem array; a 40-item backlog hit
// 73KB of summaries on one line). Per-row cap = min(SUMMARY_ROW_CAP, floor(BUDGET/n))
// — the budget-aware bound coord:inbox (EI-1752) + plans:get (WI-274) use: total
// summary text stays <= BUDGET at ANY list size, while small lists keep most rows full.
// Full body is always available via work_items:get { id }.
export const SUMMARY_ROW_CAP = 240;
export const SUMMARIES_TOTAL_BUDGET = 16_000;

// EI-1597: a thin semantic wrapper over the shared budget-aware bound — single
// source of truth for the per-field excerpt (was an inlined copy of the loop).
export function boundSummaries<T extends { summary?: string | null }>(
  rows: T[],
): T[] {
  return boundRowField(
    rows,
    "summary",
    SUMMARY_ROW_CAP,
    SUMMARIES_TOTAL_BUDGET,
  );
}

export default defineTool({
  name: "work_items:list",
  profile: "engineer",
  description:
    "List work-items across kinds (feature/research-task/chunk/bug/change). Default shows top-level items (chunks are hidden — pass parent or includeChildren). Filter by harness, kind, state. Returns the WorkItem array directly — each row's summary is EXCERPTED to keep the list bounded (a row carries summary_truncated + summary_full_chars when cut); use work_items:get { id } for a full body.",
  guidance: {
    when: "You want the current work-items in a harness (or operator-wide). Default hides chunks; pass `parent` to see a parent's chunks. Each row carries `priority` (the shared backlog order, LOWER = claimed sooner) so the Queen can read the whole backlog's order in one call before steering it with work_items:set_priority.",
    chaining:
      "work_items:list → work_items:get { id } for detail; work_items:claim to take one; work_items:set_priority to re-order the backlog.",
    seeAlso: [
      'work_items:set_priority (steer the backlog order you just read)',
      'work_items:get (full detail on specific ids)',
      'work_items:claim_next (take the next claimable item)',
    ],
  },
  capability: "work_items:read",
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(80).optional(),
    // P-001/P-011 generic-kind: a built-in kind OR a workspace-registered generic-kind
    // datatype (declared via meta:define-datatype). familyOf() maps any non-issue kind to
    // the feature family + featureFamilyKindClause admits registered generic kinds, so the
    // filter works downstream; an unknown kind simply lists empty. Enum-locking this arg
    // was the observability gap — the queue could hold demo-bet rows the list tool refused
    // to filter by. Free string mirrors work_items:create.
    kind: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'built-in kind (feature, research-task, chunk, bug, change, task) OR a workspace-registered generic-kind datatype',
      ),
    state: z.string().max(40).optional(),
    parent: z
      .string()
      .max(80)
      .optional()
      .describe("list children (chunks) of this parent id"),
    includeChildren: z
      .boolean()
      .optional()
      .describe("include child items (chunks) in the list"),
    limit: z.number().int().positive().max(500).optional(),
  }),
  result: z.array(WORK_ITEM_ROW),
  // Freshness negotiation (agent-tool-delta-client-rollout-2026-06-23, P-001) — the #1
  // LLM-agent re-read by total bytes×repeats (queen/bee/overwatch poll the backlog ~3×/wake,
  // ~25KB/call). The diffable unit is the WorkItem row set (the data IS the array), keyed by
  // `id`; `kind` is the row type. The framework folds the filter args (harness/kind/state/
  // parent/includeChildren/limit) into the view fingerprint; `scope` adds the workspace.
  // NOTE: row summaries are budget-EXCERPTED by list size, so a row's content-hash can shift
  // when the list size changes — that just re-sends the row as `updated` (still checksum-correct,
  // never wrong). Dormant until a delta-aware client sends `_meta.delta` (the WI-514 follow-up).
  delta: {
    rows: (data) => (Array.isArray(data) ? data : null),
    itemKey: (row) => (row as { id: string }).id,
    itemKeyField: "id",
    rowType: (row) => (row as { kind: string }).kind,
    orderKey: "priority",
    scope: (_args, ctx) => (ctx as { workspaceId?: string }).workspaceId ?? "",
    schemaVersion: "work-items-list-v1",
    maxDeltaAge: 5 * 60_000,
  },
  async handler(args, ctx) {
    // Cache the expensive list read (cache-expensive-tool-reads P-005). Non-principal-
    // scoped (depends only on workspace + the filter args). The bounding is folded INTO
    // the cached factory so the stored value is the final, deterministic-per-args result.
    const items = await cachedRead(
      ctx as CachedReadCtx,
      {
        tool: "work_items:list",
        key: {
          harness: args.harness ?? null,
          kind: args.kind ?? null,
          state: args.state ?? null,
          parent: args.parent ?? null,
          includeChildren: args.includeChildren === true,
          limit: args.limit ?? null,
        },
        tags: ["harness_features_consolidated"],
        softTtlMs: WORK_ITEMS_LIST_SOFT_TTL_MS,
      },
      async () => {
        const rows = await listWorkItems({
          harness: args.harness,
          kind: args.kind as WorkItemKind | undefined,
          state: args.state,
          parent: args.parent,
          includeChildren: args.includeChildren,
          limit: args.limit,
        });
        // EI-1597: excerpt per-row summaries so a large backlog can't overflow the agent
        // result cap. Full body via work_items:get { id }.
        return boundSummaries(rows);
      },
    );
    return { data: items };
  },
});
