'use client';

/**
 * PlansPane (owner-plans-single-pane-2026-07-17 P-001/P-002) — the simplified
 * plan-tracking face of the op-chat sidebar (`?opcv=plans`), beside the Inbox
 * face. The owner's ask: plan tracking is too complicated — so this pane is a
 * STATUS GLANCE, not a browser:
 *
 *   - ACTIVE plans only by default (bucketOf ∈ draft/ready/running); one
 *     search box; ONE "show finished" toggle. None of the Create dock's 11
 *     filter facets — authoring/power-filtering stays in /adv Create.
 *   - Every row answers "does this need me?" without opening it: a needs-you
 *     badge (decision-tier attention count), a live-agents count, item
 *     progress (done/total), and last-activity recency.
 *   - Sorted needs-you first, then most recently active.
 *   - Clicking a row opens the plan in a POPUP (PlanPopupModal → the same
 *     PlanDetail the Create tab renders, read-first) — never a navigation.
 *
 * REUSE, not re-derivation:
 *   - plan rows: the SAME `plans.list` sync feed (usePlanList) the Create
 *     dock + /admin/plans read (shared cache entry, SSE-invalidated);
 *   - needs-you counts: the SAME `plans.attention` feed the Inbox badge and
 *     Queue read (useInboxAttention → effectiveTier === 'decision');
 *   - live-agent counts: the SAME `advRoster.list` sync feed the Sessions
 *     roster reads (active entries' currentPlanSlug).
 *
 * State lives in the URL (nuqs) so the pane is deep-linkable and
 * agent-driveable: `?plq` search, `?plf` show-finished, `?pplan` popup plan,
 * `?ppv` popup tab (see PlanPopupModal).
 */
import { useMemo } from 'react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Tooltip } from '@/app/harness/Tooltip';
import {
  bucketOf,
  usePlanList,
  type PlanBucket,
  type PlanListRow,
} from '@/app/admin/plans/plans-api';
import { effectiveTier, useInboxAttention } from '../inbox/use-inbox-pending';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import PlanPopupModal from './PlanPopupModal';
import './plans-pane.css';

/** Buckets shown by default — "not started + started", never the finished. */
const ACTIVE_BUCKETS: ReadonlySet<PlanBucket> = new Set(['draft', 'ready', 'running']);

/** An active plan with no real activity for this long reads as "stale" — a
 *  visibility nudge against plan sprawl (owner-plans-single-pane P-008). */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** True when an active plan hasn't been touched in ≥ STALE_MS. Pure. */
export function isStale(updated: string | null, now = Date.now()): boolean {
  if (!updated) return false;
  const t = Date.parse(updated);
  return Number.isFinite(t) && now - t >= STALE_MS;
}

/** Compact relative recency — same local convention as the roster/backup panes. */
export function agoLabel(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** done / total-open+done item progress from the list row's itemCounts. */
export function progressOf(row: Pick<PlanListRow, 'itemCounts'>): { done: number; total: number } | null {
  const c = row.itemCounts;
  if (!c) return null;
  let done = 0;
  let total = 0;
  for (const [k, v] of Object.entries(c)) {
    const n = v ?? 0;
    if (k === 'unknown') continue;
    total += n;
    if (k === 'done') done += n;
  }
  return total > 0 ? { done, total } : null;
}

export interface PlanGlanceRow {
  plan: PlanListRow;
  needsYou: number;
  liveAgents: number;
}

/** Filter + decorate + sort the raw plan list into the glance rows.
 *  Pure — exported for unit tests. */
export function buildGlanceRows(opts: {
  plans: readonly PlanListRow[];
  query: string;
  showFinished: boolean;
  needsYouByPlan: ReadonlyMap<string, number>;
  liveByPlan: ReadonlyMap<string, number>;
}): PlanGlanceRow[] {
  const q = opts.query.trim().toLowerCase();
  const rows: PlanGlanceRow[] = [];
  for (const plan of opts.plans) {
    if (plan.archived || plan.isLegacy) continue;
    const bucket = bucketOf(plan);
    if (!opts.showFinished && !ACTIVE_BUCKETS.has(bucket)) continue;
    if (q) {
      const hay = `${plan.title ?? ''} ${plan.slug}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    rows.push({
      plan,
      needsYou: opts.needsYouByPlan.get(plan.slug) ?? 0,
      liveAgents: opts.liveByPlan.get(plan.slug) ?? 0,
    });
  }
  rows.sort((a, b) => {
    if (a.needsYou !== b.needsYou) return b.needsYou - a.needsYou;
    const au = a.plan.updated ? Date.parse(a.plan.updated) : 0;
    const bu = b.plan.updated ? Date.parse(b.plan.updated) : 0;
    return bu - au;
  });
  return rows;
}

/** The advRoster.list payload's one row (subset this pane reads). */
interface RosterPayloadRow {
  active?: Array<{ currentPlanSlug?: string | null }>;
}

export default function PlansPane() {
  const [query, setQuery] = useQueryState('plq', parseAsString.withDefault(''));
  const [showFinished, setShowFinished] = useQueryState('plf', parseAsBoolean.withDefault(false));
  const [popupPlan, setPopupPlan] = useQueryState('pplan', parseAsString);

  const planList = usePlanList({});
  const { items: attentionItems, loading: attentionLoading } = useInboxAttention();
  const workspaceId = useWorkspaceId();

  // Live-agent counts: the shared Sessions-roster sync entry (no new query
  // when the roster panel is also mounted). Reading only active[].currentPlanSlug.
  const roster = useSyncQuery<RosterPayloadRow>({
    queryName: 'advRoster.list',
    args: useMemo(() => ({ workspaceId: workspaceId ?? null }), [workspaceId]),
  });

  const needsYouByPlan = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of attentionItems) {
      if (!i.planSlug) continue;
      if (effectiveTier(i) !== 'decision') continue;
      m.set(i.planSlug, (m.get(i.planSlug) ?? 0) + 1);
    }
    return m;
  }, [attentionItems]);

  const liveByPlan = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of roster.data?.[0]?.active ?? []) {
      const slug = e.currentPlanSlug;
      if (!slug) continue;
      m.set(slug, (m.get(slug) ?? 0) + 1);
    }
    return m;
  }, [roster.data]);

  const plans = planList.data?.plans;
  const rows = useMemo(
    () =>
      buildGlanceRows({
        plans: plans ?? [],
        query,
        showFinished,
        needsYouByPlan,
        liveByPlan,
      }),
    [plans, query, showFinished, needsYouByPlan, liveByPlan],
  );

  const popupRow = popupPlan ? (plans ?? []).find((p) => p.slug === popupPlan) ?? null : null;

  return (
    <div className="plans-pane" data-testid="plans-pane">
      <div className="plans-pane__bar">
        <input
          type="search"
          className="plans-pane__search"
          placeholder="Search plans…"
          value={query}
          onChange={(e) => void setQuery(e.target.value || null)}
          aria-label="Search plans"
          data-testid="plans-pane-search"
        />
        <Tooltip label={showFinished ? 'Hide finished plans' : 'Also show shipped / superseded plans'}>
          <button
            type="button"
            className={`plans-pane__finished-toggle${showFinished ? ' is-on' : ''}`}
            onClick={() => void setShowFinished(showFinished ? null : true)}
            aria-pressed={showFinished}
            data-testid="plans-pane-finished-toggle"
          >
            Finished
          </button>
        </Tooltip>
      </div>

      {planList.loading && !plans ? (
        <div className="plans-pane__empty">Loading plans…</div>
      ) : rows.length === 0 ? (
        <div className="plans-pane__empty">
          {query.trim()
            ? 'No plans match the search.'
            : showFinished
              ? 'No plans yet.'
              : 'No active plans — everything is finished. 🎉'}
        </div>
      ) : (
        <ul className="plans-pane__list" aria-label="Plans">
          {rows.map(({ plan, needsYou, liveAgents }) => {
            const progress = progressOf(plan);
            return (
              <li key={`${plan.harness}:${plan.slug}`}>
                <button
                  type="button"
                  className="plans-pane__row"
                  onClick={() => void setPopupPlan(plan.slug)}
                  data-testid={`plans-pane-row-${plan.slug}`}
                >
                  <span className="plans-pane__row-main">
                    <span className="plans-pane__row-title">{plan.title ?? plan.slug}</span>
                    <span className="plans-pane__row-sub">
                      <span className="plans-pane__row-harness">{plan.harness}</span>
                      <span className="plans-pane__row-ago" title={plan.updated ?? undefined}>
                        {agoLabel(plan.updated)}
                      </span>
                    </span>
                  </span>
                  <span className="plans-pane__row-badges">
                    {needsYou > 0 ? (
                      <span
                        className="plans-pane__badge plans-pane__badge--needs"
                        title={`${needsYou} decision${needsYou === 1 ? '' : 's'} need you`}
                        data-testid="plans-pane-needs-badge"
                      >
                        {needsYou}
                      </span>
                    ) : null}
                    {liveAgents > 0 ? (
                      <span
                        className="plans-pane__badge plans-pane__badge--live"
                        title={`${liveAgents} agent${liveAgents === 1 ? '' : 's'} working now`}
                        data-testid="plans-pane-live-badge"
                      >
                        ●&nbsp;{liveAgents}
                      </span>
                    ) : null}
                    {progress ? (
                      <span
                        className="plans-pane__badge plans-pane__badge--progress"
                        title={`${progress.done} of ${progress.total} items done`}
                      >
                        {progress.done}/{progress.total}
                      </span>
                    ) : null}
                    {!showFinished && isStale(plan.updated) ? (
                      <span
                        className="plans-pane__badge plans-pane__badge--stale"
                        title={`No activity since ${plan.updated} — a candidate to archive`}
                        data-testid="plans-pane-stale-badge"
                      >
                        stale
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {attentionLoading && rows.length === 0 ? null : null}

      <PlanPopupModal
        planSlug={popupPlan}
        harnessSlug={popupRow?.harness ?? null}
        planTitle={popupRow?.title ?? popupPlan}
        onClose={() => void setPopupPlan(null)}
      />
    </div>
  );
}
