/**
 * Plan → work-item promotion RUNNER (unified-work-item-ledger-2026-06-21 P-003).
 *
 * The I/O wrapper around the pure computePromotions(): on plans:start (behind the
 * default-OFF flag papercusp-plan-workitem-promotion), mint a placeable, UNCLAIMED
 * feature work-item for each OPEN plan-item that doesn't already have one — so a
 * started+eligible plan never sits at zero work-items and the Queen has work to
 * place (D-002: plans:start is the single promotion path; the Queen just calls it).
 *
 * TWO-PASS (work-item-dependency-edges-2026-08-02 P-006): mint every item, then translate
 * each one's plan-level `blockedBy` into real `blocks` edges. Before this, promotion carried
 * the plan's NODES but not its GRAPH — `blockedBy` was read only to pick a starting lane
 * (EI-14024), so the dependency structure the plan described existed nowhere the scheduler
 * could query. The pass split is load-bearing: a plan-item id only becomes a work-item id at
 * mint time, so a single pass silently drops every forward reference. See
 * `writePromotedDependencyEdges` for which writer to use — D-010, and it is not the obvious one —
 * and for P-008/D-012's cycle policy: PRE-FLIGHT AND REJECT at edge granularity (refuse the edges
 * a cyclic plan graph implies, still mint the nodes, which the lane gate already parks).
 *
 * Coherent with convert-at-pickup (plan-items/convert.ts): promotion reuses the
 * SAME idempotency truth (the `implements` coord_links edge via
 * listConvertedPlanItemRefs) and stamps the SAME payload.plan_item + writes the
 * SAME edge — so a later pickup RESUMES the promoted work-item rather than minting
 * a duplicate. The only difference from convert: promotion leaves the item
 * UNCLAIMED (no owner) — it is placeable, not picked-up.
 *
 * SAFE BY DEFAULT: the flag defaults OFF (dark) → this is a no-op. plans:start
 * calls it fire-and-forget + .catch(), so it can never break the start path. Ships
 * dark until the owner integration-verifies + flips it on.
 */
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { resolveEffectiveStatusForItems, type ItemStatus, type PlanItem } from '@papercusp/plan-parser';
import { systemDistinctId } from './flag-distinct-id';
import { readPlanBySlug } from './agent-tools/plans/source';
import { createWorkItem, linkWorkItem } from './work-items';
import { PLAN_ITEM_KIND, planItemRef } from './issue-blocks-merge';
import {
  findConvertedWorkItemByStamp,
  IMPLEMENTS_REL,
  listConvertedPlanItemRefs,
  type PlanItemStamp,
} from './plan-items/convert';
import { syncFeatureBlockEdges } from './dbos/feature-blockers-edges';
import { syncLinkedWorkItemsToPlanLane, type PlanLaneSyncStatus } from './plan-items/reconcile-linked-work-items';
import { computePromotions, type OpenPlanItem } from './plan-workitem-promotion';

export interface PromotePlanResult {
  /** new work-items minted this call */
  promoted: number;
  /** open items already covered by a work-item (idempotent skips) */
  skipped: number;
  /** true when the flag is OFF — promotion was a no-op */
  flagOff?: boolean;
  /**
   * P-006: feature→feature `blocks` edges written from the plan's `blockedBy` this call.
   * Counts EDGES, not items — one item with two blockers contributes two.
   */
  edgesWritten: number;
  /**
   * P-006: edge writes that FAILED at the writer — after P-008's pre-flight this is the
   * exceptional path, not the expected one: a cross-plan cycle the plan-level pre-flight
   * cannot see (an edge from an already-promoted item back into this plan), or genuine I/O.
   * A plan-internal cycle no longer reaches the writer; it is counted in `edgesRejectedCyclic`.
   */
  edgeFailures: number;
  /**
   * P-008: edges REFUSED by the pre-flight because the plan's own `blockedBy` graph is cyclic
   * (either side of the edge is in a cycle). Counts EDGES, like `edgesWritten`. These items are
   * still minted and still gated — `resolveEffectiveStatusForItems` resolves every cycle member
   * to `blocked`, so pass 1's lane gate parks them; what is withheld is only the edge.
   */
  edgesRejectedCyclic: number;
  /**
   * P-008: `blockedBy` refs naming a plan item that DOES NOT EXIST in the plan — an authoring
   * error `plans:lint` already reports, split out from `blockersUnresolved` because the two
   * demand different responses (fix the plan text vs. investigate a promotion that should have
   * happened). Previously conflated into `blockersUnresolved`.
   */
  blockersDangling: number;
  /**
   * P-006: `blockedBy` refs naming a REAL, still-open plan item that nonetheless resolved to no
   * work-item — i.e. a promotion that should have happened and didn't, NOT the ordinary
   * done/dropped blocker (deliberately uncounted) and no longer the dangling ref (see above).
   */
  blockersUnresolved: number;
}

/** The zero-edge result shape shared by every early return (nothing minted ⇒ nothing to link). */
const NO_EDGES = {
  edgesWritten: 0,
  edgeFailures: 0,
  edgesRejectedCyclic: 0,
  blockersDangling: 0,
  blockersUnresolved: 0,
} as const;

function isOpenStatus(status: string | null): boolean {
  return status !== 'done' && status !== 'dropped';
}

/**
 * Promote a plan's open items to placeable, unclaimed work-items. Idempotent
 * (re-running mints only newly-open items, never duplicates). Throws on a genuine
 * error so a direct caller/test sees it; plans:start wraps the call in .catch().
 */
export async function promotePlanItems(opts: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  createdBy: string;
}): Promise<PromotePlanResult> {
  const enabled = await getFlag(FLAGS.PLAN_WORKITEM_PROMOTION, systemDistinctId());
  if (!enabled) return { promoted: 0, skipped: 0, flagOff: true, ...NO_EDGES };

  const read = await readPlanBySlug(opts.planSlug, {
    harnessSlug: opts.harnessSlug,
    workspaceId: opts.workspaceId,
  });
  if (!read) return { promoted: 0, skipped: 0, ...NO_EDGES };

  // Mirror convertPlanItem's item read: prefer the PG-canonical row.items, fall
  // back to the parsed markdown items. blockedBy is carried through too (EI-14024)
  // so DAG-blocked items can be minted already GATED instead of briefly claimable.
  const rawItems =
    read.row.items.length > 0
      ? read.row.items.map((i) => ({
          id: i.id,
          status: i.status as string | null,
          text: (i.text as string | null) ?? '',
          blockedBy: Array.isArray((i as { blockedBy?: unknown }).blockedBy)
            ? ((i as { blockedBy: string[] }).blockedBy ?? [])
            : [],
        }))
      : read.parsed.items.map((i) => ({
          id: i.id,
          status: i.storedStatus as string | null,
          text: i.text ?? '',
          blockedBy: i.blockedBy ?? [],
        }));
  const openItems: OpenPlanItem[] = rawItems
    .filter((i) => isOpenStatus(i.status))
    .map((i) => ({ id: i.id, text: i.text }));
  if (openItems.length === 0) return { promoted: 0, skipped: 0, ...NO_EDGES };

  // EI-14024: resolve each item's EFFECTIVE status (blocked-by graph aware, same
  // algorithm scheduler/plan-item-lane-guard.ts checks post-claim) over the FULL
  // item set (a blocker outside `openItems` — e.g. itself blocked — must still
  // resolve correctly), so a freshly-promoted item whose plan-level blockers are
  // still open can be minted already gated instead of briefly claimable.
  const planItemsForResolve: PlanItem[] = rawItems.map((i) => ({
    id: i.id,
    text: i.text,
    storedStatus: (i.status ?? 'todo') as ItemStatus,
    importance: 'normal',
    blockedBy: i.blockedBy,
    decisionRefs: [],
    phase: null,
    lineNumber: 0,
    rawLine: '',
  }));
  // P-008: the SAME resolve also returns `cycleMembers` — the pre-flight the edge write needs,
  // computed here for free, over the FULL item set, BEFORE anything is minted. Promotion used to
  // destructure only `{ items }` and discard it, which is why cycle handling could only ever be
  // post-hoc (catch the writer's throw). See `writePromotedDependencyEdges` for the policy.
  const { items: resolvedItems, cycleMembers } = resolveEffectiveStatusForItems(planItemsForResolve);
  const effectiveById = new Map(resolvedItems.map((i) => [i.id, i]));
  const cyclicPlanItemIds = new Set(cycleMembers);

  // Idempotency: an item already CONVERTED (has an `implements` edge — the same
  // truth convert-at-pickup uses) is never re-promoted.
  const convertedRefs = await listConvertedPlanItemRefs();
  const alreadyIds = openItems
    .map((i) => i.id)
    .filter((id) => convertedRefs.has(planItemRef(opts.planSlug, id)));

  const specs = computePromotions({
    planSlug: opts.planSlug,
    harness: opts.harnessSlug,
    openItems,
    existingPromotedItemIds: alreadyIds,
  });

  const textById = new Map(openItems.map((i) => [i.id, i.text]));
  let promoted = 0;
  /**
   * P-006 PASS 1 — mint every item first, recording `planItemId → workItemId`.
   *
   * The two-pass split is the whole point: a plan item's `blockedBy` names a PLAN-item id
   * (`P-004`), and the work-item id it becomes (`WI-6923`) is not known until that item is
   * minted. A single pass can only translate blockers that happen to appear EARLIER in the
   * list, so any forward reference — an item blocked by one declared below it — would be
   * silently dropped. Minting first makes the whole map available before any edge is written,
   * so translation is order-independent.
   */
  const mintedByPlanItem = new Map<string, string>();
  for (const spec of specs) {
    const itemId = spec.sourcePlanItemIds[0];
    const stamp: PlanItemStamp = {
      plan_slug: opts.planSlug,
      item_id: itemId,
      harness_slug: opts.harnessSlug,
    };
    const wi = await createWorkItem({
      kind: spec.kind,
      title: spec.title,
      summary: textById.get(itemId) ?? undefined,
      harness: spec.harness,
      sourcePlanSlug: spec.sourcePlanSlug,
      payload: { plan_item: stamp },
      createdBy: opts.createdBy,
      // NO assignee — placeable, UNCLAIMED; the Queen places it.
    });
    await linkWorkItem(
      wi.id,
      { kind: PLAN_ITEM_KIND, ref: planItemRef(opts.planSlug, itemId) },
      IMPLEMENTS_REL,
      { harness: wi.harness ?? undefined, by: opts.createdBy },
    );
    // EI-14024: if this item's plan-level blockers are still open (or it needs a
    // human decision), gate it the SAME way the periodic lane-sync sweep
    // (reconcile-linked-work-items.ts's syncLinkedWorkItemsToPlanLane, EI-14699)
    // already does — reused here at MINT time so there is no window where a
    // DAG-blocked item sits plainly claimable. `blockerCompletionUnblocksDependents`
    // (the reverse leg — a blocker's own completion) is already covered: the
    // orphan-reconcile periodic sweep + reconcile-rule.ts re-derive this item's
    // lane on every relevant transition and un-gate it once actionable.
    const effective = effectiveById.get(itemId);
    const laneStatus: PlanLaneSyncStatus | null =
      effective?.effectiveStatus === 'blocked' ? 'blocked' : effective?.needsHuman ? 'needs-human' : null;
    if (laneStatus) {
      await syncLinkedWorkItemsToPlanLane(
        { planSlug: opts.planSlug, itemId, harnessSlug: opts.harnessSlug },
        laneStatus,
      ).catch(() => {
        // Best-effort — never let a gating hiccup break the mint itself; the
        // periodic sweep (system:plan-item-orphan-reconcile, every 15min) is the
        // backstop that eventually parks it if this inline gate fails.
      });
    }
    mintedByPlanItem.set(itemId, wi.id);
    promoted++;
  }

  const edgeCounts = await writePromotedDependencyEdges({
    planSlug: opts.planSlug,
    harnessSlug: opts.harnessSlug,
    mintedByPlanItem,
    blockedByById: new Map(rawItems.map((i) => [i.id, i.blockedBy])),
    statusById: new Map(rawItems.map((i) => [i.id, i.status])),
    cyclicPlanItemIds,
    knownPlanItemIds: new Set(rawItems.map((i) => i.id)),
  });

  return { promoted, skipped: openItems.length - promoted, ...edgeCounts };
}

/**
 * P-006 PASS 2 — translate each newly-minted item's plan-level `blockedBy` into real
 * `blocks` edges, so a promoted plan carries its DAG into the scheduler instead of only its
 * nodes. Until now promotion read `blockedBy` solely to pick a lane (EI-14024's gate), which
 * parks an item as `blocked` but records no edge — so nothing ever un-gated it from the
 * dependency side, and the graph the plan described existed nowhere queryable.
 *
 * ⚠ WHICH WRITER — this is the part that is easy to get wrong and impossible to notice.
 * Per D-010, edges go through `syncFeatureBlockEdges` (coord_links), **not** the
 * `work_item_deps` store directly. Reads flipped to `work_item_deps` in the P-004 cutover, so
 * a direct write there is read back correctly and its tests pass — but `syncFeatureBlockEdges`
 * REBUILDS that table's feature-family edges for a blocked ref from coord_links (delete, then
 * insert), so the next unrelated blocker sync for the same item would silently erase every
 * edge promotion wrote. Writing through the authoritative seam keeps both stores consistent
 * and cannot be clobbered.
 *
 * Endpoint form follows D-009 rule 1: promoted items are FEATURE-family (computePromotions
 * hardcodes `kind: 'feature'`), so `featureRef()`'s harness-qualified `<harness>#<id>` is the
 * correct form on both sides — the form a feature-family floor can actually see.
 *
 * ⚠ CYCLES + UNRESOLVABLE REFS — P-008's ruling, replacing P-006's interim (D-012).
 * PRE-FLIGHT AND REJECT, at EDGE granularity: an edge is refused BEFORE the write when either
 * side is in a plan-level `blockedBy` cycle. This matches the house convention set by
 * `POST /features/import` (validate the union graph, refuse before writing — D-011) and by
 * `syncFeatureBlockEdges` itself, which rejects a cycle-closing set at the authoritative writer.
 *
 * REJECT THE EDGES, NOT THE PROMOTION — the one place this deliberately departs from features.ts,
 * which 400s the whole batch. Three reasons: (1) promotion's stated purpose is that a started plan
 * never sits at zero work-items, so refusing 20 healthy items over one cyclic pair defeats the
 * runner; (2) plans:start calls this fire-and-forget under `.catch()`, so a throw is swallowed
 * invisibly — an aborted promotion would be indistinguishable from a disabled one; (3) refusing
 * the edge costs no safety, because a cycle member is ALREADY gated: it resolves to
 * effectiveStatus `blocked`, so pass 1's lane gate parks it. features.ts has no such fallback —
 * its batch IS edges, so rejecting the request and rejecting the edges are the same act.
 *
 * Withholding the edge is also the RECOVERABLE choice. A cycle is a plan-authoring error that
 * `plans:lint` already reports; once the plan is fixed the periodic lane sweep re-derives the
 * item's status and un-gates it. Had we written the cyclic edges instead, fixing the plan would
 * NOT clear them — nothing rewrites promoted edges after the fact — leaving a permanent frontier
 * deadlock in the graph.
 *
 * Pre-flighting also makes the outcome ORDER-INDEPENDENT, which the interim was not: catching the
 * writer's throw per item meant that for a 2-cycle the FIRST write succeeded and only the second
 * was refused, persisting one arbitrary arrow of the cycle. Which arrow survived depended on mint
 * order. The pre-flight sees the whole set at once and refuses all of it.
 *
 * The writer's own guard is KEPT as the backstop, and now means something specific: a cross-plan
 * cycle the plan-level graph cannot see (an existing edge from an earlier-promoted item back into
 * this plan) or genuine I/O — counted in `edgeFailures`, no longer the expected path.
 */
async function writePromotedDependencyEdges(args: {
  planSlug: string;
  harnessSlug: string;
  /** planItemId → workItemId for the items minted THIS call. */
  mintedByPlanItem: ReadonlyMap<string, string>;
  blockedByById: ReadonlyMap<string, string[]>;
  statusById: ReadonlyMap<string, string | null>;
  /** P-008 pre-flight: plan items in a `blockedBy` cycle (from resolveEffectiveStatusForItems). */
  cyclicPlanItemIds: ReadonlySet<string>;
  /** Every plan item id, so a `blockedBy` ref naming no item is distinguishable from an unpromoted one. */
  knownPlanItemIds: ReadonlySet<string>;
}): Promise<{
  edgesWritten: number;
  edgeFailures: number;
  edgesRejectedCyclic: number;
  blockersDangling: number;
  blockersUnresolved: number;
}> {
  let edgesWritten = 0;
  let edgeFailures = 0;
  let edgesRejectedCyclic = 0;
  let blockersDangling = 0;
  let blockersUnresolved = 0;

  if (args.cyclicPlanItemIds.size > 0) {
    // Loud, once per plan: the plan cannot express a valid ordering for these items, so their
    // edges are withheld until a human fixes the plan (plans:lint reports the same cycle).
    console.warn(
      `[plan-workitem-promotion] plan '${args.planSlug}' has a blocked-by CYCLE among ` +
        `[${[...args.cyclicPlanItemIds].join(', ')}] — dependency edges touching these items are ` +
        `REFUSED (they stay gated via their blocked lane); fix the plan's blocked-by graph`,
    );
  }

  // A blocker may have been promoted by an EARLIER run (this call only mints newly-open
  // items), so the map alone is not enough: without the stamp lookup, incremental promotion
  // — the common case, an item added to a plan that already started — would drop exactly the
  // edges pointing back at the plan's existing work. Cached: one lookup per distinct blocker.
  const resolvedByStamp = new Map<string, string | null>();
  const resolveBlocker = async (planItemId: string): Promise<string | null> => {
    const minted = args.mintedByPlanItem.get(planItemId);
    if (minted) return minted;
    const cached = resolvedByStamp.get(planItemId);
    if (cached !== undefined) return cached;
    const wi = await findConvertedWorkItemByStamp(args.planSlug, planItemId, args.harnessSlug);
    const id = wi?.id ?? null;
    resolvedByStamp.set(planItemId, id);
    return id;
  };

  for (const [planItemId, workItemId] of args.mintedByPlanItem) {
    const blockers = args.blockedByById.get(planItemId) ?? [];
    if (blockers.length === 0) continue;

    const blockedSideCyclic = args.cyclicPlanItemIds.has(planItemId);
    const blockerWorkItemIds: string[] = [];
    for (const blockerPlanItemId of blockers) {
      // A done/dropped blocker is SATISFIED, not missing — it never promoted (openItems
      // filters it out) and must not gate anything. Skipped silently, and deliberately NOT
      // counted as unresolved: counting it would make every healthy plan look anomalous.
      if (!isOpenStatus(args.statusById.get(blockerPlanItemId) ?? null)) continue;
      // P-008 PRE-FLIGHT: refuse the edge if EITHER side sits in a cycle. Both directions
      // matter — a cyclic blocker is permanently non-terminating, so gating an otherwise
      // healthy item on it would propagate the deadlock outward from the cycle.
      if (blockedSideCyclic || args.cyclicPlanItemIds.has(blockerPlanItemId)) {
        edgesRejectedCyclic++;
        continue;
      }
      if (!args.knownPlanItemIds.has(blockerPlanItemId)) {
        // A `blockedBy` naming no plan item at all — an authoring error, not a promotion gap.
        // Checked before the stamp lookup: there is nothing for it to find.
        blockersDangling++;
        continue;
      }
      const resolved = await resolveBlocker(blockerPlanItemId);
      if (!resolved) {
        // A REAL, still-open blocker that resolved to no work-item: a promotion that should
        // have happened and didn't. Surfaced in the result rather than dropped on the floor —
        // a silently-missing edge is precisely this plan's bug class.
        blockersUnresolved++;
        continue;
      }
      if (resolved !== workItemId) blockerWorkItemIds.push(resolved);
    }
    // Nothing to write. Note we do NOT call the sync with an empty set: it has REPLACE
    // semantics, so an empty call would clear edges rather than leave them alone.
    if (blockerWorkItemIds.length === 0) continue;

    try {
      await syncFeatureBlockEdges(args.harnessSlug, workItemId, blockerWorkItemIds);
      edgesWritten += blockerWorkItemIds.length;
    } catch (err) {
      // BACKSTOP (P-008/D-012), no longer the expected path: the plan-level pre-flight above
      // has already refused every edge the plan's OWN graph makes cyclic, so reaching here means
      // a cycle only the LIVE graph shows — an existing edge from an earlier-promoted item back
      // into this plan, which no plan-level check can see — or genuine I/O. Still non-fatal for
      // the same reason the pre-flight refuses edges rather than the promotion: the items are
      // already minted, and plans:start's `.catch()` would swallow a throw invisibly. Counted on
      // the result so a caller can see it rather than infer it from a log line.
      edgeFailures++;
      console.warn(
        `[plan-workitem-promotion] blocks-edge write failed for ${args.harnessSlug}#${workItemId} ` +
          `(plan ${args.planSlug} item ${planItemId}, blockers [${blockerWorkItemIds.join(', ')}]):`,
        err,
      );
    }
  }

  return { edgesWritten, edgeFailures, edgesRejectedCyclic, blockersDangling, blockersUnresolved };
}
