'use client';

/**
 * AdvPlansTabs — VSCode-style tab strip sitting above PlansClient.
 *
 * Tab model:
 *   - `index` (pinned, leftmost, not closeable) — the rail + browse/
 *     inbox/actionable/triage views; mounts when slug is null and q
 *     is empty.
 *   - `search` (pinned, not closeable) — auto-focused whenever the
 *     query input becomes non-empty; mounts PlanSearchResults via
 *     PlansClient's existing behavior.
 *   - `plan:<slug>` (additive, closeable) — one per opened plan;
 *     focused when slug is set.
 *
 * The strip is a *view layer* over PlansClient's existing nuqs state
 * (`view`/`slug`/`q`): clicking a tab adjusts those query params, and
 * the strip observes them to keep the active highlight + open-plan
 * list in sync. The list of currently-open plan tabs persists in
 * `?tabs=` so a reload restores them; the active tab is derived from
 * (slug, q) so we don't keep an authoritative `activeTab` query
 * separately — single source of truth wins.
 */

import { useEffect, useMemo } from 'react';
import {
  parseAsArrayOf,
  parseAsString,
  parseAsStringEnum,
  useQueryState,
} from 'nuqs';
import { usePlanList } from '../../admin/plans/plans-api';

type PlansView = 'list' | 'inbox' | 'actionable' | 'triage';
type PaneMode = 'read' | 'edit';

interface Tab {
  id: string;
  label: string;
  hint?: string;
  closeable: boolean;
}

export default function AdvPlansTabs({ children }: { children: React.ReactNode }) {
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
  const [openSlugs, setOpenSlugs] = useQueryState(
    'tabs',
    parseAsArrayOf(parseAsString).withDefault([]),
  );

  const queryTrimmed = q.trim();

  // Pull plan titles so tab labels are human-readable, not raw slugs.
  // PlansClient already mounts a copy of this hook for the rail — the
  // shared SWR/Zero cache (whatever usePlanList is built on) makes the
  // second mount cheap.
  const planList = usePlanList({ includeArchived: true, includeLegacy: true });
  const titleBySlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of planList.data?.plans ?? []) {
      if (p.title) map.set(p.slug, p.title);
    }
    return map;
  }, [planList.data]);

  // Push every newly-opened plan onto the tab stack (de-duped, order
  // preserved). This is the "click a plan in the rail → it appears
  // as a new tab" wiring.
  useEffect(() => {
    if (slug && !openSlugs.includes(slug)) {
      void setOpenSlugs([...openSlugs, slug]);
    }
  }, [slug, openSlugs, setOpenSlugs]);

  // Derive the active tab from PlansClient state. Order matters:
  //   - open plan wins (user is reading a plan)
  //   - then search if the query is non-empty
  //   - then index
  const activeTabId: string = slug
    ? `plan:${slug}`
    : queryTrimmed
      ? 'search'
      : 'index';

  const tabs: Tab[] = useMemo(() => {
    const base: Tab[] = [
      { id: 'index', label: 'Plans', closeable: false },
      {
        id: 'search',
        label: queryTrimmed ? `Search: "${truncate(queryTrimmed, 28)}"` : 'Search',
        closeable: false,
      },
    ];
    for (const s of openSlugs) {
      const label = labelForPlan(s, titleBySlug.get(s) ?? null);
      base.push({ id: `plan:${s}`, label, hint: s, closeable: true });
    }
    return base;
  }, [queryTrimmed, openSlugs, titleBySlug]);

  const focus = (tabId: string) => {
    if (tabId === 'index') {
      void setPane('read');
      void setSlug(null);
      void setQ('');
      void setView('list');
    } else if (tabId === 'search') {
      void setPane('read');
      void setSlug(null);
      void setView('list');
      if (!queryTrimmed) {
        // Search tab focused with no query — focus the search input
        // so the user can immediately type. PlansClient's PlanFilters
        // owns the input and tags it with `data-plan-search-input`.
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLInputElement>('[data-plan-search-input]');
          el?.focus();
        });
      }
    } else if (tabId.startsWith('plan:')) {
      const next = tabId.slice('plan:'.length);
      void setPane('read');
      void setView('list');
      void setSlug(next);
    }
  };

  const close = (tabId: string) => {
    if (!tabId.startsWith('plan:')) return;
    const planSlug = tabId.slice('plan:'.length);
    const idx = openSlugs.indexOf(planSlug);
    const remaining = openSlugs.filter((s) => s !== planSlug);
    void setOpenSlugs(remaining);
    if (activeTabId !== tabId) return;
    // Closing the active tab — fall back to the neighbor on the right,
    // then left, then to the index tab.
    const fallback = remaining[idx] ?? remaining[idx - 1];
    if (fallback) {
      void setSlug(fallback);
    } else {
      void setSlug(null);
    }
  };

  return (
    <>
      <div className="pc-adv-tabstrip" role="tablist" aria-label="Open plans">
        {tabs.map((t) => {
          const isActive = t.id === activeTabId;
          return (
            <span
              key={t.id}
              className={`pc-adv-tab${isActive ? ' is-active' : ''}${t.closeable ? '' : ' is-pinned'}`}
              role="tab"
              aria-selected={isActive}
              title={t.hint ?? t.label}
            >
              <button
                type="button"
                className="pc-adv-tab__label"
                onClick={() => focus(t.id)}
              >
                {t.label}
              </button>
              {t.closeable ? (
                <button
                  type="button"
                  className="pc-adv-tab__close"
                  aria-label={`Close ${t.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.id);
                  }}
                >
                  ×
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
      {children}
      <style>{`
        .pc-adv-tabstrip {
          display: flex;
          align-items: stretch;
          gap: 2px;
          overflow-x: auto;
          padding: 6px 10px 0;
          border-bottom: 1px solid rgba(167, 139, 250, 0.18);
          background: rgba(11, 13, 28, 0.96);
          scrollbar-width: thin;
        }
        .pc-adv-tab {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-height: 28px;
          max-width: 240px;
          padding: 0 6px 0 10px;
          border: 1px solid rgba(167, 139, 250, 0.14);
          border-bottom-color: transparent;
          border-radius: 8px 8px 0 0;
          background: rgba(255, 255, 255, 0.02);
          color: rgba(220, 214, 248, 0.7);
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.01em;
          white-space: nowrap;
        }
        .pc-adv-tab.is-pinned { background: rgba(31, 23, 56, 0.5); }
        .pc-adv-tab.is-active {
          color: #f7f5ff;
          background: rgba(31, 23, 56, 0.96);
          border-color: rgba(167, 139, 250, 0.5);
        }
        .pc-adv-tab__label {
          all: unset;
          cursor: pointer;
          padding: 0 4px;
          max-width: 200px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pc-adv-tab__label:focus-visible { outline: 1px dashed rgba(167, 139, 250, 0.6); }
        .pc-adv-tab__close {
          all: unset;
          cursor: pointer;
          padding: 0 6px;
          color: rgba(220, 214, 248, 0.5);
          border-radius: 4px;
        }
        .pc-adv-tab__close:hover { color: #f7f5ff; background: rgba(167, 139, 250, 0.18); }
      `}</style>
    </>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Pick a readable label for a plan tab:
 *   - plan title (best — what a human wrote)
 *   - else slug with the trailing `-YYYY-MM-DD` date suffix stripped
 *   - else slug verbatim
 * Capped at 32 chars with an ellipsis.
 */
function labelForPlan(slug: string, title: string | null): string {
  if (title && title.trim()) return truncate(title.trim(), 32);
  const stripped = slug.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return truncate(stripped, 32);
}
