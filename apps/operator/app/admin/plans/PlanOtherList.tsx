'use client';

/**
 * PlanOtherList — the "Other" attention surfaces in the Planning tab
 * (planning-attention-importance-2026-05-31, P-013 Other filter + P-015
 * detail pane).
 *
 * Renders the non-plan-item AttentionItem kinds from plans:attention —
 * coord escalations, coord messages-to-human, smoke-test failures, plans
 * awaiting review — grouped (per the reader's plan / "Alerts" buckets),
 * importance-sorted, master-detail like PlanItemsList: pick a row, its
 * message + per-kind action buttons show in the right pane.
 *
 * Action dispatch (Resolve via coord:resolve, Ack, View-log, Open) is
 * P-017; the buttons render here and report which action they'll carry
 * out until that lands.
 */

import { useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import PlanChatModal from './PlanChatModal';
import type { AttentionGroup, AttentionItem, AttentionKind } from './plans-api';

const KIND_LABEL: Record<AttentionKind, string> = {
  'plan-item': 'item',
  'coord-escalation': 'escalation',
  'coord-message': 'message',
  'smoke-fail': 'smoke',
  'plan-review': 'review',
};

interface Props {
  groups: AttentionGroup[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  title: string;
  subtitle: string;
  /** When non-empty, show only these kinds (the active per-kind facets). */
  kinds?: AttentionKind[];
  /** When non-empty, the rail's plan selection — narrows the Other list to
   *  attention items belonging to these plans, so the left sidebar acts as a
   *  filter here too (harness-level alerts with no plan are dropped). */
  planFilters?: string[];
}

/** Keep only the non-plan-item kinds (optionally narrowed to `allow`), and —
 *  when a plan filter is active — only items belonging to those plans; drop
 *  groups left empty. */
function otherOnly(
  groups: AttentionGroup[],
  allowKinds: AttentionKind[],
  allowPlans: string[],
): AttentionGroup[] {
  const allow = allowKinds.length ? new Set(allowKinds) : null;
  const plans = allowPlans.length ? new Set(allowPlans) : null;
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          i.kind !== 'plan-item' &&
          (!allow || allow.has(i.kind)) &&
          (!plans || (i.planSlug != null && plans.has(i.planSlug))),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

export default function PlanOtherList({ groups, loading, error, refresh, kinds, planFilters }: Props) {
  const [selected, setSelected] = useQueryState('other', parseAsString);

  const planList = planFilters ?? [];
  const otherGroups = otherOnly(groups, kinds ?? [], planList);
  const allItems = otherGroups.flatMap((g) => g.items);
  const selItem = allItems.find((i) => i.id === selected) ?? null;

  if (loading) {
    return (
      <div className="pc-items pc-items--mixed">
        <p className="pc-plans__placeholder">Loading…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="pc-items pc-items--mixed">
        <div className="pc-plans__placeholder pc-plans__placeholder--error">
          <p>Failed to load attention items:</p>
          <code>{error}</code>
          <button type="button" className="pc-plans__retry" onClick={refresh}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!allItems.length) {
    return (
      <div className="pc-items pc-items--mixed">
        <div className="pc-items__empty">
          {planList.length
            ? 'No alerts for the selected plan(s).'
            : 'Nothing else needs attention right now.'}
        </div>
      </div>
    );
  }

  return (
    <div className="pc-items pc-items--mixed">
      <div className="pc-items__layout">
        <div className="pc-items__listpane">
          <ul className="pc-items__groups" role="list">
            {otherGroups.map((g) => (
              <li key={g.key} className="pc-items__group">
                <div className="pc-items__plan-head pc-items__plan-head--static">
                  <span className="pc-items__plan-copy">
                    <span className="pc-items__plan-name">{g.title}</span>
                    {g.harnessSlug ? (
                      <span className="pc-items__plan-meta">
                        <span className="pc-pill pc-pill--harness">{g.harnessSlug}</span>
                      </span>
                    ) : null}
                  </span>
                  <span className="pc-items__plan-count">{g.items.length}</span>
                </div>
                <ul className="pc-items__rows" role="list">
                  {g.items.map((it) => {
                    const isSel = selected === it.id;
                    return (
                      <li key={it.id} className={`pc-items__row-wrap${isSel ? ' is-selected' : ''}`}>
                        <button
                          type="button"
                          className="pc-items__row"
                          aria-current={isSel ? 'true' : undefined}
                          title={it.title}
                          onClick={() => void setSelected(it.id)}
                        >
                          {/* Free-form text first (leftmost); kind + importance
                              pills follow on the right. */}
                          <span className="pc-items__text">{it.title}</span>
                          <span className="pc-items__rowmeta">
                            <span className={`pc-kind pc-kind--${it.kind}`}>{KIND_LABEL[it.kind]}</span>
                            {it.importance !== 'normal' ? (
                              <span className={`pc-imp pc-imp--${it.importance}`}>{it.importance}</span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>

        <OtherDetail item={selItem} />
      </div>
    </div>
  );
}

function OtherDetail({ item }: { item: AttentionItem | null }) {
  const [chatOpen, setChatOpen] = useState(false);

  if (!item) {
    return (
      <aside className="pc-items__detail">
        <div className="pc-items__detail-empty">Select an item to see its detail and actions.</div>
      </aside>
    );
  }

  const kindLabel = KIND_LABEL[item.kind];

  return (
    <aside className="pc-items__detail">
      <PlanChatModal
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        harnessSlug={item.harnessSlug}
        label={item.planSlug ? `${item.planSlug} · ${kindLabel}` : `${item.harnessSlug ?? 'harness'} · ${kindLabel}`}
      />
      {/* Actions live on the top header bar (matching PlanItemPreview), not
          inside the card body. */}
      <div className="pc-items__detail-toolbar">
        <span className={`pc-kind pc-kind--${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        <span className={`pc-count pc-count--${item.status}`}>{item.status}</span>
        {item.importance !== 'normal' ? (
          <span className={`pc-imp pc-imp--${item.importance}`}>{item.importance}</span>
        ) : null}
        <div className="pc-items__detail-actions">
          {item.actions.map((a) =>
            a.id === 'chat' ? (
              <button
                key={a.id}
                type="button"
                className="pc-items__action-btn pc-items__action-btn--chat"
                onClick={() => setChatOpen(true)}
                title={`Open an in-app, context-scoped agent chat about this ${kindLabel}`}
              >
                {`💬 ${a.label}`}
              </button>
            ) : (
              <button
                key={a.id}
                type="button"
                className={a.primary ? 'pc-items__resolve' : 'pc-items__action-btn'}
                onClick={() =>
                  toast.info(`"${a.label}" — ${KIND_LABEL[item.kind]} action wiring lands in P-017.`)
                }
                title={`${a.label} — coord wiring (coord:resolve / coord:ack / open) is deferred to P-017`}
              >
                {a.label}
              </button>
            ),
          )}
        </div>
      </div>
      <div className="pc-items__detail-body">
        <h3>{item.title}</h3>
        {item.harnessSlug ? <span className="pc-pill pc-pill--harness">{item.harnessSlug}</span> : null}
        {item.body ? <p>{item.body}</p> : null}
      </div>
    </aside>
  );
}

