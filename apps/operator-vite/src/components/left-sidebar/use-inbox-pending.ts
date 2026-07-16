/**
 * useInboxAttention / useInboxPendingCount — the left-sidebar Inbox tab's data
 * feed (EI-13037, owner ask 2026-07-16: a first-class human inbox in the GUI).
 *
 * REUSE, not re-derivation: this is the SAME `plans.attention` sync feed the
 * /adv Create→Queue renders (usePlanAttention — normalized groups, SSE-
 * invalidated), flattened to items. `effectiveTier` mirrors AdvOverviewTab's
 * selectDecisions/countAlerts wire-lag fallback (Brief 21: rows from a
 * pre-tier server arrive without `tier`) — kept in ONE place that the rail
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
  const items = useMemo(() => (groups ?? []).flatMap((g) => g.items), [groups]);
  return { items, loading: q.loading, error: q.error, refresh: q.refresh };
}

/** Live count of decision-tier ("needs you") items — drives the rail badge. */
export function useInboxPendingCount(): number {
  const { items } = useInboxAttention();
  return useMemo(() => items.filter((i) => effectiveTier(i) === 'decision').length, [items]);
}
