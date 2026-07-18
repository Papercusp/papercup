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
