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
import { getWorkItemCheckpointWithMeta } from "../../work-item-checkpoint";
import { computeCheckpointStaleness } from "../../checkpoint-staleness";
import { getPresence } from "../coordination/presence";

/**
 * SWR backstop for work_items:get (cache-expensive-tool-reads-2026-06-22 P-005).
 *
 * WI-4491: the cache tag MUST be the base TABLE that carries the emit_change_notify
 * trigger — `work_items` — NOT a compat view. mig-374 renamed the base table
 * `harness_features_consolidated` -> `work_items` and folded engineer_issues into it;
 * `harness_features_consolidated` / `engineer_issues` are now relkind 'v' VIEWS that
 * CANNOT carry a row trigger, so a write NEVER emits `<view>.changed` — it always fires
 * `harness_shared.work_items.changed`. This tool used to tag with the stale VIEW name
 * `harness_features_consolidated`, so NEITHER of its tags was ever bumped by a write:
 * the entry was invalidated by nothing but TTL, and a read-after-write returned the
 * pre-write row (proven live, WI-4508 repro — a create→update→get served the stale body
 * while Postgres held the new one). Tag with `work_items` (table-level) — bumped on
 * EVERY work-item write — as the read-your-writes correctness floor.
 *
 * The `work_items:<id>` row tag is kept for PRECISE per-row invalidation, but it only
 * fires once emit_change_notify emits the row PK for this table: `work_items` keys on
 * `feature_id` (no `id` column), and the trigger currently reads `to_jsonb(row)->'id'`
 * (JSON null here), so the row tag is presently inert and correctness rides the table
 * tag. Restoring the row PK emission (COALESCE ->'id', ->'feature_id') is tracked as a
 * separate defect (row-level tag dead for work_items + sync-bridge per-row scoping);
 * until it lands the table tag is what guarantees correctness. The short soft TTL
 * backstops the un-tagged dimensions a detail read folds in (topics / thread posts /
 * links). Not on the claim hot path (D-004-safe).
 */
const WORK_ITEMS_GET_SOFT_TTL_MS = 20_000;

export default defineTool({
  name: "work_items:get",
  profile: "engineer",
  description:
    "Fetch one OR many work-items by id (WI-/F-/EI-…) across every kind in ONE call — pass `id` for one or `ids` for several (1–100). Pass `harness` to disambiguate a feature id that may repeat across harnesses. Returns { ok, results:[{ ok, id, workItem?, checkpoint?, checkpointAgeMs?, checkpointUpdatedAtMs?, error? }], counts } — correlate each result by its id, not by position; a missing id comes back as that item's { ok:false } without failing the rest. `checkpoint` is the item's in-flight state left by work_items:checkpoint (null if none was ever written) — check it before assuming state was lost on a cold resume. `checkpointAgeMs`/`checkpointUpdatedAtMs` (EI-8885) are the checkpoint's write recency — a checkpoint is a HYPOTHESIS about current state, more trustworthy the fresher it is; treat one older than your own recent activity as possibly stale and re-verify against ground truth (re-read the real file, re-run the real test) rather than trusting a prose narrative that may predate a fix landing. `checkpointStale` (present only when set): the assignee stayed active AFTER the checkpoint — don't conclude safety from it.",
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
        // base TABLE `work_items` (the trigger producer — bumped on EVERY work-item
        // write, so a read-after-write is never stale) + the per-row tag `work_items:<id>`
        // (precise once the trigger emits this table's row PK — see the note above; inert
        // but harmless until then). NOT the compat VIEW name (WI-4491 — a view emits no
        // .changed, so tagging it left the entry TTL-only-invalidated → read-your-writes
        // staleness). Not-found is NOT cached (cacheEmpty default false) — a just-created
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
            tags: ["work_items", `work_items:${id}`],
            softTtlMs: WORK_ITEMS_GET_SOFT_TTL_MS,
          },
          () =>
            args.detail
              ? getWorkItemDetail(id, args.harness)
              : getWorkItem(id, args.harness),
        );
        if (!workItem) {
          return { ok: false as const, id, error: `work_item '${id}' not found` };
        }
        // EI-7252: an in-flight checkpoint (work_items:checkpoint → carry-note scope
        // `workitem:<harness>:<id>`) was previously INVISIBLE here — an investigator
        // (or a compacted successor) reading work_items:get had no way to know one
        // existed and would wrongly conclude state was lost. Surface it directly;
        // read-only, uncached (checkpoints change out-of-band of the harness_features_
        // consolidated tags this tool's cache is keyed on, so a cached copy could go
        // stale) and cheap (single indexed row lookup, null when never checkpointed).
        // EI-8805: read under the item's OWN harness — INCLUDING a harness-null item
        // (the store canonicalizes a null harness to the wildcard namespace it was
        // written under). Previously harness-null items skipped this lookup entirely
        // and always read null, silently losing a written checkpoint.
        // EI-8885: surface the checkpoint's write recency alongside its content — a
        // checkpoint read back with no age signal reads as CURRENT even when it's
        // several wakes stale (a compaction summary can claim green while the
        // actual checkpoint write never happened, or vice versa; WI-3578). Mirrors
        // the loop carry-note's getLoopCarryNoteWithMeta shape for the work-item scope.
        const { checkpoint, updatedAtMs: checkpointUpdatedAtMs } = await getWorkItemCheckpointWithMeta({
          harness: workItem.harness,
          workItemId: workItem.id,
        }).catch(() => ({ checkpoint: null, updatedAtMs: null }));
        const checkpointAgeMs = checkpointUpdatedAtMs != null ? Math.max(0, Date.now() - checkpointUpdatedAtMs) : null;
        // EI-15184: RELATIVE checkpoint staleness. `checkpointAgeMs` above is
        // ABSOLUTE age ("how old is this snapshot"); it does NOT tell a reader —
        // typically a fleet leader reconciling a peer's status — that the ASSIGNEE
        // kept working PAST this checkpoint. On WI-5013 a leader concluded a peer's
        // shared "MUST-NOT-TOUCH" rig was "intact" from a checkpoint that already
        // lagged the peer's own later (invisible) destructive action; the rig sat
        // degraded 3h+. Compare the checkpoint's write time to the assignee's last
        // GENUINE-activity time (presence.lastActiveAt): a material positive lag ⇒
        // "the checkpoint may not reflect their latest state; don't conclude safety
        // from it." Warn-only, bounded (only for a fetched item that HAS a checkpoint
        // + assignee — never a hot per-tick loop), fail-soft (a presence read miss
        // just omits the signal). Returned only when actually stale, to stay lean.
        let checkpointStale: ReturnType<typeof computeCheckpointStaleness> | undefined;
        if (checkpoint && checkpointUpdatedAtMs != null && workItem.assignee) {
          const assigneePresence = await getPresence(workItem.assignee).catch(() => null);
          const activeAt = assigneePresence?.lastActiveAt ? Date.parse(assigneePresence.lastActiveAt) : null;
          const staleness = computeCheckpointStaleness({
            checkpointUpdatedAtMs,
            assigneeActiveAtMs: activeAt != null && Number.isFinite(activeAt) ? activeAt : null,
          });
          if (staleness.stale) checkpointStale = staleness;
        }
        return {
          ok: true as const,
          id,
          workItem,
          checkpoint,
          checkpointAgeMs,
          checkpointUpdatedAtMs,
          ...(checkpointStale ? { checkpointStale } : {}),
        };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
