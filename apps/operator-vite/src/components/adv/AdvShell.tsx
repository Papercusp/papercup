import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { HARNESS_SCOPE_MODES, type HarnessScopeMode } from '@papercusp/operator-core/lib/harness/scope';
import * as Tabs from '@radix-ui/react-tabs';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import {
  BookOpen,
  Boxes,
  Check,
  Crown,
  Eye,
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
import { Select } from '@/app/harness/Select';
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

const ADV_TAB_IDS = ['overview', 'harnesses', 'health', 'overwatch', 'queen', 'brainstorm', 'prs', 'insights', 'conversations', 'learning', 'settings', 'docs', 'git', 'testing', 'plans', 'frames', 'evals'] as const;
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
  // Overwatch — the autonomous system-health supervisor's ACTIONABLE view, beside
  // the read-only Health dashboard (overwatch-role-2026-06-15 B-08, D-006).
  // Workspace-scoped (aggregates the whole running system, not one pot), so it
  // also lives in WORKSPACE_TAB_IDS. Flag-gated (OVERWATCH, default OFF). Indigo +
  // the 👁 Eye glyph mirror the role's roster identity (D-011).
  { id: 'overwatch', label: 'Overwatch', icon: Eye, accent: '#6366f1', accentRgb: '99, 102, 241' },
  // Queen — the owner's steering panel for the autonomous Queen (focus plans /
  // directive / pause-new-work), beside the supervision surfaces
  // (queen-steering-panel-2026-06-15 B-04, D-003). Workspace-scoped (steers the
  // whole hive), so it also lives in WORKSPACE_TAB_IDS. UNGATED — a finished
  // owner control over existing Queen state, gold 👑 crown.
  { id: 'queen', label: 'Queen', icon: Crown, accent: '#fbbf24', accentRgb: '251, 191, 36' },
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
  'harnesses',
  // Health aggregates the whole running system (Queen / bees / tokens / infra),
  // not a single pot — so it stays visible under "All Pots" (system-health-tab).
  'health',
  // Overwatch supervises the whole running system too (its brief is the
  // actionable subset of the same SystemHealth) — workspace-scoped (B-08, D-006).
  'overwatch',
  // Queen steering acts on the whole hive (the owner's focus/pause controls) —
  // workspace-scoped (queen-steering-panel-2026-06-15 B-04).
  'queen',
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
  // P-012: lite payload now surfaces parent_slug + harness_kind so the
  // selector can render a tree without paying for /projects.
  parent_slug?: string | null;
  harness_kind?: string | null;
  // Whether the harness has been shared (a `.papercusp/shared.json` exists).
  // Drives the header's Share button → Shared badge swap.
  is_shared?: boolean;
};

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
  // Overwatch is a new, not-yet-proven autonomous role: its tab is gated on
  // papercusp-overwatch (default OFF until B-12 proves it live). Off ⇒ no strip
  // entry (the resolver/loop are inert too). (overwatch-role-2026-06-15 D-009.)
  const overwatchOn = useFlag(FLAGS.OVERWATCH);
  const visibleTabs = visibleAdvTabs(allMode).filter(
    (tab) => (tab.id !== 'health' || healthOn) && (tab.id !== 'overwatch' || overwatchOn),
  );
  // If the active tab just went invisible (scope flipped to "All Pots", or a
  // per-pot deep link landed in all-mode), snap to Overview so the strip and
  // the content pane stay consistent.
  useEffect(() => {
    if (allMode && !WORKSPACE_TAB_IDS.has(activeTab)) void setActiveTab('overview');
  }, [allMode, activeTab, setActiveTab]);
  // overwatch-role-2026-06-15 B-10 (D-009): the Overwatch tab is dark while
  // papercusp-overwatch is OFF. The strip already hides its button (visibleTabs),
  // but a direct ?tab=overwatch deep-link / ui:dispatch would otherwise render the
  // (inert) pane — snap away so the role is FULLY dark, not just button-hidden.
  // Mirrors the all-mode snap above; scoped to the flag so no other tab is affected.
  useEffect(() => {
    if (!overwatchOn && activeTab === 'overwatch') void setActiveTab('overview');
  }, [overwatchOn, activeTab, setActiveTab]);

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
              options={buildHarnessSelectOptions(projects, projectLoadError, t('pot', { plural: true }))}
              triggerClassName="pc-advshell__select-trigger"
            />
            {/* Sub-harness union is meaningless under "all" (everything is
                already included), so the toggle only shows for a single pick. */}
            {!allMode && (
              <label className="pc-advshell__scope-toggle" title="Include sub-harnesses in list views (plans, sessions). Editor views still focus a single harness.">
                <input
                  type="checkbox"
                  checked={scopeMode === 'expanded'}
                  onChange={(e) => void setScopeMode(e.target.checked ? 'expanded' : 'self')}
                />
                <span>sub-harnesses</span>
              </label>
            )}
            <button
              type="button"
              className="pc-advshell__action pc-advshell__action--new"
              title="Create or add a new harness"
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
        <Tabs.Root value={activeTab} onValueChange={(value) => void setActiveTab(value as AdvTabId)} className="pc-advshell__tabs">
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
        hiveScope={!allMode ? (activeSlug ?? null) : null}
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
          color: color-mix(in oklab, var(--accent-strong, #7dd3fc), transparent 26%);
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
          background: rgba(56, 189, 248, 0.14);
          color: #7dd3fc;
          border-color: rgba(56, 189, 248, 0.38);
        }
        .pc-advshell__action--share:hover {
          background: rgba(56, 189, 248, 0.26);
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

        .pc-advshell__tabs { min-width: 0; display: flex; align-items: flex-end; padding: 0 12px; }
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
 * Build the harness selector option list as a tree: an "All harnesses"
 * row first, then roots alphabetically, each child (where parent_slug →
 * root) listed under it with a leading "  ↳ " marker. Concrete picks
 * remain single-slug; the scope toggle decides whether downstream
 * consumers UNION across the subtree, and the "All harnesses" row flips
 * ?scope=all. Per `plans-newbutton-and-subharness-scope-2026-05-25` P-014.
 *
 * Exported for unit tests.
 */
export function buildHarnessSelectOptions(
  projects: HarnessProjectLite[],
  projectLoadError: string | null,
  // The plural label for the top-level grouping ("Pots" | "Hives"), resolved
  // by the active brand pack. Defaults to the classic label so callers/tests
  // that don't thread the lexicon stay unchanged.
  potPlural = 'Pots',
): Array<{ value: string; label: string; disabled?: boolean }> {
  if (projects.length === 0) {
    return [{
      value: '__loading',
      label: projectLoadError ? 'Failed to load harnesses' : 'Loading harnesses…',
      disabled: true,
    }];
  }

  const childrenByParent = new Map<string, HarnessProjectLite[]>();
  const roots: HarnessProjectLite[] = [];
  for (const p of projects) {
    const parent = p.parent_slug?.trim() || null;
    if (!parent) {
      roots.push(p);
    } else {
      let bucket = childrenByParent.get(parent);
      if (!bucket) {
        bucket = [];
        childrenByParent.set(parent, bucket);
      }
      bucket.push(p);
    }
  }
  // Orphans (parent_slug set but parent not in registry) — render as
  // roots so they're still pickable.
  for (const p of projects) {
    const parent = p.parent_slug?.trim() || null;
    if (parent && !projects.some((q) => q.slug === parent) && !roots.includes(p)) {
      roots.push(p);
    }
  }
  roots.sort((a, b) => a.slug.localeCompare(b.slug));
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  // "All harnesses" always leads the list (when there's anything to span).
  // Selecting it flips ?scope=all rather than ?slug= — see AdvShell.onChange.
  const out: Array<{ value: string; label: string; disabled?: boolean }> = [
    { value: ALL_HARNESSES_OPTION, label: `All ${potPlural}` },
  ];
  const visited = new Set<string>();
  function emit(node: HarnessProjectLite, depth: number): void {
    if (visited.has(node.slug)) return;
    visited.add(node.slug);
    const indent = depth === 0 ? '' : '  '.repeat(depth) + '↳ ';
    out.push({ value: node.slug, label: indent + node.slug });
    const kids = childrenByParent.get(node.slug);
    if (kids && depth < 4) {
      for (const k of kids) emit(k, depth + 1);
    }
  }
  for (const r of roots) emit(r, 0);
  return out;
}
