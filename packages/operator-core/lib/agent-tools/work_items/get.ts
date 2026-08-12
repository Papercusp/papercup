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
import { getWorkItem, getWorkItemDetail, getWorkItemThreadWindow } from "../../work-items";
import { mergeIds, runBulk, bulkContent } from "../_bulk";
import { cachedRead, type CachedReadCtx } from "../../cache";
import { getWorkItemCheckpointWithMeta, getWorkItemCheckpointFreshness } from "../../work-item-checkpoint";
import { getClaimTimePriorWorkHint, priorWorkWarning } from "../../work-item-prior-work";
import { computeCheckpointStaleness } from "../../checkpoint-staleness";
import { detectBgJobCheckpointClaim } from "../../checkpoint-bg-job-claim";
import { getPresence } from "../coordination/presence";
import { planItemLaneBlockReason } from "../../scheduler/plan-item-lane-guard";
import { planItemClaimCollision } from "../../scheduler/plan-item-claim-collision";
import { attachHolderContext } from "./_holder-lens";
import { holderContextReader } from "../coordination/holder-advisory";
import { getWorkItemLifecycleHistory } from "../../work-item-lifecycle-history";
import { activeWorkspaceId } from "../../workspace-registry";
import { extractCitedFactKeys, resolveCitedFacts, citedFactsWarning } from "../../agent-facts/cited-facts";
import { shapeWorkItemsGet } from "./get-shape";

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
    "Fetch one OR many work-items by id (WI-/F-/EI-…) — `id` for one or `ids` for several (1–100). `harness` disambiguates a repeated feature id. Returns { ok, results:[…], counts } — correlate by id, NOT position. Use `threadLimit` for a bounded, consumable recent-comment window; `detail:true` remains the full coord-substrate read. Several conditional fields carry warnings you must read before acting (claim collisions, stale checkpoints, prose-only completion evidence): see `returns`.",
  guidance: {
    when: "You have one or more work-item ids and need their full state (kind, lifecycle, assignee, parent). Pass every id you need at once via `ids` instead of calling per id. For comments, pass `threadLimit` (1–10) to get a bounded recent window with a same-snapshot total; this avoids loading the full thread behind `detail:true`.",
    returns:
      "{ ok, results:[{ ok, id, workItem?, holder?, checkpoint?, checkpointAgeMs?, checkpointUpdatedAtMs?, planItemBlocked?, planItemClaimCollision?, error? }], counts } — correlate by id, not position.\n\nConditional fields, present only when they apply:\n• `holder` — WHO holds this item and WHAT they are working toward, without attempting a claim ({ goalRef, goalText, assumptions:{count,keys}, declaredAt, stale, agreement, competing[] }). Read `agreement`/`competing` before trusting `goalRef`: 'divergent' plus a non-empty `competing` means the holder holds several claims and precedence picked one — measured, 3 of 19 holders hold two work-items at once. Absent means EITHER the holder declared no goal OR it is not readable by you; the two are deliberately indistinguishable.\n• `planItemBlocked` — the linked plan lane is still blocked/needs-human/stale ({ reason, planSlug, itemId, effectiveStatus }). Check before unblocking.\n• `planItemClaimCollision` — holding this work-item is NOT holding its linked plan item; someone else now holds a LIVE claim on it ({ planSlug, itemId, claimedBy, claimedByLabel, note }). Coordinate before continuing — you may be duplicating work.\n• `priorWork`/`priorWorkWarning` — P-001: this item has ALREADY BEEN WORKED (prior release/attempt history), so it is NOT fresh work even when it reads open+unassigned. Loudest when NO checkpoint exists — that row is otherwise indistinguishable from never-started. Read the source before building.\n• `checkpoint` — in-flight state from work_items:checkpoint, with `checkpointAgeMs` its write-recency (trust a stale one less).\n• `checkpointFreshness` — P-007: the verdict from the checkpoint's DECLARED dependencies ({ verdict: fresh|stale|recomputed, changed:[{dep,was,now}], reason }). Present only when its author declared any; it OVERRIDES the age/activity signals below (which cannot see a PEER's change at all), and a `stale` verdict names exactly which dependency moved.\n• `checkpointStale` — the assignee kept working after that checkpoint. Fallback only; suppressed when `checkpointFreshness` is present.\n• `citedFacts` — this item's PROSE cites `facts:assert` key(s) as its authority and some no longer resolve ({ cited:[{ key, condition, ref, excerpt?, scope }], dangling, decayed, note }). Measured: 22 of 25 such citations workspace-wide were already dead, while the item still read as fully specified. `decayed` (retracted/expired/superseded) is RECOVERABLE — the body is quoted in `excerpt` right here, so do not go hunting for it; `dangling` has no row under any scope and is unrecoverable, so do NOT treat that citation as specification and do NOT escalate its absence as a contested directive (it far more likely decayed than was withdrawn). Absent when every citation still resolves live, AND when the ledger could not be read at all — this never reports a read failure as a dangling reference.\n• `checkpointBgJobWarning` — the checkpoint cites a background job/task as evidence, and that bookkeeping can die silently across a process boundary. Verify the pid/completion-marker before trusting it.\n• `lifecycle` (with `detail:true`) — ANSWERS \"was this item ever blocked / held / reopened, by whom, when\". Unifies the three stores that each hold part of the answer (audit_log, payload.reopenHistory, payload flags) into one newest-first timeline: { events:[{ at, kind, by, source, action?, detail? }], flags:{ needsHuman, claimHold, heldOpenBy, heldOpenReason }, coverage }. READ `coverage` BEFORE concluding anything from an empty `events`: `notRecorded[]` names the transitions that are recorded NOWHERE for this item's family (non-terminal moves always; feature-family blocks before this field existed), and `degraded:true` means a source could not be READ — which is not the same fact as a source being empty. An empty timeline is never by itself evidence that nothing happened; conflating those two is the exact error this field was built to end.",
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
  // EI-20187955452832561: this handler never reads ctx.tx. It performs its own
  // work-item/checkpoint/coordination reads (and can enrich a bulk request) via
  // their dedicated accessors, so retaining the host's ambient workspace
  // transaction across that await-heavy work pins an org-app pool slot for the
  // whole read and starves unrelated coordination calls under fleet load.
  skipWorkspaceTx: true,
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
          "also return topics, thread posts (comments), outgoing links, and `lifecycle` — the unified history (blocks, holds, reopens) with a coverage report saying what is NOT recorded",
        ),
      threadLimit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe(
          "return a bounded oldest-first recent-comment window instead of loading the full thread; max 10 posts, with a same-snapshot total",
        ),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: "pass `id` (one) or `ids` (many)",
    }),
  // EI-19447969329510166: without a declared shaper this tool fell through to the
  // framework's GENERIC bounded projection, which clips every string at a flat 800
  // chars for a trimmed session — and the string it clipped was the CHECKPOINT.
  // That is the one field this tool exists to deliver on a post-respawn re-orient
  // (work_items:checkpoint: "your transcript does NOT carry across a task
  // boundary; the checkpoint is your continuity"), and a clipped checkpoint is not
  // a smaller answer but a different one — a note that opens with a superseded
  // root cause and retracts it further down reads, truncated, as endorsement of
  // the retracted lead. get-shape.ts spends the budget on `checkpoint` + the
  // warnings, and drops `workItem.summary`/`payload` instead.
  shape: {
    standard: (data) => shapeWorkItemsGet(data, "standard"),
    trimmed: (data) => shapeWorkItemsGet(data, "trimmed"),
  },
  async handler(args, ctx) {
    const ids = mergeIds(args.id, args.ids);
    // P-030: resolved ONCE for the whole bulk read. The reader is an argument to
    // the holder lens, never a cache-key dimension — the per-id `cachedRead`
    // below is deliberately non-principal-scoped, so reader-relative holder
    // context must be attached to what the cache RETURNS, never to what it
    // stores. `holderContextReader` returns null rather than throwing for a caller
    // this tool cannot attribute: `requirePrincipal: false` above makes such a
    // caller LEGITIMATE here, so an unguarded identity resolve would let the
    // enrichment fail the read it decorates.
    const reader = holderContextReader(ctx as Parameters<typeof holderContextReader>[0]);
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
        const boundedThread = args.threadLimit !== undefined;
        // A bounded thread request wins over detail:true so the diagnostic path
        // never pays the unbounded full-render read.
        const readDetail = args.detail === true && !boundedThread;
        const workItem = await cachedRead(
          ctx as CachedReadCtx,
          {
            tool: "work_items:get",
            key: {
              id,
              harness: args.harness ?? null,
              detail: readDetail,
            },
            tags: ["work_items", `work_items:${id}`],
            softTtlMs: WORK_ITEMS_GET_SOFT_TTL_MS,
          },
          () =>
            readDetail
              ? getWorkItemDetail(id, args.harness)
              : getWorkItem(id, args.harness),
        );
        if (!workItem) {
          return { ok: false as const, id, error: `work_item '${id}' not found` };
        }
        // Bounded diagnostic thread read. Do not route this through
        // getWorkItemDetail: that full-render helper intentionally loads every
        // post and was the source of truncated MCP replies on heavily-commented
        // items. A failure is explicit and fail-soft so the ordinary work-item
        // read remains usable.
        const threadWindowRead = boundedThread
          ? getWorkItemThreadWindow(id, args.threadLimit!, args.harness)
              .then((threadWindow) => ({ threadWindow, failed: false as const }))
              .catch(() => ({ threadWindow: null, failed: true as const }))
          : Promise.resolve({ threadWindow: undefined, failed: false as const });
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
        // WI-6737: the read still fails SOFT (a checkpoint-store blip must never fail the item
        // read) — but the FAILURE IS NOW RECORDED rather than collapsed into the same `null` a
        // successful never-checkpointed read produces. Those are different facts: "nothing was
        // ever written" invites starting fresh, "I could not ask" must not. Conflating them
        // silently re-created the exact conclusion EI-7252 above added this field to prevent
        // (a reader wrongly concluding in-flight state was lost) — and worse, fed an emphatic
        // prose assertion downstream via `hasCheckpoint` (see priorWork below).
        // EI-20220772039692003: these five enrichments are independent. Awaiting them
        // serially made their pool-acquisition queue time additive under checkpoint
        // load: the base item read succeeded, but the complete tool call crossed the
        // client's 15s deadline. Start them together so latency is bounded by the
        // slowest enrichment rather than their sum. Each leg keeps its existing
        // fail-soft fallback, so concurrency does not widen the failure surface.
        const [checkpointRead, planItemBlocked, claimCollision, decoratedRows, priorWorkRaw, threadWindowReadResult] =
          await Promise.all([
          getWorkItemCheckpointWithMeta({
            harness: workItem.harness,
            workItemId: workItem.id,
          })
            .then((r) => ({ checkpoint: r.checkpoint, updatedAtMs: r.updatedAtMs, readFailed: false }))
            .catch(() => ({ checkpoint: null, updatedAtMs: null, readFailed: true })),
          planItemLaneBlockReason(workItem).catch(() => null),
          planItemClaimCollision(workItem).catch(() => null),
          attachHolderContext(
            [{ assignee: workItem.assignee ?? null, state: workItem.state ?? null }],
            reader,
          ).catch(() => [undefined]),
          getClaimTimePriorWorkHint({
            harness: workItem.harness,
            workItemId: workItem.id,
          }).catch(() => null),
            threadWindowRead,
          ]);
        const [decorated] = decoratedRows;
        const { checkpoint, updatedAtMs: checkpointUpdatedAtMs, readFailed: checkpointReadFailed } = checkpointRead;
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
        //
        // P-007/D-013: the DECLARED-dependency verdict, which OVERRIDES the time
        // heuristics when the checkpoint's author declared what it derives from.
        // The heuristics above/below are proxies for "did anything this note depends
        // on change?"; when that question can be answered mechanically, the proxy is
        // not just redundant but WRONG in both directions — it calls an untouched
        // 3h-old note stale, and it cannot see a peer's edit at all (it keys on the
        // assignee's own activity). Undefined ⇒ nothing declared ⇒ fall back.
        const checkpointFreshness = checkpoint
          ? await getWorkItemCheckpointFreshness({ harness: workItem.harness, workItemId: workItem.id }).catch(
              () => undefined,
            )
          : undefined;
        const freshnessDeclared = checkpointFreshness !== undefined;
        let checkpointStale: ReturnType<typeof computeCheckpointStaleness> | undefined;
        // Skip the presence round-trip entirely when a declared verdict already
        // answers the question authoritatively.
        if (!freshnessDeclared && checkpoint && checkpointUpdatedAtMs != null && workItem.assignee) {
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
        // P-006 (agent-trap-guards-2026-07-26): "holding the linked work-item is not
        // holding the plan item" — surface it when the linked plan item's live claim
        // has diverged from this work-item's own assignee, so an agent mid-execution
        // can see the item is no longer (solely) theirs instead of discovering it only
        // at close time via a plan-item claim conflict. Fails open (undefined) on any
        // lookup error or when there is no divergence.
        // EI-18654296679612119: the checkpoint may cite a background job/task as evidence of
        // in-flight or completed work — that bookkeeping lives in the WRITER'S own process/shell
        // and can die silently across a session teardown / loop-carry respawn / compaction with
        // no trace left in the checkpoint text (EI-16611). Flag it here too: this is the surface
        // a careful reader actually used to catch the live repro (reading the checkpoint directly
        // via work_items:get, not just at claim time).
        const checkpointBgJobWarning = checkpoint ? detectBgJobCheckpointClaim(checkpoint).reason : undefined;
        // P-030 / D-060: WHO holds this item and WHAT they are trying to do, on
        // the ordinary read — not only when a claim is REFUSED. A lens onto the
        // shared P-026 projection, gated by `getCell('agent.goal', reader)`;
        // total, so a failure costs this field and never the read.
        // P-001 (fleet-leadership-continuity-and-actuation-2026-08-01): the read-side twin of the
        // claim-time guard. `checkpoint` above answers "what did the prior holder SAY"; this
        // answers "was there a prior holder AT ALL" — which is the only question left when the
        // checkpoint is empty, and the one that distinguishes a worked-then-released item from a
        // never-started one. Fail-soft: a lookup miss just omits the field.
        // WI-6737: `'unknown'` when the checkpoint read above FAILED — never `false`, which
        // priorWorkWarning renders as the categorical "NO checkpoint was ever written".
        const priorWork = priorWorkRaw
          ? {
              ...priorWorkRaw,
              hasCheckpoint: checkpointReadFailed ? ('unknown' as const) : (checkpoint ?? '') !== '',
            }
          : null;
        const priorWorkWarn = priorWorkWarning(priorWork);
        // EI-19397599078921465: the unified lifecycle history — "what actually happened to
        // this item". The filing that produced this believed the history did not exist; it
        // did, spread across audit_log + payload.reopenHistory + payload flags with nothing
        // tying them together, so an agent queried one store, found nothing, and concluded
        // (reasonably, and wrongly) that the question was unanswerable.
        //
        // Folded into `detail` rather than a new arg — an opt-in nobody knows about would
        // reproduce the exact discoverability defect this closes, and `detail` is already
        // the flag that means "the fuller picture" for an item being investigated. The plain
        // read stays on its existing cost, so the hot path is untouched.
        //
        // Read OUTSIDE cachedRead: audit_log rows are written fire-and-forget AFTER the
        // work-item write that triggers them, so they can land after the cache entry that
        // would have captured them — a cached timeline could omit the newest event while
        // looking complete, which is the one failure mode this field must not have.
        // Fail-soft: a miss omits the field and never fails the item read.
        // EI-19465127338264010: the PROSE fact-citation lens. The typed `assumptions`
        // channel is already gated at close time (resolveDeclaredAssumptions refuses a
        // dangling declaration); prose citations — "Map=fact pot-backend-rename-map" in a
        // summary or checkpoint — are not, and they are the channel agents actually use.
        // Measured on the live corpus the day this landed: 22 of 25 such citations in
        // non-terminal work-items no longer resolved, while the item still read as fully
        // specified. This is the READ seam, i.e. where the misleading actually happens.
        //
        // Cost is ~zero on the hot path: the extract is a PURE regex over two strings the
        // handler already holds, and the DB read happens ONLY when a key-shaped citation
        // is present (~25 of them workspace-wide). Fails open — see resolveCitedFacts.
        const citedKeys = extractCitedFactKeys([
          (workItem as { summary?: string | null }).summary,
          checkpoint,
        ]);
        const citedFacts = citedKeys.keys.length
          ? citedFactsWarning(
              await resolveCitedFacts(citedKeys.keys).catch(() => []),
              { truncated: citedKeys.truncated },
            )
          : undefined;
        const lifecycle = args.detail
          ? await getWorkItemLifecycleHistory({
              id: workItem.id,
              workspaceId: activeWorkspaceId(),
              payload: (workItem as { payload?: unknown }).payload,
              family: (workItem as { family?: string | null }).family ?? null,
            }).catch(() => null)
          : null;
        return {
          ok: true as const,
          id,
          workItem,
          ...(decorated?.holder ? { holder: decorated.holder } : {}),
          checkpoint,
          checkpointAgeMs,
          checkpointUpdatedAtMs,
          // WI-6737: present ONLY on a failed read, so `checkpoint: null` stops being ambiguous
          // between "never written" and "could not ask". Absent on the ordinary path.
          ...(checkpointReadFailed ? { checkpointReadFailed: true as const } : {}),
          ...(priorWorkWarn ? { priorWork, priorWorkWarning: priorWorkWarn } : {}),
          ...(checkpointFreshness ? { checkpointFreshness } : {}),
          ...(checkpointStale ? { checkpointStale } : {}),
          ...(checkpointBgJobWarning ? { checkpointBgJobWarning } : {}),
          ...(citedFacts ? { citedFacts } : {}),
          ...(planItemBlocked ? { planItemBlocked } : {}),
          ...(claimCollision ? { planItemClaimCollision: claimCollision } : {}),
          ...(boundedThread ? { threadWindow: threadWindowReadResult.threadWindow } : {}),
          ...(threadWindowReadResult.failed ? { threadWindowReadFailed: true as const } : {}),
          ...(lifecycle ? { lifecycle } : {}),
        };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
