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
import { useCallback, useEffect, useMemo, useRef } from 'react';
import PlanRail, { type PlanRailHandle } from './PlanRail';
import PlanDetail from './PlanDetail';
import PlanItemsList from './PlanItemsList';
import PlanFilters from './PlanFilters';
import PlanSearchResults from './PlanSearchResults';
import PlanTriage from './PlanTriage';
import { usePlanList, type PlanListRow } from './plans-api';

type PlansView = 'list' | 'inbox' | 'actionable' | 'triage';
type PaneMode = 'read' | 'edit';

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
  const railRef = useRef<PlanRailHandle | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const planList = usePlanList({ includeArchived: true, includeLegacy: true });
  const stats = useMemo(() => buildPlanStats(planList.data?.plans ?? []), [planList.data]);

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

  return (
    <div className="pc-plans">
      <aside className="pc-plans__rail">
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

        <PlanFilters
          list={planList}
          query={q}
          onQueryChange={setQ}
          searchRef={searchRef}
        />

        <div className="pc-plans__list" aria-label="Plan list">
          <PlanRail
            ref={railRef}
            list={planList}
            selectedSlug={slug}
            query={q}
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
          />
        )}

        {view === 'list' && !slug && q.trim() ? (
          <PlanSearchResults query={q} onPick={(s) => navSlug(s)} />
        ) : null}

        {view === 'list' && !slug && !q.trim() && (
          <EmptyState stats={stats} />
        )}

        {view === 'inbox' && (
          <PlanItemsList mode="inbox" onPick={(s) => navSlug(s)} />
        )}

        {view === 'actionable' && (
          <PlanItemsList mode="actionable" onPick={(s) => navSlug(s)} />
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
