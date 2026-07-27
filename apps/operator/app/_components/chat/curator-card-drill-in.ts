/**
 * curator-card-drill-in — map a curator/report card's opaque row `ref` onto the
 * attention item it should select (deterministic-status-cards-2026-07-17
 * P-003/D-004; drill-in resolver rework WI-5342). Pure + unit-testable — this
 * is the RESOLUTION half only (ref -> which live item, `selId`), unchanged by
 * WHERE the caller opens it.
 *
 * hud-consolidation-2026-07-26 P-003/P-004: the Inbox pane this used to open
 * (`?opcv=inbox` + `?opci` filter + `?opcis=<id>` selection) is retired
 * (`_retired/inbox-pane/`). The chat (OperatorChatSidebar.handleCardDrillIn)
 * now looks up the matched item's `ownerAgentId` and navigates to the HUD tab
 * instead — `/adv?tab=hud&hudsession=<ownerAgentId>` when one exists, or just
 * `/adv?tab=hud` for an ownerless ask (it still renders there, in the HUD's
 * unattributed lane — hud-consolidation P-002) or a ref with no live match.
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
 * chat-ref-pills-2026-07-26 P-002 originally extended this same matching
 * with a SECOND destination — a chat WorkRefPill (P-003) pointing at the
 * "Working tab"'s `DetailPanel` (`apps/operator/app/adv/harnesses/
 * DetailPanel.tsx`, `?sel=<id>`) instead of the inbox pane. D-001 (owner
 * re-spec, 2026-07-26) superseded that DESTINATION: a pill click now opens a
 * POPUP (`WorkItemPopupModal`, P-008) instead of navigating tabs. P-009
 * retired that Working-tab resolver (`resolveWorkingTabDrillIn`) as dead —
 * the RESOLUTION half (ref -> which live item) still runs through this same
 * `resolveInboxDrillIn`, unchanged; only the since-removed translation onto
 * the Working tab's nuqs param + dock panel type is gone. The current
 * work-item-ref activation path is the D-002 seam: `ChatConversation.tsx`
 * (P-004) exposes a plain `onWorkRefActivate` passthrough hook with no
 * destination logic of its own, and `WorkItemPopupModal` (P-008) wires the
 * popup into that hook.
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

/* ── ref → destination (hud-open-destinations-and-true-counts-2026-07-27 P-001) ──
 *
 * `resolveInboxDrillIn` above answers "WHICH live attention item is this ref",
 * which was sufficient while every drill-in had exactly one destination (the
 * Inbox pane). That pane is retired, and its replacement (P-004: navigate to the
 * HUD tab, selecting the matched item's owning agent) covers only ONE of the
 * things a curator report row can name.
 *
 * The gap the owner hit (2026-07-27, "clicking open on one of the papercup
 * reports is supposed to open something relevant but it isn't"): a row naming a
 * WORK ITEM or a PLAN resolves to no `ownerAgentId`, so the handler pushed
 * `/adv?tab=hud` with nothing selected — and fired from the chat sidebar, which
 * is already on `/adv`, that is a visible no-op.
 *
 * The rule here is: OPEN THE MOST SPECIFIC THING THE REF NAMES.
 *   1. a work item (explicit `wi:` prefix, a bare WI-/EI-/F- id, or the matched
 *      item's own `itemRef`)  → the work item
 *   2. a plan (`plan:<slug>`, or the matched item's `planSlug`) → the plan
 *   3. otherwise, an ask from a live agent → that agent's conversation
 *   4. nothing resolvable (e.g. `health:<panelId>`) → 'none', so the CALLER can
 *      say so instead of navigating somewhere useless
 *
 * The one deliberate exception is `escalation:<msgId>`: an escalation names a
 * MESSAGE, and the actionable target of a message is the agent that sent it —
 * answering them IS the response. So an escalation with a resolvable owning
 * agent goes to the conversation first, falling back to the chain above.
 *
 * Pure — `items` is passed in, same contract as the resolvers above.
 */

/** The live-item shape {@link resolveRefDestination} reads: what
 *  {@link resolveInboxDrillIn} needs, plus the owning agent the HUD
 *  conversation destination is keyed by. */
export type RefDestinationItem = DrillInItem & { ownerAgentId?: string | null };

export type RefDestination =
  /** Open `id` in WorkItemPopupModal. */
  | { kind: 'work-item'; id: string }
  /** Open `slug` in PlanPopupModal. */
  | { kind: 'plan'; slug: string }
  /** Open this agent's conversation (the HUD `?hudsession=` destination). */
  | { kind: 'session'; ownerAgentId: string }
  /** Nothing this ref names can be opened — the caller must SAY so rather than
   *  navigate somewhere that looks like a no-op. */
  | { kind: 'none' };

/** WI-/EI-/F- ids, anchored (a whole ref token, not a scan over prose — that is
 *  `parseWorkRefs`'s job). Case-insensitive so a `wi:wi-42` ref still resolves;
 *  the id is normalized to uppercase, matching `parseWorkRefs`. */
const WORK_ITEM_ID = /^(WI|EI|F)-(\d+)$/i;

function asWorkItemId(token: string): string | null {
  const m = WORK_ITEM_ID.exec(token.trim());
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

export function resolveRefDestination(
  ref: string,
  items: readonly RefDestinationItem[],
): RefDestination {
  const r = ref.trim();
  if (!r) return { kind: 'none' };

  const colon = r.indexOf(':');
  const prefix = colon >= 0 ? r.slice(0, colon) : '';
  const bare = colon >= 0 ? r.slice(colon + 1) : r;

  // 1. Explicit kind prefixes from the curator's own ref vocabulary
  //    (fleet-signals.ts) — these are unambiguous, so they win outright.
  if (prefix === 'wi' && bare) {
    return { kind: 'work-item', id: asWorkItemId(bare) ?? bare };
  }
  if (prefix === 'plan' && bare) return { kind: 'plan', slug: bare };

  // 2. A bare work-item id carrying no prefix at all.
  const bareId = colon < 0 ? asWorkItemId(r) : null;
  if (bareId) return { kind: 'work-item', id: bareId };

  // 3. Resolve against the live items, reusing the SAME matcher the inbox
  //    destination uses — so the two can never disagree about which item a ref
  //    denotes, only about where to open it.
  const { selId } = resolveInboxDrillIn(r, items);
  const match = selId ? items.find((i) => i.id === selId) ?? null : null;

  // The escalation exception: answering the agent IS the action.
  if (prefix === 'escalation' && match?.ownerAgentId) {
    return { kind: 'session', ownerAgentId: match.ownerAgentId };
  }

  if (match) {
    const viaItemRef = match.itemRef ? asWorkItemId(match.itemRef) : null;
    if (viaItemRef) return { kind: 'work-item', id: viaItemRef };
    if (match.planSlug) return { kind: 'plan', slug: match.planSlug };
    if (match.ownerAgentId) return { kind: 'session', ownerAgentId: match.ownerAgentId };
  }

  return { kind: 'none' };
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
 * mirroring {@link resolveInboxDrillIn}'s "no match → null" contract.
 *
 * Pure — `items` passed in for testability, same pattern as
 * {@link resolveInboxDrillIn}.
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
