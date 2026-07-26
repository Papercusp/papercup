/**
 * curator-card-drill-in — map a curator/report card's opaque row `ref` onto the
 * inbox selection it should open (deterministic-status-cards-2026-07-17
 * P-003/D-004; drill-in resolver rework WI-5342). Pure + unit-testable; the
 * chat (OperatorChatSidebar.handleCardDrillIn) opens the inbox pane
 * (`?opcv=inbox`), switches the filter (`?opci`), and sets the selection
 * (`?opcis=<id>`) from this.
 *
 * The curator's refs (fleet-signals.ts) and the inbox item ids (attention
 * adapters) are DIFFERENT identifier spaces:
 *   - `escalation:<msgId>`        → inbox id `coord-escalation:<msgId>`
 *   - `wi:<ref>`                  → item whose `itemRef` is `<ref>`
 *   - `plan:<slug>`              → first item on that plan
 *   - `decision:<id>` / bare id  → item whose id is `<id>`
 *   - `health:<panelId>`         → no inbox item (opens the pane only)
 *
 * WI-5342: the old pure `drillInRefToInbox` hard-coded ONLY the escalation
 * translation and returned null for every other ref, so clicking "Open ↗" on
 * any non-escalation card opened the inbox pane with NOTHING selected (and left
 * the filter on 'needs', which could also hide the item). Rather than enumerate
 * every ref→id mapping (which rots as kinds are added), we match the ref
 * against the LIVE items on their OWN identifiers — so any ref that corresponds
 * to a present inbox item selects it, current and future kinds alike.
 *
 * chat-ref-pills-2026-07-26 P-002: {@link resolveWorkingTabDrillIn} EXTENDS
 * this same matching (do not fork a second resolver) for a SECOND
 * destination — a chat WorkRefPill (P-003) pointing at the "Working tab"'s
 * `DetailPanel` (`apps/operator/app/adv/harnesses/DetailPanel.tsx`,
 * `?sel=<id>`) instead of the inbox pane. It calls {@link resolveInboxDrillIn}
 * for the actual id match (the bare-id branch already resolves a plain
 * "WI-5927"-shaped ref) and translates the result onto the Working tab's own
 * nuqs param + dock panel type — no independent matching logic.
 */
import type { AttentionItem } from '@/app/admin/plans/plans-api';

const ESCALATION_PREFIX = 'escalation:';

/** The minimal item shape the resolver reads (a subset of AttentionItem). */
export type DrillInItem = Pick<AttentionItem, 'id' | 'itemRef' | 'planSlug'>;

export interface InboxDrillTarget {
  /** The `?opcis` selection id, or null when no inbox item matches the ref. */
  selId: string | null;
  /** The `?opci` filter to switch to so the selected row is VISIBLE ('all'),
   *  or null to leave the current filter (no selection was made). The inbox
   *  defaults to the 'needs' filter, which hides alert/activity-tier items —
   *  so a selection MUST force 'all' or the row lands on nothing. */
  filter: 'all' | null;
}

/**
 * Resolve a curator card `ref` onto the inbox selection it should open, given
 * the live attention items. Pure — `items` is passed in for testability.
 */
export function resolveInboxDrillIn(
  ref: string,
  items: readonly DrillInItem[],
): InboxDrillTarget {
  const r = ref.trim();
  if (!r) return { selId: null, filter: null };

  // The bare underlying id after a known `kind:` prefix (escalation:, wi:,
  // decision:, plan:, health:, …), or the whole ref when it carries no prefix.
  const colon = r.indexOf(':');
  const bare = colon >= 0 ? r.slice(colon + 1) : r;

  // Escalation fast-path: `escalation:<msgId>` → adapter id
  // `coord-escalation:<msgId>` (adapters.ts `coordEscalationToAttention`).
  const escalationId =
    r.startsWith(ESCALATION_PREFIX) && bare ? `coord-escalation:${bare}` : null;

  // Match on the item's OWN identifiers — conservative (no loose suffix
  // matching), so a hit is always the right item.
  const match = items.find(
    (i) =>
      i.id === r ||
      i.id === bare ||
      i.id === escalationId ||
      (i.itemRef != null && (i.itemRef === r || i.itemRef === bare)) ||
      (i.planSlug != null && r === `plan:${i.planSlug}`),
  );
  if (match) return { selId: match.id, filter: 'all' };

  // Escalation ref with no live match in the current snapshot: still target the
  // constructed id (the item is expected present; selecting a missing id is a
  // harmless no-op the pane tolerates).
  if (escalationId) return { selId: escalationId, filter: 'all' };

  // No inbox item corresponds to this ref (e.g. `health:<panelId>`) — open the
  // pane without a selection, leaving the current filter.
  return { selId: null, filter: null };
}

/**
 * @deprecated Use {@link resolveInboxDrillIn}, which matches against the live
 * items. Retained as the escalation-only string translation for any caller
 * that cannot supply the item list.
 */
export function drillInRefToInbox(ref: string): string | null {
  const r = ref.trim();
  if (r.startsWith(ESCALATION_PREFIX)) {
    const msgId = r.slice(ESCALATION_PREFIX.length);
    return msgId ? `coord-escalation:${msgId}` : null;
  }
  return null;
}

/** The registered dock panel type (HarnessesDock's `panelRegistry`) that
 *  hosts the Working tab's work-item detail pane. */
const WORKING_TAB_PANEL_TYPE = 'adv:work-items';

/** The minimal item shape {@link resolveWorkingTabDrillIn} needs — a plain
 *  work-item id, same vocabulary parse-work-refs.ts's `WorkRefMatch.id`
 *  reports for `kind: 'work-item'` (e.g. "WI-5927", "EI-42", "F-100"). */
export type WorkingTabDrillItem = { id: string };

export interface WorkingTabDrillTarget {
  /** The `?sel=` value DetailPanel's swap view reads, or null when `ref`
   *  names no live item — the caller should render a plain (non-navigating)
   *  pill rather than write a dead selection (mirrors P-006's "no plan
   *  context → plain text" stance one layer up). */
  sel: string | null;
  /** The registered dock panel type to focus/open (via
   *  `requestDockPanelOpen`, `apps/operator/app/adv/harnesses/open-dock-panel.ts`)
   *  so the detail pane is actually visible before `sel` takes effect — null
   *  alongside a null `sel` (nothing to navigate to). */
  panelType: typeof WORKING_TAB_PANEL_TYPE | null;
}

/**
 * Resolve a WI-/EI-/F- work-item ref (as chat's `parseWorkRefs`, P-001,
 * reports them — a bare id, no `kind:` prefix) onto the Working tab's
 * DetailPanel selection. Pure — `items` passed in for testability, same
 * pattern as {@link resolveInboxDrillIn}.
 *
 * Reuses {@link resolveInboxDrillIn}'s existing bare-id match branch (`ref`
 * with no `kind:` prefix already matches an item's own `id`) rather than
 * re-implementing ref matching — this function only translates that same
 * match onto the Working tab's `sel`/panel-type shape instead of the inbox
 * pane's `selId`/`filter` shape. P-NNN plan-item refs are out of scope here
 * (P-006 handles plan-slug-scoped resolution separately); pass only
 * `work-item`-kind refs.
 */
export function resolveWorkingTabDrillIn(
  ref: string,
  items: readonly WorkingTabDrillItem[],
): WorkingTabDrillTarget {
  const { selId } = resolveInboxDrillIn(
    ref,
    items.map((i): DrillInItem => ({ id: i.id, itemRef: null, planSlug: null })),
  );
  return { sel: selId, panelType: selId ? WORKING_TAB_PANEL_TYPE : null };
}

/** The minimal plan-item shape {@link resolvePlanItemDrillIn} needs — a
 *  plan-item id plus the plan it belongs to. P-NNN is unique only WITHIN a
 *  plan (every plan has its own P-006), never globally, so a bare id alone
 *  is never enough to identify one (chat-ref-pills-2026-07-26 "Known
 *  ambiguity"). */
export type PlanItemDrillItem = { id: string; planSlug: string };

export interface PlanItemDrillTarget {
  /** The admin/plans surface's own selection key — the SAME
   *  `"<planSlug>::<itemId>"` shape `PlanItemsList.tsx`'s `?item=` param
   *  already uses (reused verbatim rather than inventing a second encoding),
   *  or null when the ref can't be safely resolved: no message plan-slug
   *  context, or no live item matches within THAT specific plan. A pill
   *  with a null `sel` must render as plain text — pointing at the wrong
   *  plan's same-numbered item is worse than no pill at all. */
  sel: string | null;
}

/**
 * Resolve a bare P-NNN plan-item ref (as chat's `parseWorkRefs`, P-001,
 * reports it for `kind: 'plan-item'` — no `kind:` prefix) against the CHAT
 * MESSAGE'S OWN `plan_slug` context (chat-ref-pills-2026-07-26 P-006).
 *
 * P-NNN is unique only within a single plan, so resolving it against the
 * wrong plan (or guessing when no plan context is known at all) risks
 * linking to a DIFFERENT plan's same-numbered item — strictly worse than
 * rendering plain, non-navigating text. This function therefore requires
 * BOTH a non-empty `messagePlanSlug` AND a live item matching `ref` within
 * that exact plan before returning a `sel`; either miss returns
 * `{ sel: null }` so the caller (P-004's wiring) falls back to plain text,
 * mirroring {@link resolveWorkingTabDrillIn}'s "no match → null" contract.
 *
 * Pure — `items` passed in for testability, same pattern as
 * {@link resolveInboxDrillIn} / {@link resolveWorkingTabDrillIn}.
 */
export function resolvePlanItemDrillIn(
  ref: string,
  messagePlanSlug: string | null | undefined,
  items: readonly PlanItemDrillItem[],
): PlanItemDrillTarget {
  const r = ref.trim();
  if (!r || !messagePlanSlug) return { sel: null };
  const match = items.find((i) => i.planSlug === messagePlanSlug && i.id === r);
  return { sel: match ? `${messagePlanSlug}::${match.id}` : null };
}
