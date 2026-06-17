import { useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { HARNESS_SCOPE_MODES, type HarnessScopeMode } from '@papercusp/operator-core/lib/harness/scope';
import * as Tabs from '@radix-ui/react-tabs';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import {
  BookOpen,
  Boxes,
  CalendarClock,
  Check,
  FlaskConical,
  GitBranch,
  GraduationCap,
  HeartPulse,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  MessageCircle,
  MonitorPlay,
  Plus,
  Settings,
  Share2,
  TrendingUp,
  Trophy,
} from 'lucide-react';
import { Select, type SelectEntry, type SelectOption } from '@/app/harness/Select';
import { groupByHive } from '@papercusp/operator-core/lib/harness/hive-groups';
import { useWorkspaceLabel } from '@/lib/useWorkspaceLabel';
import { CreateHarnessPicker } from '@/app/harness/CreateHarnessPicker';
import { Modal } from '@/app/harness/Modal';
import { PublishHiveCard } from '@/app/harness/PublishHiveCard';
import AdvNowRunning from './AdvNowRunning';
import HivesRunningPill from './HivesRunningPill';
import DiscordBadge from './DiscordBadge';
import { ALL_HARNESSES_OPTION, resolveAdvHarnessSelection } from './adv-harness-selection';
import { useLexicon } from '@/lib/useLexicon';
import { useShortcutAction } from '@/lib/hotkeys';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';

const ADV_TAB_IDS = ['overview', 'harnesses', 'health', 'brainstorm', 'prs', 'insights', 'conversations', 'learning', 'settings', 'docs', 'git', 'testing', 'plans', 'calendar', 'frames', 'evals'] as const;
export type AdvTabId = (typeof ADV_TAB_IDS)[number];

/**
 * /adv shell — TSR mirror of apps/operator/app/adv/_components/AdvShell.tsx.
 *
 * The Vite operator is the live UI (the legacy Next operator at
 * apps/operator/app/* is parallel/transitional); /adv has to live
 * here too or the ADV navbar button serves stale tabs.
 */
export const ADV_TABS: ReadonlyArray<{
  id: Exclude<AdvTabId, 'prs'>;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  accent: string;
  accentRgb: string;
}> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, accent: '#818cf8', accentRgb: '129, 140, 248' },
  { id: 'brainstorm', label: 'Brainstorm', icon: Lightbulb, accent: '#38bdf8', accentRgb: '56, 189, 248' },
  { id: 'plans', label: 'Create', icon: ListChecks, accent: '#f59e0b', accentRgb: '245, 158, 11' },
  // Calendar — the schedulable time-surface for scheduled/recurring plans
  // (scheduled-recurring-plans-2026-06-16 P-019). Next to Create (D-001: no separate
  // routines tab — plans are just optionally-scheduled). Workspace-scoped (aggregates
  // every pot's scheduled plans), so it also lives in WORKSPACE_TAB_IDS.
  { id: 'calendar', label: 'Calendar', icon: CalendarClock, accent: '#2dd4bf', accentRgb: '45, 212, 191' },
  // Label "Working" (owner ask 2026-06-11, was "Progress"): the tab is the
  // live-work view (work items / agents / runs for the selected project). The
  // tab ID stays 'harnesses' — it's serialized in URLs (?tab=harnesses), deep
  // links, and the agent ui:dispatch surface; renaming the id would break all
  // of them.
  { id: 'harnesses', label: 'Working', icon: Boxes, accent: '#a78bfa', accentRgb: '167, 139, 250' },
  // Health — the read-only at-a-glance system dashboard (system-health-tab-2026-06-15),
  // beside Working. Workspace-scoped (it aggregates the whole running system, not one
  // pot), so it also lives in WORKSPACE_TAB_IDS. Flag-gated (SYSTEM_HEALTH_TAB).
  { id: 'health', label: 'Health', icon: HeartPulse, accent: '#f43f5e', accentRgb: '244, 63, 94' },
  // (The Overwatch surface moved to the left sidebar next to Queen — its
  // actionable control + anomaly→action list — and its duplicated health grid
  // was dropped in favour of this Health tab. system-health-tab P-008, 2026-06-15.)
  { id: 'frames', label: 'Frames', icon: MonitorPlay, accent: '#22d3ee', accentRgb: '34, 211, 238' },
  { id: 'git', label: 'Git', icon: GitBranch, accent: '#22c55e', accentRgb: '34, 197, 94' },
  { id: 'testing', label: 'Tests', icon: FlaskConical, accent: '#84cc16', accentRgb: '132, 204, 22' },
  { id: 'docs', label: 'Docs', icon: BookOpen, accent: '#60a5fa', accentRgb: '96, 165, 250' },
  { id: 'insights', label: 'Insights', icon: TrendingUp, accent: '#14b8a6', accentRgb: '20, 184, 166' },
  { id: 'conversations', label: 'Conversations', icon: MessageCircle, accent: '#ec4899', accentRgb: '236, 72, 153' },
  { id: 'learning', label: 'Learning', icon: GraduationCap, accent: '#34d399', accentRgb: '52, 211, 153' },
  // Evaluation — the impartial-benchmark surface (impartial-benchmark-suite-2026-06-15
  // D-007). Workspace-scoped (aggregates external benchmark runs across the whole
  // workspace, not one pot), so it also lives in WORKSPACE_TAB_IDS below.
  { id: 'evals', label: 'Evaluation', icon: Trophy, accent: '#eab308', accentRgb: '234, 179, 8' },
  { id: 'settings', label: 'Settings', icon: Settings, accent: '#f97316', accentRgb: '249, 115, 22' },
] as const;

/**
 * Workspace-level tabs — they aggregate across every pot, so they stay
 * visible when the selector is on "All Pots". Every other tab is a per-pot
 * view (one brainstorm canvas, one git repo, one docs tree, …) and is hidden
 * from the strip until a single pot is picked (AdvHarnessPanelPage keeps a
 * pick-one fallback for deep links that land before the snap-back effect).
 */
export const WORKSPACE_TAB_IDS: ReadonlySet<AdvTabId> = new Set<AdvTabId>([
  'overview',
  'plans',
  // Calendar aggregates every pot's scheduled-plan occurrences, not one pot
  // (scheduled-recurring-plans-2026-06-16 P-019), so it stays visible under "All Pots".
  'calendar',
  'harnesses',
  // Health aggregates the whole running system (Queen / bees / tokens / infra),
  // not a single pot — so it stays visible under "All Pots" (system-health-tab).
  'health',
  'conversations',
  // Learning aggregates the workspace-wide papercusp-improvement backlog, so it
  // stays visible under "All Pots" (operator-learning-tab-2026-06-09).
  'learning',
  // Swarm live view aggregates every deployed frame in the workspace
  // (hive-frame-desktops-live-view P-006).
  'frames',
  // Evaluation aggregates external-benchmark runs (all arms × suites) across the
  // whole workspace — it is not a per-pot view (impartial-benchmark-suite D-007).
  'evals',
]);

/** The tab strip for a scope: full strip for a single pot, workspace-level subset under "All Pots". */
export function visibleAdvTabs(allMode: boolean): typeof ADV_TABS {
  return allMode ? ADV_TABS.filter((t) => WORKSPACE_TAB_IDS.has(t.id)) : ADV_TABS;
}

type HarnessProjectLite = {
  slug: string;
  path?: string;
  hasState?: boolean;
  hasSpec?: boolean;
  // P-012: lite payload surfaces hive_slug (authoritative Hive membership,
  // shared-hive-federation) + parent_slug (legacy) + harness_kind so the
  // selector renders the Hive tree without paying for /projects.
  hive_slug?: string | null;
  parent_slug?: string | null;
  harness_kind?: string | null;
  // Whether the harness has been shared (a `.papercusp/shared.json` exists).
  // Drives the header's Share button → Shared badge swap.
  is_shared?: boolean;
};

/**
 * Which side(s) of the tab strip have tabs scrolled out of view (owner ask
 * 2026-06-15 #1). Pure so the indicator logic is unit-testable without layout.
 * `left`/`right` true ⇒ there are hidden tabs that way (fade + chevron shown).
 * The 1px epsilon absorbs sub-pixel scroll rounding.
 */
export function tabOverflowState(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { left: boolean; right: boolean } {
  const max = scrollWidth - clientWidth;
  return { left: scrollLeft > 1, right: scrollLeft < max - 1 };
}

export default function AdvShell({
  title = 'Advanced',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  // Active brand-pack term resolver (the-hive-lexicon). Reactive to the flag.
  const t = useLexicon();
  const [activeTab, setActiveTab] = useQueryState(
    'tab',
    // Overview is the default landing surface (Brief 23 /
    // overview-dashboard-2026-06-05 D-001). Keep in sync with the
    // parser in routes/adv/index.tsx.
    parseAsStringEnum<AdvTabId>([...ADV_TAB_IDS]).withDefault('overview'),
  );
  // Tab strip overflows on narrow viewports. Only scroll into view when
  // the active tab is actually clipped — otherwise we'd scroll AWAY from
  // tabs the user can already see (the first wrong version of this
  // effect scrolled `brainstorm` to centre on /adv and pushed `harnesses`
  // off-screen to the left).
  const tablistRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const list = tablistRef.current;
    if (!list) return;
    const trigger = list.querySelector<HTMLElement>(`.pc-advshell__tab--${activeTab}`);
    if (!trigger) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = trigger.getBoundingClientRect();
    const PAD = 8;
    const clippedLeft = tabRect.left < listRect.left + PAD;
    const clippedRight = tabRect.right > listRect.right - PAD;
    if (!clippedLeft && !clippedRight) return;
    try {
      trigger.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    } catch {
      /* best effort */
    }
  }, [activeTab]);
  // Tab-strip overflow indicator (owner ask 2026-06-15 #1): when tabs overflow a
  // narrow window they were silently clipped with no affordance. Track which
  // side is scrolled-away so the render can fade that edge + show a scroll
  // chevron — "there are more tabs over here, click/scroll to reach them".
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  const updateTabOverflow = useCallback(() => {
    const list = tablistRef.current;
    if (!list) return;
    setTabOverflow(tabOverflowState(list.scrollLeft, list.scrollWidth, list.clientWidth));
  }, []);
  useEffect(() => {
    const list = tablistRef.current;
    if (!list) return;
    updateTabOverflow();
    list.addEventListener('scroll', updateTabOverflow, { passive: true });
    // ResizeObserver catches window/layout width changes; MutationObserver
    // catches the visible tab set changing (workspace scope hides/shows tabs),
    // which changes scrollWidth without a size change RO would see.
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateTabOverflow()) : null;
    ro?.observe(list);
    const mo =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(() => updateTabOverflow()) : null;
    mo?.observe(list, { childList: true });
    window.addEventListener('resize', updateTabOverflow);
    return () => {
      list.removeEventListener('scroll', updateTabOverflow);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener('resize', updateTabOverflow);
    };
  }, [updateTabOverflow]);
  // A chevron click nudges the strip ~70% of a screenful toward the hidden tabs.
  const scrollTabs = useCallback((dir: 1 | -1) => {
    const list = tablistRef.current;
    if (!list) return;
    list.scrollBy({ left: dir * Math.max(140, list.clientWidth * 0.7), behavior: 'smooth' });
  }, []);
  const [activeSlug, setActiveSlug] = useQueryState('slug', parseAsString);
  // The Harnesses-tab member axis (`?harness=`). The shell only WRITES it on an
  // into-hive create (focus the new member in the rail, P-011 contract) — the
  // tab owns reading it. Mirrors HarnessesWorkspace.handleCreated.
  const [, setActiveHarness] = useQueryState('harness', parseAsString);
  // P-015: scope axis. 'expanded' (default) means consumers UNION the
  // selected slug + its sub-harnesses; 'self' narrows to just the picked
  // slug; 'all' spans every harness in the workspace (the selector's
  // "All harnesses" option). URL-round-tripped so the choice survives
  // refresh + tab switches. Enum is shared so all readers agree.
  const [scopeMode, setScopeMode] = useQueryState(
    'scope',
    parseAsStringEnum<HarnessScopeMode>([...HARNESS_SCOPE_MODES]).withDefault('expanded'),
  );
  const [projects, setProjects] = useState<HarnessProjectLite[]>([]);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  // Workspace display name for the selector's root-group header (falls back to
  // the raw id until the registry read lands).
  const workspaceLabel = useWorkspaceLabel();
  // Create-harness flow. The dialog open-state is URL-backed (nuqs) so it
  // survives refresh and is agent-controllable; `refreshNonce` re-runs the
  // project fetch once a harness is created so the selector picks it up.
  const [createOpen, setCreateOpen] = useQueryState('create', parseAsBoolean.withDefault(false));
  // Share the currently-selected harness. URL-backed so it survives refresh
  // and is agent-controllable; only meaningful when a slug is active.
  const [shareOpen, setShareOpen] = useQueryState('share', parseAsBoolean.withDefault(false));
  const [refreshNonce, setRefreshNonce] = useState(0);
  // The persisted-selection restore runs at most once per mount. Setting the
  // slug below re-triggers this effect (activeSlug is a dep); the ref keeps
  // the re-run from re-restoring (or fighting a user's later pick).
  const restoredSelectionRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/harness/projects/lite', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(async (d) => {
        if (cancelled) return;
        const nextProjects = Array.isArray(d?.projects) ? d.projects : [];
        setProjects(nextProjects);
        setProjectLoadError(null);
        if (restoredSelectionRef.current || !nextProjects.length) return;
        restoredSelectionRef.current = true;
        // Restore the persisted harness selection so the selector + tab strip
        // inherit the last harness the user picked (persisted to localStorage
        // on every selector change). resolveAdvHarnessSelection encodes the
        // precedence: explicit ?slug= wins, else a persisted concrete harness
        // (→ scope=expanded, full tab strip), else All-harnesses.
        const persisted =
          typeof window !== 'undefined'
            ? window.localStorage.getItem(wsLocalKey('harness.activeProject'))
            : null;
        const decision = resolveAdvHarnessSelection({
          projectSlugs: nextProjects.map((p: HarnessProjectLite) => p.slug),
          urlSlug: activeSlug,
          persisted,
        });
        // Apply the two writes SEQUENTIALLY (await between them). The custom
        // nuqs adapter merges each write over the live `window.location.search`,
        // so two same-tick writes both snapshot the pre-write URL and the later
        // flush clobbers the earlier — a concurrent slug+scope restore kept only
        // the slug and left a stale `scope=all`, so the strip stayed collapsed.
        // Awaiting serializes them; scope is written last so it's authoritative
        // for allMode. (No `cancelled` guard between them: the slug write
        // re-triggers this effect and cancels THIS closure, but the restore is
        // one logical unit that must finish.)
        if (decision.setSlug) await setActiveSlug(decision.setSlug);
        if (decision.setScope) await setScopeMode(decision.setScope);
      })
      .catch((e) => {
        if (!cancelled) setProjectLoadError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [activeSlug, setActiveSlug, setScopeMode, refreshNonce]);

  // "All harnesses" mode: list views (Plans, Sessions) span the whole
  // workspace. The single-harness widgets (Share, now-running, Discord)
  // have no single target, so blank them out.
  const allMode = scopeMode === 'all';
  const singleSlug = allMode ? null : activeSlug;
  const activeProject = singleSlug ? projects.find((p) => p.slug === singleSlug) : undefined;
  // Sharing happens at the HIVE level (comb-retire-per-harness-sharing-2026-06-11):
  // the header Share affordance publishes the active hive to the P2P directory.
  // `is_shared` (a legacy `.papercusp/shared.json` per-harness share) only
  // surfaces as a passive badge — no new per-harness shares can be created.
  const activeIsHive = activeProject?.harness_kind === 'hive';
  const activeIsShared = !!activeProject?.is_shared;

  // Tab visibility follows scope: under "All Pots" only the workspace-level
  // tabs (Overview/Create/Harnesses/Conversations) make sense, so the per-pot
  // tabs (Docs/Config/Insights/…) are hidden rather than rendering a
  // pick-a-pot placeholder (owner directive 2026-06-05). An earlier version
  // collapsed the all-mode strip to just TWO tabs, which read as "the strip
  // broke" — the workspace-level subset plus the snap-back below avoids that.
  // Health is flag-gated (SYSTEM_HEALTH_TAB, default ON): hide its strip entry
  // when off (the kill-switch — the resolver/tick also no-op).
  const healthOn = useFlag(FLAGS.SYSTEM_HEALTH_TAB);
  const baseVisibleTabs = visibleAdvTabs(allMode).filter((tab) => tab.id !== 'health' || healthOn);
  // Under "All Pots" the per-pot tabs are normally hidden from the strip. But if
  // the user flips to "All" while parked ON a per-pot tab, KEEP that tab pinned +
  // highlighted (instead of snapping to Overview) so its body can show the
  // "pick a {pot} from the dropdown" prompt — restoring the empty-state the old
  // snap-back used to swallow (owner ask 2026-06-17). Appended only when the
  // active tab isn't already a workspace tab in the strip.
  const activeTabDef = ADV_TABS.find((tab) => tab.id === activeTab);
  const visibleTabs =
    allMode && activeTabDef && !baseVisibleTabs.some((tab) => tab.id === activeTab)
      ? [...baseVisibleTabs, activeTabDef]
      : baseVisibleTabs;

  // ── Discord-parity keyboard handlers (discord-shortcuts 2026-06-06) ──────
  // Alt+↑/↓ cycles the visible tab strip (Discord's prev/next channel);
  // Mod+Alt+←/→ cycles harnesses (Discord's server switcher); Mod+I jumps to
  // Conversations and Mod+Shift+N opens the create dialog IN PLACE. The root
  // GlobalAppShortcuts registers navigate-here fallbacks for the last two —
  // the shortcut bus runs the most-recently-registered handler, so these
  // win while /adv is mounted and the fallbacks cover every other route.
  const navKeyOpts = { enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] as const };
  const cycleTab = (dir: 1 | -1) => {
    const idx = visibleTabs.findIndex((tab) => tab.id === activeTab);
    const next = visibleTabs[(idx + dir + visibleTabs.length) % visibleTabs.length];
    if (next && next.id !== activeTab) void setActiveTab(next.id);
  };
  useShortcutAction('goto.prevTab', () => cycleTab(-1), navKeyOpts);
  useShortcutAction('goto.nextTab', () => cycleTab(1), navKeyOpts);

  const cycleHarness = async (dir: 1 | -1) => {
    if (projects.length === 0) return;
    const slugs = projects.map((p) => p.slug);
    const idx = activeSlug ? slugs.indexOf(activeSlug) : -1;
    const next =
      idx === -1
        ? dir === 1
          ? slugs[0]
          : slugs[slugs.length - 1]
        : slugs[(idx + dir + slugs.length) % slugs.length];
    if (!next || next === activeSlug) return;
    // Mirror the selector's onChange exactly: exit all-mode FIRST and
    // SEQUENTIALLY (a same-tick scope+slug pair collides in the nuqs
    // adapter and the scope write is lost), then set + persist the pick.
    if (allMode) await setScopeMode('expanded');
    await setActiveSlug(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(wsLocalKey('harness.activeProject'), next);
    }
  };
  useShortcutAction('harness.prev', () => void cycleHarness(-1), navKeyOpts);
  useShortcutAction('harness.next', () => void cycleHarness(1), navKeyOpts);

  // In-place versions of the root fallbacks (see GlobalAppShortcuts).
  // 'conversations' is a workspace-level tab, so it's valid in both scopes.
  useShortcutAction('goto.inbox', () => void setActiveTab('conversations'));
  useShortcutAction('harness.create', () => void setCreateOpen(true));

  return (
    <div className="pc-advshell">
      <header className="pc-advshell__header">
        {/* Combined row: title · selector · status bar · action buttons */}
        <div className="pc-advshell__header-top">
          <div className="pc-advshell__copy">
            <span className="pc-advshell__kicker">Advanced orchestration</span>
            <h1>{title}</h1>
          </div>
          {/* Pot label + selector + sub-pot toggle + New + Share — all inline */}
          <div className="pc-advshell__selector">
            <span className="pc-advshell__selector-label">{t('pot')}</span>
            <Select
              value={allMode ? ALL_HARNESSES_OPTION : (activeSlug ?? '')}
              onChange={async (next) => {
                if (next === '__loading') return;
                if (next === ALL_HARNESSES_OPTION) {
                  // Route "all" to the scope axis — leave ?slug= holding the
                  // last real harness so switching back is one click. Persist
                  // the ALL choice too so a fresh load restores it (the
                  // projects/lite effect replays this on load).
                  void setScopeMode('all');
                  if (typeof window !== 'undefined') {
                    window.localStorage.setItem(
                      wsLocalKey('harness.activeProject'),
                      ALL_HARNESSES_OPTION,
                    );
                  }
                  return;
                }
                // Picking a concrete harness exits "all" mode, back to the
                // sub-harness-union default so the choice actually scopes views.
                // SEQUENTIAL (await): the custom nuqs adapter merges each write
                // over the live search, so a same-tick scope+slug pair collides
                // and the scope write is lost — the pick would stay stranded in
                // all-mode. Exit all-mode first, then set the slug.
                if (allMode) await setScopeMode('expanded');
                await setActiveSlug(next);
                if (next && typeof window !== 'undefined') {
                  window.localStorage.setItem(wsLocalKey('harness.activeProject'), next);
                }
              }}
              disabled={projects.length === 0}
              ariaLabel={`Select ${t('pot')}`}
              placeholder={projectLoadError ? `Failed to load ${t('pot', { plural: true })}` : `Select ${t('pot')}`}
              options={buildHarnessSelectOptions(projects, projectLoadError, t('pot', { plural: true }), workspaceLabel)}
              triggerClassName="pc-advshell__select-trigger"
            />
            {/* Sub-harness union is meaningless under "all" (everything is
                already included), so the toggle only shows for a single pick. */}
            {!allMode && (
              <label className="pc-advshell__scope-toggle" title={`Include sub-${t('pot', { plural: true, lower: true })} in list views (plans, sessions). Editor views still focus a single ${t('pot')}.`}>
                <input
                  type="checkbox"
                  checked={scopeMode === 'expanded'}
                  onChange={(e) => void setScopeMode(e.target.checked ? 'expanded' : 'self')}
                />
                <span>sub-{t('pot', { plural: true, lower: true })}</span>
              </label>
            )}
            <button
              type="button"
              className="pc-advshell__action pc-advshell__action--new"
              title={`Create or add a new ${t('pot')}`}
              onClick={() => void setCreateOpen(true)}
            >
              <Plus size={13} aria-hidden /> New
            </button>
            {!allMode && activeSlug && activeIsHive && (
              <button
                type="button"
                className="pc-advshell__action pc-advshell__action--share"
                title={`Share ${activeSlug} — publish the hive to the P2P directory so others can join`}
                onClick={() => void setShareOpen(true)}
              >
                <Share2 size={13} aria-hidden /> Share
              </button>
            )}
            {!allMode && activeSlug && !activeIsHive && activeIsShared && (
              <span
                className="pc-advshell__action pc-advshell__action--shared"
                title={`${activeSlug} carries a legacy per-harness share (shared.json) — sharing now happens at the hive level`}
              >
                <Check size={13} aria-hidden /> Shared
              </span>
            )}
          </div>
          {/* Always-visible central hive control (hive-control-surface): the
              "N running" pill + click-to-expand per-hive start/stop, so hive
              state is visible/flippable from the header, not just inside a hive. */}
          <HivesRunningPill />
          {/* Inline status: dot + label + pills + start/stop */}
          <AdvNowRunning slug={singleSlug} />
          <DiscordBadge slug={singleSlug} />
        </div>

        {/* Tab strip */}
        <Tabs.Root
          value={activeTab}
          onValueChange={(value) => void setActiveTab(value as AdvTabId)}
          className="pc-advshell__tabs"
          data-of-left={tabOverflow.left ? '' : undefined}
          data-of-right={tabOverflow.right ? '' : undefined}
        >
          {/* Tab-strip overflow chevrons (owner ask 2026-06-15 #1) — shown only
              when tabs are clipped on that side; click to scroll to the hidden
              ones. The CSS also fades the clipped edge so it reads at a glance. */}
          <button
            type="button"
            className="pc-advshell__tabnav pc-advshell__tabnav--left"
            aria-label="Scroll tabs left to hidden tabs"
            tabIndex={-1}
            onClick={() => scrollTabs(-1)}
          >
            ‹
          </button>
          <Tabs.List ref={tablistRef} className="pc-advshell__tablist" aria-label="Adv sections">
            {visibleTabs.map((t) => {
              const Icon = t.icon;
              return (
                <Tabs.Trigger
                  key={t.id}
                  value={t.id}
                  title={t.label}
                  className={`pc-advshell__tab pc-advshell__tab--${t.id}`}
                  style={{
                    '--h-main-tab-accent': t.accent,
                    '--h-main-tab-accent-rgb': t.accentRgb,
                  } as CSSProperties}
                >
                  <Icon size={13} aria-hidden />
                  <span className="pc-advshell__tab-label">{t.label.toLowerCase()}</span>
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
          <button
            type="button"
            className="pc-advshell__tabnav pc-advshell__tabnav--right"
            aria-label="Scroll tabs right to hidden tabs"
            tabIndex={-1}
            onClick={() => scrollTabs(1)}
          >
            ›
          </button>
          {/* a11y (aria-valid-attr-value): AdvShell renders panel content
              imperatively in `pc-advshell__body` below — NOT via Radix
              Tabs.Content — so each Trigger's auto-generated `aria-controls`
              would point at a content panel that never mounts (a dangling
              idref axe flags as critical). Render hidden, force-mounted
              Content stubs so the referenced ids exist and resolve. */}
          {visibleTabs.map((t) => (
            <Tabs.Content key={t.id} value={t.id} forceMount style={{ display: 'none' }} />
          ))}
        </Tabs.Root>
      </header>
      <CreateHarnessPicker
        open={createOpen}
        onOpenChange={(o: boolean) => void setCreateOpen(o)}
        // EI-319: the removed bottom-right FAB was the only opener that passed a
        // hive scope, so the header "New" button (now the primary opener) lost
        // the into-hive "Add to <hive>" mode. Restore it when scoped to a single
        // hive — mirrors how the share modal below already takes activeSlug.
        // all-mode has no scope ⇒ null ⇒ New-hive/Standalone only.
        //
        // Gate on activeIsHive, NOT just a non-null activeSlug: the `?slug=` URL
        // param outlives the entity, so a removed hive (slug no longer in
        // `projects`) or a non-hive active harness would still enable the "Add to
        // <X>" fork. Submitting that posts `intoHive=<X>`, which the backend
        // rejects as `hive_not_found` ("The selected hive wasn't found — it may
        // have been removed"), blocking the headline new-hive create from a stale
        // scope. activeIsHive already requires activeProject to exist AND be
        // kind:'hive' (line ~318), exactly the backend's into-hive precondition.
        hiveScope={activeIsHive ? activeSlug : null}
        onCreated={(slug: string, opts?: { hive?: string }) => {
          setRefreshNonce((n) => n + 1);
          if (opts?.hive && opts.hive === activeSlug) {
            // Added INTO the active hive (P-011): keep ?slug= on the hive, focus
            // the new member via ?harness= — same contract as HarnessesWorkspace.
            void setActiveHarness(slug);
          } else {
            // A new hive / standalone harness becomes the focused scope.
            void setActiveSlug(slug);
            void setActiveHarness(null);
            if (typeof window !== 'undefined') {
              window.localStorage.setItem(wsLocalKey('harness.activeProject'), slug);
            }
          }
        }}
      />
      {shareOpen && !allMode && activeSlug && activeIsHive && (
        <Modal
          open={shareOpen}
          onOpenChange={(v) => {
            if (!v) {
              void setShareOpen(false);
              // Re-fetch projects/lite so a just-completed publish is reflected.
              setRefreshNonce((n) => n + 1);
            }
          }}
          title={`Share ${activeSlug}`}
          contentStyle={{
            width: 'min(480px, 96vw)',
            background: 'var(--bg-popover, #0d1829)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 24,
            color: 'var(--fg, #e8e8ea)',
          }}
        >
          <PublishHiveCard hiveSlug={activeSlug} />
        </Modal>
      )}
      <div className="pc-advshell__body">{children}</div>
      <style>{`
        .pc-advshell {
          display: flex;
          flex-direction: column;
          /* Viewport-bounded (NOT min-height) so the shell never grows past
             the window. This makes the per-tab content panes the real
             scrollers — without it the whole shell grows and the WINDOW
             scrolls, which defeats every inner sticky/overflow pane (e.g.
             the Plans preview pane never sticks). */
          height: calc(100vh - 56px);
          min-height: 0;
          background:
            radial-gradient(circle at top left, color-mix(in oklab, var(--accent, #38bdf8), transparent 91%), transparent 30%),
            linear-gradient(180deg, var(--bg, #07101d), #04111b);
        }
        .pc-advshell__header {
          display: flex;
          flex-direction: column;
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.15));
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.025);
        }
        .pc-advshell__header-top {
          display: flex;
          align-items: center;
          gap: 14px;
          min-width: 0;
          padding: 8px 12px;
        }
        .pc-advshell__copy { display: grid; gap: 4px; min-width: 0; }
        .pc-advshell__kicker {
          color: color-mix(in oklab, var(--accent-strong, var(--accent-soft)), transparent 26%);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.11em;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-advshell__header h1 {
          margin: 0;
          font-size: 22px;
          font-weight: 760;
          line-height: 1;
          letter-spacing: -0.02em;
          color: var(--fg, #e7f7ff);
        }
        .pc-advshell__selector {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .pc-advshell__selector-label {
          color: var(--fg-mute, #7f9bb4);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.09em;
          line-height: 1;
          text-transform: uppercase;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .pc-advshell__scope-toggle {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          text-transform: none;
          letter-spacing: normal;
          font-size: 9.5px;
          font-weight: 600;
          color: var(--fg-mute, #7f9bb4);
          cursor: pointer;
        }
        .pc-advshell__scope-toggle input {
          margin: 0;
          width: 12px;
          height: 12px;
          cursor: pointer;
          accent-color: var(--accent, #38bdf8);
        }
        .pc-advshell__select-trigger {
          display: inline-flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 34px;
          min-width: 190px;
          border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32));
          border-radius: 10px;
          background: var(--bg-popover, #0d1829);
          color: var(--fg, #e7f7ff);
          font-size: 12px;
          font-weight: 650;
          padding: 0 11px;
          cursor: pointer;
          outline: none;
        }
        .pc-advshell__select-trigger[data-disabled] {
          color: var(--fg-mute, #7f9bb4);
          cursor: default;
        }
        .pc-advshell__action {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 5px 10px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          border-radius: 6px;
          border: 1px solid transparent;
          cursor: pointer;
          flex-shrink: 0;
        }
        .pc-advshell__action:disabled {
          opacity: 0.55;
          cursor: default;
        }
        .pc-advshell__action--start {
          background: rgba(34, 197, 94, 0.16);
          color: #86efac;
          border-color: rgba(34, 197, 94, 0.38);
        }
        .pc-advshell__action--start:hover:not(:disabled) {
          background: rgba(34, 197, 94, 0.26);
        }
        .pc-advshell__action--stop {
          background: rgba(239, 68, 68, 0.12);
          color: #fca5a5;
          border-color: rgba(239, 68, 68, 0.34);
        }
        .pc-advshell__action--stop:hover {
          background: rgba(239, 68, 68, 0.22);
        }
        .pc-advshell__action--new {
          background: rgba(167, 139, 250, 0.16);
          color: #c4b5fd;
          border-color: rgba(167, 139, 250, 0.4);
        }
        .pc-advshell__action--new:hover {
          background: rgba(167, 139, 250, 0.28);
          color: #e7f7ff;
        }
        .pc-advshell__action--share {
          background: color-mix(in srgb, var(--accent), transparent 86%);
          color: var(--accent-soft);
          border-color: color-mix(in srgb, var(--accent), transparent 62%);
        }
        .pc-advshell__action--share:hover {
          background: color-mix(in srgb, var(--accent), transparent 74%);
          color: #e7f7ff;
        }
        /* Shared = a non-interactive status badge (green "done" tint) shown in
           place of the Share button once the harness has been shared. */
        .pc-advshell__action--shared {
          background: rgba(34, 197, 94, 0.16);
          color: #86efac;
          border-color: rgba(34, 197, 94, 0.4);
          cursor: default;
        }
        /* Amber "N plans waiting" nudge — started plans with no running
           harness to pick them up. Matches the Plans tab's amber accent. */
        .pc-advshell__action--waiting {
          background: rgba(245, 158, 11, 0.14);
          color: #fcd34d;
          border-color: rgba(245, 158, 11, 0.4);
        }
        .pc-advshell__action--waiting:hover {
          background: rgba(245, 158, 11, 0.24);
          color: #fde68a;
        }
        .pc-advshell__pills {
          display: flex;
          gap: 4px;
          min-width: 0;
          overflow: hidden;
        }
        .pc-advshell__pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px;
          font-size: 11px;
          color: rgba(220, 214, 248, 0.86);
          background: rgba(20, 18, 38, 0.7);
          border: 1px solid rgba(167, 139, 250, 0.28);
          border-radius: 999px;
          cursor: default;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 200px;
        }
        .pc-advshell__pill:hover {
          background: rgba(31, 23, 56, 0.96);
          border-color: rgba(167, 139, 250, 0.5);
        }
        .pc-advshell__pill-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #86efac;
          box-shadow: 0 0 8px rgba(134, 239, 172, 0.6);
          flex-shrink: 0;
          animation: pc-advshell-pulse 1.6s ease-in-out infinite;
        }
        @keyframes pc-advshell-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .pc-advshell__idle {
          font-size: 11px;
          font-style: italic;
          color: rgba(220, 214, 248, 0.5);
          white-space: nowrap;
        }

        /* ── Harness status bar (inline in header row) ───────────────── */
        .pc-advshell__harness-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;
          padding-left: 10px;
          margin-left: 2px;
          border-left: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        }
        .pc-advshell__harness-status {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }
        .pc-advshell__harness-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
          background: #475569;
        }
        .pc-advshell__harness-bar--is-active .pc-advshell__harness-dot {
          background: #4ade80;
          box-shadow: 0 0 7px rgba(74, 222, 128, 0.5);
          animation: pc-advshell-pulse 2s ease-in-out infinite;
        }
        .pc-advshell__harness-label {
          font-size: 11px;
          font-weight: 650;
          color: var(--fg-mute, #7f9bb4);
          white-space: nowrap;
        }
        .pc-advshell__harness-bar--is-active .pc-advshell__harness-label {
          color: #86efac;
        }

        .pc-advshell__tabs { position: relative; min-width: 0; display: flex; align-items: flex-end; padding: 0 12px; }
        .pc-advshell__tab-label { display: inline; }
        .pc-advshell__tablist {
          display: inline-flex;
          align-items: flex-end;
          gap: 6px;
          min-width: 0;
          max-width: 100%;
          overflow-x: auto;
          overflow-y: hidden;
          overscroll-behavior-x: contain;
          scrollbar-width: none;
          -webkit-overflow-scrolling: touch;
          padding: 0;
        }
        .pc-advshell__tablist::-webkit-scrollbar {
          display: none;
        }
        /* Tab-strip overflow affordance (owner ask 2026-06-15 #1). When tabs are
           clipped, fade the clipped edge (a background-independent CSS mask, with
           the -webkit- prefix for the WebKitGTK desktop) so it reads "there are
           more tabs"; the chevron buttons below give a click-to-scroll. */
        .pc-advshell__tabs[data-of-left][data-of-right] .pc-advshell__tablist {
          -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 26px, #000 calc(100% - 26px), transparent 100%);
          mask-image: linear-gradient(90deg, transparent 0, #000 26px, #000 calc(100% - 26px), transparent 100%);
        }
        .pc-advshell__tabs[data-of-left]:not([data-of-right]) .pc-advshell__tablist {
          -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 26px);
          mask-image: linear-gradient(90deg, transparent 0, #000 26px);
        }
        .pc-advshell__tabs:not([data-of-left])[data-of-right] .pc-advshell__tablist {
          -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 26px), transparent 100%);
          mask-image: linear-gradient(90deg, #000 calc(100% - 26px), transparent 100%);
        }
        .pc-advshell__tabnav {
          position: absolute;
          top: 0;
          bottom: 1px;
          z-index: 3;
          display: none;
          align-items: center;
          width: 26px;
          padding: 0;
          border: none;
          background: none;
          color: var(--fg-dim, #b9d4e8);
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          transition: color var(--dur-fast, 120ms) var(--ease-out, ease);
        }
        .pc-advshell__tabnav:hover { color: var(--fg, #e7f7ff); }
        .pc-advshell__tabnav--left { left: 12px; justify-content: flex-start; }
        .pc-advshell__tabnav--right { right: 12px; justify-content: flex-end; }
        .pc-advshell__tabs[data-of-left] .pc-advshell__tabnav--left { display: inline-flex; }
        .pc-advshell__tabs[data-of-right] .pc-advshell__tabnav--right { display: inline-flex; }
        .pc-advshell__tab {
          position: relative;
          flex: 0 0 auto;
          scroll-snap-align: start;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 34px;
          margin-bottom: -1px;
          padding: 9px 14px 10px;
          border: 1px solid transparent;
          border-bottom: 1px solid transparent;
          border-radius: 10px 10px 0 0;
          background:
            radial-gradient(circle at 18% 0%, rgba(var(--h-main-tab-accent-rgb), 0.12), transparent 72%),
            linear-gradient(180deg, rgba(var(--h-main-tab-accent-rgb), 0.080), rgba(3, 10, 20, 0.98));
          border-color: rgba(var(--h-main-tab-accent-rgb), 0.28);
          color: color-mix(in oklab, var(--fg-dim, #b9d4e8), var(--h-main-tab-accent) 18%);
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          cursor: pointer;
          transition: color var(--dur-fast, 120ms) var(--ease-out, ease), border-color var(--dur-fast, 120ms) var(--ease-out, ease), background-color var(--dur-fast, 120ms) var(--ease-out, ease);
        }
        .pc-advshell__tab:hover {
          color: var(--fg, #e7f7ff);
        }
        .pc-advshell__tab:focus-visible {
          color: var(--fg, #e7f7ff);
          outline: 1px solid color-mix(in oklab, var(--accent, #38bdf8), white 16%);
          outline-offset: -2px;
        }
        .pc-advshell__tab[aria-selected='true'],
        .pc-advshell__tab[data-state='active'] {
          color: var(--fg, #e7f7ff);
          background: rgba(var(--h-main-tab-accent-rgb), 0.22);
          border-color: rgba(var(--h-main-tab-accent-rgb), 0.68);
          border-bottom-color: color-mix(in oklab, var(--bg-2, rgba(255, 255, 255, 0.045)), white 3%);
          box-shadow: 0 -8px 22px rgba(0, 0, 0, 0.16);
        }
        .pc-advshell__tab[aria-selected='true']::after,
        .pc-advshell__tab[data-state='active']::after {
          content: "";
          position: absolute;
          left: 12px;
          right: 12px;
          bottom: 2px;
          height: 2px;
          border-radius: 999px;
          background: linear-gradient(90deg, var(--h-main-tab-accent), color-mix(in oklab, var(--h-main-tab-accent), white 28%));
          box-shadow: 0 0 14px color-mix(in oklab, var(--h-main-tab-accent), transparent 54%);
        }
        /* Fallback scroller: tabs that lay out their own internal overflow
           panes (Plans, Sessions) scroll there; tabs that don't (Brainstorm,
           Insights) scroll here instead of growing the shell + window. */
        .pc-advshell__body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }

        /* Flat in-page buttons. Action buttons / pills inside the page body
           get NO embossed bevel, raised drop-shadow, glow, or hover-lift —
           those "3D" treatments are hard to read. The large top tab strip
           lives in .pc-advshell__header (page-level nav, a different
           category) and is intentionally NOT affected. Focus-visible rings
           are preserved for keyboard a11y. See /internal/docs/design#buttons. */
        .pc-advshell__body :is(button, [role="button"]):not(:focus-visible) {
          box-shadow: none !important;
        }
        .pc-advshell__body :is(button, [role="button"]):hover,
        .pc-advshell__body :is(button, [role="button"]):active {
          transform: none !important;
        }
      `}</style>
    </div>
  );
}

/**
 * Build the selector option list as a Workspace → Hive → member tree
 * (workspace-hive-ui-2026-06-17): an "All harnesses" row first, then a single
 * group whose label is the WORKSPACE (a non-selectable root header), holding
 * each Hive (depth 0) with its member harnesses indented beneath it ("  ↳ ").
 *
 * Membership is the AUTHORITATIVE Hive grouping — `groupByHive` over `hive_slug`
 * (the shared-hive-federation field), with the legacy `parent_slug` as fallback.
 * The old build keyed off bare `parent_slug`, which almost no Hive carries, so
 * everything rendered flat. Concrete picks stay single-slug; the scope toggle
 * decides subtree UNION, and the "All harnesses" row flips ?scope=all.
 *
 * Exported for unit tests.
 */
export function buildHarnessSelectOptions(
  projects: HarnessProjectLite[],
  projectLoadError: string | null,
  // The plural label for the "All …" row ("Pots" | "Hives"), from the brand pack.
  // Defaults to the classic label so callers/tests that don't thread it are unchanged.
  potPlural = 'Pots',
  // The workspace root-group header. Defaults to a generic label.
  workspaceLabel = 'Workspace',
): SelectEntry[] {
  if (projects.length === 0) {
    return [{
      value: '__loading',
      label: projectLoadError ? `Failed to load ${potPlural}` : `Loading ${potPlural}…`,
      disabled: true,
    }];
  }

  // Authoritative Hive grouping (hive_slug → home, parent_slug fallback; a
  // kind:'hive' home is its own root). groupByHive sorts roots + members.
  //
  // A `kind:'hive'` home is repo-LESS plumbing (it owns the Queen + federation
  // identity, never code) — so we never surface it as a node by its raw
  // `<name>-hive` slug. The hive is presented by a friendly name; `value` stays
  // the home slug so `?slug=` still scopes to the hive (backend unchanged):
  //   • single-member hive (the common create-from-repo case) — the hive IS that
  //     one repo, so it collapses to ONE row labeled by the repo (no `-hive`, no
  //     redundant member row).
  //   • multi-member hive — a friendly hive header (`-hive` suffix stripped) +
  //     the member repos beneath it.
  //   • a legacy/standalone root (a real harness that is its own hive) is shown
  //     as-is — it carries its own content, so it stays a real node.
  const tree: SelectOption[] = [];
  for (const group of groupByHive(projects)) {
    const root = group.root;
    const members = group.members.filter((m) => m.slug !== root.slug);
    // A kind:'hive' home is repo-LESS plumbing — never show its raw `<x>-hive`
    // slug. Label it by the stripped hive name; `value` stays the home slug so
    // `?slug=` still scopes to the hive (backend unchanged). A legacy/standalone
    // root (a real harness that is its own hive) keeps its slug.
    const rootLabel = root.harness_kind === 'hive' ? root.slug.replace(/-hive$/, '') : root.slug;
    tree.push({ value: root.slug, label: rootLabel });
    for (const member of members) {
      // Single-repo collapse: a `<x>-hive` home whose one member is the repo `<x>`
      // — the hive IS that repo, so drop the redundant `↳ <x>` row (the `<x>`
      // header already stands for it; selecting it scopes to the hive).
      if (root.harness_kind === 'hive' && member.slug === rootLabel) continue;
      tree.push({ value: member.slug, label: `  ↳ ${member.slug}` });
    }
  }

  // "All …" leads (flips ?scope=all); the workspace is the non-selectable root
  // header above the Hive → member tree.
  return [
    { value: ALL_HARNESSES_OPTION, label: `All ${potPlural}` },
    { kind: 'group', label: workspaceLabel, options: tree },
  ];
}
