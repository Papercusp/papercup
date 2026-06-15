'use client';

/**
 * create:queue dock panel — the cross-plan item Queue.
 *
 * Parity with PlansClient's "Queue" view (queue-authorization-redesign-2026-06-14):
 *   - A1 (P-004/P-005): the "Other" attention list groups by AUTHORIZER —
 *     "Needs your call" / "Automatable — for now" / "Alerts" — with a per-card
 *     why-line + category badge, behind the QUEUE_AUTHORIZATION_VIEW flag
 *     (PlanOtherList renders all of this when `groupByAuthorizer` is set; the
 *     `?qcat` category facet lives inside it too).
 *   - B1 (P-006): a Pending | Queen's-log segmented control + the two-halves
 *     QueueSummary strip, reusing the shared <DecisionLog/> for the log.
 *
 * The redesign originally landed in PlansClient only; this panel is the surface
 * the /adv Create tab actually renders, so it carries the same wiring. Data and
 * selection (?item / ?other) come from the shared hooks / list components.
 */

import { parseAsStringEnum, useQueryState } from 'nuqs';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import PlanItemsList from '@/app/admin/plans/PlanItemsList';
import PlanOtherList from '@/app/admin/plans/PlanOtherList';
import QueueSummary from '@/app/admin/plans/QueueSummary';
import { QUEUE_TABS, QUEEN_LOG_LAYERS } from '@/app/admin/plans/queue-authorizer';
import DecisionLog from '@/app/_components/DecisionLog';
import {
  useCreateScope,
  usePlanListMaps,
  useQueueData,
  useItemStatusFilter,
  usePlanBucketFilter,
  useItemPlanFilter,
  ITEM_FILTERS,
  ITEM_FILTER_LABEL,
} from './use-create-data';

export default function QueuePanel(_props?: Partial<PanelComponentProps>) {
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [istatus, setIstatus] = useItemStatusFilter();
  const [pBuckets] = usePlanBucketFilter();
  const [itemPlans] = useItemPlanFilter();

  // A1 authorizer-split + B1 tabs are flag-gated (default-ON). OFF = the legacy
  // plan/harness grouping and no Queen's-log tab.
  const queueAuthzView = useFlag(FLAGS.QUEUE_AUTHORIZATION_VIEW);
  const [queueTab, setQueueTab] = useQueryState(
    'queueTab',
    parseAsStringEnum<'pending' | 'queen-log'>(['pending', 'queen-log']).withDefault('pending'),
  );
  const [qlLayer, setQlLayer] = useQueryState(
    'qlLayer',
    parseAsStringEnum<'disposition' | 'action'>(['disposition', 'action']).withDefault('disposition'),
  );

  const queue = useQueueData({
    istatus,
    pBuckets,
    planBucketBySlug: maps.planBucketBySlug,
    scope,
  });

  const toggleItemStatus = (id: (typeof ITEM_FILTERS)[number]['id']) =>
    void setIstatus(istatus.includes(id) ? istatus.filter((x) => x !== id) : [...istatus, id]);

  const itemTitle = istatus.length
    ? istatus.map((s) => ITEM_FILTER_LABEL[s]).join(' · ')
    : 'All items';

  const showQueenLog = queueAuthzView && queueTab === 'queen-log';

  return (
    <div className="pc-queue__list" style={{ height: '100%', overflow: 'auto' }}>
      {/* B1 (P-006): two-halves summary + Pending|Queen's-log tabs (flag-gated). */}
      {queueAuthzView ? (
        <>
          <QueueSummary waitingOnYou={queue.tierCounts.decision} />
          <nav className="pc-queue__tabs" aria-label="Queue tab">
            {QUEUE_TABS.map((tb) => (
              <button
                key={tb.id}
                type="button"
                className={`pc-queue__tab${queueTab === tb.id ? ' is-active' : ''}`}
                aria-pressed={queueTab === tb.id}
                onClick={() => void setQueueTab(tb.id)}
                title={tb.hint}
              >
                {tb.label}
              </button>
            ))}
          </nav>
        </>
      ) : null}

      {showQueenLog ? (
        <section className="pc-queue__queenlog" aria-label="Queen's decision log">
          <nav className="pc-queue__tabs pc-queue__layer-toggle" aria-label="Decision log layer">
            {QUEEN_LOG_LAYERS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`pc-queue__tab${qlLayer === l.id ? ' is-active' : ''}`}
                aria-pressed={qlLayer === l.id}
                onClick={() => void setQlLayer(l.id)}
                title={l.hint}
              >
                {l.label}
              </button>
            ))}
          </nav>
          <DecisionLog
            layer={qlLayer}
            limit={50}
            title={qlLayer === 'disposition' ? 'What the Queen decided' : 'Governed actions (audit)'}
            description={
              qlLayer === 'disposition'
                ? 'Every item the Queen considered and what she chose — act, defer, reject, route, or no-op. Newest first.'
                : 'Every governed action that ran, auto or gated — the full audit trail. Newest first.'
            }
            emptyText="No decisions logged yet. As the Queen considers items, they appear here."
          />
        </section>
      ) : (
        <>
          <nav className="pc-queue__filters" aria-label="Queue item filters">
            {ITEM_FILTERS.map((f) => {
              const active = istatus.includes(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`pc-queue__filter pc-plans__view--${f.id} ${active ? 'is-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => toggleItemStatus(f.id)}
                  title={f.hint}
                >
                  <span className="pc-queue__filter-label">{f.label}</span>
                  <span className="pc-queue__filter-count">
                    {queue.loading ? '…' : queue.itemStatusCounts[f.id]}
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="pc-items__listpane">
            {queue.showOther ? (
              <PlanOtherList
                groups={queue.otherGroups}
                loading={queue.attentionRaw.loading}
                error={queue.attentionRaw.error}
                refresh={queue.attentionRaw.refresh}
                title="Other"
                kinds={queue.otherFacets}
                planFilters={itemPlans}
                groupByAuthorizer={queueAuthzView}
              />
            ) : null}
            {queue.showPlanItems ? (
              <PlanItemsList
                items={queue.filteredItems}
                loading={queue.loading}
                error={queue.error}
                refresh={queue.refresh}
                harnessByPlan={maps.harnessByPlan}
                planMeta={maps.planMetaBySlug}
                planFilters={itemPlans}
                title={itemTitle}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
