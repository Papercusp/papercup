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
import { useSyncQuery } from '@papercusp/sync';
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

/**
 * Recency window (days) beyond which a stale ACTIVITY-tier inbox item (a
 * lifecycle/broadcast FYI, an ungraded rollup) is dropped from the human Inbox.
 * Decisions and Alerts are current-state and never expire on age.
 */
export const INBOX_STALE_DAYS = 14;

/**
 * The Inbox "truly currently active" scope predicate
 * (inbox-pane-active-scope-dates-filters-2026-07-19 P-101). The shared
 * `plans.attention` feed is the WHOLE attention firehose (~15 sources incl. every
 * non-terminal plan item across every plan) — correct for the /adv Queue, wrong
 * for a HUMAN inbox, where it renders hundreds of backlog rows that are not
 * awaiting the owner. This narrows the feed to what genuinely belongs in an inbox:
 *   - DROP the plan-item execution backlog (todo/wip/blocked plan items) — those
 *     belong in the Queue/Working tab. A needs-human plan DECISION always stays.
 *   - KEEP every Decision and Alert (owner-addressed asks + current-state signals
 *     like blocked/needs-human work-items, escalations, smoke-fails) regardless of
 *     age — a decision doesn't expire, and blocked-work drill-ins depend on it.
 *   - RECENCY-BOUND only the Activity tier (auto/lifecycle broadcasts, old FYIs,
 *     the scout-grade rollup): drop it once older than INBOX_STALE_DAYS. An item
 *     with no `occurredAt` is kept (staleness can't be proven).
 */
export function isInboxActive(i: AttentionItem, now: number = Date.now()): boolean {
  const tier = effectiveTier(i);
  // Plan-item execution backlog → the Queue, not the Inbox (a needs-human
  // plan-item is tier 'decision' and is kept by the next clause).
  if (i.kind === 'plan-item' && tier !== 'decision') return false;
  // Decisions + Alerts are current-state — always kept.
  if (tier !== 'activity') return true;
  // Activity tier: recency-bound the append-heavy broadcast/FYI stream.
  const at = i.occurredAt ? new Date(i.occurredAt).getTime() : null;
  if (at != null && Number.isFinite(at) && (now - at) / 86_400_000 > INBOX_STALE_DAYS) {
    return false;
  }
  return true;
}

/** Apply {@link isInboxActive} to a feed — the Inbox pane's scoped item set. */
export function scopeInboxItems(
  items: readonly AttentionItem[],
  now: number = Date.now(),
): AttentionItem[] {
  return items.filter((i) => isInboxActive(i, now));
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

/**
 * The badge aggregate — `plans.attentionCounts` (WI-5955).
 *
 * Both badges below are mounted on EVERY app start, and both used to derive
 * their integer by pulling the whole unscoped `plans.attention` feed (~1MB
 * after the P-003 projection) into the client. They now read a ~100-byte
 * aggregate instead; the feed itself is fetched only by surfaces that actually
 * render items (InboxPane, SessionChatModal, the Overview tiles).
 *
 * The counts are derived SERVER-side from the same grouped feed, with the same
 * dedupe-by-id and the same `effectiveTier` fallback used here — see
 * packages/operator-core/lib/sync-resolver/attention-counts.ts, and
 * attention-counts-parity.test.ts which pins the two derivations together so
 * the badge can never disagree with the list the user then opens.
 */
interface AttentionCountsRow {
  decisionItems: number;
  decisionPlans: number;
  alerts: number;
  total: number;
}

/** Stable identity — a fresh {} each render would churn the sync query key. */
const NO_ARGS: Record<string, unknown> = {};

function useAttentionCounts(): AttentionCountsRow {
  const q = useSyncQuery<AttentionCountsRow>({ queryName: 'plans.attentionCounts', args: NO_ARGS });
  const row = q.data?.[0];
  return {
    decisionItems: row?.decisionItems ?? 0,
    decisionPlans: row?.decisionPlans ?? 0,
    alerts: row?.alerts ?? 0,
    total: row?.total ?? 0,
  };
}

/** Live count of decision-tier ("needs you") items — drives the header badge. */
export function useInboxPendingCount(): number {
  return useAttentionCounts().decisionItems;
}

/** Live count of distinct PLANS with ≥1 decision-tier ("needs you") item —
 *  drives the Plans-face badge (owner-plans-single-pane-2026-07-17 P-001). This
 *  differs from useInboxPendingCount (which counts ITEMS): the Plans tab answers
 *  "how many plans need me", not "how many decisions are open". Shares the one
 *  counts query, so mounting both adds no second request. */
export function usePlansNeedingYouCount(): number {
  return useAttentionCounts().decisionPlans;
}
