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
import { detectBgJobCheckpointClaim } from "../../checkpoint-bg-job-claim";
import { getPresence } from "../coordination/presence";
import { planItemLaneBlockReason } from "../../scheduler/plan-item-lane-guard";
import { planItemClaimCollision } from "../../scheduler/plan-item-claim-collision";
import { looksLikeCitedProseEvidence } from "../../completion-audit";

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
 * The `work_items:<id>` row tag is kept for PRECISE per-row invalidation. `work_items`
 * keys on `feature_id` (no `id` column); WI-4513 (migration 625) taught the generic
 * emit_change_notify trigger to fall back to `feature_id` when `id` is absent, so this
 * row tag now fires on every work-item write — precision no longer rides solely on the
 * table tag, though the table tag remains the correctness floor regardless (belt+braces).
 * The short soft TTL backstops the un-tagged dimensions a detail read folds in (topics /
 * thread posts / links). Not on the claim hot path (D-004-safe).
 */
const WORK_ITEMS_GET_SOFT_TTL_MS = 20_000;

export default defineTool({
  name: "work_items:get",
  profile: "engineer",
  // P-011 prompt-weight budget counts description + when + notWhen + chaining
  // and NOT returns/seeAlso. The conditional-field reference below therefore
  // lives in `guidance.returns`: it was in `description`, which pushed this tool
  // to 1774 chars and breached the 1600 HARD CAP, reddening the fleet gate. It
  // is documentation of the RESPONSE, so `returns` is also where it belongs.
  description:
    "Fetch one OR many work-items by id (WI-/F-/EI-…) — `id` for one or `ids` for several (1–100). `harness` disambiguates a repeated feature id. Returns { ok, results:[…], counts } — correlate by id, NOT position. Several conditional fields carry warnings you must read before acting (claim collisions, stale checkpoints, prose-only completion evidence): see `returns`.",
  guidance: {
    when: "You have one or more work-item ids and need their full state (kind, lifecycle, assignee, parent). Pass every id you need at once via `ids` instead of calling per id.",
    returns:
      "{ ok, results:[{ ok, id, workItem?, checkpoint?, checkpointAgeMs?, checkpointUpdatedAtMs?, planItemBlocked?, planItemClaimCollision?, auditProseEvidenceLikely?, error? }], counts } — correlate by id, not position.\n\nConditional fields, present only when they apply:\n• `planItemBlocked` — the linked plan lane is still blocked/needs-human/stale ({ reason, planSlug, itemId, effectiveStatus }). Check before unblocking.\n• `planItemClaimCollision` — holding this work-item is NOT holding its linked plan item; someone else now holds a LIVE claim on it ({ planSlug, itemId, claimedBy, claimedByLabel, note }). Coordinate before continuing — you may be duplicating work.\n• `checkpoint` — in-flight state from work_items:checkpoint, with `checkpointAgeMs` its write-recency (trust a stale one less).\n• `checkpointStale` — the assignee kept working after that checkpoint.\n• `checkpointBgJobWarning` — the checkpoint cites a background job/task as evidence, and that bookkeeping can die silently across a process boundary. Verify the pid/completion-marker before trusting it.\n• `auditProseEvidenceLikely` — structured completion evidence is empty but a `terminalCompletionRef` exists, so the real proof is likely PROSE in completion.summary. Read it before reopening a close as bare.",
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
        // EI-13715: blockedness has TWO sources of truth for a plan-linked work-item
        // (payload.plan_item back-pointer) — this item's own `state`, and its linked
        // plan-item's `effectiveStatus` (plans:get-item). Previously ONLY the latter
        // surfaced the real reason ("blocked-by P-308"); this read gave no hint the
        // plan gate even existed (`externalBlockers: null` reads as "blocked, reason
        // unrecorded"), so a reader unblocked a live plan-supervised gate believing
        // there was nothing left to check. Surface the SAME check work_items:observe
        // / claim_next / scheduler:get_next already enforce, here too — read-only,
        // fails open (null on no back-pointer, lookup error, or a clear lane), cheap
        // (one plan-row read, only when the item actually carries the back-pointer).
        const planItemBlocked = await planItemLaneBlockReason(workItem).catch(() => null);
        // P-006 (agent-trap-guards-2026-07-26): "holding the linked work-item is not
        // holding the plan item" — surface it when the linked plan item's live claim
        // has diverged from this work-item's own assignee, so an agent mid-execution
        // can see the item is no longer (solely) theirs instead of discovering it only
        // at close time via a plan-item claim conflict. Fails open (undefined) on any
        // lookup error or when there is no divergence.
        const claimCollision = await planItemClaimCollision(workItem).catch(() => null);
        // EI-13845: completion evidence lives on TWO surfaces — the STRUCTURED
        // `terminalCompletionEvidence` (testsRun/testResult/verifiedHow/…, populated only
        // when the closer filled those specific fields) and the PROSE `terminalCompletionRef`
        // (`completion.summary`, which many closers use to write the real verification detail
        // instead — "535 tests green; unblocked P-005" cites nothing the structured fields
        // capture). A reader of a SINGLE item via work_items:get had no way to tell "never
        // said how" apart from "said how, in prose" — work_items:list's `audit:'no-evidence'`
        // path already stamps this signal (looksLikeCitedProseEvidence, EI-13424) but only on
        // that bulk sweep, not here, so an auditor who pulled the one item straight (as in the
        // WI-5153 near-wrongful-reopen this closes) saw only the empty structured field and
        // read it as "no evidence at all". Stamp the same best-effort signal here whenever the
        // structured surface is empty but a completion ref exists, so both surfaces are visible
        // together wherever completion evidence is read — never just the possibly-empty one.
        const auditProseEvidenceLikely =
          !workItem.terminalCompletionEvidence && workItem.terminalCompletionRef
            ? looksLikeCitedProseEvidence(workItem.terminalCompletionRef)
            : undefined;
        // EI-18654296679612119: the checkpoint may cite a background job/task as evidence of
        // in-flight or completed work — that bookkeeping lives in the WRITER'S own process/shell
        // and can die silently across a session teardown / loop-carry respawn / compaction with
        // no trace left in the checkpoint text (EI-16611). Flag it here too: this is the surface
        // a careful reader actually used to catch the live repro (reading the checkpoint directly
        // via work_items:get, not just at claim time).
        const checkpointBgJobWarning = checkpoint ? detectBgJobCheckpointClaim(checkpoint).reason : undefined;
        return {
          ok: true as const,
          id,
          workItem,
          checkpoint,
          checkpointAgeMs,
          checkpointUpdatedAtMs,
          ...(checkpointStale ? { checkpointStale } : {}),
          ...(checkpointBgJobWarning ? { checkpointBgJobWarning } : {}),
          ...(planItemBlocked ? { planItemBlocked } : {}),
          ...(claimCollision ? { planItemClaimCollision: claimCollision } : {}),
          ...(auditProseEvidenceLikely !== undefined ? { auditProseEvidenceLikely } : {}),
        };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
