/**
 * work_items:get — resolve one OR many work-items by id across kinds
 * (unify-work-items; bulk-standardized per bulk-endpoint-standardization-2026-06-21).
 * Searches both kind-tables (ids are disjoint across families). Returns the
 * unified work-item shape incl. kind, lifecycle state, assignee, parent.
 *
 * Bulk by default (the house keyed-array contract): pass `id` for one or `ids`
 * for several; the result is `{ ok, results:[{ ok, id, workItem?, error? }], counts }`
 * — each result self-describes its id, so a not-found item never poisons the rest
 * and the agent correlates by id (not array position).
 */
import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import { COORD_ROLES } from "../coordination/roles";
import { getWorkItem, getWorkItemDetail } from "../../work-items";
import { mergeIds, runBulk, bulkContent } from "../_bulk";
import { cachedRead, type CachedReadCtx } from "../../cache";

/**
 * SWR backstop for work_items:get (cache-expensive-tool-reads-2026-06-22 P-005).
 * A per-id entry is tagged with BOTH the unified table AND harness_features_consolidated:<id>,
 * so the data-model generic-notify fix's per-row .changed bump invalidates exactly that
 * item on a write. The short soft TTL backstops the un-tagged dimensions a detail read
 * folds in (topics / thread posts / links). Not on the claim hot path (D-004-safe).
 */
const WORK_ITEMS_GET_SOFT_TTL_MS = 20_000;

export default defineTool({
  name: "work_items:get",
  profile: "engineer",
  description:
    "Fetch one OR many work-items by id (WI-/F-/EI-…) across every kind in ONE call — pass `id` for one or `ids` for several (1–100). Pass `harness` to disambiguate a feature id that may repeat across harnesses. Returns { ok, results:[{ ok, id, workItem?, error? }], counts } — correlate each result by its id, not by position; a missing id comes back as that item's { ok:false } without failing the rest.",
  guidance: {
    when: "You have one or more work-item ids and need their full state (kind, lifecycle, assignee, parent). Pass every id you need at once via `ids` instead of calling per id.",
    notWhen:
      "Browsing or filtering the queue → work_items:list / work_items:search (they already return many rows).",
    chaining:
      "work_items:list → work_items:get { ids:[…] } for detail on the ones you care about.",
    seeAlso: [
      'work_items:observe (claimability of these ids without taking them)',
      'work_items:comment (post an update on one)',
      'work_items:link (record a dependency between two)',
    ],
  },
  capability: "work_items:read",
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z
        .string()
        .min(1)
        .optional()
        .describe("a single work-item id (n=1 shorthand for ids:[id])"),
      ids: z
        .array(z.string().min(1))
        .max(100)
        .optional()
        .describe("work-item ids to fetch (1–100)"),
      harness: z.string().max(80).optional(),
      detail: z
        .boolean()
        .optional()
        .describe(
          "also return topics, thread posts (comments), and outgoing links",
        ),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: "pass `id` (one) or `ids` (many)",
    }),
  async handler(args, ctx) {
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        // Cache the per-id read (cache-expensive-tool-reads P-005). Tagged with the
        // unified table + the per-row tag so a write to THIS item invalidates exactly
        // its entry. Not-found is NOT cached (cacheEmpty default false) — a just-created
        // item must surface immediately, and a miss is cheap to recompute.
        const workItem = await cachedRead(
          ctx as CachedReadCtx,
          {
            tool: "work_items:get",
            key: {
              id,
              harness: args.harness ?? null,
              detail: args.detail === true,
            },
            tags: [
              "harness_features_consolidated",
              `harness_features_consolidated:${id}`,
            ],
            softTtlMs: WORK_ITEMS_GET_SOFT_TTL_MS,
          },
          () =>
            args.detail
              ? getWorkItemDetail(id, args.harness)
              : getWorkItem(id, args.harness),
        );
        return workItem
          ? { ok: true as const, id, workItem }
          : { ok: false as const, id, error: `work_item '${id}' not found` };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
