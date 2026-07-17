/**
 * The PLAN-ITEM-LANE readiness guard for self-select claims (WI-3667).
 *
 * A work-item can carry a `payload.plan_item: { plan_slug, item_id }` back-pointer
 * (stamped by plan-workitem-promotion-run.ts when a plan lane is promoted into an
 * execution record). `reservedPlanLaneExclusionSql` (work-items.ts) already excludes
 * such a row from self-select while its PLAN is `active` — but that is a coarse,
 * plan-wide floor. It says nothing about the individual plan ITEM's own resolved
 * status: a plan can be inactive (draft/paused) or its `active` floor can already
 * have lapsed while the SPECIFIC item is explicitly `blocked` (or blocked-by an
 * unresolved dependency, or a cycle) — and a claim-then-inspect self-selector then
 * picks up exactly the kind of mid-flight, human-supervised close-out work that
 * causes damage when run early (WI-3667: a Phase-5 close-out claimed mid-outage-
 * diagnosis, before the diagnosis had settled).
 *
 * ─ TERMINAL-lane residue (EI-13337 / EI-13352 / EI-13267 / EI-14693) ──────────
 * The costlier, recurring variant: the linked plan item is already TERMINAL
 * (`done`/`dropped`) yet the work-item is sitting at `state:'todo'` — a stale
 * residue (a completion that never terminalized the WI, a WI reset back to todo
 * after its plan item was already done, or a WI minted after the item completed).
 * `reconcileLinkedWorkItemsForPlanItem` (the reverse mirror, EI-5925/6960) heals
 * this — but ONLY on the plan-item's done TRANSITION; once the item is already
 * done, that reaction never re-fires, so a WI that lands in `todo` afterwards is
 * never reconciled. Nothing then stops the backlog-drain fleet from claiming it,
 * re-verifying "already done, no code needed", and re-closing it by hand — the
 * exact repeated fleet-time cost those four issues each report. This guard closes
 * that gap defensively: a claimed WI whose linked plan item is terminal is treated
 * the same as a blocked one (release + retry, never served), independent of
 * WHATEVER left the WI non-terminal.
 *
 * effectiveStatus resolution (blocked-by graph, cycles, missing refs — see
 * @papercusp/plan-parser's resolveEffectiveStatusForItems) is genuinely a JS-side
 * computation over the plan's JSONB `items` index, not a cheap SQL predicate — so
 * this is a POST-CLAIM guard, not a claimFloorsWhereSql addition: the caller claims
 * atomically as before, then this checks the linked plan item; on a hit the caller
 * releases the row and tries the next one (see getNextForBee's retry loop). The
 * short claim-then-release window is invisible to the outside caller (never
 * returned) and mirrors the existing lease-arbitration-loss retry shape.
 *
 * Fails OPEN (returns null ⇒ not blocked) on any lookup error — a plans read
 * hiccup must never wedge the whole claim path; the coarse plan-wide floor above
 * still applies as a backstop.
 */
import type { WorkItem } from '../work-items';

export interface PlanItemLaneBlock {
  reason: string;
  planSlug: string;
  itemId: string;
  effectiveStatus: string;
}

function extractPlanItemStamp(payload: unknown): { plan_slug: string; item_id: string } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).plan_item;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stamp = raw as Record<string, unknown>;
  const planSlug = typeof stamp.plan_slug === 'string' ? stamp.plan_slug : null;
  const itemId = typeof stamp.item_id === 'string' ? stamp.item_id : null;
  if (!planSlug || !itemId) return null;
  return { plan_slug: planSlug, item_id: itemId };
}

/**
 * Whether a just-claimed work-item's linked plan-item lane is currently
 * blocked / needs-human / already-terminal — the cases self-select must not
 * silently hand out. Returns null when the item carries no plan-item
 * back-pointer, the linked plan/item can't be found, or the lane is clear.
 */
export async function planItemLaneBlockReason(
  workItem: Pick<WorkItem, 'payload' | 'harness'>,
): Promise<PlanItemLaneBlock | null> {
  const stamp = extractPlanItemStamp(workItem.payload);
  if (!stamp) return null;
  try {
    const [{ getPlanRow, planItemsForRow }, { resolveEffectiveStatusForItems }] = await Promise.all([
      import('../agent-tools/plans/source'),
      import('@papercusp/plan-parser'),
    ]);
    const row = await getPlanRow(stamp.plan_slug, { harnessSlug: workItem.harness ?? undefined });
    if (!row) return null;
    const { items } = resolveEffectiveStatusForItems(planItemsForRow(row));
    const item = items.find((i) => i.id === stamp.item_id);
    if (!item) return null;
    // Already-terminal lane (EI-13337/13352/13267/14693): the plan item is done or
    // dropped, so this work-item is stale residue — completed/abandoned work, not
    // open work. Never hand it to a self-selector to re-verify + re-close by hand.
    if (item.effectiveStatus === 'done' || item.effectiveStatus === 'dropped') {
      return {
        reason: `plan-item ${stamp.plan_slug}#${stamp.item_id} is already ${item.effectiveStatus} — its work-item is stale residue of completed/abandoned work, not open work`,
        planSlug: stamp.plan_slug,
        itemId: stamp.item_id,
        effectiveStatus: item.effectiveStatus,
      };
    }
    if (item.effectiveStatus === 'blocked') {
      const blockers = item.unresolvedBlockers.length > 0 ? ` (blocked-by: ${item.unresolvedBlockers.join(', ')})` : '';
      return {
        reason: `plan-item ${stamp.plan_slug}#${stamp.item_id} is effectively blocked${blockers}`,
        planSlug: stamp.plan_slug,
        itemId: stamp.item_id,
        effectiveStatus: item.effectiveStatus,
      };
    }
    if (item.needsHuman) {
      return {
        reason: `plan-item ${stamp.plan_slug}#${stamp.item_id} needs a human decision`,
        planSlug: stamp.plan_slug,
        itemId: stamp.item_id,
        effectiveStatus: item.effectiveStatus,
      };
    }
    return null;
  } catch {
    // Fail OPEN — a plans-read hiccup must never wedge the shared claim path.
    return null;
  }
}
