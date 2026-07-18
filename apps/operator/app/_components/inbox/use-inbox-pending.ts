/**
 * useInboxAttention / useInboxPendingCount — the Inbox pane's data feed
 * (EI-13037, owner ask 2026-07-16: a first-class human inbox in the GUI;
 * moved into the op-chat sidebar per the owner's placement correction —
 * the far-left sidebar is the "live running stuff" surface).
 *
 * REUSE, not re-derivation: this is the SAME `plans.attention` sync feed the
 * /adv Create→Queue renders (usePlanAttention — normalized groups, SSE-
 * invalidated), flattened to items. `effectiveTier` mirrors AdvOverviewTab's
 * selectDecisions/countAlerts wire-lag fallback (Brief 21: rows from a
 * pre-tier server arrive without `tier`) — kept in ONE place that the header
 * badge AND the pane's filter both read, so the badge can never disagree with
 * the pane's "Needs you" list.
 *
 * The badge is a LIVE COUNT of decision-tier items, not an unread-since-last-
 * seen marker: attention items are stateful (they leave the feed when
 * resolved/acked/answered), so the correct badge is derived directly from the
 * live feed — no last-seen bookkeeping to drift (owner design principle
 * 2026-07-11: make the primary value right the first time instead of layering
 * a reconciliation pass on a value that can go stale).
 */
import { useMemo } from 'react';
import {
  usePlanAttention,
  type AttentionItem,
  type AttentionTier,
} from '@/app/admin/plans/plans-api';

/** Canonical tier read with the Brief 21 wire-lag fallback (mirrors
 *  AdvOverviewTab's selectDecisions/countAlerts — keep the three in sync). */
export function effectiveTier(i: AttentionItem): AttentionTier {
  if (i.tier) return i.tier;
  if (i.needsHuman) return 'decision';
  if (i.kind === 'smoke-fail' || i.kind === 'coord-escalation') return 'alert';
  return 'activity';
}

export interface InboxAttention {
  items: AttentionItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** The flattened attention feed (every kind, every tier). One shared sync
 *  cache entry with the Queue/Overview — mounting this adds no new query. */
export function useInboxAttention(enabled = true): InboxAttention {
  const q = usePlanAttention({ enabled });
  const groups = q.data?.groups;
  const items = useMemo(() => {
    // Dedupe by id: a non-plan-scoped attention item (owner-wall, loop-carry-
    // note, an alert that isn't tied to one plan) appears in MULTIPLE plan
    // groups, so a bare `groups.flatMap(g => g.items)` emits it once per group
    // → the inbox renders the same row 2-5x with duplicate React keys, and the
    // chip "Needs you"/"All" counts disagree with the visible list (WI-5337).
    // Keep first occurrence; every consumer (badge, filter, plans-needing-you)
    // reads this, so deduping here fixes all of them at once.
    const seen = new Set<string>();
    const out: AttentionItem[] = [];
    for (const g of groups ?? []) {
      for (const it of g.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
    }
    return out;
  }, [groups]);
  return { items, loading: q.loading, error: q.error, refresh: q.refresh };
}

/** Live count of decision-tier ("needs you") items — drives the header badge. */
export function useInboxPendingCount(): number {
  const { items } = useInboxAttention();
  return useMemo(() => items.filter((i) => effectiveTier(i) === 'decision').length, [items]);
}

/** Live count of distinct PLANS with ≥1 decision-tier ("needs you") item —
 *  drives the Plans-face badge (owner-plans-single-pane-2026-07-17 P-001). This
 *  differs from useInboxPendingCount (which counts ITEMS): the Plans tab answers
 *  "how many plans need me", not "how many decisions are open". Same shared
 *  `plans.attention` cache entry, so mounting it adds no new query. */
export function usePlansNeedingYouCount(): number {
  const { items } = useInboxAttention();
  return useMemo(() => {
    const plans = new Set<string>();
    for (const i of items) {
      if (i.planSlug && effectiveTier(i) === 'decision') plans.add(i.planSlug);
    }
    return plans.size;
  }, [items]);
}
