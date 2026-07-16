/**
 * Inbox tab (EI-13037, owner ask 2026-07-16) — the owner's HUMAN INBOX as a
 * first-class left-sidebar pane, beside Papercup: everything addressed to YOU
 * — coord messages (`coord:send { to: ['human'] }`), escalations, standing
 * approvals, agent questions, operator reports — with the actions to answer
 * them inline. Until now these were reachable only via the URL-only
 * /coord?panel=inbox (read-only, no nav entry) or by knowing the /adv
 * Create→Queue existed; agents saying "check your inbox" pointed at a screen
 * with no clickable path.
 *
 * REUSE, not re-derivation:
 *   - data: useInboxAttention → the SAME `plans.attention` sync feed the
 *     Queue + Overview render (shared cache entry, SSE-invalidated);
 *   - detail: the Queue's own exported OtherDetail — the unified
 *     AskChoiceCard + triage audit + QueueCardActions + Discuss thread —
 *     rendered inline under the selected row, so acting from the sidebar IS
 *     acting in the Queue (same terminal dispatches, same toasts);
 *   - tier semantics: effectiveTier (mirrors AdvOverviewTab's fallback).
 *
 * This pane supersedes /coord?panel=inbox as the human-facing inbox surface
 * (that panel stays as a coord-dashboard debug view).
 *
 * Filter + selection live in the URL (nuqs `?lsi` / `?lsis`) so the pane is
 * deep-linkable and agent-driveable (ui:get_state / ui:dispatch), per the
 * nuqs-by-default policy.
 */
import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryState, parseAsString, parseAsStringLiteral } from 'nuqs';
import { useLexicon } from '@/lib/useLexicon';
import { OtherDetail, KIND_LABEL } from '@/app/admin/plans/PlanOtherList';
import { TIER_LABEL, type AttentionTier } from '@/app/admin/plans/plans-api';
import { effectiveTier, useInboxAttention } from './use-inbox-pending';
// The Queue detail card's styles (pc-items__*, pc-tier/pc-kind badges). Global
// (non-module) CSS, already loaded on /adv + /admin/plans routes; importing it
// here makes the sidebar self-sufficient on every route.
import '@/app/admin/plans/plans.css';

const FILTERS = ['needs', 'alerts', 'all'] as const;
type InboxFilter = (typeof FILTERS)[number];

const FILTER_LABEL: Record<InboxFilter, string> = {
  needs: 'Needs you',
  alerts: 'Alerts',
  all: 'All',
};

/** Decisions first, then alerts — the order the owner should read. */
const TIER_RANK: Record<AttentionTier, number> = { decision: 0, alert: 1, handled: 2, activity: 3 };

export default function InboxTab({ active: _active }: { active: boolean }) {
  const t = useLexicon();
  const { items, loading, error, refresh } = useInboxAttention();
  const [filter, setFilter] = useQueryState(
    'lsi',
    parseAsStringLiteral(FILTERS).withDefault('needs'),
  );
  const [sel, setSel] = useQueryState('lsis', parseAsString);

  const counts = useMemo(() => {
    const c: Record<InboxFilter, number> = { needs: 0, alerts: 0, all: items.length };
    for (const i of items) {
      const tier = effectiveTier(i);
      if (tier === 'decision') c.needs += 1;
      else if (tier === 'alert') c.alerts += 1;
    }
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const filtered = items.filter((i) => {
      const tier = effectiveTier(i);
      if (filter === 'needs') return tier === 'decision';
      if (filter === 'alerts') return tier === 'alert';
      return true;
    });
    // Stable sort: decisions on top, then alerts; ties keep server order.
    return filtered
      .map((item, idx) => ({ item, idx }))
      .sort(
        (a, b) =>
          TIER_RANK[effectiveTier(a.item)] - TIER_RANK[effectiveTier(b.item)] || a.idx - b.idx,
      )
      .map((x) => x.item);
  }, [items, filter]);

  return (
    <div className="pclsb-inbox" data-testid="inbox-tab">
      <div className="pclsb-inbox__chips" aria-label="Inbox filter">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`pclsb-inbox__chip${filter === f ? ' is-active' : ''}`}
            aria-pressed={filter === f}
            data-testid={`inbox-filter-${f}`}
            onClick={() => void setFilter(f)}
          >
            {FILTER_LABEL[f]}
            <span className="pclsb-inbox__chip-count">{counts[f]}</span>
          </button>
        ))}
      </div>

      {error ? <div className="pclsb-inbox__error">Error: {error}</div> : null}
      {loading && items.length === 0 ? <div className="pclsb-panel__empty">Loading…</div> : null}
      {!loading && !error && visible.length === 0 ? (
        <p className="pclsb-inbox__empty" data-testid="inbox-empty">
          {filter === 'needs'
            ? `Inbox zero — nothing needs you. Decisions, escalations and messages the ${t('fleet', { lower: true })} sends you land here.`
            : 'Nothing here right now.'}
        </p>
      ) : null}

      <ul className="pclsb-inbox__list">
        {visible.map((i) => {
          const isSel = i.id === sel;
          const tier = effectiveTier(i);
          const meta = [i.ownerLabel ?? i.ownerAgentId, i.planSlug ?? i.harnessSlug]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={i.id} className={`pclsb-inbox__row${isSel ? ' is-selected' : ''}`}>
              <button
                type="button"
                className="pclsb-inbox__rowbtn"
                data-testid={`inbox-row-${i.id}`}
                aria-expanded={isSel}
                onClick={() => void setSel(isSel ? null : i.id)}
              >
                <span className="pclsb-inbox__rowhead">
                  <span
                    className={`pclsb-inbox__tierdot pclsb-inbox__tierdot--${tier}`}
                    title={TIER_LABEL[tier]}
                    aria-label={TIER_LABEL[tier]}
                  />
                  <span className="pclsb-inbox__kind">{KIND_LABEL[i.kind] ?? i.kind}</span>
                  {meta ? <span className="pclsb-inbox__meta">{meta}</span> : null}
                </span>
                <span className="pclsb-inbox__title">{i.title}</span>
              </button>
              {isSel ? (
                <div className="pclsb-inbox__detail" data-testid="inbox-detail">
                  {/* key remounts the detail per selection so its local card
                      state (answered/discuss/answer) resets — same contract as
                      PlansClient's OtherDetail usage. */}
                  <OtherDetail key={i.id} item={i} onResolved={refresh} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="pclsb-inbox__foot">
        {/* MERGE over the live URL (the `(prev) =>` updater) so the rail's own
            ?lsb/?lst params survive the jump — same convention as SwarmTab. */}
        <Link
          to="/adv"
          search={(prev: Record<string, unknown>) => ({ ...prev, tab: 'plans', view: 'queue' })}
          className="pclsb-inbox__queue-link"
          data-testid="inbox-open-queue"
        >
          Open full queue →
        </Link>
      </div>
    </div>
  );
}
