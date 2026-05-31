'use client';

/**
 * Plans admin tab — nuqs-driven shell, additive-filter model (D-007).
 *
 * The main pane is always a cross-plan ITEM list (PlanItemsList), unless a
 * plan is open (`?plan=` → PlanDetail) or a search is active (`?q=` →
 * PlanSearchResults to find/open a plan). Two multi-select filter facets
 * combine to narrow the item list:
 *   - item-status (`?istatus=`): Needs Human / ToDos / Blocked,
 *     OR within the facet. Empty = all three.
 *   - plan-status (`?pBuckets=`): Draft … Superseded, OR within. Empty =
 *     all plans. Scopes which plans' items show.
 * The facets AND across each other. Output is always items (grouped by
 * plan) — a plan with no matching items doesn't appear (use search to
 * reach an item-less plan).
 *
 * Navigation guard (Bug-1): PlanDetail reports unsaved-edit state via
 * `onDirtyChange`; every path that abandons the open plan runs through
 * `leaveGuard()` first.
 */

import { useQueryState, parseAsArrayOf, parseAsString, parseAsStringEnum } from 'nuqs';
import { wsLocalKey } from '@/lib/browser-workspace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import PlanRail, { type PlanRailHandle } from './PlanRail';
import PlanDetail from './PlanDetail';
import PlanItemsList from './PlanItemsList';
import PlanOtherList from './PlanOtherList';
import PlanFilters from './PlanFilters';
import PlanBucketTabs from './PlanBucketTabs';
import PlanSearchResults from './PlanSearchResults';
import {
  usePlanList,
  usePlanItems,
  usePlanAttention,
  usePlanSearch,
  bucketOf,
  PLAN_BUCKETS,
  type PlanListRow,
  type PlanStatus,
  type PlanBucket,
  type PlanItemRow,
} from './plans-api';
import { launchAgent } from '@/lib/launch-agent';
import { resolveHarnessScope, type HarnessNodeForScope, HARNESS_SCOPE_MODES, type HarnessScopeMode } from '@/lib/harness/scope';

/** localStorage key AdvShell uses for the fallback active-harness slug. */
const ACTIVE_HARNESS_KEY = 'harness.activeProject';

type PaneMode = 'read' | 'edit';
type PlanDetailTab = 'editor' | 'revisions' | 'agents';

// Additive filter model: item-status facet (OR within) AND plan-status
// bucket facet (OR within). Each item maps to one item-status category.
type ItemStatusFilter =
  | 'needs-human'
  | 'todo'
  | 'blocked'
  | 'coord-escalation'
  | 'coord-message'
  | 'smoke-fail'
  | 'plan-review';
const ITEM_STATUS_IDS = [
  'needs-human',
  'todo',
  'blocked',
  'coord-escalation',
  'coord-message',
  'smoke-fail',
  'plan-review',
] as const;
// The non-plan-item facets — each maps 1:1 to an AttentionItem kind from
// the plans:attention reader (the "Other" surfaces, now split out).
const OTHER_KIND_IDS = ['coord-escalation', 'coord-message', 'smoke-fail', 'plan-review'] as const;
type OtherKind = (typeof OTHER_KIND_IDS)[number];

/** Item-status filter toggles — the "Items" group. */
const ITEM_FILTERS: Array<{ id: ItemStatusFilter; label: string; hint: string }> = [
  { id: 'needs-human', label: 'Needs Human', hint: 'Items waiting on a human decision.' },
  { id: 'todo', label: 'ToDos', hint: 'Agent-actionable work — effective todo, all blockers cleared. Sorted by importance.' },
  { id: 'blocked', label: 'Blocked', hint: 'Items stuck on unresolved blockers or external waits.' },
  { id: 'coord-escalation', label: 'Escalations', hint: 'Agent escalations from the coord log — a decision is blocking progress.' },
  { id: 'coord-message', label: 'Messages', hint: 'Coord messages addressed to you.' },
  { id: 'smoke-fail', label: 'Smoke', hint: 'Failing smoke tests — the harness app is broken.' },
  { id: 'plan-review', label: 'Reviews', hint: 'Plans awaiting your review.' },
];

const ITEM_FILTER_LABEL: Record<ItemStatusFilter, string> = {
  'needs-human': 'Needs Human',
  todo: 'ToDos',
  blocked: 'Blocked',
  'coord-escalation': 'Escalations',
  'coord-message': 'Messages',
  'smoke-fail': 'Smoke',
  'plan-review': 'Reviews',
};

const BUCKET_IDS: PlanBucket[] = PLAN_BUCKETS.map((b) => b.id);

export default function PlansClient() {
  // The OPEN-PLAN slug. Lives on `?plan=`, NOT `?slug=` — AdvShell owns
  // `?slug=` for the active harness (a global query param shared across
  // every /adv tab).
  const [slug, setSlug] = useQueryState('plan', parseAsString);
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [, setPane] = useQueryState(
    'pane',
    parseAsStringEnum<PaneMode>(['read', 'edit']).withDefault('read'),
  );
  // `ptab` (plan-detail tab), NOT `tab` — AdvShell owns `?tab=` on /adv.
  const [, setTab] = useQueryState(
    'ptab',
    parseAsStringEnum<PlanDetailTab>(['editor', 'revisions', 'agents']).withDefault('editor'),
  );
  const [, setJump] = useQueryState('jump', parseAsString);
  // Per-plan filter for the item list — the left rail sets it (clicking a
  // plan FILTERS the list to that plan; it does NOT open the plan).
  const [itemPlan, setItemPlan] = useQueryState('itemPlan', parseAsString);

  // Additive filter facets.
  const [istatus, setIstatus] = useQueryState(
    'istatus',
    parseAsArrayOf(parseAsStringEnum<ItemStatusFilter>([...ITEM_STATUS_IDS])).withDefault([]),
  );
  const [pBuckets] = useQueryState(
    'pBuckets',
    parseAsArrayOf(parseAsStringEnum<PlanBucket>([...BUCKET_IDS])).withDefault([]),
  );
  // Main-pane view: the plan browser (default — this is the Plans tab) vs the
  // item inbox. The Plans / Inbox header buttons flip it.
  const [view, setView] = useQueryState(
    'view',
    parseAsStringEnum<'plans' | 'inbox'>(['plans', 'inbox']).withDefault('plans'),
  );

  const railRef = useRef<PlanRailHandle | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // P-024 + P-016 + P-015 + P-029: harness scope. `?h=` user filter →
  // `?slug=` active harness → `?scope=` expanded/self toggle.
  const [harnessFilter, setHarnessFilter] = useQueryState('h', parseAsString);
  const [advActiveSlug] = useQueryState('slug', parseAsString);
  const [scopeMode] = useQueryState(
    'scope',
    parseAsStringEnum<HarnessScopeMode>([...HARNESS_SCOPE_MODES]).withDefault('expanded'),
  );
  const [registryProjects, setRegistryProjects] = useState<HarnessNodeForScope[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/harness/projects/lite', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled) return;
        setRegistryProjects(Array.isArray(d?.projects) ? d.projects : []);
      })
      .catch(() => { /* selector still works on the existing plan-row harness set */ });
    return () => { cancelled = true; };
  }, []);
  const harnessSlugsForFetch = useMemo<readonly string[] | undefined>(() => {
    if (harnessFilter) return [harnessFilter];
    // "All harnesses": fan out over every harness in the workspace. The
    // plans server treats an omitted list as ctx-harness-only (NOT all),
    // so we must pass every slug explicitly. Until the registry loads we
    // fall back to undefined (ctx harness) and re-resolve once it arrives.
    if (scopeMode === 'all') {
      return registryProjects.length ? registryProjects.map((p) => p.slug) : undefined;
    }
    if (!advActiveSlug) return undefined;
    if (scopeMode === 'self') return [advActiveSlug];
    if (registryProjects.length === 0) return [advActiveSlug];
    return resolveHarnessScope(advActiveSlug, registryProjects);
  }, [harnessFilter, advActiveSlug, scopeMode, registryProjects]);
  const planList = usePlanList({
    includeArchived: true,
    includeLegacy: true,
    harness_slugs: harnessSlugsForFetch,
  });
  const harnessOptions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const p of planList.data?.plans ?? []) {
      if (p.harness) set.add(p.harness);
    }
    return [...set].sort();
  }, [planList.data]);
  const visiblePlans = useMemo<PlanListRow[]>(() => {
    const all = planList.data?.plans ?? [];
    if (!harnessFilter) return all;
    return all.filter((p) => p.harness === harnessFilter);
  }, [planList.data, harnessFilter]);
  const filteredPlanList = useMemo(
    () => ({
      ...planList,
      data: planList.data ? { ...planList.data, plans: visiblePlans } : null,
    }),
    [planList, visiblePlans],
  );

  const harnessByPlan = useMemo(
    () => new Map((planList.data?.plans ?? []).map((p) => [p.slug, p.harness])),
    [planList.data],
  );
  // plan-slug → lifecycle bucket, for scoping items by plan-status.
  const planBucketBySlug = useMemo(() => {
    const m = new Map<string, PlanBucket>();
    for (const p of planList.data?.plans ?? []) m.set(p.slug, bucketOf(p));
    return m;
  }, [planList.data]);

  // The three item-status categories are fetched separately (the server
  // filters each), then unioned + tagged so the additive filter can pick
  // any subset. All three always load — the main pane is always items.
  const itemsNeedsHuman = usePlanItems({ needsHuman: true });
  const itemsActionable = usePlanItems({ actionable: true });
  const itemsBlocked = usePlanItems({ status: 'blocked' });
  const itemsLoading = itemsNeedsHuman.loading || itemsActionable.loading || itemsBlocked.loading;
  const itemsError = itemsNeedsHuman.error ?? itemsActionable.error ?? itemsBlocked.error;
  // The "Other" facet: non-plan-item attention surfaces (coord escalations,
  // smoke-fails, plan reviews, messages) from the plans:attention reader.
  const attention = usePlanAttention();
  const refreshItems = () => {
    itemsNeedsHuman.refresh();
    itemsActionable.refresh();
    itemsBlocked.refresh();
    attention.refresh();
  };

  const taggedItems = useMemo(() => {
    const out: Array<{ row: PlanItemRow; category: ItemStatusFilter }> = [];
    for (const r of itemsNeedsHuman.data?.items ?? []) out.push({ row: r, category: 'needs-human' });
    for (const r of itemsActionable.data?.items ?? []) out.push({ row: r, category: 'todo' });
    for (const r of itemsBlocked.data?.items ?? []) out.push({ row: r, category: 'blocked' });
    const seen = new Set<string>();
    const dedup: typeof out = [];
    for (const e of out) {
      const k = `${e.row.plan}::${e.row.item.id}`;
      if (!seen.has(k)) {
        seen.add(k);
        dedup.push(e);
      }
    }
    return dedup;
  }, [itemsNeedsHuman.data, itemsActionable.data, itemsBlocked.data]);

  const otherItems = useMemo(
    () => (attention.data?.groups ?? []).flatMap((g) => g.items).filter((i) => i.kind !== 'plan-item'),
    [attention.data],
  );

  // Plans-view rows — the harness-scoped plans, narrowed by the active
  // plan-status (bucket) filter. Click opens the plan (PlanDetail).
  const planBrowseRows = useMemo(
    () => visiblePlans.filter((p) => pBuckets.length === 0 || pBuckets.includes(bucketOf(p))),
    [visiblePlans, pBuckets],
  );
  // Split the active item-status facet into plan-item categories and the
  // non-plan-item ("Other") kinds. Empty selection = show everything.
  const otherFacets = useMemo(
    () => istatus.filter((s): s is OtherKind => (OTHER_KIND_IDS as readonly string[]).includes(s)),
    [istatus],
  );
  const planItemFacetCount = istatus.length - otherFacets.length;
  // Show the Other section when no facet is selected, or an Other-kind facet
  // is. Show the plan-item list when no facet is selected, or a plan-item
  // facet is. (So a bare "Escalations" selection shows only Other items.)
  const showOther = istatus.length === 0 || otherFacets.length > 0;
  const showPlanItems = istatus.length === 0 || planItemFacetCount > 0;

  const istatusKey = istatus.join('|');
  const pBucketsKey = pBuckets.join('|');
  // The additive result: items whose category is in the item-status facet
  // (or all if empty) AND whose plan is in the bucket facet (or all).
  const filteredItems = useMemo(
    () =>
      taggedItems
        .filter((e) => istatus.length === 0 || istatus.includes(e.category))
        .filter(
          (e) => pBuckets.length === 0 || pBuckets.includes(planBucketBySlug.get(e.row.plan) ?? 'draft'),
        )
        .map((e) => e.row),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taggedItems, istatusKey, pBucketsKey, planBucketBySlug],
  );

  // Per-status counts for the item-status chips — scoped by the active
  // plan-status buckets (but NOT by the item-status selection, so each
  // chip shows what selecting it would surface). Shrinks as you narrow
  // the plan buckets.
  const itemStatusCounts = useMemo(() => {
    const acc: Record<ItemStatusFilter, number> = {
      'needs-human': 0,
      todo: 0,
      blocked: 0,
      'coord-escalation': 0,
      'coord-message': 0,
      'smoke-fail': 0,
      'plan-review': 0,
    };
    for (const e of taggedItems) {
      if (pBuckets.length && !pBuckets.includes(planBucketBySlug.get(e.row.plan) ?? 'draft')) continue;
      acc[e.category] += 1;
    }
    for (const it of otherItems) {
      if (it.kind in acc) acc[it.kind as ItemStatusFilter] += 1;
    }
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taggedItems, pBucketsKey, planBucketBySlug, otherItems]);

  // Total across every facet — the Inbox button's badge.
  const inboxTotal = useMemo(
    () => Object.values(itemStatusCounts).reduce((a, b) => a + b, 0),
    [itemStatusCounts],
  );

  // The rail lists the plans that have matching items — a navigator +
  // per-plan filter (itemPlan) for the item list.
  const itemPlanSlugs = useMemo(() => new Set(filteredItems.map((r) => r.plan)), [filteredItems]);
  const railVisiblePlans = useMemo(
    () => visiblePlans.filter((p) => itemPlanSlugs.has(p.slug)),
    [visiblePlans, itemPlanSlugs],
  );
  const railList = useMemo(
    () => ({
      ...filteredPlanList,
      data: filteredPlanList.data ? { ...filteredPlanList.data, plans: railVisiblePlans } : null,
    }),
    [filteredPlanList, railVisiblePlans],
  );

  // Heading text for the item list — reflects the active facets.
  const itemTitle = istatus.length
    ? istatus.map((s) => ITEM_FILTER_LABEL[s]).join(' · ')
    : 'All items';
  const itemSubtitle = useMemo(() => {
    const bucketLabels = PLAN_BUCKETS.filter((b) => pBuckets.includes(b.id)).map((b) => b.label);
    return bucketLabels.length
      ? `In ${bucketLabels.join(' · ')} plan${bucketLabels.length > 1 ? 's' : ''}`
      : 'Across all plans';
  }, [pBucketsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Search-scope chips in PlanSearchResults (plans with needs-human /
  // todo items). Derived from plan-list item counts.
  const needsHumanPlans = useMemo(
    () =>
      new Set(
        (planList.data?.plans ?? [])
          .filter((p) => (p.itemCounts?.['needs-human'] ?? 0) > 0)
          .map((p) => p.slug),
      ),
    [planList.data],
  );
  const needsDecisionPlans = useMemo(
    () =>
      new Set(
        (planList.data?.plans ?? [])
          .filter((p) => (p.itemCounts?.todo ?? 0) > 0)
          .map((p) => p.slug),
      ),
    [planList.data],
  );

  // Lift cross-plan search up so PlanRail can union its hits into the rail.
  const railSearchHits = usePlanSearch(q);
  const searchHitSlugs = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const h of railSearchHits.data?.hits ?? []) s.add(h.plan);
    return s;
  }, [railSearchHits.data]);

  // Bug-1 guard: PlanDetail keeps this ref current with its unsaved-edit
  // state. `leaveGuard` is consulted before every navigation that abandons
  // the open plan.
  const dirtyRef = useRef(false);
  const leaveGuard = useCallback((): boolean => {
    if (!dirtyRef.current) return true;
    return window.confirm('Discard unsaved edits to this plan?');
  }, []);

  const navSlug = useCallback(
    (next: string | null) => {
      if (!leaveGuard()) return;
      setPane('read');
      setSlug(next);
    },
    [leaveGuard, setPane, setSlug],
  );

  // Open a plan from the item list / preview (the full PlanDetail), with an
  // optional P-NNN deep-link.
  const navPlanTarget = useCallback(
    (next: string, targetId?: string) => {
      if (!leaveGuard()) return;
      setPane('read');
      setTab('editor');
      setJump(targetId ?? null);
      setSlug(next);
    },
    [leaveGuard, setJump, setPane, setSlug, setTab],
  );

  // Toggle an item-status filter. Clears the open plan so the (re)filtered
  // list is what shows.
  const toggleItemStatus = useCallback(
    (id: ItemStatusFilter) => {
      if (!leaveGuard()) return;
      setSlug(null);
      const has = istatus.includes(id);
      void setIstatus(has ? istatus.filter((x) => x !== id) : [...istatus, id]);
    },
    [leaveGuard, setSlug, istatus, setIstatus],
  );

  // "Inbox" — jump to the items view with item-status filters cleared
  // (active plan-status / harness filters stay). Closes any open plan +
  // search + per-plan rail selection so the full cross-plan inbox shows.
  const goInbox = useCallback(() => {
    if (!leaveGuard()) return;
    setPane('read');
    setSlug(null);
    void setQ(null);
    void setIstatus([]);
    void setItemPlan(null);
    void setView('inbox');
  }, [leaveGuard, setPane, setSlug, setQ, setIstatus, setItemPlan, setView]);

  // "Plans" — the plan browser view. Closes any open plan + search; plan-status
  // / harness filters stay applied (they scope which plans show).
  const goPlans = useCallback(() => {
    if (!leaveGuard()) return;
    setPane('read');
    setSlug(null);
    void setQ(null);
    void setView('plans');
  }, [leaveGuard, setPane, setSlug, setQ, setView]);

  usePlanShortcuts({ navSlug, setQ, rail: railRef, search: searchRef });

  // P-007: dual-homed (/admin/plans + /adv?tab=plans). Fall back to the
  // localStorage active-harness for the New plan button on standalone /admin.
  const [activeHarnessSlug] = useQueryState('slug', parseAsString);
  const [fallbackHarnessSlug, setFallbackHarnessSlug] = useState<string | null>(null);
  useEffect(() => {
    if (activeHarnessSlug) return;
    if (typeof window === 'undefined') return;
    try {
      setFallbackHarnessSlug(window.localStorage.getItem(wsLocalKey(ACTIVE_HARNESS_KEY)));
    } catch { /* ignore */ }
  }, [activeHarnessSlug]);
  const resolvedHarnessSlug = activeHarnessSlug ?? fallbackHarnessSlug;

  const [launchingNewPlan, setLaunchingNewPlan] = useState(false);
  const onNewPlan = useCallback(async () => {
    if (launchingNewPlan) return;
    setLaunchingNewPlan(true);
    try {
      const result = await launchAgent({
        slug: resolvedHarnessSlug ?? null,
        planSlug: null,
        label: resolvedHarnessSlug ? `new-plan · ${resolvedHarnessSlug}` : 'new-plan',
        kickoff: { kind: 'new-plan' },
      });
      if (result.ok) {
        toast.success('Agent launched to draft a new plan.', { duration: 3000 });
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunchingNewPlan(false);
    }
  }, [launchingNewPlan, resolvedHarnessSlug]);

  return (
    <div className="pc-plans">
      <aside className="pc-plans__rail">
        <div className="pc-plans__rail-actions">
          <button
            type="button"
            className="pc-plans__new-plan"
            onClick={onNewPlan}
            disabled={launchingNewPlan}
            title={
              resolvedHarnessSlug
                ? `Launch an agent session to draft a new plan in ${resolvedHarnessSlug}`
                : 'Launch an agent session to draft a new plan (no active harness — agent will ask)'
            }
          >
            {launchingNewPlan ? 'Launching…' : '+ New plan'}
          </button>
          <button
            type="button"
            className={`pc-plans__plans-btn${view === 'plans' && !slug ? ' is-active' : ''}`}
            onClick={goPlans}
            title="Browse plans — open one to view/edit it. (Plan-status & harness filters stay applied.)"
          >
            Plans
          </button>
          <button
            type="button"
            className={`pc-plans__inbox-btn${view === 'inbox' && !slug ? ' is-active' : ''}`}
            onClick={goInbox}
            title="Open the Inbox — every item & attention surface across plans, with item filters cleared (plan filters stay)."
          >
            <span className="pc-plans__inbox-btn-label">Inbox</span>
            {inboxTotal > 0 ? <span className="pc-plans__inbox-btn-count">{inboxTotal}</span> : null}
          </button>
        </div>

        {/* ── PLANS group — search + plan-status filters (scope which plans' items show). ── */}
        <div className="pc-plans__group">
          {harnessOptions.length > 1 ? (
            <div className="pc-plans__harness-filter">
              <label className="pc-plans__harness-filter-label" htmlFor="pc-plans-harness-filter">
                Harness
              </label>
              <select
                id="pc-plans-harness-filter"
                className="pc-plans__harness-filter-select"
                value={harnessFilter ?? ''}
                onChange={(e) => void setHarnessFilter(e.target.value || null)}
              >
                <option value="">All ({planList.data?.plans.length ?? 0})</option>
                {harnessOptions.map((h) => {
                  const count = (planList.data?.plans ?? []).filter((p) => p.harness === h).length;
                  return (
                    <option key={h} value={h}>
                      {h} ({count})
                    </option>
                  );
                })}
              </select>
            </div>
          ) : null}

          <PlanFilters
            list={filteredPlanList}
            query={q}
            onQueryChange={setQ}
            searchRef={searchRef}
          />

          <PlanBucketTabs plans={visiblePlans} query={q} searchHitSlugs={searchHitSlugs} />
        </div>

        <div className="pc-plans__list" aria-label="Plans with matching items">
          <PlanRail
            ref={railRef}
            list={railList}
            selectedSlug={itemPlan}
            query={q}
            searchHitSlugs={searchHitSlugs}
            onSelect={(s) => void setItemPlan(itemPlan === s ? null : s)}
            onStartToggle={() => planList.refresh()}
            harnessSlug={harnessFilter ?? advActiveSlug}
          />
        </div>
      </aside>

      <main className="pc-plans__main">
        {slug ? (
          <PlanDetail
            key={slug}
            slug={slug}
            onClose={() => navSlug(null)}
            onDirtyChange={(d) => {
              dirtyRef.current = d;
            }}
            startStatus={visiblePlans.find((p) => p.slug === slug)?.startStatus ?? null}
            onStartStatusChange={() => planList.refresh()}
            onPlanStatusChange={(status?: PlanStatus) => {
              if (status && planList.setData) {
                planList.setData((prev) =>
                  prev
                    ? { ...prev, plans: prev.plans.map((p) => (p.slug === slug ? { ...p, status } : p)) }
                    : prev,
                );
              } else {
                planList.refresh();
              }
            }}
          />
        ) : q.trim() ? (
          <PlanSearchResults
            query={q}
            onPick={(s) => navSlug(s)}
            needsHumanPlans={needsHumanPlans}
            needsDecisionPlans={needsDecisionPlans}
          />
        ) : view === 'plans' ? (
          <div className="pc-plan-browse">
            <header className="pc-items__head">
              <div className="pc-items__head-copy">
                <span className="pc-items__kicker">Plans</span>
                <h2>
                  {planBrowseRows.length} plan{planBrowseRows.length === 1 ? '' : 's'}
                </h2>
                <p>{itemSubtitle}</p>
              </div>
            </header>
            {planBrowseRows.length === 0 ? (
              <div className="pc-items__empty">No plans match the current filters.</div>
            ) : (
              <ul className="pc-plan-browse__list" role="list">
                {planBrowseRows.map((p) => {
                  const needsHuman = p.itemCounts?.['needs-human'] ?? 0;
                  return (
                    <li key={p.slug}>
                      <button
                        type="button"
                        className="pc-plan-browse__row"
                        onClick={() => navPlanTarget(p.slug)}
                        title={p.slug}
                      >
                        <span className="pc-plan-browse__title">{p.title ?? p.slug}</span>
                        <span className="pc-plan-browse__meta">
                          <span className="pc-count">{p.status}</span>
                          {p.harness ? <span className="pc-pill pc-pill--harness">{p.harness}</span> : null}
                          {needsHuman > 0 ? (
                            <span className="pc-imp pc-imp--high">{needsHuman} needs-human</span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="pc-inbox">
            {/* Item filters live here on the Inbox page (moved off the rail). */}
            <nav className="pc-inbox__filters" aria-label="Inbox item filters">
              {ITEM_FILTERS.map((f) => {
                const active = istatus.includes(f.id);
                return (
                  <button
                    key={f.id}
                    type="button"
                    className={`pc-inbox__filter pc-plans__view--${f.id} ${active ? 'is-active' : ''}`}
                    aria-pressed={active}
                    onClick={() => toggleItemStatus(f.id)}
                    title={f.hint}
                  >
                    <span className="pc-inbox__filter-label">{f.label}</span>
                    <span className="pc-inbox__filter-count">
                      {itemsLoading ? '…' : itemStatusCounts[f.id]}
                    </span>
                  </button>
                );
              })}
            </nav>
            {showOther ? (
              <PlanOtherList
                groups={attention.data?.groups ?? []}
                loading={attention.loading}
                error={attention.error}
                refresh={attention.refresh}
                title="Other"
                subtitle={itemSubtitle}
                kinds={otherFacets}
              />
            ) : null}
            {showPlanItems ? (
              <PlanItemsList
                items={filteredItems}
                loading={itemsLoading}
                error={itemsError}
                refresh={refreshItems}
                onPick={navPlanTarget}
                harnessByPlan={harnessByPlan}
                planFilter={itemPlan}
                title={itemTitle}
                subtitle={itemSubtitle}
              />
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}

/* ── Keyboard shortcuts ───────────────────────────────────────────── */

type PlanShortcutSetters = {
  navSlug: (s: string | null) => unknown;
  setQ: (q: string | null) => unknown;
  rail: React.RefObject<PlanRailHandle | null>;
  search: React.RefObject<HTMLInputElement | null>;
};

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.isContentEditable) return true;
  if (t.closest('.vditor-ir, .vditor-wysiwyg, .vditor-sv')) return true;
  return false;
}

/**
 * Document-level shortcuts:
 *   /       focus rail search
 *   J / K   next / previous plan in the rail
 *   Esc     close the open plan (or clear search if focused there)
 */
function usePlanShortcuts({ navSlug, setQ, rail, search }: PlanShortcutSetters) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Escape') {
        if (document.activeElement === search.current) {
          search.current?.blur();
          if (search.current?.value) setQ('');
          return;
        }
        if (!isTypingTarget(event.target)) {
          navSlug(null);
        }
        return;
      }

      if (isTypingTarget(event.target)) return;

      if (event.key === '/') {
        event.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault();
        rail.current?.next();
        return;
      }
      if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        rail.current?.prev();
        return;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [navSlug, setQ, rail, search]);
}
