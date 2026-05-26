'use client';

/**
 * Plans admin tab — nuqs-driven shell.
 *
 * All user-meaningful state is URL state (D-006): `view` selects the
 * surface, `slug` selects the open plan, `q` holds the search query,
 * `pane` is the read/edit toggle inside the detail view.
 *
 * Navigation guard (Bug-1 fix): PlanDetail reports unsaved-edit state
 * via `onDirtyChange`; every path that leaves the open plan (rail
 * click, view switch, search pick, inbox/actionable/triage pick, back
 * button, keyboard nav) runs through `leaveGuard()` first — a confirm
 * if the plan has unsaved edits. PlanDetail is also keyed on `slug` so
 * a confirmed switch fully remounts it: no draft / hash / conflict
 * state can survive into the next plan (the contamination root cause).
 */

import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import PlanRail, { type PlanRailHandle } from './PlanRail';
import PlanDetail from './PlanDetail';
import PlanItemsList from './PlanItemsList';
import PlanFilters from './PlanFilters';
import PlanSearchResults from './PlanSearchResults';
import PlanTriage from './PlanTriage';
import { usePlanList, usePlanSearch, type PlanListRow } from './plans-api';
import { launchOmpAgent } from '@/lib/native-omp-launch';
import { resolveHarnessScope, type HarnessNodeForScope } from '@/lib/harness/scope';

/** localStorage key AdvShell uses for the fallback active-harness slug. */
const ACTIVE_HARNESS_KEY = 'harness.activeProject';

type PlansView = 'list' | 'inbox' | 'actionable' | 'triage';
type PaneMode = 'read' | 'edit';
type PlanDetailTab = 'editor' | 'revisions' | 'agents';

const VIEWS: Array<{ id: PlansView; label: string }> = [
  { id: 'list', label: 'Browse' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'actionable', label: 'Actionable' },
  { id: 'triage', label: 'Triage' },
];

interface PlanStats {
  total: number;
  visible: number;
  legacy: number;
  needsHuman: number;
  actionable: number;
}

export default function PlansClient() {
  const [view, setView] = useQueryState(
    'view',
    parseAsStringEnum<PlansView>(['list', 'inbox', 'actionable', 'triage']).withDefault('list'),
  );
  const [slug, setSlug] = useQueryState('slug', parseAsString);
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [, setPane] = useQueryState(
    'pane',
    parseAsStringEnum<PaneMode>(['read', 'edit']).withDefault('read'),
  );
  const [, setTab] = useQueryState(
    'tab',
    parseAsStringEnum<PlanDetailTab>(['editor', 'revisions', 'agents']).withDefault('editor'),
  );
  const [, setJump] = useQueryState('jump', parseAsString);
  const railRef = useRef<PlanRailHandle | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // P-024 + P-016 + P-015 + P-029 (audit fix): harness scope.
  // Three signals stack:
  //   - `?h=<slug>` user-explicit harness filter (overrides everything).
  //   - `?slug=<slug>` AdvShell-active harness (default narrow).
  //   - `?scope=` AdvShell scope toggle: 'expanded' (default) UNIONS
  //     the slug + its sub-harnesses; 'self' narrows to just the slug.
  // Audit fix: the resolved scope is sent as `harness_slugs` to the
  // server (P-029) so plans:list actually fans out across multiple
  // harness dirs — Phase 3 was previously inert because the server
  // only ever returned one harness's plans.
  const [harnessFilter, setHarnessFilter] = useQueryState('h', parseAsString);
  const [advActiveSlug] = useQueryState('slug', parseAsString);
  const [scopeMode] = useQueryState(
    'scope',
    parseAsStringEnum<'expanded' | 'self'>(['expanded', 'self']).withDefault('expanded'),
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
  /** Server-side fan-out list. null = use ctx default (no harness arg). */
  const harnessSlugsForFetch = useMemo<readonly string[] | undefined>(() => {
    if (harnessFilter) return [harnessFilter];
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
  // Client-side narrow when the user has set ?h= explicitly. The server
  // already returned multi-harness data; this is the final per-row gate.
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

  const stats = useMemo(() => buildPlanStats(visiblePlans), [visiblePlans]);

  // Lift cross-plan search up so PlanRail can union its hits into the
  // rail filter — otherwise the rail does a substring match on
  // title/slug only and a search like "memory" (which appears in body
  // text but no title/slug) reads as "0 results" even though
  // PlanSearchResults has 20+ hits. PlanSearchResults still mounts its
  // own debounced search; the small duplicate fetch is the price for
  // keeping that component standalone.
  const railSearchHits = usePlanSearch(q);
  const searchHitSlugs = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const h of railSearchHits.data?.hits ?? []) s.add(h.plan);
    return s;
  }, [railSearchHits.data]);

  // Bug-1 guard: PlanDetail keeps this ref current with its unsaved-
  // edit state. `leaveGuard` is consulted before every navigation that
  // would abandon the open plan.
  const dirtyRef = useRef(false);
  const leaveGuard = useCallback((): boolean => {
    if (!dirtyRef.current) return true;
    return window.confirm('Discard unsaved edits to this plan?');
  }, []);

  // Navigate to a different plan (or close the detail). Resets `pane`
  // to read — a fresh plan opens in read mode, not inheriting the
  // previous plan's edit toggle.
  const navSlug = useCallback(
    (next: string | null) => {
      if (!leaveGuard()) return;
      setPane('read');
      setSlug(next);
    },
    [leaveGuard, setPane, setSlug],
  );

  // Open a plan from a cross-plan item list and optionally deep-link to
  // a concrete P-NNN/D-NNN target. Unlike navSlug(), this also switches
  // back to the plan detail surface; otherwise clicks inside view=inbox
  // only changed `slug` while the inbox panel stayed mounted.
  const navPlanTarget = useCallback(
    (next: string, targetId?: string) => {
      if (!leaveGuard()) return;
      setPane('read');
      setTab('editor');
      setJump(targetId ?? null);
      setView('list');
      setSlug(next);
    },
    [leaveGuard, setJump, setPane, setSlug, setTab, setView],
  );

  // Switch the top-level view. Guards only when the switch abandons an
  // open plan (i.e. moving off `list`, which clears `slug`).
  const navView = useCallback(
    (next: PlansView) => {
      if (next !== 'list') {
        if (!leaveGuard()) return;
        setPane('read');
        setView(next);
        setSlug(null);
        return;
      }
      setView('list');
    },
    [leaveGuard, setPane, setView, setSlug],
  );

  // P-304 keyboard shortcuts. `navView` / `navSlug` are the guarded
  // setters (prompt on unsaved edits); `setView` is raw — J/K call
  // setView('list') alongside the already-guarded rail nav, and
  // guarding both would double-prompt.
  usePlanShortcuts({
    setView,
    navView,
    navSlug,
    setQ,
    rail: railRef,
    search: searchRef,
  });

  // P-007: PlansClient is dual-homed (/admin/plans + /adv?tab=plans).
  // /adv puts the active harness slug on `?slug=`; standalone /admin
  // doesn't. Fall back to localStorage (the same key AdvShell uses
  // for first-load) so the New plan button still works there.
  const [activeHarnessSlug] = useQueryState('slug', parseAsString);
  const [fallbackHarnessSlug, setFallbackHarnessSlug] = useState<string | null>(null);
  useEffect(() => {
    if (activeHarnessSlug) return;
    if (typeof window === 'undefined') return;
    try {
      setFallbackHarnessSlug(window.localStorage.getItem(ACTIVE_HARNESS_KEY));
    } catch { /* ignore */ }
  }, [activeHarnessSlug]);
  const resolvedHarnessSlug = activeHarnessSlug ?? fallbackHarnessSlug;

  const [launchingNewPlan, setLaunchingNewPlan] = useState(false);
  const onNewPlan = useCallback(async () => {
    if (launchingNewPlan) return;
    setLaunchingNewPlan(true);
    try {
      const result = await launchOmpAgent({
        slug: resolvedHarnessSlug ?? null,
        planSlug: null,
        label: resolvedHarnessSlug ? `new-plan · ${resolvedHarnessSlug}` : 'new-plan',
        kickoff: { kind: 'new-plan' },
      });
      if (result.ok) {
        toast.success('OMP launched to draft a new plan.', { duration: 3000 });
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
                ? `Launch an OMP session to draft a new plan in ${resolvedHarnessSlug}`
                : 'Launch an OMP session to draft a new plan (no active harness — agent will ask)'
            }
          >
            {launchingNewPlan ? 'Launching…' : '+ New plan'}
          </button>
        </div>
        <PlansOverview stats={stats} loading={planList.loading} />

        <nav className="pc-plans__views" aria-label="Plans views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`pc-plans__view ${view === v.id ? 'is-active' : ''}`}
              onClick={() => navView(v.id)}
              aria-current={view === v.id ? 'page' : undefined}
            >
              <span className="pc-plans__view-label">{v.label}</span>
              <span className="pc-plans__view-count">{viewCount(v.id, stats, planList.loading)}</span>
            </button>
          ))}
        </nav>

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

        <div className="pc-plans__list" aria-label="Plan list">
          <PlanRail
            ref={railRef}
            list={filteredPlanList}
            selectedSlug={slug}
            query={q}
            searchHitSlugs={searchHitSlugs}
            onSelect={navSlug}
          />
        </div>
      </aside>

      <main className="pc-plans__main">
        {view === 'list' && slug && (
          <PlanDetail
            key={slug}
            slug={slug}
            onClose={() => navSlug(null)}
            onDirtyChange={(d) => {
              dirtyRef.current = d;
            }}
            startStatus={visiblePlans.find((p) => p.slug === slug)?.startStatus ?? null}
            onStartStatusChange={() => planList.refresh()}
          />
        )}

        {view === 'list' && !slug && q.trim() ? (
          <PlanSearchResults query={q} onPick={(s) => navSlug(s)} />
        ) : null}

        {view === 'list' && !slug && !q.trim() && (
          <EmptyState stats={stats} />
        )}

        {view === 'inbox' && (
          <PlanItemsList mode="inbox" onPick={navPlanTarget} />
        )}

        {view === 'actionable' && (
          <PlanItemsList mode="actionable" onPick={navPlanTarget} />
        )}

        {view === 'triage' && <PlanTriage onPick={(s) => navSlug(s)} />}
      </main>
    </div>
  );
}

function EmptyState({ stats }: { stats: PlanStats }) {
  return (
    <div className="pc-plans__empty">
      <span className="pc-plans__empty-kicker">Plan workspace</span>
      <h2>Pick a plan to continue</h2>
      <p>
        Browse {stats.visible} current plans, jump to {stats.needsHuman} human decision
        {stats.needsHuman === 1 ? '' : 's'}, or use search to open a specific plan.
      </p>
      <div className="pc-plans__empty-actions" aria-label="Keyboard shortcuts">
        <span><kbd>/</kbd> search</span>
        <span><kbd>J</kbd>/<kbd>K</kbd> move</span>
        <span><kbd>g</kbd> then <kbd>I</kbd> inbox</span>
      </div>
    </div>
  );
}

function buildPlanStats(plans: PlanListRow[]): PlanStats {
  return plans.reduce<PlanStats>(
    (acc, plan) => {
      const counts = plan.itemCounts ?? {};
      acc.total += 1;
      if (!plan.archived) acc.visible += 1;
      if (plan.isLegacy) acc.legacy += 1;
      acc.needsHuman += counts['needs-human'] ?? 0;
      acc.actionable += counts.todo ?? 0;
      return acc;
    },
    {
      total: 0,
      visible: 0,
      legacy: 0,
      needsHuman: 0,
      actionable: 0,
    },
  );
}

function viewCount(view: PlansView, stats: PlanStats, loading: boolean): string {
  if (loading) return '…';
  if (view === 'list') return String(stats.visible);
  if (view === 'inbox') return String(stats.needsHuman);
  if (view === 'actionable') return String(stats.actionable);
  return String(stats.legacy);
}

function PlansOverview({ stats, loading }: { stats: PlanStats; loading: boolean }) {
  const total = loading ? '…' : stats.visible;
  return (
    <section className="pc-plans__overview" aria-label="Plans overview">
      <span className="pc-plans__overview-kicker">Plan command center</span>
      <div className="pc-plans__overview-main">
        <strong>{total}</strong>
        <span>current plans</span>
      </div>
    </section>
  );
}

/* ── P-304 keyboard shortcuts ─────────────────────────────────────── */

type PlanShortcutSetters = {
  /** Raw view setter — used only for J/K's incidental setView('list'). */
  setView: (v: PlansView) => unknown;
  /** Guarded view setter — prompts if the open plan has unsaved edits. */
  navView: (v: PlansView) => unknown;
  /** Guarded slug setter — prompts if the open plan has unsaved edits. */
  navSlug: (s: string | null) => unknown;
  setQ: (q: string | null) => unknown;
  rail: React.RefObject<PlanRailHandle | null>;
  search: React.RefObject<HTMLInputElement | null>;
};

const G_TIMEOUT_MS = 800;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.isContentEditable) return true;
  // Inside vditor editing surfaces.
  if (t.closest('.vditor-ir, .vditor-wysiwyg, .vditor-sv')) return true;
  return false;
}

/**
 * Document-level shortcut handler.
 *
 *   /       focus rail search
 *   J / K   next / previous plan in the rail (list view only)
 *   g L     go to list view
 *   g I     go to inbox view
 *   g A     go to actionable view
 *   Esc     close detail back to list (or clear search if focused there)
 *
 * Slug-changing shortcuts (J/K via the rail, g I / g A, Esc) route
 * through the guarded `navSlug` so an unsaved edit prompts first.
 * Disabled when the user is typing into any input / textarea /
 * contenteditable / vditor surface — vditor's own hotkeys win when the
 * editor has focus (D-004 reconciliation).
 */
function usePlanShortcuts({ setView, navView, navSlug, setQ, rail, search }: PlanShortcutSetters) {
  useEffect(() => {
    let gArmed = false;
    let gTimer: number | null = null;
    const disarmG = () => {
      gArmed = false;
      if (gTimer !== null) {
        window.clearTimeout(gTimer);
        gTimer = null;
      }
    };
    const armG = () => {
      gArmed = true;
      if (gTimer !== null) window.clearTimeout(gTimer);
      gTimer = window.setTimeout(disarmG, G_TIMEOUT_MS);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Esc has a couple of overloads — handled even inside the search box.
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

      // `g L/I/A` two-key combos — all route through the guarded
      // `navView` (which clears the slug + prompts on unsaved edits).
      if (gArmed) {
        const k = event.key.toLowerCase();
        if (k === 'l' || k === 'i' || k === 'a') {
          event.preventDefault();
          disarmG();
          navView(k === 'l' ? 'list' : k === 'i' ? 'inbox' : 'actionable');
          return;
        }
        disarmG();
        // fall through — other key in g-mode is treated as a fresh press
      }

      if (event.key === '/') {
        event.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
      if (event.key === 'g') {
        event.preventDefault();
        armG();
        return;
      }
      // J/K move the rail selection (the rail's onSelect is the guarded
      // navSlug). setView('list') is raw so a guarded rail-nav doesn't
      // double-prompt.
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault();
        setView('list');
        rail.current?.next();
        return;
      }
      if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        setView('list');
        rail.current?.prev();
        return;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      disarmG();
    };
  }, [setView, navView, navSlug, setQ, rail, search]);
}
