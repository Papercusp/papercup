/**
 * Plan → work-item promotion RUNNER (unified-work-item-ledger-2026-06-21 P-003).
 *
 * The I/O wrapper around the pure computePromotions(): on plans:start (behind the
 * default-OFF flag papercusp-plan-workitem-promotion), mint a placeable, UNCLAIMED
 * feature work-item for each OPEN plan-item that doesn't already have one — so a
 * started+eligible plan never sits at zero work-items and the Queen has work to
 * place (D-002: plans:start is the single promotion path; the Queen just calls it).
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
import { IMPLEMENTS_REL, listConvertedPlanItemRefs, type PlanItemStamp } from './plan-items/convert';
import { syncLinkedWorkItemsToPlanLane, type PlanLaneSyncStatus } from './plan-items/reconcile-linked-work-items';
import { computePromotions, type OpenPlanItem } from './plan-workitem-promotion';

export interface PromotePlanResult {
  /** new work-items minted this call */
  promoted: number;
  /** open items already covered by a work-item (idempotent skips) */
  skipped: number;
  /** true when the flag is OFF — promotion was a no-op */
  flagOff?: boolean;
}

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
  if (!enabled) return { promoted: 0, skipped: 0, flagOff: true };

  const read = await readPlanBySlug(opts.planSlug, {
    harnessSlug: opts.harnessSlug,
    workspaceId: opts.workspaceId,
  });
  if (!read) return { promoted: 0, skipped: 0 };

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
  if (openItems.length === 0) return { promoted: 0, skipped: 0 };

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
  const { items: resolvedItems } = resolveEffectiveStatusForItems(planItemsForResolve);
  const effectiveById = new Map(resolvedItems.map((i) => [i.id, i]));

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
    promoted++;
  }
  return { promoted, skipped: openItems.length - promoted };
}
