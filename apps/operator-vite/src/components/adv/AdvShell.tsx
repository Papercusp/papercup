import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import {
  HARNESS_SCOPE_MODES,
  resolveHarnessScope,
  type HarnessScopeMode,
} from '@papercusp/operator-core/lib/harness/scope';
import * as Tabs from '@radix-ui/react-tabs';
import { Command as CmdK } from 'cmdk';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import {
  BookOpen,
  BarChart3,
  Boxes,
  CalendarClock,
  Check,
  ChevronDown,
  FlaskConical,
  Gauge,
  GitBranch,
  GraduationCap,
  HeartPulse,
  History as HistoryIcon,
  LayoutDashboard,
  ListChecks,
  MessageCircle,
  MonitorPlay,
  Settings,
  TrendingUp,
  Trophy,
  Workflow,
} from 'lucide-react';
import type { SelectEntry, SelectOption } from '@/app/harness/Select';
import { Popover } from '@/app/harness/Popover';
import { groupByHive } from '@papercusp/operator-core/lib/harness/hive-groups';
import { hiveHomeLabel } from '@/lib/hive-label';
import { CreateHarnessPicker } from '@/app/harness/CreateHarnessPicker';
import { Modal } from '@/app/harness/Modal';
import { PublishPotCard } from '@/app/harness/PublishPotCard';
import { ALL_HARNESSES_OPTION, resolveAdvHarnessSelection } from './adv-harness-selection';
import { useShortcutAction } from '@/lib/hotkeys';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { CATEGORICAL } from '@/app/harness/theme';
// PotsRunningPill ("▶ N POT running") was the first pill in this strip until
// 2026-08-10, when it was deleted by owner directive ([owner 2026-08-10]
// "remove the ... 'pots running' button", retire-mug-kettle-su-only-2026-08-09
// P-075) — it expanded a per-pot start/stop control, i.e. the retired
// autonomous tier (D-010). It had a second mount in QuickPanelHeaderControls;
// both went together.
import AgentsRunningPill from './AgentsRunningPill';
import TasksRunningPill from './TasksRunningPill';
// The pills' own button/popover styles. Portable by design
// (quick-panel-status-pills-2026-07-13 D-001) precisely so they render correctly
// wherever they are mounted — here in the tab strip, and in the Quick Panel popup
// which never mounts this shell.
import './adv-header-pills.css';

// 'brainstorm' removed 2026-07-13 (quick-panel-saved-prompts P-010): the brainstorm
// surface lives in the Quick Panel popup's Brainstorm tab now (owner ask). Old
// ?tab=brainstorm deep links fall back to 'overview' via the enum parser.
const ADV_TAB_IDS = ['overview', 'hud', 'harnesses', 'health', 'prs', 'insights', 'conversations', 'learning', 'settings', 'docs', 'history', 'git', 'stats', 'testing', 'plans', 'automations', 'calendar', 'frames', 'evals'] as const;
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
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, accent: CATEGORICAL.indigo400.hex, accentRgb: CATEGORICAL.indigo400.rgb },
  // HUD — the session board (adv-hud-fleet-board-2026-07-25). First slot right of
  // Overview by owner ask (2026-07-25): it is the "who is doing what / who needs me"
  // glance you reach for immediately after the landing dashboard. Workspace-scoped
  // (it aggregates every session in the workspace, not one pot), so it also lives in
  // WORKSPACE_TAB_IDS. `/adv/HUD` redirects here rather than rendering its own page.
  // HUD accent: teal300 — reads distinct from its strip neighbors Overview
  // (indigo400) and Create (amber500); cyan/sky shades are brand-reserved
  // (design-primitives lint), so the original cyan400 pick was not usable.
  { id: 'hud', label: 'HUD', icon: Gauge, accent: CATEGORICAL.teal300.hex, accentRgb: CATEGORICAL.teal300.rgb },
  // (Brainstorm tab removed — it lives in the Quick Panel popup now; P-010.)
  { id: 'plans', label: 'Create', icon: ListChecks, accent: CATEGORICAL.amber500.hex, accentRgb: CATEGORICAL.amber500.rgb },
  // Automations — one workspace-wide identity and control surface for triggered
  // plans, AI routines, and deterministic system tasks. Replaces the fragmented
  // Agents/System/Spend middle-pane catalogs; live agent attention remains HUD
  // and system health remains Health.
  { id: 'automations', label: 'Automations', icon: Workflow, accent: CATEGORICAL.blue400.hex, accentRgb: CATEGORICAL.blue400.rgb },
  // Calendar — the schedulable time-surface for scheduled/recurring plans
  // (scheduled-recurring-plans-2026-06-16 P-019). Next to Create (D-001: no separate
  // routines tab — plans are just optionally-scheduled). Workspace-scoped (aggregates
  // every pot's scheduled plans), so it also lives in WORKSPACE_TAB_IDS.
  { id: 'calendar', label: 'Calendar', icon: CalendarClock, accent: CATEGORICAL.teal400.hex, accentRgb: CATEGORICAL.teal400.rgb },
  // Label "Work" (owner ask 2026-07-26; was "Working" 2026-06-11, "Progress"
  // before that): the tab is the live-work view (work items / agents / runs for
  // the selected project). The tab ID stays 'harnesses' — it's serialized in
  // URLs (?tab=harnesses), deep links, and the agent ui:dispatch surface;
  // renaming the id would break all of them.
  { id: 'harnesses', label: 'Work', icon: Boxes, accent: CATEGORICAL.violet400.hex, accentRgb: CATEGORICAL.violet400.rgb },
  // Health — the read-only at-a-glance system dashboard (system-health-tab-2026-06-15),
  // beside Work. Workspace-scoped (it aggregates the whole running system, not one
  // pot), so it also lives in WORKSPACE_TAB_IDS. Flag-gated (SYSTEM_HEALTH_TAB).
  { id: 'health', label: 'Health', icon: HeartPulse, accent: CATEGORICAL.rose500.hex, accentRgb: CATEGORICAL.rose500.rgb },
  // (The Overwatch surface moved to the left sidebar next to Queen — its
  // actionable control + anomaly→action list — and its duplicated health grid
  // was dropped in favour of this Health tab. system-health-tab P-008, 2026-06-15.)
  { id: 'frames', label: 'Frames', icon: MonitorPlay, accent: 'var(--accent-strong, var(--accent))', accentRgb: 'var(--accent-rgb, 56, 189, 248)' },
  { id: 'git', label: 'Git', icon: GitBranch, accent: CATEGORICAL.green500.hex, accentRgb: CATEGORICAL.green500.rgb },
  { id: 'stats', label: 'Stats', icon: BarChart3, accent: CATEGORICAL.violet300.hex, accentRgb: CATEGORICAL.violet300.rgb },
  { id: 'testing', label: 'Tests', icon: FlaskConical, accent: CATEGORICAL.lime500.hex, accentRgb: CATEGORICAL.lime500.rgb },
  { id: 'docs', label: 'Docs', icon: BookOpen, accent: CATEGORICAL.blue400.hex, accentRgb: CATEGORICAL.blue400.rgb },
  { id: 'history', label: 'History', icon: HistoryIcon, accent: CATEGORICAL.emerald400.hex, accentRgb: CATEGORICAL.emerald400.rgb },
  { id: 'insights', label: 'Insights', icon: TrendingUp, accent: CATEGORICAL.teal500.hex, accentRgb: CATEGORICAL.teal500.rgb },
  { id: 'conversations', label: 'Conversations', icon: MessageCircle, accent: CATEGORICAL.pink500.hex, accentRgb: CATEGORICAL.pink500.rgb },
  // One continuous learning loop: Observe → Improve → Verify → Retain. Signals
  // was folded into this destination so the system's inputs and outcomes share
  // one visual model instead of competing top-level tabs.
  { id: 'learning', label: 'Learning', icon: GraduationCap, accent: CATEGORICAL.emerald400.hex, accentRgb: CATEGORICAL.emerald400.rgb },
  // Evaluation — the impartial-benchmark surface (impartial-benchmark-suite-2026-06-15
  // D-007). Workspace-scoped (aggregates external benchmark runs across the whole
  // workspace, not one pot), so it also lives in WORKSPACE_TAB_IDS below.
  { id: 'evals', label: 'Evaluation', icon: Trophy, accent: CATEGORICAL.yellow500.hex, accentRgb: CATEGORICAL.yellow500.rgb },
  { id: 'settings', label: 'Settings', icon: Settings, accent: CATEGORICAL.orange500.hex, accentRgb: CATEGORICAL.orange500.rgb },
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
  // HUD is a roster of every SESSION in the workspace (presence-primary), not a
  // per-pot view — it stays visible under "All Pots".
  'hud',
  'plans',
  'automations',
  // Calendar aggregates every pot's scheduled-plan occurrences, not one pot
  // (scheduled-recurring-plans-2026-06-16 P-019), so it stays visible under "All Pots".
  'calendar',
  'harnesses',
  // Health aggregates the whole running system (Queen / bees / tokens / infra),
  // not a single pot — so it stays visible under "All Pots" (system-health-tab).
  'health',
  'conversations',
  // Learning aggregates observations, ideas, rubrics/scorecards, benchmarks,
  // improvements, and retained memory across the workspace.
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

/**
 * hud-first-nav-and-dossier-2026-07-26 D-001/P-002 (owner decision, option C
 * from four rendered mockups): only Overview + HUD stay on the visible strip;
 * every other tab moves behind a searchable "More" menu. Presentation only —
 * tab IDs (ADV_TAB_IDS) are unchanged, since they're serialised into ?tab=
 * URLs, deep links, and the agent ui:dispatch surface.
 */
export const PRIMARY_ADV_TAB_IDS: ReadonlySet<AdvTabId> = new Set<AdvTabId>([
  'overview',
  'hud',
  'automations',
  // Work (id 'harnesses') promoted to the visible strip, immediately right of
  // HUD (owner ask 2026-07-26: "pull it out of MORE as a main tab to put next
  // to HUD") — pulled out of the More menu's Work group, which now holds only
  // Conversations + Calendar and is labelled "Activity" so it doesn't collide
  // with this tab's name. splitPrimarySecondary preserves ADV_TABS order, and
  // 'harnesses' sits before 'learning' there, so HUD → Work → Learning falls
  // out without explicit ordering here.
  'harnesses',
  // Learning promoted to the visible strip (owner ask 2026-07-26 — pulled out
  // of the More menu's Insights group).
  'learning',
]);

/**
 * Groups for the More menu (mitigation (a): "hidden" must not become
 * "undiscoverable"). Every non-primary ADV_TABS id must appear in exactly one
 * group — the dev-mode assertion below catches a newly-added tab that would
 * otherwise silently vanish (no strip entry, no More-menu entry).
 */
export const SECONDARY_TAB_GROUPS: ReadonlyArray<{ id: string; label: string; tabIds: readonly AdvTabId[] }> = [
  { id: 'build', label: 'Build', tabIds: ['plans', 'git', 'stats', 'testing', 'docs', 'history'] },
  // Was "Work" holding ['harnesses','conversations','calendar'] — 'harnesses'
  // IS the Work tab now (promoted to the strip 2026-07-26), so the group was
  // relabelled "Activity" to avoid two things called "Work" in the same nav.
  { id: 'work', label: 'Activity', tabIds: ['conversations', 'calendar'] },
  { id: 'insights', label: 'Insights', tabIds: ['insights', 'evals', 'health'] },
  { id: 'system', label: 'System', tabIds: ['frames', 'settings'] },
];

// `vite build` pins process.env.NODE_ENV to 'production' regardless of --mode
// and constant-folds this comparison at BUILD time — under the dev shell
// (`vite build --watch --mode development`) that made this self-check
// permanently dead code (WI-7002). `import.meta.env.MODE` is the predicate
// that actually reflects --mode in every build (dev shell, HMR dev server,
// and the packaged production build).
if (import.meta.env.MODE !== 'production') {
  const grouped = new Set(SECONDARY_TAB_GROUPS.flatMap((g) => g.tabIds));
  // ADV_TABS, not ADV_TAB_IDS: 'prs' is a valid AdvTabId (its own redirect
  // route) but deliberately excluded from ADV_TABS — it was never a strip tab
  // and isn't a More-menu candidate either.
  const missing = ADV_TABS.map((t) => t.id).filter((id) => !PRIMARY_ADV_TAB_IDS.has(id) && !grouped.has(id));
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`AdvShell: SECONDARY_TAB_GROUPS is missing tab id(s): ${missing.join(', ')} — they would be unreachable (no strip entry, no More-menu entry).`);
  }
}

/** Split a tab list (already scope-filtered by visibleAdvTabs/allMode) into the
 * always-visible strip entries and the ones that move into the More menu. */
export function splitPrimarySecondary<T extends { id: AdvTabId }>(tabs: readonly T[]): { primary: T[]; secondary: T[] } {
  const primary: T[] = [];
  const secondary: T[] = [];
  for (const tab of tabs) {
    (PRIMARY_ADV_TAB_IDS.has(tab.id) ? primary : secondary).push(tab);
  }
  return { primary, secondary };
}

const RECENT_SECONDARY_TABS_MAX = 3;
const recentSecondaryTabsKey = () => wsLocalKey('adv.recentSecondaryTabs');

/** Parse+validate the persisted recent-secondary-tabs list (pure, unit-tested). */
export function parseRecentSecondaryTabs(raw: string | null): AdvTabId[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is AdvTabId => typeof id === 'string' && (ADV_TAB_IDS as readonly string[]).includes(id) && !PRIMARY_ADV_TAB_IDS.has(id as AdvTabId));
  } catch {
    return [];
  }
}

/** Move `id` to the front, dedupe, cap at RECENT_SECONDARY_TABS_MAX (pure, unit-tested). */
export function pushRecentSecondaryTab(recents: readonly AdvTabId[], id: AdvTabId): AdvTabId[] {
  return [id, ...recents.filter((r) => r !== id)].slice(0, RECENT_SECONDARY_TABS_MAX);
}

/** One row of the `harnessProjects.lite` registry read. Exported for AdvPotBar,
 *  which renders the selector over the SAME (deduped) query. */
export type HarnessProjectLite = {
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

/**
 * The pot scope every /adv tab reads. ONE selection, shared by every tab — it
 * lives on the URL (`?slug=` + `?scope=`), so a tab never keeps its own private
 * pot state (owner directive 2026-07-26: "the pot should be inherited by the
 * currently selected pot").
 *
 * What changed 2026-07-27 (owner ask): the WRITE side moved. The selector used to
 * be a single instance in this shell's header bar, above the tab strip; that bar
 * is gone and the cluster now renders inside each pot-scoped tab as its first row
 * (AdvPotBar / POT_BAR_TAB_IDS). The axes, the precedence and this context are
 * unchanged — "inherited" still means "read from the URL", it just isn't picked
 * from a global bar any more.
 *
 * `hive` is the hive HOME slug the selection resolves to (a member harness
 * resolves to its hive; '' = All Pots ⇒ workspace-wide); `ready` is false while
 * the projects list — the member→hive mapping — is still loading, so scoped
 * queries can gate on it instead of firing with a half-resolved lens.
 */
export interface AdvScope {
  allMode: boolean;
  scopeMode: HarnessScopeMode;
  /** The raw selection (?slug=), null under All Pots. */
  slug: string | null;
  /** Hive home the selection resolves to; '' ⇒ workspace-wide. */
  hive: string;
  /** Exact harness set for scoped reads; null means the whole workspace. */
  harnessSlugs: readonly string[] | null;
  ready: boolean;
}

const AdvScopeContext = createContext<AdvScope>({
  allMode: true,
  scopeMode: 'all',
  slug: null,
  hive: '',
  harnessSlugs: null,
  ready: false,
});

/** Resolve the shell's URL scope into the exact set every pot-aware tab reads. */
export function resolveAdvScopeHarnessSlugs(
  scopeMode: HarnessScopeMode,
  slug: string | null,
  projects: readonly HarnessProjectLite[],
): readonly string[] | null {
  if (scopeMode === 'all') return null;
  if (!slug) return [];
  if (scopeMode === 'self') return [slug];
  // The registry's authoritative hive_slug is the parent edge for modern Hive
  // members; parent_slug remains the legacy tree edge. Normalize both into the
  // canonical resolver rather than teaching every tab a second tree walk.
  return resolveHarnessScope(
    slug,
    projects.map((project) => ({
      slug: project.slug,
      parent_slug:
        project.parent_slug ??
        (project.hive_slug && project.hive_slug !== project.slug ? project.hive_slug : null),
    })),
  );
}

/** Read the inherited pot scope from the nearest AdvShell. */
export function useAdvScope(): AdvScope {
  return useContext(AdvScopeContext);
}

/**
 * The /adv shell. Chrome = the tab strip (+ the two URL-mounted modals); the tab
 * bodies — and, on the pot-scoped ones, the pot bar — are `children`.
 *
 * There is deliberately NO title/kicker bar any more (owner ask 2026-07-27:
 * "remove the whole ADVANCED ORCHESTRATION / HUD bar so the tabs sit at the very
 * top"). The tab strip names the section, so the bar was a second, redundant
 * label — and its right half carried a pot selector that implied it scoped
 * workspace-level tabs too. Both went; the cluster moved into the pot-scoped tab
 * bodies (AdvPotBar).
 */
export default function AdvShell({ children }: { children: React.ReactNode }) {
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
  // The Harnesses-tab member axis (`?harness=`). The shell WRITES it on an into-hive
  // create (focus the new member in the rail, P-011 contract) and CLEARS it (→ null)
  // whenever a hive is picked in the selector / keyboard switcher, so the Harnesses
  // dock re-scopes to the picked hive instead of staying pinned to a drilled-into
  // sub-hive (the stale-?harness bug). The tab owns READING it.
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
  // LIVE harness registry list (harnessProjects.lite). Replaces the old one-shot
  // /api/harness/projects/lite fetch (data-sync-push P-010): the resolver is
  // invalidated from the registry write seam, so creates/deletes/renames/forks
  // from ANY operator process live-update the selector (EI-206). `invalidate()`
  // still forces an immediate refetch after a local create/publish so the
  // just-written state shows without waiting for the push.
  const {
    data: projectsData,
    error: projectsError,
    invalidate: refreshProjects,
  } = useSyncQuery<HarnessProjectLite>({
    queryName: 'harnessProjects.lite',
    args: { includeHiveHomes: true },
    staleTime: 60_000,
  });
  const projects = projectsData ?? [];
  const projectLoadError = projectsError ? String(projectsError.message ?? projectsError) : null;
  // Create-harness flow. The dialog open-state is URL-backed (nuqs) so it
  // survives refresh and is agent-controllable; `refreshProjects()` re-queries
  // the registry once a harness is created so the selector picks it up.
  const [createOpen, setCreateOpen] = useQueryState('create', parseAsBoolean.withDefault(false));
  // Share the currently-selected harness. URL-backed so it survives refresh
  // and is agent-controllable; only meaningful when a slug is active.
  const [shareOpen, setShareOpen] = useQueryState('share', parseAsBoolean.withDefault(false));
  // The persisted-selection restore runs at most once per mount. Setting the
  // slug re-renders (activeSlug changes), but the ref keeps the effect from
  // re-restoring (or fighting a user's later pick / a later live push).
  const restoredSelectionRef = useRef(false);

  useEffect(() => {
    if (restoredSelectionRef.current || projects.length === 0) return;
    restoredSelectionRef.current = true;
    let cancelled = false;
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
      projectSlugs: projects.map((p) => p.slug),
      urlSlug: activeSlug,
      urlScope: scopeMode,
      persisted,
    });
    // Apply the two writes SEQUENTIALLY (await between them). The custom
    // nuqs adapter merges each write over the live `window.location.search`,
    // so two same-tick writes both snapshot the pre-write URL and the later
    // flush clobbers the earlier — a concurrent slug+scope restore kept only
    // the slug and left a stale `scope=all`, so the strip stayed collapsed.
    // Awaiting serializes them; scope is written last so it's authoritative
    // for allMode.
    void (async () => {
      if (decision.setSlug) await setActiveSlug(decision.setSlug);
      if (cancelled) return;
      if (decision.setScope) await setScopeMode(decision.setScope);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.length]);

  // "All harnesses" mode: list views (Plans, Sessions) span the whole
  // workspace; the single-pot widgets (Share, now-running, Discord — all in
  // AdvPotBar now) have no single target, so they blank out.
  const allMode = scopeMode === 'all';
  const singleSlug = allMode ? null : activeSlug;
  const activeProject = singleSlug ? projects.find((p) => p.slug === singleSlug) : undefined;
  // Sharing happens at the HIVE level (comb-retire-per-harness-sharing-2026-06-11):
  // the Share affordance (in AdvPotBar) publishes the active hive to the P2P
  // directory; this shell only mounts the modal it opens, so it needs to know
  // whether the active pot IS a hive.
  const activeIsHive = activeProject?.harness_kind === 'hive';

  // The inherited pot scope for every tab (useAdvScope above). A selected
  // member harness resolves to its hive home via the lite payload's
  // authoritative hive_slug; a selected hive is itself; All Pots ⇒ ''.
  const advScope = useMemo<AdvScope>(
    () => ({
      allMode,
      scopeMode,
      slug: singleSlug,
      hive: !singleSlug ? '' : activeIsHive ? singleSlug : activeProject?.hive_slug || singleSlug,
      harnessSlugs: resolveAdvScopeHarnessSlugs(scopeMode, singleSlug, projects),
      ready: allMode || projects.length > 0 || Boolean(projectLoadError),
    }),
    [allMode, scopeMode, singleSlug, activeIsHive, activeProject?.hive_slug, projects, projectLoadError],
  );

  // (The Share-button → Shared-badge swap reads the active hive's directory
  // share-state; that lives with the button, in AdvPotBar.)

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

  // D-001 (owner decision, option C): only Overview + HUD render as real strip
  // tabs; everything else lives behind the More menu (moreOpen).
  const { primary: primaryTabs, secondary: secondaryTabs } = splitPrimarySecondary(visibleTabs);
  const isSecondaryTabActive = secondaryTabs.some((tab) => tab.id === activeTab);
  const [moreOpen, setMoreOpen] = useState(false);

  // Mitigation (b): pin the last few visited secondary tabs at the top of the
  // More menu so a heavy Git/Tests/Docs user doesn't pay a hunt every time.
  const [recentSecondaryTabs, setRecentSecondaryTabs] = useState<AdvTabId[]>(() =>
    typeof window === 'undefined' ? [] : parseRecentSecondaryTabs(window.localStorage.getItem(recentSecondaryTabsKey())),
  );
  useEffect(() => {
    if (PRIMARY_ADV_TAB_IDS.has(activeTab)) return;
    setRecentSecondaryTabs((prev) => {
      if (prev[0] === activeTab) return prev;
      const next = pushRecentSecondaryTab(prev, activeTab);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(recentSecondaryTabsKey(), JSON.stringify(next));
      }
      return next;
    });
  }, [activeTab]);

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
    // Same as the selector: reset the within-hive member focus so the dock follows
    // the newly-picked hive (sequential await — same-tick writes collide in the adapter).
    await setActiveHarness(null);
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

  // Two-stroke tab jump (`g i`). Shipped in the registry with NO handler
  // anywhere, so the settings row let a user rebind a key that fired nothing
  // (settings-audit 2026-07-09). Unlike goto.inbox this is a PER-POT tab, so
  // under "All Pots" it's absent from the base strip — the pin-the-active-tab
  // branch above appends + highlights the tab and its body renders the
  // pick-a-pot prompt (owner ask 2026-06-17). That is the designed
  // empty-state, so no scope guard here. (goto.brainstorm removed with the
  // Brainstorm tab — the surface lives in the Quick Panel popup now; P-010.)
  useShortcutAction('goto.insights', () => void setActiveTab('insights'));

  return (
    // data-testid is the packaged perf suite's contract for "the OPERATOR shell
    // is up, not a first-run lookalike" (tools/perf-test/wdio/app-mount.ts,
    // EI-18889416741921988). It keyed on `.pc-advshell` before, which is a
    // styling class nothing stopped a refactor from renaming — and the suite had
    // no way to tell the operator UI from /onboarding, so it measured the wrong
    // screen for its entire existence. Renaming this testid breaks that suite.
    <div className="pc-advshell" data-testid="operator-shell">
      <header className="pc-advshell__header">
        {/* The tab strip is the TOPMOST chrome (owner ask 2026-07-27). What used
            to sit above it — the "ADVANCED ORCHESTRATION / <title>" copy and the
            pot cluster + status pills — is gone from here: the copy was a second
            label for what the strip already names, and the cluster now renders
            inside each pot-scoped tab body (AdvPotBar), where the scope it sets
            is actually the scope you are looking at. */}
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
            {primaryTabs.map((t) => {
              const Icon = t.icon;
              return (
                <Tabs.Trigger
                  key={t.id}
                  value={t.id}
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
          {secondaryTabs.length > 0 && (
            <Popover
              open={moreOpen}
              onOpenChange={setMoreOpen}
              trigger={
                <button
                  type="button"
                  className={`pc-advshell__more-trigger${isSecondaryTabActive ? ' pc-advshell__more-trigger--active' : ''}`}
                  aria-label="More sections"
                >
                  <span>More</span>
                  <ChevronDown size={12} aria-hidden />
                </button>
              }
              ariaLabel="More sections"
              side="bottom"
              align="start"
              autoFocusOnOpen
              contentClassName="pc-advshell__more-panel"
            >
              <AdvMoreMenu
                groups={SECONDARY_TAB_GROUPS}
                tabs={secondaryTabs}
                recentIds={recentSecondaryTabs}
                activeTab={activeTab}
                onSelect={(id) => {
                  void setActiveTab(id);
                  setMoreOpen(false);
                }}
              />
            </Popover>
          )}
          {/* ── Workspace status pills, immediately right of More (owner ask
              2026-08-01: "move these buttons from the HUD tab to the top bar
              visible when viewing any tabs, to the right of the MORE button").
              Both read the WHOLE workspace (hive.controlState / advRoster.list),
              so gating them behind one tab was a scope mismatch: they lived in
              AdvPotBar's `withStatus` block, which only HUD passed. The strip is
              the shell's topmost chrome, so mounting them here is what makes
              them visible on every tab.

              Only these two moved. AdvNowRunning (this pot's start/stop + "N
              plans waiting") and DiscordBadge (this pot's link) are genuinely
              pot-scoped and stay on the HUD pot bar — a pot-scoped control in a
              bar that outlives the pot selector is the confusion the 2026-07-27
              split set out to remove.

              Each pill self-hides when it has nothing to say (no local pot / flag
              off; zero running agents), so this adds no empty chrome. */}
          {/* TasksRunningPill joins them 2026-08-02 (WI-6844, owner ask: "move the
              location of it from the middle pane to a button on our top bar to the
              right of the 'agents running' button"). It reads the whole box, not one
              pot, so it belongs in this strip for the same reason the other two do —
              and it self-hides when the ledger is empty or the flag is switched off,
              so it adds no empty chrome either. Its old home was the left rail's
              `tasks` tab, removed in the same change; plan decision D-014 reasoned
              about WHERE in that rail it sat, which this supersedes. */}
          <div className="pc-advshell__header-status">
            <AgentsRunningPill />
            <TasksRunningPill />
          </div>
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
        // Opening only: the picker CLOSES itself via a single atomic useQueryStates
        // write (clearing ?create + ?picker together) — writing ?create here too
        // would be a second same-tick write the custom adapter clobbers. AdvShell
        // re-reads ?create and re-renders shut.
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
          // SIDE-EFFECTS ONLY. The picker writes the focus params (?slug / ?harness)
          // in the SAME atomic useQueryStates write as the modal close, so the
          // custom nuqs adapter can't clobber one of two same-tick writes (that
          // dropped ?create=false → stuck-open modal). Doing setActiveSlug/Harness
          // here would re-introduce that race, so we keep only non-URL effects.
          refreshProjects();
          const intoActiveHive = opts?.hive && opts.hive === activeSlug;
          if (!intoActiveHive && typeof window !== 'undefined') {
            window.localStorage.setItem(wsLocalKey('harness.activeProject'), slug);
          }
        }}
      />
      {shareOpen && !allMode && activeSlug && activeIsHive && (
        <Modal
          open={shareOpen}
          onOpenChange={(v) => {
            if (!v) {
              void setShareOpen(false);
              // Re-query projects/lite so a just-completed publish is reflected.
              refreshProjects();
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
          <PublishPotCard potSlug={activeSlug} />
        </Modal>
      )}
      <div className="pc-advshell__body">
        <AdvScopeContext.Provider value={advScope}>{children}</AdvScopeContext.Provider>
      </div>
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
        /* The pot cluster's rules (selector · sub-pots · New/Share) moved to
           adv-pot-bar.css, and AdvNowRunning's (--start/--stop/--waiting, the
           status bar) to the shared adv-header-pills.css, when the cluster left
           this header for the tab bodies (owner ask 2026-07-27). A stylesheet that
           only applies "while AdvShell happens to be mounted" is exactly the
           fragility adv-header-pills.css was extracted to fix
           (quick-panel-status-pills-2026-07-13 D-001) — so the rules travel with
           the components that own them, not with this shell. */
        @keyframes pc-advshell-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        /* The strip is now the FIRST row of the header, so it carries the top
           padding the removed title row used to provide. */
        .pc-advshell__tabs { position: relative; min-width: 0; display: flex; align-items: flex-end; padding: 6px 12px 0; }
        .pc-advshell__tab-label { display: inline; }
        /* The workspace status pills, sitting immediately right of More (owner ask
           2026-08-01). NOTE: this whole block is a JS template literal, so it must
           contain NO backticks — one in a comment ends the literal and the file
           fails to parse (hit while writing this rule; the same trap reds
           operator-core when a SQL comment quotes an identifier).

           align-items:center + the bottom margin lift the pills off the strip's
           flex-end baseline so they read as centred against the 34px tabs rather
           than hanging from their bottom edge.

           The narrow-window contract, and why it needs the two overrides below.
           This strip is NOT the window width — the left sidebar takes most of it
           (measured live: a 1280px window left the strip 439px). Tabs + More
           already fill that on their own, which is what the overflow chevrons
           exist for. Dropping ~420px of pills in beside them therefore overflows
           by default, and the pills lose their own base rule to boot:
           .pc-advshell__action sets flex-shrink: 0 (adv-header-pills.css — right
           for a pill in a roomy bar), so a shrinking wrapper does NOT shrink
           them; they spill straight out of it and off the window edge. Measured
           before the fix: the agents pill ran to x=1455 in a 1280px window.

           So: the wrapper shrinks (flex: 0 1 auto + min-width: 0) AND clips
           (overflow: hidden), and inside it the pills are allowed to shrink and
           ellipsize. The leading "N agents running" survives; the tail (thinking
           count, fleet dots) is what degrades — correct, since the head is the
           number the bar exists to show. Tabs keep their space: they are
           navigation, the pills are only a readout.

           The right-hand margin applies only while the strip is actually
           overflowing: .pc-advshell__tabnav--right is absolutely positioned at
           right: 12px and is displayed only under [data-of-right] — so without
           this the chevron would land on top of the last pill exactly when the
           window is tight enough for them to collide. */
        .pc-advshell__header-status {
          display: flex;
          align-items: center;
          gap: 6px;
          flex: 0 1 auto;
          min-width: 0;
          overflow: hidden;
          margin-left: 8px;
          margin-bottom: 6px;
        }
        .pc-advshell__header-status .pc-advshell__action {
          flex-shrink: 1;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          display: inline-block;
          line-height: 18px;
        }
        .pc-advshell__tabs[data-of-right] .pc-advshell__header-status { margin-right: 26px; }
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
          letter-spacing: 0;
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
        /* ── "More" menu (D-001): trigger button + searchable/grouped popover ── */
        .pc-advshell__more-trigger {
          position: relative;
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-height: 34px;
          margin-bottom: -1px;
          margin-left: 2px;
          padding: 9px 12px 10px;
          border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.28));
          border-radius: 10px 10px 0 0;
          background: linear-gradient(180deg, color-mix(in srgb, var(--accent), transparent 94%), rgba(3, 10, 20, 0.98));
          color: var(--fg-dim, #b9d4e8);
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0;
          text-transform: uppercase;
          cursor: pointer;
        }
        .pc-advshell__more-trigger:hover,
        .pc-advshell__more-trigger:focus-visible {
          color: var(--fg, #e7f7ff);
          outline: none;
        }
        .pc-advshell__more-trigger--active {
          color: var(--fg, #e7f7ff);
          background: color-mix(in srgb, var(--accent), transparent 82%);
          border-color: var(--border-strong, rgba(125, 211, 252, 0.55));
        }
        .pc-advshell__more-panel {
          width: min(280px, 92vw);
          max-height: min(420px, 70vh);
          display: flex;
          border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32));
          border-radius: 10px;
          background: var(--bg-popover, #0d1829);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
          overflow: hidden;
        }
        .pc-advshell__more-cmd { display: flex; flex-direction: column; width: 100%; min-height: 0; }
        .pc-advshell__more-input {
          margin: 8px;
          padding: 7px 10px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.22));
          border-radius: 8px;
          background: var(--bg, #07101d);
          color: var(--fg, #e7f7ff);
          font-size: 12.5px;
          outline: none;
        }
        .pc-advshell__more-input:focus { border-color: var(--accent, #38bdf8); }
        .pc-advshell__more-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 6px 6px; }
        .pc-advshell__more-empty {
          padding: 10px 12px;
          color: var(--fg-mute, #7f9bb4);
          font-size: 12px;
        }
        .pc-advshell__more-group [cmdk-group-heading] {
          padding: 8px 8px 4px;
          color: var(--fg-mute, #7f9bb4);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .pc-advshell__more-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 8px;
          border-radius: 7px;
          color: var(--fg-dim, #b9d4e8);
          font-size: 12.5px;
          font-weight: 550;
          cursor: pointer;
        }
        .pc-advshell__more-item svg:first-child { color: var(--h-main-tab-accent); }
        .pc-advshell__more-item[data-selected='true'] {
          background: color-mix(in srgb, var(--accent), transparent 86%);
          color: var(--fg, #e7f7ff);
        }
        .pc-advshell__more-item[data-active] { color: var(--fg, #e7f7ff); font-weight: 650; }
        .pc-advshell__more-item-check { margin-left: auto; color: var(--accent, #38bdf8); }

        /* Fallback scroller: tabs that lay out their own internal overflow
           panes (Plans, Sessions) scroll there; tabs that don't (e.g.
           Insights) scroll here instead of growing the shell + window. */
        .pc-advshell__body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
        /* The tab body, BELOW the pot bar (flex:none chrome inside
           .pc-advshell__body). It carries the same fallback-scroller contract the
           body has, because with a sibling row above it the body's own height is
           no longer the tab's height: a tab that manages its own overflow needs a
           definite height to lay out against (.hud's height:100% resolves here),
           and a tab that doesn't scrolls here rather than being clipped.
           NOTE: no backticks in this <style> template literal — one terminates it. */
        .pc-advshell__tabbody { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }

        /* Flat in-page buttons. Action buttons / pills inside the page body
           get NO embossed bevel, raised drop-shadow, glow, or hover-lift —
           those "3D" treatments are hard to read. The large top tab strip
           lives in .pc-advshell__header (page-level nav, a different
           category) and is intentionally NOT affected. Focus-visible rings
           are preserved for keyboard a11y. See /internal/docs/design#buttons.

           EI-18772095428507037 — the [data-shadow-ok] opt-out. This reset is
           an !important rule on a DESCENDANT selector, so it silently beat every
           box-shadow any component inside the shell body declared, no matter
           what that component's own stylesheet said. It failed invisibly:
           no console warning, the losing rule sits right there in the CSS file
           and in devtools' stylesheet list, and unit tests cannot read computed
           style — so an author reasonably concluded their shadow worked. It was
           only found by reading computed style in a live shell, where
           .hud__tab--on's 1px board-bridge shadow computed to none.

           The blanket ban was too broad because it cannot tell a DECORATIVE
           bevel (what it exists to kill) from a STRUCTURAL hairline (a tab
           bridging its panel's border). Opting in with data-shadow-ok is that
           distinction, made explicit at the call site and greppable. */
        .pc-advshell__body :is(button, [role="button"]):not(:focus-visible):not([data-shadow-ok]) {
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

type AdvTabDef = (typeof ADV_TABS)[number];

/**
 * The "More" menu body (D-001 mitigation (a)/(b)): a searchable, grouped list
 * of the secondary tabs, with the last few visited pinned under "Recent".
 * cmdk (already a dependency — apps/operator/app/_components/CommandPalette.tsx)
 * gives type-to-filter + full keyboard nav (↑↓/Enter) for free.
 */
function AdvMoreMenu({
  groups,
  tabs,
  recentIds,
  activeTab,
  onSelect,
}: {
  groups: typeof SECONDARY_TAB_GROUPS;
  tabs: AdvTabDef[];
  recentIds: AdvTabId[];
  activeTab: AdvTabId;
  onSelect: (id: AdvTabId) => void;
}) {
  // Keyed explicitly by the full AdvTabId (not the narrower Exclude<…,'prs'>
  // TS would otherwise infer from `tabs`): recentIds/group.tabIds are typed
  // AdvTabId, and a Map<K,V>.get() argument must be assignable to K.
  const byId = useMemo(() => new Map<AdvTabId, AdvTabDef>(tabs.map((t) => [t.id, t])), [tabs]);
  const recentTabs = recentIds.map((id) => byId.get(id)).filter((t): t is AdvTabDef => !!t);

  return (
    <CmdK label="More sections" loop shouldFilter className="pc-advshell__more-cmd">
      <CmdK.Input
        autoFocus
        className="pc-advshell__more-input"
        placeholder="Find a section…"
        aria-label="Filter sections"
      />
      <CmdK.List className="pc-advshell__more-list">
        <CmdK.Empty className="pc-advshell__more-empty">No matching section</CmdK.Empty>
        {recentTabs.length > 0 && (
          <CmdK.Group heading="Recent" className="pc-advshell__more-group">
            {recentTabs.map((t) => (
              <AdvMoreMenuItem key={`recent-${t.id}`} tab={t} active={t.id === activeTab} onSelect={onSelect} />
            ))}
          </CmdK.Group>
        )}
        {groups.map((group) => {
          const groupTabs = group.tabIds.map((id) => byId.get(id)).filter((t): t is AdvTabDef => !!t);
          if (groupTabs.length === 0) return null;
          return (
            <CmdK.Group key={group.id} heading={group.label} className="pc-advshell__more-group">
              {groupTabs.map((t) => (
                <AdvMoreMenuItem key={t.id} tab={t} active={t.id === activeTab} onSelect={onSelect} />
              ))}
            </CmdK.Group>
          );
        })}
      </CmdK.List>
    </CmdK>
  );
}

function AdvMoreMenuItem({
  tab,
  active,
  onSelect,
}: {
  tab: AdvTabDef;
  active: boolean;
  onSelect: (id: AdvTabId) => void;
}) {
  const Icon = tab.icon;
  return (
    <CmdK.Item
      // cmdk filters/sorts on `value` — the tab's own label is enough (short,
      // unambiguous list; no need to also thread keywords).
      value={tab.label}
      onSelect={() => onSelect(tab.id)}
      className="pc-advshell__more-item"
      data-active={active ? '' : undefined}
      style={{ '--h-main-tab-accent': tab.accent } as CSSProperties}
    >
      <Icon size={13} aria-hidden />
      <span>{tab.label}</span>
      {active && <Check size={12} aria-hidden className="pc-advshell__more-item-check" />}
    </CmdK.Item>
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
    // Detect a hive home by kind OR the `-hive` slug suffix — projects-lite
    // doesn't always carry harness_kind, and members never end in `-hive`, so
    // the suffix is a safe robust fallback.
    const isHiveHome = root.harness_kind === 'hive' || root.slug.endsWith('-hive');
    const rootLabel = isHiveHome ? hiveHomeLabel(root.slug) : root.slug;
    tree.push({ value: root.slug, label: rootLabel });
    for (const member of members) {
      // Single-repo collapse: a `<x>-hive` home whose one member is the repo `<x>`
      // — the hive IS that repo, so drop the redundant `↳ <x>` row (the `<x>`
      // header already stands for it; selecting it scopes to the hive).
      if (isHiveHome && member.slug === rootLabel) continue;
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
