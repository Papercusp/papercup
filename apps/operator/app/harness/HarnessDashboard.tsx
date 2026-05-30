'use client';

import './harness.css';
import { wsLocalKey } from '@/lib/browser-workspace';
import { OperatorActionLog } from '../_components/OperatorActionLog';
import { LazyDetails } from '../_components/LazyDetails';
import { useShortcut } from '../../lib/hotkeys';
import ShortcutsCheatSheet from '../_components/ShortcutsCheatSheet';
import MonacoEditor from '@monaco-editor/react';
import * as Tabs from '@radix-ui/react-tabs';
import * as RSelect from '@radix-ui/react-select';
import * as RTooltip from '@radix-ui/react-tooltip';
import { Check as LCheck, ChevronDown as LChevronDown, ChevronUp as LChevronUp } from 'lucide-react';
import { Modal } from './Modal';
import { Tooltip } from './Tooltip';
import { Checkbox } from './Checkbox';
import { useConfirmDialog } from './useConfirmDialog';
import { usePromptDialog } from './usePromptDialog';
import { Select } from './Select';
import HarnessSettingsPanel from './HarnessSettingsPanel';
import AgentThinkingPopover from './AgentThinkingPopover';
import {
  PluginIcon,
  pluginSlugFromPath,
  type InstalledPluginAction,
  type InstalledPluginInfo,
  type EnabledPluginManifest,
} from './plugin-utils';

import { Activity as ReactActivity, type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { useReducedMotion } from 'motion/react';
import { useFancyEffectsEnabled } from '@/lib/visual-effects';
import { crossOriginUrl } from '@/lib/cross-origin-url';
import { useForm } from 'react-hook-form';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { makeAjvResolver } from '@/lib/forms';
import { useSyncQuery } from '@restart/sync';
import { createResilientEventSource } from '@restart/sse';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { useQuery } from '@tanstack/react-query';
import {

  type FeatureRow,
  type AgentRunConsolidatedRow,
} from '@restart/zero-harness';
import { RichGrid, type ColumnDef } from '@restart/grid-core';
import { useParams, useSearchParams } from 'next/navigation';
import { useQueryState, parseAsBoolean, parseAsString, parseAsStringEnum } from 'nuqs';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { navigateClient } from '../../lib/client-navigation';
import { Group as PanelGroup, Panel as RPanel, Separator } from 'react-resizable-panels';
import {
  Activity, Play, Square, SlidersHorizontal, RotateCcw, RefreshCw,
  Coins, TrendingUp, CheckCircle2, AlertTriangle, Loader2, Wrench, ArrowRight,
  Code2, BookOpen, LayoutDashboard, Lightbulb, FileText, Palette, GitPullRequest,
  // Icons available to plugin manifests via dashboardTabs[].icon
  Terminal, Code, Plus, Puzzle, Database, Cloud, MessageSquare,
  Zap, Bell, Calendar, Folder, FolderOpen, Globe, GitBranch, Inbox,
  Layers, Mail, Search, Settings, Send, Server, Shield, Star, Tag,
  Image as ImageIcon, Music, Video, Box, Download, Upload, Link as LinkIcon,
  CheckSquare, ListChecks, BarChart, PieChart, LineChart,
} from 'lucide-react';

// PLUGIN_ICON_MAP + PluginIcon now live in ./plugin-utils (shared with the
// extracted ConfigPanel, which /adv renders standalone).

gsap.registerPlugin(useGSAP);

const CODE_SERVER_PORT = 8082;

function vscodeUrl(projectPath: string): string {
  if (typeof window === 'undefined') return '#';
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${CODE_SERVER_PORT}/?folder=${encodeURIComponent(projectPath)}`;
}

const VSCODE_WINDOW_NAME = 'harness-vscode';

function openInVSCode(projectPath: string) {
  const url = vscodeUrl(projectPath);
  if (url === '#') return;
  window.open(url, VSCODE_WINDOW_NAME);
}

type MainPanel = 'brainstorm' | 'proposals' | 'git' | 'dashboard' | 'summary' | 'insights' | 'config' | 'settings' | 'prs' | 'docs' | `plugin:${string}`;

type HarnessDashboardProps = {
  forcedPanel?: MainPanel;
  embeddedPanelChrome?: boolean;
};

import { Panel } from '@restart/ui-primitives';
import { StatCard } from '@restart/ui-primitives';
import { StatusPill } from '@restart/ui-primitives';
import { LogView } from '@restart/ui-primitives';
import { MarkdownView } from '@restart/ui-primitives';
import { JsonTree } from '@restart/ui-primitives';
import { IssuesList } from './issues/IssuesList';
import { preloadGitLog as libPreloadGitLog } from '@restart/git-graph';

function preloadGitLog(slug: string, limit = 300) {
  libPreloadGitLog(`harness:${slug}`, limit, `/api/harness/${slug}/git/log?limit=${limit}`);
}

// Linear-inspired extensions (palette, peek, pulse, insights, triage).
import CommandPalette, { Command } from './CommandPalette';
import { slugSchema, semverSchema, fieldError } from '../../lib/validators';
import PluginReactTab from '../../lib/PluginReactTab';
import FeatureList from './FeatureList';
import FeaturePeekPanel from './FeaturePeekPanel';
import InsightsPanel from './InsightsPanel';
import TriageQueue from './TriageQueue';
import ArchitectInbox from './ArchitectInbox';
import { CollapsedGitRail } from './CollapsedRails';
import PhaseTabs, { type Phase } from './PhaseTabs';
import TestsTab from './TestsTab';
import PrsTab from './PrsTab';
// Dynamic + sticky-mount (see proposalsEverMounted gating below): defers
// the proposals JS+CSS chunks until the user first opens that tab, then
// keeps the component mounted so subsequent tab switches stay instant.
const ProposalsPanel = dynamic(() => import('./ProposalsPanel'), { ssr: false });
import HarnessHudOverlay from './HarnessHudOverlay';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import { buildRegistryPaletteItems } from '@/lib/commands/shims/palette-shim';

/**
 * Wrap a `dynamic()` import with retry + visible loading state so that a
 * one-off chunk fetch failure (services flapping, dev rebuild, network
 * blip) doesn't leave the panel area silently empty. Without this,
 * `dynamic(() => import(x))` swallows the import error and renders
 * nothing — there's no signal that anything went wrong, and the user
 * has to refresh the page to recover.
 */
type DynamicWithRetryOptions = {
  /**
   * Pre-warm the chunk on window mount. Defaults to true (matches historical
   * behavior — chunk fetches eagerly so first user click is instant).
   *
   * Set to false for cold panels that are NOT visible by default (e.g.
   * BrainstormFull, GitGraphPanel, SnapshotsPanel). When false, the chunk
   * — including its CSS — only fetches when the component is first
   * rendered, saving bytes/parse on cold dashboard load. The first user
   * interaction with that panel pays a one-time fetch cost.
   */
  prewarm?: boolean;
};
function dynamicWithRetry<T extends { default: React.ComponentType<any> }>(
  loader: () => Promise<T>,
  label: string,
  options?: DynamicWithRetryOptions,
): React.ComponentType<React.ComponentProps<T['default']>>;
function dynamicWithRetry<P>(
  loader: () => Promise<any>,
  label: string,
  pickComponent: (mod: any) => React.ComponentType<P>,
  options?: DynamicWithRetryOptions,
): React.ComponentType<P>;
function dynamicWithRetry(
  loader: () => Promise<any>,
  label: string,
  pickComponentOrOptions?: ((mod: any) => React.ComponentType<any>) | DynamicWithRetryOptions,
  maybeOptions?: DynamicWithRetryOptions,
): React.ComponentType<any> {
  const pickComponent =
    typeof pickComponentOrOptions === 'function' ? pickComponentOrOptions : undefined;
  const options =
    typeof pickComponentOrOptions === 'function' ? maybeOptions : pickComponentOrOptions;
  const prewarm = options?.prewarm ?? true;
  const importer = async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Race the import against a 30s timeout — if the chunk fetches but the
        // module's top-level evaluation hangs (e.g. an internal dep is stalled),
        // we want to fall through to retry/fallback instead of spinning forever.
        // 30s (was 8s) tolerates Turbopack dev rebuilds: when a sibling file is
        // being edited concurrently (paperclip agents, hot-saves), Fast Refresh
        // can hold the dynamic chunk for 5–10s per cycle, and 8s was tripping
        // even on healthy reloads. 30s is well past any normal recompile and
        // still short enough to bail before the user gives up watching a
        // genuinely-stuck import.
        const mod = await Promise.race([
          loader(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('import timeout')), 30000)),
        ]) as any;
        return pickComponent ? pickComponent(mod) : (mod.default ?? mod);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    // Give up on the first run, but keep retrying in the background on a
    // 5s cadence. Turbopack dev compiles can genuinely take 30s+ when a
    // sibling file is hot-saving (paperclip agents), so the import that
    // failed three times in a row will usually succeed a few seconds
    // later once the compile queue drains. On success the fallback chip
    // swaps itself for the real component without a page reload.
    const detail = String((lastErr as any)?.message ?? lastErr).slice(0, 120);
    function Fallback(props: any) {
      const [loaded, setLoaded] = useState<React.ComponentType<any> | null>(null);
      const [retrying, setRetrying] = useState(false);
      const [tries, setTries] = useState(0);
      const cancelledRef = useRef(false);
      const attempt = useCallback(async () => {
        if (cancelledRef.current) return;
        setRetrying(true);
        try {
          const mod = await Promise.race([
            loader(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('import timeout')), 30000)),
          ]);
          if (cancelledRef.current) return;
          const Resolved = pickComponent ? pickComponent(mod) : ((mod as any).default ?? mod);
          setLoaded(() => Resolved);
        } catch {
          if (cancelledRef.current) return;
          setTries((n) => n + 1);
        } finally {
          if (!cancelledRef.current) setRetrying(false);
        }
      }, []);
      useEffect(() => {
        cancelledRef.current = false;
        const id = window.setInterval(() => { void attempt(); }, 5000);
        return () => { cancelledRef.current = true; window.clearInterval(id); };
      }, [attempt]);
      if (loaded) {
        const Resolved = loaded;
        return <Resolved {...props} />;
      }
      return (
        <div className="h-dynamic-fallback" role="status">
          <span>Could not load <strong>{label}</strong>.</span>
          <span className="h-dynamic-fallback-detail">
            {retrying ? `retrying${tries > 0 ? ` (attempt ${tries + 1})` : ''}…` : detail}
          </span>
          <Tooltip label="Retry the import now">
            <button type="button" disabled={retrying} onClick={() => { void attempt(); }}>retry</button>
          </Tooltip>
          <Tooltip label="Reload the page">
            <button type="button" onClick={() => location.reload()}>reload</button>
          </Tooltip>
        </div>
      );
    }
    return Fallback as any;
  };
  // Pre-warm: kick off the import immediately so Turbopack compiles the chunk
  // before the user clicks the tab. No-op on error (retry happens on render).
  // Opt out via { prewarm: false } for cold panels — see DynamicWithRetryOptions.
  if (prewarm && typeof window !== 'undefined') void loader().catch(() => {});
  return dynamic(importer, {
    ssr: false,
    // Show a small placeholder while the chunk is fetching/compiling.
    // `loading: () => null` rendered an empty container, which on
    // dynamically-mounted modals (FeatureEditor especially) made the
    // modal look like nothing happened — the user clicked "edit", a
    // 0×0 wrapper div appeared, and they thought the button was dead.
    // A visible "loading" stub at least confirms the click registered.
    loading: () => (
      <div
        role="status"
        aria-live="polite"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '14px 18px',
          fontSize: 13,
          color: 'var(--fg-mute, #94a3b8)',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 12,
            height: 12,
            borderRadius: '50%',
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            animation: 'pc-spin 800ms linear infinite',
          }}
        />
        <span>Loading {label}…</span>
      </div>
    ),
  }) as unknown as React.ComponentType<any>;
}

// PiTerminalsDock is normally mounted inside an iframe pointing at the
// operator's /pi route (via the @papercupai/pi-coding plugin). In Next 16
// dev that iframe gets stuck on the Mission Control loading skeleton —
// hydration never completes inside the same-origin sub-frame. Since
// /pi is operator-internal anyway, render it inline when the active
// plugin tab is pi-coding's pi.
const InlinePiDock = dynamicWithRetry(() => import('./PiTerminalsDock'), 'PiTerminalsDock');
const SpecEditor = dynamicWithRetry(() => import('./SpecEditor'), 'SpecEditor');
const ManifestSpecEditor = dynamicWithRetry(() => import('./ManifestSpecEditor'), 'ManifestSpecEditor');
const EscalationBanner = dynamicWithRetry(() => import('./EscalationBanner'), 'EscalationBanner');
const CheckpointBanner = dynamicWithRetry(() => import('./CheckpointBanner'), 'CheckpointBanner');
const PlanReviewBanner = dynamicWithRetry(() => import('./PlanReviewBanner'), 'PlanReviewBanner');
// NOTE: prewarm:false would be a no-op here — the @restart/git-graph chunk
// is also pulled in by the static `preloadGitLog` import at the top of this
// file and by CollapsedRails.tsx, so it's in the dashboard's eager graph
// regardless. Deferring would require splitting the package (preload helpers
// out of the panel module) — separate task.
const GitGraphPanelLib = dynamicWithRetry(
  () => import('@restart/git-graph').then((m) => ({ default: m.GitGraphPanel })),
  'GitGraphPanel',
);
function GitGraphPanel({ slug }: { slug: string }) {
  // URL-backed worktree filter so refresh + share preserves the view.
  // '' / null = all worktrees; otherwise branch name or sha (no 'sha:' prefix
  // — git resolves both transparently and `/git/log` accepts ?branch or ?sha).
  const [worktree, setWorktree] = useQueryState('worktree', parseAsString);
  return (
    <GitGraphPanelLib
      scope={`harness:${slug}`}
      gitLogUrl={(limit: number, ref: string | null) => {
        const base = `/api/harness/${slug}/git/log?limit=${limit}`;
        if (!ref) return base;
        // Distinguish branch from sha so the server can validate properly.
        const param = /^[0-9a-f]{4,64}$/i.test(ref) ? 'sha' : 'branch';
        return `${base}&${param}=${encodeURIComponent(ref)}`;
      }}
      showCommitUrl={(sha: string) => crossOriginUrl(`/api/harness/${slug}/git/show/${sha}`)}
      worktreesUrl={() => `/api/harness/${slug}/git/worktrees`}
      worktree={worktree}
      onWorktreeChange={(next) => setWorktree(next)}
    />
  );
}
const BrainstormFull = dynamicWithRetry<{ slug: string }>(
  () => import('./brainstorm/BrainstormFull'),
  'Brainstorm',
  (m: any) => m.BrainstormFull,
);
const HooksPanel = dynamicWithRetry(() => import('./HooksPanel'), 'HooksPanel', { prewarm: false });
const FeatureEditor = dynamicWithRetry(() => import('./FeatureEditor'), 'FeatureEditor', { prewarm: false });
const InterventionPanel = dynamicWithRetry(() => import('./InterventionPanel'), 'InterventionPanel', { prewarm: false });
const UsagePanel = dynamicWithRetry(() => import('./UsagePanel'), 'UsagePanel', { prewarm: false });
const SnapshotsPanel = dynamicWithRetry(() => import('./SnapshotsPanel'), 'SnapshotsPanel', { prewarm: false });
const ScreenshotsPanel = dynamicWithRetry(() => import('./ScreenshotsPanel'), 'ScreenshotsPanel', { prewarm: false });
const TemplatesModal = dynamicWithRetry(() => import('./TemplatesModal'), 'TemplatesModal', { prewarm: false });
const FeatureDiffModal = dynamicWithRetry(() => import('./FeatureDiffModal'), 'FeatureDiffModal', { prewarm: false });
const ArchivesPanel = dynamicWithRetry(() => import('./ArchivesPanel'), 'ArchivesPanel', { prewarm: false });
const DecisionsPanel = dynamicWithRetry(() => import('./DecisionsPanel'), 'DecisionsPanel', { prewarm: false });
const IntelPanel = dynamicWithRetry(() => import('./IntelPanel'), 'IntelPanel', { prewarm: false });
const HealthBadge = dynamicWithRetry(() => import('./HealthBadge'), 'HealthBadge');
const SyncWithMainBadge = dynamicWithRetry(() => import('./SyncWithMainBadge'), 'SyncWithMainBadge');
const SyncWithMainDialog = dynamicWithRetry(() => import('./SyncWithMainDialog'), 'SyncWithMainDialog');
import DiscordChannelLink from '../_components/DiscordChannelLink';
import { useLocalGithubUser } from './useLocalGithubUser';
const SmokeTestPanel = dynamicWithRetry(() => import('./SmokeTestPanel'), 'SmokeTestPanel');
const IdentityPanel = dynamicWithRetry(() => import('./IdentityPanel'), 'IdentityPanel');
const SummaryPanel = dynamicWithRetry(() => import('./SummaryPanel'), 'SummaryPanel');
const DesignDashboard = dynamicWithRetry<{ slug: string }>(
  () => import('../design/[slug]/DesignDashboard'),
  'DesignDashboard',
);
const ExpertsPanel = dynamicWithRetry(() => import('./ExpertsPanel'), 'ExpertsPanel');

// ─── Types ─────────────────────────────────────────────────────────────

// FeatureStatus comes from @restart/ui-primitives so the canonical
// list (rendered by StatusPill) and the dashboard's typing stay in sync.
import type { FeatureStatus } from '@restart/ui-primitives';

interface ProjectEntry {
  slug: string;
  path: string;
  hasState: boolean;
  hasSpec: boolean;
}

interface Feature {
  id: string;
  title: string;
  claims?: string[];
  status: FeatureStatus;
  attempts: number;
  summary?: string;
  sourcePlanSlug?: string;
}

interface Status {
  project: { slug: string; path: string };
  features: Feature[];
  counts: Record<string, number>;
  iteration: number;
  lastDecision: string | null;
  alive: boolean;
  escalated: boolean;
  pendingCheckpoints?: number;
  activeCompetitions?: number;
  smokeFail?: boolean;
  missionCostUsd?: number;
  missionInputTokens?: number;
  missionOutputTokens?: number;
  discord_channel_url?: string | null;
}

interface TimelineEntry {
  kind: 'text' | 'tool_use' | 'tool_result' | 'status' | 'result' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

interface AgentDetail {
  runId: string;
  stdout: string | null;
  stderr: string | null;
  jsonlBytes: number;
  timeline: TimelineEntry[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface AgentRun {
  runId: string;
  role: string;
  ts: number;
  sizeBytes: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const STATUS_ORDER: FeatureStatus[] = ['in_progress', 'validating', 'failing', 'todo', 'blocked', 'passed'];
const STATUS_LABELS: Record<FeatureStatus, string> = {
  todo: 'todo',
  in_progress: 'running',
  validating: 'validating',
  failing: 'failing',
  passed: 'passed',
  blocked: 'blocked',
};

const EMPTY_FEATURES: Feature[] = [];

function fmtAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

// PG `claims` is a JSON-encoded string array. Defensively handle invalid
// JSON, non-array shapes, and pre-encoded arrays already passed through.
function safeParseClaims(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw.map((s) => String(s));
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v.map((s) => String(s));
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

// ─── Component ─────────────────────────────────────────────────────────


/**
 * Stable portal-rendered collapse control for the harness top chrome.
 *
 * Always keeping the same DOM node, width, and positioning avoids the old
 * "collapse button disappears / expand button reappears in a different spot"
 * jump while the URL-backed `chromeCollapsed` param settles.
 */
function CollapseTopSectionPortalButton({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const [autoToggleLeft, setAutoToggleLeft] = useState<number | null>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted || collapsed || typeof window === 'undefined') {
      setAutoToggleLeft(null);
      return;
    }

    const update = () => {
      const autoToggle = document.querySelector<HTMLElement>('.pc-header-cta-select-shell');
      if (!autoToggle) {
        setAutoToggleLeft(null);
        return;
      }
      setAutoToggleLeft(Math.round(autoToggle.getBoundingClientRect().right + 8));
    };

    const header = document.querySelector<HTMLElement>('.pc-header');
    const autoToggle = document.querySelector<HTMLElement>('.pc-header-cta-select-shell');
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (header) observer?.observe(header);
    if (autoToggle) observer?.observe(autoToggle);
    const frame = window.requestAnimationFrame(update);
    window.addEventListener('resize', update);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [collapsed, mounted]);

  if (!mounted || typeof document === 'undefined') return null;
  const Icon = collapsed ? LChevronDown : LChevronUp;
  const actionLabel = collapsed ? 'Show top section' : 'Hide top section';
  const stateLabel = collapsed ? 'Show' : 'Hide';
  const buttonStyle = autoToggleLeft === null
    ? undefined
    : ({ '--h-top-collapse-left': `${autoToggleLeft}px` } as CSSProperties);
  return createPortal(
    <button
      type="button"
      className="h-top-collapse-btn h-top-collapse-inline"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-align={autoToggleLeft === null ? 'center' : 'auto-toggle'}
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={actionLabel}
      style={buttonStyle}
    >
      <Icon className="h-top-collapse-icon" size={13} strokeWidth={2.4} aria-hidden="true" />
      <span className="h-top-collapse-state" aria-hidden="true">{stateLabel}</span>
    </button>,
    document.body
  );
}

function mainTabAccentClassForPlugin(tabId: string, label: string) {
  const key = `${tabId} ${label}`.toLowerCase();
  if (key.includes('docs') || key.includes('fumadocs')) return 'h-tab--docs';
  if (key === 'pi' || key.includes('plugin:pi') || /\bpi\b/.test(key)) return 'h-tab--pi';
  if (key.includes('vscode') || key.includes('vs code') || key.includes('code-server')) return 'h-tab--vscode';
  return 'h-tab--plugin';
}

/**
 * Plugin tab trigger.
 */
function PluginTabTrigger({ pluginSlug, pluginVersion, tabId, label, icon, activeSlug }: {
  pluginSlug: string;
  pluginVersion: string;
  tabId: string;
  label: string;
  icon: string | null;
  activeSlug: string | null;
  onDisabled: () => void;
}) {
  return (
    <Tooltip label={`${label} — from ${pluginSlug}@${pluginVersion}`}>
      <Tabs.Trigger value={`plugin:${tabId}`} className={`h-tab ${mainTabAccentClassForPlugin(tabId, label)}`} disabled={!activeSlug}>
        <PluginIcon name={icon} /> {label}
      </Tabs.Trigger>
    </Tooltip>
  );
}

/**
 * iframe wrapper that shows a skeleton+spinner while the underlying plugin
 * service spins up (e.g. code-server cold start). Fades the loader once the
 * iframe fires `onLoad`. Includes a "still loading?" hint after 8s with a
 * direct-open link so the operator isn't stuck staring at a blank slate.
 */
function PluginIframeWithLoader({ url, title }: { url: string; title: string }) {
  const [loaded, setLoaded] = useState(false);
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setShowHint(false);
    const t = setTimeout(() => setShowHint(true), 8000);
    return () => clearTimeout(t);
  }, [url]);
  return (
    <div className="h-plugin-embed-shell" style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <iframe
        className="h-plugin-embed-frame"
        src={url}
        title={title}
        onLoad={() => setLoaded(true)}
        style={{ flex: 1, border: 'none', width: '100%', height: '100%', background: 'var(--bg-2)' }}
      />
      {!loaded ? (
        <div
          className="h-plugin-embed-loading"
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 12,
            background: 'var(--bg-2)',
            color: 'var(--fg-dim)',
            fontSize: 13,
            transition: 'opacity 200ms',
            pointerEvents: 'none',
          }}
        >
          <div
            aria-hidden
            style={{
              width: 28, height: 28, borderRadius: '50%',
              border: '2px solid var(--border)', borderTopColor: 'var(--accent-strong)',
              animation: 'papercusp-spin 0.8s linear infinite',
            }}
          />
          <div>{title} — loading…</div>
          {showHint ? (
            <div style={{ fontSize: 11, color: 'var(--fg-mute)', maxWidth: 360, textAlign: 'center' }}>
              Still loading? The plugin service may not be running. Try opening{' '}
              <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-strong)', textDecoration: 'underline', pointerEvents: 'auto' }}>
                {url}
              </a>{' '}
              directly.
            </div>
          ) : null}
          <style>{`@keyframes papercusp-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Resolve the slug used by the CLI / `/api/plugins/enable` for a given
 * installed plugin. Top-level dirs (`global-plugins/<name>/`) → `<name>`;
 * scoped-package dirs (`global-plugins/@scope/<name>/`) → `@scope/<name>`.
 * Sending the bare basename for scoped-only installs makes the CLI look up
 * `<name>` at the top level and fail with "not installed".
 */
// pluginSlugFromPath + InstalledPluginAction + InstalledPluginInfo now live
// in ./plugin-utils (imported above).

/**
 * "+" trigger after the last plugin tab. Opens a popover listing every
 * installed plugin not currently enabled in this harness; clicking one
 * fires `papercusp plugin enable <slug> --harness <activeSlug>` and the
 * dashboard re-fetches its contributions on the next tick.
 */
function AddPluginButton({ activeSlug, alreadyEnabled, installed, error, onEnabled, onRetry }: {
  activeSlug: string | null;
  alreadyEnabled: Set<string>;
  /** null = still loading; [] = loaded but empty; populated array = ready. */
  installed: InstalledPluginInfo[] | null;
  /** non-null = the prefetch failed/timed out — show error UI in popover. */
  error: string | null;
  onEnabled: () => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  // Smooth FLIP animation when the candidate list grows (marketplace
  // catalog arrives after the popover opens) or shrinks (plugin
  // enabled, falls off the candidates list).
  const [listRef] = useAutoAnimate<HTMLUListElement>();
  // Marketplace catalog (plugins not yet installed in this workspace) —
  // fetched lazily on first popover open so the user can install + enable
  // in one click without leaving the dashboard.
  const [marketplace, setMarketplace] = useState<Array<{ name: string; version?: string; description?: string; icon?: string | null }> | null>(null);
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || marketplace !== null) return;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    fetch('/api/marketplace/catalog', { cache: 'no-store', signal: ac.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => {
        const items = Array.isArray(d?.catalog) ? d.catalog : [];
        setMarketplace(items.filter((m: { kind?: string }) => (m.kind ?? 'template') === 'plugin'));
        setMarketplaceError(null);
      })
      .catch((e) => setMarketplaceError(e?.name === 'AbortError' ? 'Marketplace timed out' : String(e?.message ?? e)))
      .finally(() => clearTimeout(t));
    return () => { clearTimeout(t); ac.abort(); };
  }, [open, marketplace]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    // Popover is ~373px tall; if there isn't room below the button, flip
    // it above. Without this, on shorter viewports the popover anchors
    // below the button and renders past the bottom of the page —
    // looks like the button "doesn't do anything".
    const POPOVER_HEIGHT_ESTIMATE = 380;
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const flipUp = spaceBelow < POPOVER_HEIGHT_ESTIMATE && spaceAbove > spaceBelow;
    const top = flipUp
      ? Math.max(8, r.top - POPOVER_HEIGHT_ESTIMATE - 4)
      : r.bottom + 4;
    setCoords({ top, right: window.innerWidth - r.right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-add-plugin-popover]')) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [open]);

  const candidates = useMemo(
    () => (installed ?? []).filter((p) => {
      const dirSlug = pluginSlugFromPath(p.path, p.name);
      return !alreadyEnabled.has(dirSlug) && !alreadyEnabled.has(p.name);
    }),
    [installed, alreadyEnabled],
  );
  const marketplaceCandidates = useMemo(
    () => (marketplace ?? []).filter((m) => {
      if (alreadyEnabled.has(m.name)) return false;
      return !(installed ?? []).some((p) => p.name === m.name);
    }),
    [marketplace, installed, alreadyEnabled],
  );

  async function installAndEnable(name: string) {
    if (!activeSlug) {
      toast.error('No harness selected', { description: 'Pick a harness in the project picker before adding a plugin.' });
      return;
    }
    setBusy(name);
    try {
      const r = await fetch('/api/marketplace/install-plugin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: name }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        // Strip ANSI colour codes from CLI output before showing the toast —
        // sonner renders them as visible "[36m" sequences otherwise.
        const cleanLog = String(d.log ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
        const lastLines = cleanLog.split('\n').filter(Boolean).slice(-3).join('\n');
        const desc = lastLines || d.error || 'unknown';
        // Catalog/marketplace mismatch is the most common cause when the
        // CLI returns "not found" — surface a clearer next step.
        const notFound = /not found/i.test(cleanLog);
        toast.error(`Install failed: ${name}`, {
          description: notFound
            ? `${desc}\n\nThe marketplace catalog lists this plugin but the install fetch returned 404. The publisher likely removed the tarball; try refreshing the catalog or pick a different plugin.`
            : desc,
          duration: 10000,
        });
        return;
      }
      const er = await fetch('/api/plugins/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: name, harnesses: [activeSlug] }),
      });
      const ed = await er.json();
      if (!er.ok || !ed.ok) {
        const rawLog = ed.results?.[0]?.log ?? '';
        const cleanLog = String(rawLog).replace(/\x1b\[[0-9;]*m/g, '').trim();
        const lastLines = cleanLog.split('\n').filter(Boolean).slice(-3).join('\n');
        toast.error(`Enable failed: ${name}`, {
          description: lastLines || ed.error || 'installed but not enabled',
          duration: 10000,
        });
        return;
      }
      toast.success(`${name} installed and enabled in ${activeSlug}`);
      setOpen(false);
      onEnabled();
    } catch (e: any) {
      toast.error(`Install failed: ${name}`, { description: String(e?.message ?? e), duration: 10000 });
    } finally {
      setBusy(null);
    }
  }

  async function enable(plugin: InstalledPluginInfo) {
    if (!activeSlug) return;
    // Use the on-disk dir basename — that's what the CLI keys
    // enabled-plugins.json by, independent of scoped manifest.name.
    const dirSlug = pluginSlugFromPath(plugin.path, plugin.name);
    const displayName = plugin.name || dirSlug;
    setBusy(dirSlug);
    try {
      const r = await fetch('/api/plugins/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: dirSlug, harnesses: [activeSlug] }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`Enable failed: ${displayName}`, {
          description: d.results?.[0]?.log?.slice(-300) ?? d.error ?? 'unknown',
        });
        return;
      }
      const contributesTab = (plugin.dashboardTabs?.length ?? 0) > 0;
      toast.success(`${displayName} enabled in ${activeSlug}`, {
        description: contributesTab
          ? 'Tab added to the harness workspace.'
          : 'Plugin is active. It contributes actions/secrets/webhooks (no dashboard tab).',
      });
      setOpen(false);
      onEnabled();
    } catch (e: any) {
      toast.error(`Enable failed: ${displayName}`, { description: String(e?.message ?? e) });
    } finally {
      setBusy(null);
    }
  }

  if (!activeSlug) return null;

  return (
    <div data-add-plugin-popover style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <Tooltip label="Add a plugin to this harness">
        <button
          ref={btnRef}
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          className="h-tab h-add-plugin-tab"
          style={{
            background: open ? 'var(--accent)' : 'rgba(99, 102, 241, 0.15)',
            borderColor: open ? 'var(--accent)' : 'rgba(99, 102, 241, 0.5)',
            color: open ? '#fff' : '#a5b4fc',
            cursor: 'pointer',
          }}
          aria-label="Add plugin"
        >
          <Plus size={14} /> Add plugin
        </button>
      </Tooltip>
      {open && coords && typeof document !== 'undefined' ? createPortal(
        <div
          data-add-plugin-popover
          style={{
            position: 'fixed', top: coords.top, right: coords.right,
            zIndex: 1000, minWidth: 320, maxWidth: 400,
            background: 'var(--bg-1)', color: 'var(--fg)',
            border: '1px solid var(--border)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            padding: 8,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--fg-mute)', padding: '4px 8px 8px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
            Add to <code style={{ fontSize: 11 }}>{activeSlug}</code>
          </div>
          {error ? (
            <div style={{ padding: '12px 8px', fontSize: 12, color: 'var(--fg-mute)' }}>
              <div style={{ color: 'var(--bad)', marginBottom: 6 }}>Couldn't load plugins.</div>
              <div style={{ marginBottom: 8, fontSize: 11 }}>{error}</div>
              <Tooltip label="Retry plugin discovery">
                <button
                type="button"
                onClick={onRetry}
                style={{
                  padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                  background: 'var(--bg-2)', border: '1px solid var(--border)',
                  color: 'var(--fg)', borderRadius: 4,
                }}
              >Retry</button>
              </Tooltip>
            </div>
          ) : installed === null ? (
            <div style={{ padding: '12px 8px', fontSize: 12, color: 'var(--fg-mute)' }}>Loading…</div>
          ) : (
            <ul ref={listRef} style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 360, overflowY: 'auto' }}>
              {candidates.length > 0 && (
                <li style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-mute)', padding: '6px 10px 2px' }}>Installed</li>
              )}
              {candidates.map((p) => {
                const tabIcon = p.dashboardTabs?.[0]?.icon ?? p.icon ?? null;
                return (
                  <li key={`installed:${p.name}`}>
                    <Tooltip label="Enable this plugin in the active harness">
                      <button
                        type="button"
                        onClick={() => enable(p)}
                        disabled={busy !== null}
                        style={{
                          width: '100%', textAlign: 'left', padding: '8px 10px',
                          background: 'transparent', border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
                          color: 'var(--fg)', fontSize: 12, borderRadius: 4,
                          display: 'flex', alignItems: 'flex-start', gap: 10,
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <span style={{
                          flex: '0 0 auto', width: 22, height: 22, borderRadius: 4,
                          background: 'var(--bg-2)', display: 'inline-flex',
                          alignItems: 'center', justifyContent: 'center',
                          color: '#a5b4fc',
                        }}>
                          <PluginIcon name={tabIcon} size={14} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500 }}>{p.name}{p.version ? <span style={{ color: 'var(--fg-mute)', fontWeight: 400 }}> @{p.version}</span> : null}</div>
                          {p.description && <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 2, lineHeight: 1.4 }}>{p.description}</div>}
                        </span>
                      </button>
                    </Tooltip>
                  </li>
                );
              })}
              {marketplace === null && marketplaceError === null && (
                <li style={{ padding: '8px 10px', fontSize: 11, color: 'var(--fg-mute)' }}>Loading marketplace…</li>
              )}
              {marketplaceCandidates.length > 0 && (
                <li style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-mute)', padding: '10px 10px 2px', borderTop: candidates.length > 0 ? '1px solid var(--border)' : 'none', marginTop: candidates.length > 0 ? 4 : 0 }}>Marketplace</li>
              )}
              {marketplaceCandidates.map((m) => {
                const isBusy = busy === m.name;
                return (
                  <li key={`market:${m.name}`}>
                    <Tooltip label="Install from marketplace and enable in the active harness">
                      <button
                        type="button"
                        onClick={() => void installAndEnable(m.name)}
                        disabled={busy !== null}
                        style={{
                          width: '100%', textAlign: 'left', padding: '8px 10px',
                          background: 'transparent', border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
                          color: 'var(--fg)', fontSize: 12, borderRadius: 4,
                          display: 'flex', alignItems: 'flex-start', gap: 10,
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <span style={{
                          flex: '0 0 auto', width: 22, height: 22, borderRadius: 4,
                          background: 'var(--bg-2)', display: 'inline-flex',
                          alignItems: 'center', justifyContent: 'center',
                          color: '#a5b4fc',
                        }}>
                          <PluginIcon name={m.icon ?? null} size={14} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>{m.name}{m.version ? <span style={{ color: 'var(--fg-mute)', fontWeight: 400 }}> @{m.version}</span> : null}</span>
                            <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '1px 5px', borderRadius: 3, background: 'rgba(99, 102, 241, 0.15)', color: '#a5b4fc' }}>{isBusy ? 'installing…' : 'install'}</span>
                          </div>
                          {m.description && <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 2, lineHeight: 1.4 }}>{m.description}</div>}
                        </span>
                      </button>
                    </Tooltip>
                  </li>
                );
              })}
              {candidates.length === 0 && marketplaceCandidates.length === 0 && marketplace !== null && (
                <li style={{ padding: '12px 8px', fontSize: 12, color: 'var(--fg-mute)' }}>
                  {(installed?.length ?? 0) === 0
                    ? <>Marketplace catalog empty. {marketplaceError && <span style={{ color: 'var(--bad)' }}>({marketplaceError})</span>} <a href="/marketplace/plugins" style={{ color: 'var(--accent)' }}>Browse →</a></>
                    : <>All installed plugins are already enabled here. <a href="/marketplace/plugins" style={{ color: 'var(--accent)' }}>Browse marketplace →</a></>}
                </li>
              )}
              {marketplaceError && marketplace === null && (
                <li style={{ padding: '8px 10px', fontSize: 11, color: 'var(--bad)' }}>Marketplace unreachable: {marketplaceError}</li>
              )}
            </ul>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

// EnabledPluginManifest now lives in ./plugin-utils (imported above).

/**
 * Visible per-harness "what plugins are enabled" surface. Lists every
 * enabled plugin with its actions/event-listeners/required-capabilities/
 * config-file path, plus an Invoke button per action and a Disable button.
 *
 * Critical for action-only plugins (slack-notifier, jira-sync, etc.) that
 * don't render a dashboard tab — without this panel the operator has no
 * way to confirm they're enabled or fire their actions from the UI.
 */
/**
 * Reads the harness's manifest. If `configFiles` is declared, mounts the
 * template-driven `<ManifestSpecEditor>`. Otherwise falls back to the
 * legacy hardcoded-9-tabs `<SpecEditor>`. The fetch is fire-and-forget;
 * during the brief load window we render the legacy editor (which works
 * for any harness) so users never see a blank panel.
 */
function ManifestOrLegacySpecEditor({ slug, projectPath, alive, onClose }: {
  slug: string;
  projectPath: string;
  alive: boolean;
  onClose: () => void;
}) {
  const [configFiles, setConfigFiles] = useState<Array<{ path: string; label?: string; language?: 'markdown' | 'json' | 'yaml' | 'text'; description?: string; sensitivity?: 'normal' | 'warn' | 'secret' }> | null | 'pending'>('pending');
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/harness/${encodeURIComponent(slug)}/manifest`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : Promise.resolve({ configFiles: null }))
      .then((d) => { if (!cancelled) setConfigFiles(Array.isArray(d?.configFiles) && d.configFiles.length > 0 ? d.configFiles : null); })
      .catch(() => { if (!cancelled) setConfigFiles(null); });
    return () => { cancelled = true; };
  }, [slug]);
  if (configFiles === 'pending') {
    // Show a skeleton instead of SpecEditor. Mounting SpecEditor here
    // and then swapping to ManifestSpecEditor when the manifest fetch
    // resolves causes a visible swap of editor tabs (Spec/Agents/...
    // → custom config-files list) plus a Monaco editor remount. The
    // fetch is a single GET — ~100-200ms — so a brief placeholder is
    // the right UX, not a wrong editor.
    return (
      <div style={{ flex: 1, padding: '2rem', color: 'var(--fg-mute)' }} aria-busy="true">
        loading…
      </div>
    );
  }
  if (configFiles && configFiles.length > 0) {
    return <ManifestSpecEditor inline slug={slug} projectPath={projectPath} alive={alive} onClose={onClose} configFiles={configFiles} />;
  }
  return <SpecEditor inline slug={slug} projectPath={projectPath} alive={alive} onClose={onClose} />;
}

/**
 * "Save template" button — forks the current harness's recipe (manifest +
 * SPEC.md / AGENTS.md / .harness/config.json / validation-contract.md +
 * recommended plugins lifted from enabled-plugins.json) into
 * ~/.papercusp/templates/<new-slug>/<version>/. The output is `papercusp init`
 * -ready and can be edited at /installed/templates/<slug>/edit (page TBD).
 *
 * Distinct from SaveSnapshotButton — templates capture the recipe, not the
 * in-flight state. No harness_features rows, no agent transcripts, no logs.
 */
function SaveTemplateButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newSlug, setNewSlug] = useState(`${slug}-template`);
  const [version, setVersion] = useState('0.1.0');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');

  const slugErr = fieldError(slugSchema, newSlug);
  const versionErr = fieldError(semverSchema, version);
  const formInvalid = slugErr !== null || versionErr !== null;

  const onSubmit = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/save-as-template`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: newSlug.trim(), version: version.trim(), description: description.trim(), author: author.trim() }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        toast.error(j.error ?? `save-as-template failed (${r.status})`);
        return;
      }
      toast.success(`Saved template ${j.slug}@${j.version}`, {
        description: `${j.copied?.length ?? 0} files + ${j.pluginRecs ?? 0} plugin recommendations`,
        duration: 8000,
        action: j.editPath ? {
          label: 'edit',
          onClick: () => window.open(j.editPath, '_blank', 'noopener'),
        } : undefined,
      });
      setOpen(false);
    } catch (e: unknown) {
      toast.error(`save-as-template error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, color: 'var(--fg-mute)', marginBottom: 4 };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 8px', background: 'var(--bg-1)',
    border: '1px solid var(--border)', borderRadius: 4, color: 'var(--fg)', fontSize: 13,
  };

  return (
    <>
      <button className="h-btn ghost h-save-template-btn" onClick={() => setOpen(true)} disabled={busy}>
        <Layers size={13} /> {busy ? 'saving…' : 'save template'}
      </button>
      <Modal
        open={open}
        onOpenChange={(v) => { if (!busy) setOpen(v); }}
        title="Save as template"
        description="Fork the harness recipe (SPEC, AGENTS, config, recommended plugins) into ~/.papercusp/templates/."
        contentStyle={{ width: 480, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 20 }}
      >
        <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600 }}>Save as template</h2>
        <div style={{ color: 'var(--fg-mute)', fontSize: 12, marginBottom: 16 }}>
          Forks <strong>{slug}</strong>&rsquo;s recipe (SPEC.md / AGENTS.md / .harness/config.json / validation-contract.md + recommended plugins) into <code>~/.papercusp/templates/&lt;slug&gt;/&lt;version&gt;/</code>. No mid-mission state is included.
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Slug</label>
          <input
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value)}
            disabled={busy}
            aria-invalid={slugErr !== null}
            style={{
              ...inputStyle,
              fontFamily: 'monospace',
              border: slugErr ? '1px solid var(--bad, #fb7185)' : inputStyle.border,
            }}
          />
          {slugErr && (
            <div style={{ color: 'var(--bad, #fb7185)', fontSize: 11, marginTop: 4 }}>{slugErr}</div>
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Version (semver)</label>
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            disabled={busy}
            aria-invalid={versionErr !== null}
            style={{
              ...inputStyle,
              width: 140,
              fontFamily: 'monospace',
              border: versionErr ? '1px solid var(--bad, #fb7185)' : inputStyle.border,
            }}
          />
          {versionErr && (
            <div style={{ color: 'var(--bad, #fb7185)', fontSize: 11, marginTop: 4 }}>{versionErr}</div>
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy}
            placeholder={`Template forked from ${slug}`}
            style={inputStyle} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Author (optional)</label>
          <input value={author} onChange={(e) => setAuthor(e.target.value)} disabled={busy}
            style={inputStyle} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" className="h-btn ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
          <button type="button" className="h-btn" onClick={() => void onSubmit()} disabled={busy || formInvalid}>
            {busy ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </Modal>
    </>
  );
}

/**
 * "Save snapshot" button — captures the current harness state to a
 * tarball under <projectDir>/.harness/snapshots/<id>.tar.gz. Then the
 * user can browse, instantiate, or publish it from the top-nav
 * Snapshots tab.
 */
function SaveSnapshotButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const defaultName = `${slug} snapshot @ ${new Date().toISOString().slice(0, 16)}`;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [license, setLicense] = useState('MIT');
  const [includeGit, setIncludeGit] = useState(false);
  const [includeAgentTranscripts, setIncludeAgentTranscripts] = useState(false);
  const [includeOperatorNotes, setIncludeOperatorNotes] = useState(true);
  const [acceptVerifiedSecrets, setAcceptVerifiedSecrets] = useState(false);

  async function onSubmit() {
    setBusy(true);
    const t = toast.loading('Capturing snapshot…');
    try {
      const r = await fetch('/api/snapshots/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug,
          name: name.trim() || undefined,
          description: description.trim() || undefined,
          license: license.trim() || 'MIT',
          includeGit,
          includeAgentTranscripts,
          includeOperatorNotes,
          acceptVerifiedSecrets,
          // soft-cap default: bypass for a one-click flow. The lib still
          // hard-caps at 1 GB, so genuinely runaway snapshots still refuse.
          acceptSoftCap: true,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`snapshot failed: ${d.error ?? `HTTP ${r.status}`}`, { id: t });
        return;
      }
      toast.success(`Snapshot ${d.id} captured (${(d.bytes / 1e6).toFixed(1)} MB)`, {
        id: t,
        action: { label: 'Open Snapshots', onClick: () => { navigateClient('/snapshots'); } },
        duration: 8000,
      });
      for (const w of (d.warnings ?? []) as string[]) toast.warning(w);
      setOpen(false);
      setName('');
      setDescription('');
    } catch (e: unknown) {
      toast.error(`snapshot failed: ${e instanceof Error ? e.message : String(e)}`, { id: t });
    } finally {
      setBusy(false);
    }
  }

  const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, color: 'var(--fg-mute)', marginBottom: 4 };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 8px', background: 'var(--bg-3)',
    border: '1px solid var(--border)', borderRadius: 4, color: 'var(--fg)', fontSize: 13,
  };
  const checkRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6 };

  return (
    <>
      <Tooltip label="Save current harness state as a tarball">
        <button type="button" className="h-btn ghost h-save-snapshot-btn" onClick={() => setOpen(true)} disabled={busy}>
          {busy ? '…' : 'save snapshot'}
        </button>
      </Tooltip>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Save snapshot"
        description="Capture the current harness state as a forkable, publishable tarball."
        contentStyle={{ width: 480, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 20 }}
      >
        <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600 }}>Save snapshot</h2>
        <div style={{ color: 'var(--fg-mute)', fontSize: 12, marginBottom: 16 }}>
          Captures `.harness/` + per-harness PG schema. Logs/screenshots are excluded by default.
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} style={inputStyle} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Description (optional)</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>License</label>
          <input type="text" value={license} onChange={(e) => setLicense(e.target.value)} style={inputStyle} />
        </div>

        <div style={{ marginTop: 16, marginBottom: 4, fontSize: 12, color: 'var(--fg-mute)' }}>Include</div>
        <label style={checkRow}>
          <Checkbox checked={includeOperatorNotes} onChange={setIncludeOperatorNotes} ariaLabel="Papercup notes" />
          Papercup notes
        </label>
        <label style={checkRow}>
          <Checkbox checked={includeAgentTranscripts} onChange={setIncludeAgentTranscripts} ariaLabel="Agent transcripts" />
          Agent transcripts
        </label>
        <label style={checkRow}>
          <Checkbox checked={includeGit} onChange={setIncludeGit} ariaLabel=".git directory" />
          .git directory <span style={{ color: 'var(--fg-mute)' }}>(large)</span>
        </label>
        <label style={checkRow}>
          <Checkbox checked={acceptVerifiedSecrets} onChange={setAcceptVerifiedSecrets} ariaLabel="Accept verified secrets" />
          <span>Accept verified secrets <span style={{ color: 'var(--fg-mute)' }}>(don't fail on detected secrets)</span></span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" className="h-btn ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
          <button type="button" className="h-btn" onClick={() => void onSubmit()} disabled={busy}>
            {busy ? 'Capturing…' : 'Capture snapshot'}
          </button>
        </div>
      </Modal>
    </>
  );
}

/**
 * Renders enabled-plugin actions whose manifest declares
 * `surfaces: ['harness-toolbar']` as buttons in the harness-page header,
 * alongside the built-in triage / start-stop controls. Click → fires the
 * action via `/api/plugins/invoke` with a Sonner toast for feedback.
 *
 * This is what makes plugin-contributed actions (e.g. cloudflare-pages's
 * `publish`, slack-notifier's `notify`, jira-sync's `create-issue`)
 * actually visible in the operator's main flow rather than buried inside
 * the config sub-panel.
 */
type HarnessToolbarAction = {
  pluginName: string;
  pluginDirSlug: string;
  pluginIcon: string | null;
  /** Manifest-declared icon name from `actions[].icon`, falling back to the
   *  plugin-level icon if absent. Resolved via PLUGIN_ICON_MAP. */
  actionIcon: string | null;
  name: string;
  label: string;
};

function collectHarnessToolbarActions(installed: InstalledPluginInfo[], enabledSlugs: string[]): HarnessToolbarAction[] {
  const enabledSet = new Set(enabledSlugs);
  const toolbarActions: HarnessToolbarAction[] = [];
  // Dedupe by (pluginName, action.name) — guards against `installed[]`
  // accidentally containing the same plugin under two paths.
  const seen = new Set<string>();
  for (const p of installed) {
    const dirSlug = pluginSlugFromPath(p.path, p.name);
    if (!(enabledSet.has(p.name) || enabledSet.has(dirSlug))) continue;
    const actions = p.actions ?? [];
    for (const a of actions) {
      if (!a.name) continue;
      if (!Array.isArray(a.surfaces) || !a.surfaces.includes('harness-toolbar')) continue;
      const key = `${p.name}/${a.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      toolbarActions.push({
        pluginName: p.name,
        pluginDirSlug: dirSlug,
        pluginIcon: p.icon ?? null,
        actionIcon: a.icon ?? p.icon ?? null,
        name: a.name,
        label: a.label ?? a.name,
      });
    }
  }
  return toolbarActions;
}

async function invokeHarnessToolbarAction(
  harnessSlug: string,
  action: HarnessToolbarAction,
  params?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: string; error?: string; log?: string }> {
  const r = await fetch('/api/plugins/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: action.pluginDirSlug, action: action.name, harness: harnessSlug, params }),
  });
  const d = await r.json();
  if (!r.ok || !d.ok) {
    return { ok: false, error: d.error ?? `invoke exited ${r.status}`, log: d.log };
  }
  return { ok: true, result: typeof d.result === 'string' ? d.result : undefined, log: d.log };
}

/**
 * Pure manifest-driven harness toolbar row.
 *
 * Renders one button per `actions[]` entry whose `surfaces` includes
 * `harness-toolbar`, on plugins that are installed AND enabled for this
 * harness. Icon comes from `actions[].icon` (resolved via PLUGIN_ICON_MAP),
 * falling back to the plugin-level icon, then to Puzzle. No hardcoded list,
 * no fallback "enable plugin" CTAs — install the plugin and the button
 * appears; uninstall and it disappears. Same flow as `dashboardTabs[]`.
 */
function HarnessQuickActionRow({ harnessSlug, installed, enabledSlugs, pluginsMissing, onGoToPluginConfig }: {
  harnessSlug: string;
  installed: InstalledPluginInfo[];
  enabledSlugs: string[];
  /** pluginName → list of required fields that are absent or empty. */
  pluginsMissing: Record<string, string[]>;
  /** Click-handler when the user clicks a "needs setup" red button. */
  onGoToPluginConfig: (pluginName: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const actions = collectHarnessToolbarActions(installed, enabledSlugs);

  async function invoke(action: HarnessToolbarAction) {
    const key = `${action.pluginDirSlug}/${action.name}`;
    setBusy(key);
    try {
      const result = await invokeHarnessToolbarAction(harnessSlug, action);
      if (!result.ok) {
        // Prefer the log over the wrapper error: the wrapper is just
        // "invoke exited 1", the log has the actual reason (plugin not
        // enabled, missing credentials, etc.). Strip ANSI escapes the
        // CLI emits — they render as garbage in the toast.
        const stripped = (result.log ?? '').replace(/\[[0-9;]*m/g, '').trim();
        const description = stripped.length > 0
          ? stripped.slice(-400)
          : result.error;
        toast.error(`${action.label} failed`, { description, duration: 12000 });
        return;
      }
      toast.success(`${action.label} started`, {
        description: result.result?.slice(0, 200) ?? `Handled by ${action.pluginName}.`,
      });
    } catch (e: any) {
      toast.error(`${action.label} failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  }

  if (actions.length === 0) return null;

  return (
    <div className="h-quick-action-row" aria-label="Plugin actions">
      <div className="h-quick-action-buttons">
        {actions.map((a) => {
          const key = `${a.pluginDirSlug}/${a.name}`;
          const isBusy = busy === key;
          const missing = pluginsMissing[a.pluginName] ?? [];
          const needsSetup = missing.length > 0;
          // Tooltip names each missing field per spec: "github_token is empty".
          const tooltip = needsSetup
            ? `${missing.map((f) => `${f} is empty`).join(' · ')} — click to fix in Config`
            : `${a.label} — from ${a.pluginName}`;
          return (
            <Tooltip key={key} label={tooltip}>
              <button
                type="button"
                className={`h-quick-action-btn${needsSetup ? ' needs-setup' : ''}`}
                onClick={() => needsSetup ? onGoToPluginConfig(a.pluginName) : void invoke(a)}
                aria-disabled={isBusy}
                aria-invalid={needsSetup ? true : undefined}
                style={needsSetup ? {
                  background: 'rgba(220, 38, 38, .12)',
                  border: '1px solid rgba(220, 38, 38, .45)',
                  color: 'var(--bad)',
                } : undefined}
              >
                {needsSetup
                  ? <AlertTriangle size={14} aria-hidden />
                  : <PluginIcon name={a.actionIcon} size={14} />}
                <span>{isBusy ? 'Running…' : a.label}</span>
                <em>{a.pluginName}</em>
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

/**
 * "What's running right now" bar — one pill per in-flight agent_runs row
 * (where `running=true`). Visible above the plugin-actions row whenever
 * the harness is alive, hidden when no agents are active. Pills shrink
 * proportionally if many lanes run in parallel.
 */

function ActiveAgentsBar({ slug, phase, runs, alive, onPillClick, onStart, onStop }: {
  slug: string;
  phase: string;
  runs: Array<{ runId: string; role: string; featureId?: string | null; ts: number }>;
  /**
   * Liveness of the harness process. `null` means we haven't received
   * the first /status response yet — render a "checking…" state rather
   * than falsely flashing "Harness stopped" while the network round-trip
   * is in flight. After /status returns, `true` / `false` for real.
   */
  alive: boolean | null;
  onPillClick?: (runId: string) => void;
  onStart?: () => void;
  onStop?: () => void;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (runs.length === 0) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [runs.length]);

  // Hover popover state.
  //
  // Open after a 250ms hover (avoids flicker when sweeping across pills).
  // Stay open while the cursor is over EITHER the pill OR the popover.
  // Close 150ms after both go inactive (gives cursor time to transit
  // pill → popover without a flash close).
  const [hovered, setHovered] = useState<
    | { run: { runId: string; role: string; featureId?: string | null }; rect: DOMRect }
    | null
  >(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setHovered(null), 150);
  };
  const onPillEnter = (
    run: { runId: string; role: string; featureId?: string | null },
    el: HTMLElement,
  ) => {
    cancelClose();
    if (enterTimer.current) clearTimeout(enterTimer.current);
    const rect = el.getBoundingClientRect();
    enterTimer.current = setTimeout(() => setHovered({ run, rect }), 250);
  };
  const onPillLeave = () => {
    if (enterTimer.current) { clearTimeout(enterTimer.current); enterTimer.current = null; }
    scheduleClose();
  };

  const fmt = (sec: number): string => {
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `0:${String(r).padStart(2, '0')}`;
  };

  const isIdle = runs.length === 0;
  const isLoading = alive === null;
  const headline = isLoading
    ? 'Checking harness status…'
    : !alive
      ? 'Harness stopped'
      : isIdle
        ? 'No agents in flight'
        : runs.length === 1 ? '1 agent in flight' : `${runs.length} agents in flight`;
  const subtitle = isLoading || !alive ? null : isIdle ? 'Orchestrator deciding next step…' : null;
  const rowStateClass = isLoading ? ' is-loading' : !alive ? ' is-stopped' : ' is-running';

  return (
    <div className={`h-active-agents-row${isIdle || !alive ? ' is-idle' : ''}${rowStateClass}`} aria-label="Active agents">
      {alive === true && onStop && (
        <button type="button" className="h-active-agents-stop" onClick={onStop}>
          STOP
        </button>
      )}
      <div className="h-active-agents-copy">
        {alive === true && <span>Now running</span>}
        <strong>{headline}</strong>
      </div>
      <div className="h-active-agents-pills" data-count={runs.length}>
        {runs.map((r) => {
          const dur = now - r.ts;
          const label = `${r.role}${r.featureId ? ` · ${r.featureId}` : ''} · ${fmt(dur)}`;
          return (
            <button
              key={r.runId}
              type="button"
              className="h-active-agent-pill"
              title={onPillClick
                ? `${r.role}${r.featureId ? ` · ${r.featureId}` : ''} · ${fmt(dur)} — hover for live thinking, click for full timeline`
                : `${r.role} run ${r.runId} · ${fmt(dur)} elapsed`}
              onClick={onPillClick ? () => onPillClick(r.runId) : undefined}
              onMouseEnter={(e) => onPillEnter(
                { runId: r.runId, role: r.role, featureId: r.featureId },
                e.currentTarget,
              )}
              onMouseLeave={onPillLeave}
              style={onPillClick ? { cursor: 'pointer' } : undefined}
            >
              <span className="h-active-agent-pill-dot" aria-hidden="true" />
              <span className="h-active-agent-pill-label">{label}</span>
            </button>
          );
        })}
        {!alive && onStart && (
          <button type="button" className="h-active-agents-idle h-active-agents-start" onClick={onStart}>
            Start The Harness
          </button>
        )}
        {alive && isIdle && subtitle && (
          <span className="h-active-agents-idle">{subtitle}</span>
        )}
      </div>
      {hovered && (
        <AgentThinkingPopover
          slug={slug}
          phase={phase}
          runId={hovered.run.runId}
          role={hovered.run.role}
          anchorRect={hovered.rect}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onOpenInspector={() => {
            setHovered(null);
            onPillClick?.(hovered.run.runId);
          }}
        />
      )}
    </div>
  );
}

/**
 * Config tab body. First-level sub-nav between "Harness" (SPEC.md /
 * AGENTS.md / config.json editor) and one tab per enabled plugin. Each
 * plugin tab shows that single plugin's actions/capabilities/disable
 * controls — replaces the older single "Plugins" composite tab.
 */
/**
 * Config-panel tab button. Hoisted to module scope (NOT defined inline inside
 * ConfigPanel) so its component identity is stable across renders. An inline
 * component is a brand-new type every render, so React remounts the entire tab
 * rail on each ConfigPanel re-render; the rail's `useAutoAnimate` then replays
 * its enter animation every poll/state tick — which is the "Harness subtab
 * keeps blinking" bug. `pane`/`setPane` are passed as props instead of closed
 * over.
 */
function ConfigTabBtn({
  id,
  label,
  icon,
  missing,
  pane,
  setPane,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  missing?: string[];
  pane: string;
  setPane: (p: string) => void;
}) {
  const needsSetup = (missing?.length ?? 0) > 0;
  const tooltip = needsSetup
    ? `${missing!.map((f) => `${f} is empty`).join(' · ')}`
    : label;
  const selected = pane === id;
  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        onClick={() => setPane(id)}
        className={`h-tab h-config-tab${selected ? ' is-active' : ''}${needsSetup ? ' needs-setup' : ''}`}
        aria-pressed={selected}
        style={{
          background: selected ? 'color-mix(in oklab, var(--accent), transparent 88%)' : 'transparent',
          border: 0,
          borderBottom: '2px solid',
          borderBottomColor: selected ? 'var(--accent)' : 'transparent',
          color: selected ? 'var(--fg)' : 'var(--fg-mute)',
          padding: '6px 10px 5px',
          fontSize: 11,
          cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
          borderRadius: 0,
          whiteSpace: 'nowrap',
          maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis',
          minHeight: 31,
          boxShadow: 'none',
          transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
        }}
      >
        {icon}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        {needsSetup && (
          <span
            aria-label="needs setup"
            style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
              background: 'var(--bad)', flex: '0 0 auto',
            }}
          />
        )}
      </button>
    </Tooltip>
  );
}

function ConfigPanel({
  harnessSlug, projectPath, alive, onClose,
  installedPlugins, enabledSlugs, onPluginsChange,
  activePane, onPaneChange, pluginsMissing,
}: {
  harnessSlug: string;
  projectPath: string;
  alive: boolean;
  onClose: () => void;
  installedPlugins: InstalledPluginInfo[];
  enabledSlugs: string[];
  pluginCount: number;
  onPluginsChange: () => void;
  /** Active pane ('harness' or a plugin name). URL-synced via parent. */
  activePane: string;
  onPaneChange: (p: string) => void;
  /** pluginName → list of required fields absent/empty. */
  pluginsMissing: Record<string, string[]>;
}) {
  // 'harness' = the legacy spec editor; otherwise pane === plugin.name.
  const HARNESS_PANE = 'harness' as const;
  const pane = activePane;
  const setPane = onPaneChange;
  // Smooth FLIP when a plugin is enabled/disabled and a tab appears/leaves.
  const [tabRailRef] = useAutoAnimate<HTMLDivElement>();

  const enabledManifests = useMemo(() => {
    // Dedupe by `plugin.name` — enabled-plugins.json may legitimately
    // list the same plugin under both its scoped and bare-dir names.
    const seen = new Set<string>();
    const out: EnabledPluginManifest[] = [];
    for (const slug of enabledSlugs) {
      const m = installedPlugins.find((p) => {
        const dirSlug = p.path ? pluginSlugFromPath(p.path, p.name) : null;
        return p.name === slug || dirSlug === slug;
      });
      if (!m || seen.has(m.name)) continue;
      seen.add(m.name);
      out.push(m as EnabledPluginManifest);
    }
    return out;
  }, [installedPlugins, enabledSlugs]);

  // If the active pane points at a plugin that just got disabled, fall
  // back to the harness pane.
  useEffect(() => {
    if (pane === HARNESS_PANE) return;
    if (!enabledManifests.some((p) => p.name === pane)) setPane(HARNESS_PANE);
  }, [pane, enabledManifests]);

  const activePlugin = enabledManifests.find((p) => p.name === pane);

  return (
    <div className="h-config-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div ref={tabRailRef} className="h-config-rail" style={{
        display: 'flex', alignItems: 'stretch', gap: 2,
        padding: '0 18px',
        borderBottom: '1px solid var(--border)',
        overflowX: 'auto',
        minHeight: 32,
      }}>
        <ConfigTabBtn id={HARNESS_PANE} label="Harness" icon={<SlidersHorizontal size={13} />} pane={pane} setPane={setPane} />
        {enabledManifests.map((p) => {
          const tabIcon = p.dashboardTabs?.[0]?.icon ?? p.icon ?? null;
          // Display name: strip @scope/ prefix for compactness.
          const display = p.name.includes('/') ? p.name.split('/').pop()! : p.name;
          return (
            <ConfigTabBtn
              key={p.name}
              id={p.name}
              label={display}
              icon={<PluginIcon name={tabIcon} size={13} />}
              missing={pluginsMissing[p.name]}
              pane={pane}
              setPane={setPane}
            />
          );
        })}
      </div>
      <div className="h-config-body" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex' }}>
        {pane === HARNESS_PANE ? (
          <ManifestOrLegacySpecEditor
            slug={harnessSlug}
            projectPath={projectPath}
            alive={alive}
            onClose={onClose}
          />
        ) : activePlugin ? (
          <div className="h-config-plugin-pane" style={{ flex: 1, padding: '20px 28px', overflowY: 'auto', color: 'var(--fg)' }}>
            <PluginPanelCard
              plugin={activePlugin}
              harnessSlug={harnessSlug}
              onChange={onPluginsChange}
            />
          </div>
        ) : (
          <div style={{ flex: 1, padding: 32, color: 'var(--fg-mute)' }}>
            Plugin not found.
          </div>
        )}
      </div>
    </div>
  );
}

const inlineCode: React.CSSProperties = {
  fontFamily: "'SF Mono', monospace", fontSize: 11,
  padding: '1px 6px', borderRadius: 3,
  background: 'var(--bg-1)', border: '1px solid var(--border)',
};

function PluginPanelCard({ plugin, harnessSlug, onChange }: {
  plugin: EnabledPluginManifest;
  harnessSlug: string;
  onChange: () => void;
}) {
  const dirSlug = pluginSlugFromPath(plugin.path, plugin.name);
  const tabIcon = plugin.dashboardTabs?.[0]?.icon ?? plugin.icon ?? null;
  const [busy, setBusy] = useState(false);
  const [invoking, setInvoking] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const configPath = `~/.papercusp/harnesses/${harnessSlug}/plugin-configs/${dirSlug}.json`;
  const secretCaps = (plugin.capabilities ?? []).filter((c) => c.startsWith('secrets:read:'));
  const eventListens = (plugin.capabilities ?? []).filter((c) => c.startsWith('events:listen:'));
  const httpFetches = (plugin.capabilities ?? []).filter((c) => c.startsWith('http:fetch:'));

  async function disable() {
    if (!await askConfirm({
      title: `Disable ${plugin.name}?`,
      body: `${plugin.name} will stop running in ${harnessSlug}. The plugin's config is preserved.`,
      confirmLabel: 'Disable',
      destructive: true,
    })) return;
    setBusy(true);
    try {
      const r = await fetch('/api/plugins/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: dirSlug, harnesses: [harnessSlug], disable: true }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`Disable failed`, { description: d.results?.[0]?.log?.slice(-300) ?? d.error });
        return;
      }
      toast.success(`${plugin.name} disabled in ${harnessSlug}`);
      onChange();
    } catch (e: any) {
      toast.error(`Disable failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  }

  async function invoke(actionId: string) {
    setInvoking(actionId);
    try {
      const r = await fetch('/api/plugins/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: dirSlug, action: actionId, harness: harnessSlug }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`Invoke failed: ${actionId}`, { description: d.error ?? d.log?.slice(-300) });
        return;
      }
      toast.success(`Action ${actionId} fired`, {
        description: typeof d.result === 'string' ? d.result.slice(0, 200) : 'Check the action history for details.',
      });
    } catch (e: any) {
      toast.error(`Invoke failed: ${e?.message ?? e}`);
    } finally { setInvoking(null); }
  }

  return (
    <div className="pc-card h-plugin-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {confirmEl}
      <div className="h-plugin-card-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <span className="h-plugin-card-icon" style={{
          flex: '0 0 auto', width: 40, height: 40, borderRadius: 8,
          background: 'rgba(99, 102, 241, 0.15)', color: '#a5b4fc',
          border: '1px solid rgba(99, 102, 241, 0.3)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <PluginIcon name={tabIcon} size={20} />
        </span>
        <div className="h-plugin-card-main" style={{ flex: 1, minWidth: 0 }}>
          <div className="h-plugin-card-title-row" style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <h3 className="h-plugin-card-title" style={{ margin: 0, fontSize: 16 }}>{plugin.name}</h3>
            <span className="h-plugin-card-version" style={{ fontSize: 11, color: 'var(--fg-mute)', fontFamily: "'SF Mono', monospace" }}>
              v{plugin.version}
            </span>
            {(plugin.dashboardTabs?.length ?? 0) === 0 && (
              <span className="h-plugin-card-badge" style={{
                fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
                padding: '2px 6px', borderRadius: 4,
                background: 'rgba(99, 102, 241, 0.15)', color: '#a5b4fc',
              }}>action-only</span>
            )}
          </div>
          {plugin.description && (
            <p className="h-plugin-card-description" style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
              {plugin.description}
            </p>
          )}
        </div>
        <Tooltip label="Disable this plugin (config preserved)">
          <button
          onClick={disable}
          disabled={busy}
          className="pc-button"
          style={{ background: 'transparent', color: 'var(--bad)', border: '1px solid var(--border)', flex: '0 0 auto' }}
        >
          {busy ? 'Disabling…' : 'Disable'}
        </button>
        </Tooltip>
      </div>

      {(plugin.actions?.length ?? 0) > 0 && (
        <div className="h-plugin-section">
          <div className="h-plugin-section-label" style={sectionLabel}>Actions</div>
          <div className="h-plugin-action-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {plugin.actions!.map((a) => {
              const id = a.id ?? a.name ?? '?';
              return (
                <div key={id} className="h-plugin-action-row" style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '8px 12px', background: 'var(--bg-1)', borderRadius: 6,
                  border: '1px solid var(--border)',
                }}>
                  <code className="h-plugin-action-id" style={{ fontSize: 12, fontFamily: "'SF Mono', monospace", flex: '0 0 auto' }}>{id}</code>
                  <span className="h-plugin-action-label" style={{ flex: 1, fontSize: 12, color: 'var(--fg-mute)' }}>
                    {a.label ?? a.description ?? ''}
                  </span>
                  <Tooltip label="Manually invoke this hook now">
                    <button
                    onClick={() => invoke(id)}
                    disabled={invoking !== null}
                    className="pc-button"
                    style={{ fontSize: 11, padding: '4px 10px', flex: '0 0 auto' }}
                  >
                    {invoking === id ? 'Invoking…' : 'Invoke'}
                  </button>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {eventListens.length > 0 && (
        <div className="h-plugin-section">
          <div className="h-plugin-section-label" style={sectionLabel}>Listens to events</div>
          <div className="h-plugin-tags" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {eventListens.map((c) => (
              <span key={c} className="h-plugin-tag" style={tagStyle}>{c.replace('events:listen:', '')}</span>
            ))}
          </div>
        </div>
      )}

      {(secretCaps.length > 0 || httpFetches.length > 0) && (
        <div className="h-plugin-section">
          <div className="h-plugin-section-label" style={sectionLabel}>Required capabilities</div>
          <div className="h-plugin-tags" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {secretCaps.map((c) => {
              const key = c.replace('secrets:read:', '');
              return <span key={c} className="h-plugin-tag h-plugin-tag-secret" style={{ ...tagStyle, color: 'var(--warn)', borderColor: 'rgba(251, 191, 36, 0.3)', background: 'rgba(251, 191, 36, 0.1)' }} title={`Set this with: papercusp secrets set ${key} <value>`}>secret: {key}</span>;
            })}
            {httpFetches.map((c) => (
              <span key={c} className="h-plugin-tag" style={tagStyle}>http: {c.replace('http:fetch:', '')}</span>
            ))}
          </div>
          {secretCaps.length > 0 && (
            <p className="h-plugin-cli-hint" style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-mute)' }}>
              Set secrets via the CLI:{' '}
              <code style={inlineCode}>papercusp secrets set {secretCaps[0]!.replace('secrets:read:', '')} &lt;value&gt;</code>
            </p>
          )}
        </div>
      )}

      <PluginConfigEditor
        harnessSlug={harnessSlug}
        dirSlug={dirSlug}
        configPath={configPath}
        configSchema={plugin.configSchema}
        defaultConfig={(plugin as { defaultConfig?: Record<string, unknown> }).defaultConfig}
      />
    </div>
  );
}

interface PluginConfigField {
  type?: 'string' | 'boolean' | 'number' | 'integer' | 'array';
  default?: unknown;
  description?: string;
  enum?: unknown[];
}

function PluginConfigEditor({ harnessSlug, dirSlug, configPath, configSchema, defaultConfig }: {
  harnessSlug: string;
  dirSlug: string;
  configPath: string;
  configSchema?: { required?: string[]; properties?: Record<string, PluginConfigField> };
  defaultConfig?: Record<string, unknown>;
}) {
  const open = true;
  const [mode, setMode] = useQueryState('editorMode', parseAsStringEnum<'fields' | 'json'>(['fields', 'json']).withDefault('fields'));
  const [loaded, setLoaded] = useState<Record<string, unknown> | null>(null);
  const [draftJson, setDraftJson] = useState<string>('');
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Plugin schemas may omit `type` at the root — Ajv requires it. Normalize.
  const ajvSchema = useMemo(() => ({
    type: 'object',
    additionalProperties: true,
    ...(configSchema ?? {}),
  }), [configSchema]);

  const resolver = useMemo(() => makeAjvResolver(ajvSchema), [ajvSchema]);

  const {
    register,
    handleSubmit,
    reset: rhfReset,
    setValue,
    getValues,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Record<string, unknown>>({
    resolver,
    defaultValues: {},
    mode: 'onSubmit',
  });

  // Eager via Zero — pluginConfigs.byHarness returns all rows for this
  // harness; filter for the single (harnessSlug, pluginSlug) match.
  // Avoid pluginConfigs.byKey because it uses .one() — per memory
  // feedback_zero_one_shape_mismatch that can return undefined even
  // when upstream has rows. byHarness + client-side find is robust.
  const pluginConfigEditorWs = useWorkspaceId();
  const { data: pluginConfigEditorRows } = useSyncQuery<{
    harnessSlug: string;
    pluginSlug: string;
    config: Record<string, unknown> | null;
  }>({
    queryName: 'pluginConfigs.byHarness',
    args: { harnessSlug, workspaceId: pluginConfigEditorWs },
    enabled: !!harnessSlug && !!dirSlug && !!pluginConfigEditorWs,
  });
  useEffect(() => {
    if (loaded !== null) return;
    if (!Array.isArray(pluginConfigEditorRows)) return;
    const row = pluginConfigEditorRows.find((r) => r.pluginSlug === dirSlug);
    if (!row) return;
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    setLoaded(cfg);
    rhfReset(cfg);
    setDraftJson(JSON.stringify(cfg, null, 2));
  }, [loaded, pluginConfigEditorRows, dirSlug, rhfReset]);

  // REST back-stop — fires only if Zero hasn't hydrated within ~600ms,
  // covering harnesses that pre-date the plugin_configs mirror.
  useEffect(() => {
    if (loaded !== null) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled || loaded !== null) return;
      fetch(`/api/plugins/config?harness=${encodeURIComponent(harnessSlug)}&plugin=${encodeURIComponent(dirSlug)}`, { cache: 'no-store' })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then((d) => {
          if (cancelled || loaded !== null) return;
          const cfg = (d?.config ?? {}) as Record<string, unknown>;
          setLoaded(cfg);
          rhfReset(cfg);
          setDraftJson(JSON.stringify(cfg, null, 2));
        })
        .catch((e) => { if (!cancelled) setServerError(String(e?.message ?? e)); });
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [loaded, harnessSlug, dirSlug, rhfReset]);

  function resetToLoaded() {
    if (loaded) {
      rhfReset(loaded);
      setDraftJson(JSON.stringify(loaded, null, 2));
    }
    setServerError(null);
  }
  function loadDefaults() {
    const obj: Record<string, unknown> = { ...(defaultConfig ?? {}) };
    if (configSchema?.properties) {
      for (const [k, v] of Object.entries(configSchema.properties)) {
        if (!(k in obj) && v.default !== undefined) obj[k] = v.default;
      }
    }
    rhfReset(obj);
    setDraftJson(JSON.stringify(obj, null, 2));
    setServerError(null);
  }

  // Drop empty strings on save (treated as "no value, fall back to default").
  function pruneEmpty(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.length === 0) continue;
      out[k] = v;
    }
    return out;
  }

  async function persist(parsed: Record<string, unknown>) {
    setServerError(null);
    try {
      const r = await fetch('/api/plugins/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harness: harnessSlug, plugin: dirSlug, config: parsed }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setServerError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setLoaded(parsed);
      rhfReset(parsed);
      setDraftJson(JSON.stringify(parsed, null, 2));
      setSavedAt(Date.now());
      toast.success(`Config saved for ${dirSlug}`);
    } catch (e: any) {
      setServerError(String(e?.message ?? e));
    }
  }

  // Submit handler dispatches based on which mode is active so JSON mode
  // round-trips through JSON.parse before ajvResolver validates.
  async function onClickSave() {
    if (mode === 'json') {
      let parsed: Record<string, unknown>;
      try {
        const j = JSON.parse(draftJson);
        if (typeof j !== 'object' || j === null || Array.isArray(j)) {
          setServerError('Config must be a JSON object.');
          return;
        }
        parsed = j as Record<string, unknown>;
      } catch (e: any) {
        setServerError(`Invalid JSON: ${e?.message ?? e}`);
        return;
      }
      await persist(parsed);
    } else {
      void handleSubmit(async (data) => {
        await persist(pruneEmpty(data));
      })();
    }
  }

  // Switch modes — keep state in sync.
  function toggleMode() {
    if (mode === 'fields') {
      setDraftJson(JSON.stringify(getValues(), null, 2));
      setMode('json');
    } else {
      try {
        const j = JSON.parse(draftJson);
        if (typeof j === 'object' && j !== null && !Array.isArray(j)) {
          rhfReset(j as Record<string, unknown>);
        }
      } catch { /* keep RHF state as-is */ }
      setMode('fields');
    }
  }

  const dirty = mode === 'json'
    ? (loaded !== null && draftJson !== JSON.stringify(loaded, null, 2))
    : isDirty;
  const schemaKeys = Object.keys(configSchema?.properties ?? {});
  const requiredSet = new Set(configSchema?.required ?? []);
  // Subscribe to changes so the field-mode renderer sees up-to-date values.
  watch();

  return (
    <div className="h-plugin-config-editor" style={{
      marginTop: 4, padding: '8px 12px', background: 'var(--bg-1)', borderRadius: 6,
      border: '1px solid var(--border)',
    }}>
      <div className="h-plugin-config-editor-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div className="h-plugin-config-editor-meta" style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
          <span className="h-plugin-config-title" style={{ fontWeight: 600, color: 'var(--fg-dim)', marginRight: 8 }}>Config</span>
          <code className="h-plugin-config-path" style={{ fontFamily: "'SF Mono', monospace", fontSize: 11 }}>{configPath}</code>
          {schemaKeys.length > 0 && (
            <span className="h-plugin-config-keys" style={{ marginLeft: 12, color: 'var(--fg-mute)' }}>
              keys: {schemaKeys.map((k) => <code key={k} className="h-plugin-config-key" style={{ ...inlineCode, fontSize: 10, marginLeft: 4 }}>{k}</code>)}
            </span>
          )}
        </div>
      </div>

      {open && (
        <div className="h-plugin-config-content" style={{ marginTop: 10 }}>
          {serverError && (
            <div className="h-plugin-config-error" style={{
              marginBottom: 8, padding: '6px 10px',
              background: '#450a0a', color: 'var(--bad)',
              border: '1px solid #7f1d1d', borderRadius: 4,
              fontSize: 11,
            }}>{serverError}</div>
          )}
          {loaded === null ? (
            <div className="h-plugin-config-loading" style={{ padding: '16px 8px', fontSize: 12, color: 'var(--fg-mute)' }}>Loading config…</div>
          ) : mode === 'fields' && schemaKeys.length > 0 ? (
            <div className="h-plugin-config-fields" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 8 }}>
              {schemaKeys.map((key) => {
                const field = (configSchema?.properties ?? {})[key]!;
                const required = requiredSet.has(key);
                const values = getValues();
                const current = (key in values) ? values[key] : (field.default ?? '');
                const fieldError = errors[key]?.message ? String(errors[key]!.message) : undefined;
                return (
                  <div key={key} className="h-config-field">
                    <label className="h-plugin-config-field-label" style={pluginFieldLabel}>
                      {key} {required && <span style={{ color: 'var(--bad)' }}>*</span>}
                    </label>
                    {field.description && (
                      <div className="h-plugin-config-field-description" style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 3 }}>{field.description}</div>
                    )}
                    {renderPluginConfigInput(key, field, current, (v) => setValue(key, v, { shouldDirty: true, shouldValidate: false }))}
                    {fieldError && (
                      <div role="alert" style={{ marginTop: 4, fontSize: 11, color: 'var(--bad)' }}>{fieldError}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="h-plugin-config-json" style={{ height: Math.min(420, Math.max(160, (draftJson.split('\n').length + 1) * 18)), border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
              <MonacoEditor
                height="100%"
                language="json"
                theme="vs-dark"
                value={draftJson}
                onChange={(v) => setDraftJson(v ?? '')}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                }}
              />
            </div>
          )}
          <div className="h-plugin-config-footer" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Tooltip label="Save plugin config changes">
              <button
              type="button"
              onClick={onClickSave}
              disabled={isSubmitting || !dirty}
              className="pc-button"
              style={{ fontSize: 12, padding: '4px 12px' }}
            >{isSubmitting ? 'Saving…' : dirty ? 'Save' : 'No changes'}</button>
            </Tooltip>
            <Tooltip label="Discard unsaved config changes">
              <button
              type="button"
              onClick={resetToLoaded}
              disabled={isSubmitting || !dirty}
              style={{
                fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                background: 'transparent', color: 'var(--fg-mute)',
                border: '1px solid var(--border)', borderRadius: 4,
              }}
            >Reset</button>
            </Tooltip>
            <Tooltip label="Replace draft with the plugin's defaultConfig + configSchema defaults">
              <button
              type="button"
              onClick={loadDefaults}
              disabled={isSubmitting}
              style={{
                fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                background: 'transparent', color: 'var(--fg-mute)',
                border: '1px solid var(--border)', borderRadius: 4,
              }}
            >Load defaults</button>
            </Tooltip>
            {schemaKeys.length > 0 && (
              <Tooltip label={mode === 'fields' ? 'Switch to raw JSON editing' : 'Switch back to schema-driven form'}>
                <button
                type="button"
                onClick={toggleMode}
                disabled={isSubmitting}
                style={{
                  fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                  background: 'transparent', color: 'var(--fg-mute)',
                  border: '1px solid var(--border)', borderRadius: 4,
                }}
              >{mode === 'fields' ? 'Edit as JSON' : 'Edit as form'}</button>
              </Tooltip>
            )}
            {savedAt && !dirty && (
              <span className="h-plugin-config-saved" style={{ fontSize: 10, color: 'var(--good)' }}>
                ✓ saved {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
            <span className="h-plugin-config-cli" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--fg-mute)' }}>
              CLI:{' '}
              <code style={inlineCode}>papercusp plugin config {dirSlug} --harness {harnessSlug}</code>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function renderPluginConfigInput(
  key: string,
  field: PluginConfigField,
  value: unknown,
  onChange: (v: unknown) => void,
): React.ReactElement {
  const baseInput: React.CSSProperties = {
    width: '100%', padding: '6px 9px', fontSize: 12,
    background: 'var(--bg-2)', color: 'var(--fg)',
    border: '1px solid var(--border)', borderRadius: 5,
    fontFamily: 'inherit', boxSizing: 'border-box',
    minHeight: 30,
  };
  if (field.type === 'boolean') {
    return (
      <Checkbox
        checked={!!value}
        onChange={onChange}
        ariaLabel={key}
        style={{ width: 16, height: 16 }}
      />
    );
  }
  if (field.type === 'number' || field.type === 'integer') {
    return (
      <input
        type="number"
        value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        style={baseInput}
      />
    );
  }
  if (field.enum && Array.isArray(field.enum)) {
    const EMPTY_ENUM_VALUE = '__empty_enum_value__';
    const current = String(value ?? '');
    return (
      <Select
        value={current === '' ? EMPTY_ENUM_VALUE : current}
        onChange={(next) => onChange(next === EMPTY_ENUM_VALUE ? '' : next)}
        options={field.enum.map((opt) => {
          const stringValue = String(opt);
          return { value: stringValue === '' ? EMPTY_ENUM_VALUE : stringValue, label: stringValue };
        })}
        ariaLabel={key}
        triggerStyle={{ ...baseInput, justifyContent: 'space-between' }}
        contentStyle={{ zIndex: 90 }}
      />
    );
  }
  const isSecret = /token|key|secret|password|pat\b/i.test(key);
  return (
    <input
      type={isSecret ? 'password' : 'text'}
      value={typeof value === 'string' ? value : (value == null ? '' : String(value))}
      onChange={(e) => onChange(e.target.value)}
      style={baseInput}
      autoComplete="off"
      spellCheck={false}
    />
  );
}

const pluginFieldLabel: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--fg-dim)', marginBottom: 3,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--fg-mute)', marginBottom: 8,
};
const tagStyle: React.CSSProperties = {
  fontSize: 11, fontFamily: "'SF Mono', monospace",
  padding: '2px 8px', borderRadius: 4,
  background: 'var(--bg-1)', border: '1px solid var(--border)',
  color: 'var(--fg-dim)',
};

export default function HarnessDashboard({ forcedPanel, embeddedPanelChrome = false }: HarnessDashboardProps = {}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const snapshotsEnabled = useFlag(FLAGS.SNAPSHOTS);
  const templatesEnabled = useFlag(FLAGS.TEMPLATES);
  const harnessPhasesEnabled = useFlag(FLAGS.HARNESS_PHASES);
  const designEnabled = useFlag(FLAGS.DESIGN);
  const testingEnabled = useFlag(FLAGS.TESTING);
  const visualEffectsEnabled = useFancyEffectsEnabled();
  const localGithubUser = useLocalGithubUser();
  const fancyEffectsEnabled = visualEffectsEnabled && !reducedMotion;
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  // Selected harness — deep-link via ?slug=, agent-visible via ui:get_state.
  const [activeSlug, setActiveSlug] = useQueryState('slug', parseAsString);

  // Plugin tabs (P7): when PAPERCUSP_TABS_FROM_PLUGINS=1 is set on the
  // substrate process, the docs/vscode/pi tabs come from installed plugins
  // instead of being hard-coded. We always fetch the list so the UI can show
  // additional plugin tabs even with the flag off (additive); the flag
  // controls whether the legacy hard-coded tabs are hidden.
  // Plugin-contributed dashboard tabs. Pulled from the unified contributions
  // endpoint (Pattern 1 — see ARCHITECTURE.md). Only tabs with an iframeUrl
  // are surfaced inline; React-mode tabs (componentRoot+componentId) need
  // <PluginTabs> for rendering and are out of scope for this inline strip.
  const [pluginRefreshKey, setPluginRefreshKey] = useState(0);
  // Prefetch installed plugins so the "+ plugin" popover renders instantly.
  // Cached at the dashboard level so a single fetch backs every popover open.
  // 8s timeout — substrate dev server can be slow under HMR; we'd rather show
  // an error than have the popover sit on "Loading…" indefinitely.
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginInfo[] | null>(null);
  const [installedPluginsError, setInstalledPluginsError] = useState<string | null>(null);
  const [installedPluginsRefreshKey, setInstalledPluginsRefreshKey] = useState(0);
  // enabled-plugins.json contents per harness — the source of truth for
  // "is this plugin enabled here?". Independent of which plugins contribute
  // dashboard tabs (action-only plugins like @papercupai/jira-sync would
  // otherwise look un-enabled).
  // Eager via Zero — pluginEnables.byWorkspace returns rows of
  // (harnessSlug, pluginSlug, enabled). Derive the harness → slugs map
  // client-side. Replaces the lazy /plugins/enabled fetch on dashboard
  // mount; the popover's enabled-list is hot before the user opens it.
  // Inline-imported workspace id so this hook can run before the
  // activeWorkspaceParam declaration further down.
  const __pluginEnablesWs = useWorkspaceId();
  const { data: pluginEnableRows } = useSyncQuery<{
    harnessSlug: string;
    pluginSlug: string;
    enabled: boolean;
  }>({
    queryName: 'pluginEnables.byWorkspace',
    args: { workspaceId: __pluginEnablesWs },
    enabled: !!__pluginEnablesWs,
  });
  const enabledByHarness = useMemo<Record<string, string[]>>(() => {
    const m: Record<string, string[]> = {};
    if (!Array.isArray(pluginEnableRows)) return m;
    for (const r of pluginEnableRows) {
      if (!r.enabled) continue;
      (m[r.harnessSlug] ??= []).push(r.pluginSlug);
    }
    return m;
  }, [pluginEnableRows]);
  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30000);
    setInstalledPluginsError(null);
    fetch('/api/plugins/global', { cache: 'no-store', signal: ac.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => {
        setInstalledPlugins(Array.isArray(d?.plugins) ? d.plugins : []);
        setInstalledPluginsError(null);
      })
      .catch((e) => {
        if (e?.name === 'AbortError') {
          setInstalledPluginsError('Request timed out after 30s. The substrate is busy — try again.');
        } else {
          setInstalledPluginsError(String(e?.message ?? e));
        }
      })
      .finally(() => clearTimeout(t));
    return () => { clearTimeout(t); ac.abort(); };
  }, [installedPluginsRefreshKey]);
  const [pluginTabs, setPluginTabs] = useState<Array<{
    pluginSlug: string;
    pluginVersion: string;  // not surfaced by the unified endpoint today
    tabId: string;
    label: string;
    icon: string | null;
    iframeUrl: string | null;
    componentRoot: string | null;
    componentId: string | null;
    replaces: string[];
    embedMode: 'iframe' | 'inline-dock' | null;
  }>>([]);
  useEffect(() => {
    if (!activeSlug) {
      setPluginTabs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/plugins/${encodeURIComponent(activeSlug)}/contributions`,
          { cache: 'no-store' },
        );
        if (!r.ok) return;
        const j = (await r.json()) as {
          dashboardTabs?: Array<{
            pluginName: string;
            id: string;
            label: string;
            icon?: string;
            iframeUrl?: string;
            componentRoot?: string;
            componentId?: string;
            replaces?: string[];
            embedMode?: 'iframe' | 'inline-dock';
          }>;
        };
        if (cancelled) return;
        const tabs = (j.dashboardTabs ?? [])
          .filter((t) => {
            const hasIframe = typeof t.iframeUrl === 'string' && t.iframeUrl.length > 0;
            const hasReact = typeof t.componentRoot === 'string' && typeof t.componentId === 'string'
              && t.componentRoot.length > 0 && t.componentId.length > 0;
            return hasIframe || hasReact;
          })
          .map((t) => ({
            pluginSlug: t.pluginName,
            pluginVersion: '',
            tabId: t.id,
            label: t.label,
            icon: t.icon ?? null,
            iframeUrl: t.iframeUrl ?? null,
            componentRoot: t.componentRoot ?? null,
            componentId: t.componentId ?? null,
            replaces: Array.isArray(t.replaces) ? t.replaces : [],
            embedMode: (t.embedMode === 'iframe' || t.embedMode === 'inline-dock') ? t.embedMode : null,
          }));
        setPluginTabs(tabs);
      } catch {
        // best-effort — fall back to legacy tabs
      }
    })();
    return () => { cancelled = true; };
  }, [activeSlug, pluginRefreshKey]);
  // The legacy docs/vscode/pi tabs are removed; their replacements live in
  // pluginTabs (rendered inline below) sourced from @papercupai/fumadocs,
  // @papercupai/vscode-server, and @papercupai/pi-coding respectively.
  // Other plugins that still use the older `replaces: [<id>]` field are
  // honored by the per-plugin enable flow — there are no built-in tab ids
  // left to suppress at this layer.
  //
  // Deep-link compatibility: ?panel=pi (and docs/vscode) used to be valid
  // built-in tab ids. Now they're plugin-mounted, so the literal `pi` value
  // has no rendering branch. Resolve it to the matching `plugin:<tabId>`
  // once the plugin tabs have loaded. Same shim covers callers that still
  // call `setActivePanel('pi')` directly (FeatureList chat button, etc).
  const [urlActivePanel, setUrlActivePanel] = useQueryState('panel', parseAsString.withDefault('dashboard'));
  const activePanel = forcedPanel ?? urlActivePanel;
  const setActivePanel = useCallback(
    (next: MainPanel | string) => {
      if (forcedPanel) return;
      void setUrlActivePanel(next);
    },
    [forcedPanel, setUrlActivePanel],
  );
  // Plugin tab replacement shim uses activePanel, so declare it before the effect.
  const LEGACY_ALIASES = useMemo(() => ['pi', 'docs', 'vscode'], []);
  useEffect(() => {
    if (!LEGACY_ALIASES.includes(activePanel)) return;
    if (pluginTabs.length === 0) return;
    const replacement = pluginTabs.find((pt) => pt.replaces.includes(activePanel));
    if (replacement) setActivePanel(`plugin:${replacement.tabId}`);
  }, [activePanel, pluginTabs, setActivePanel, LEGACY_ALIASES]);
  // Synchronous resolved-panel value: if activePanel is a legacy alias
  // ('pi', 'docs', 'vscode') and we already know the matching plugin tab,
  // render as if URL had `plugin:<tabId>` directly. Eliminates the blank
  // flash when:
  //   - the user clicks a "switch to Pi" button in the FeatureList
  //     (chat button — issue #3 "reloads whole page"), OR
  //   - the user deep-links via ?panel=pi (issue #4).
  // The URL still updates to the canonical `plugin:<tabId>` form via
  // the effect above, but the visible panel doesn't have to wait for
  // that round-trip.
  const resolvedPanel = useMemo(() => {
    if (LEGACY_ALIASES.includes(activePanel) && pluginTabs.length > 0) {
      const replacement = pluginTabs.find((pt) => pt.replaces.includes(activePanel));
      if (replacement) return `plugin:${replacement.tabId}`;
    }
    return activePanel;
  }, [activePanel, pluginTabs, LEGACY_ALIASES]);
  // Sticky mount: defer ProposalsPanel's first mount (and its CSS chunk)
  // until the user first opens that tab. After first visit, remains
  // mounted to preserve the "instant tab switch" guarantee.
  const [proposalsEverMounted, setProposalsEverMounted] = useState(false);
  const [everMountedPanels, setEverMountedPanels] = useState<Set<string>>(() => new Set(['dashboard']));
  useEffect(() => {
    if (resolvedPanel === 'proposals' && !proposalsEverMounted) setProposalsEverMounted(true);
    if (resolvedPanel.startsWith('plugin:')) return;
    setEverMountedPanels((prev) => {
      if (prev.has(resolvedPanel)) return prev;
      const next = new Set(prev);
      next.add(resolvedPanel);
      return next;
    });
  }, [resolvedPanel, proposalsEverMounted]);
  const [status, setStatus] = useState<Status | null>(null);
  const [agents, setAgents] = useState<AgentRun[]>([]);
  const [issues, setIssues] = useState<string>('');
  // Structured log events from /api/harness/:slug/log/stream. Each event
  // carries source/level/corrId so the LogView can tab + filter without
  // round-tripping to the server. Capped at 5000 client-side; older
  // events drop off the bottom of scrollback. (Persistent backfill from
  // run.log.jsonl rotations is a follow-up commit.)
  const [logEvents, setLogEvents] = useState<import('@restart/ui-primitives').LogEvent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentDetail | null>(null);
  const agentPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [peekFeature, setPeekFeature] = useState<Feature | null>(null);
  const [activePhase, setActivePhase] = useQueryState(
    'phase',
    parseAsStringEnum<Phase>(['staging', 'testing', 'production']).withDefault('staging'),
  );
  // When the phases flag is off (production mode), force the active
  // phase to 'staging'. The displayed tab in PhaseTabs renders as
  // "production"/main, but internally everything threads through
  // 'staging' — that's the orchestrator's default ctx.phase (from
  // config.json), and lane rows are written keyed on it. A coerced
  // 'production' value would route API calls + Zero subscriptions to
  // an empty bucket and the agents-in-flight bar would stay empty.
  useEffect(() => {
    if (!harnessPhasesEnabled && activePhase !== 'staging') {
      void setActivePhase('staging');
    }
  }, [harnessPhasesEnabled, activePhase, setActivePhase]);
  // Dashboard sidebar parent panel collapse — when true, only the
  // CollapsedGitRail (40px) shows; click it to expand back to the
  // full RPanel + git subpanel.
  const [gitCollapsed, setGitCollapsed] = useQueryState(
    'gitCollapsed',
    parseAsBoolean.withDefault(false),
  );
  const [reviewCount, setReviewCount] = useState(0);
  const [showTriage, setShowTriage] = useQueryState('triage', parseAsBoolean.withDefault(false));
  const [showHooks, setShowHooks] = useQueryState('hooks', parseAsBoolean.withDefault(false));
  const [showIntervention, setShowIntervention] = useQueryState('intervene', parseAsBoolean.withDefault(false));
  const [showUsage, setShowUsage] = useQueryState('usage', parseAsBoolean.withDefault(false));
  const [showSnapshots, setShowSnapshots] = useQueryState('snapshots', parseAsBoolean.withDefault(false));
  const [showScreenshots, setShowScreenshots] = useQueryState('screenshots', parseAsBoolean.withDefault(false));
  const [showDecisions, setShowDecisions] = useQueryState('decisions', parseAsBoolean.withDefault(false));
  const [showSmokeTest, setShowSmokeTest] = useQueryState('smoke', parseAsBoolean.withDefault(false));
  const [showIdentity, setShowIdentity] = useQueryState('identity', parseAsBoolean.withDefault(false));
  const [showTemplates, setShowTemplates] = useQueryState('templates', parseAsBoolean.withDefault(false));
  const [showArchives, setShowArchives] = useQueryState('archives', parseAsBoolean.withDefault(false));
  const [showIntel, setShowIntel] = useQueryState('intel', parseAsBoolean.withDefault(false));
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  const [diffFeatureId, setDiffFeatureId] = useQueryState('diff', parseAsString);
  const [editingFeature, setEditingFeature] = useState<Feature | null | 'new'>(null);
  // Memoized handler for FeatureList's onEdit prop — without this, every
  // parent render creates a new arrow, invalidating ListView's `columns`
  // useMemo (which has onEdit in its deps) and forcing every virtualized
  // row to re-render on every keystroke. INP storm fix per diagnostic
  // 2026-05-06 finding D (247ms INP, 28 long tasks per 3s of clicks).
  const handleEditFeature = useCallback((f: Feature) => setEditingFeature(f), []);
  // Stable handler refs for FeatureList — without these the inline arrows
  // would create new function references on every dashboard render and
  // defeat React.memo on FeatureList. setActivePanel from useQueryState
  // is a stable ref so the deps list is empty.
  const handleSelectFeature = useCallback(
    (f: Feature) => setPeekFeature(f),
    [],
  );
  const handleSwitchToPi = useCallback(() => setActivePanel('pi'), [setActivePanel]);
  const handleAddFeature = useCallback(() => setEditingFeature('new'), []);
  // Stable handler for ArchitectInbox.onFeatureFocus — closes over the latest
  // status via a ref so the callback identity stays stable across renders
  // (lets ArchitectInbox's memo short-circuit).
  const statusRefForFocus = useRef<Status | null>(null);
  const handleArchitectFocus = useCallback((fid: string) => {
    const f = statusRefForFocus.current?.features.find((ff) => ff.id === fid);
    if (f) setPeekFeature(f as Feature);
  }, []);
  const [lanes, setLanes] = useState<{ lanes: Array<{ pid: number; featureId: string; startedAt: number; elapsedSeconds: number; alive: boolean }>; max: number } | null>(null);
  const [pendingProposals, setPendingProposals] = useState(0);
  const [configPane, setConfigPane] = useQueryState('configPane', parseAsString.withDefault('harness'));
  const [topChromeCollapsed, setTopChromeCollapsed] = useQueryState('chromeCollapsed', parseAsBoolean.withDefault(false));

  // (Removed) Empty-SPEC bootstrap — previously fetched /spec and nudged the
  // user to fill SPEC.md when empty, CTA'ing to Config → Harness → SPEC.md.
  // SPEC.md is deprecated (plans-central-harness-ux-2026-05-26, D-004) and the
  // SPEC.md editor tab is gone (P-017), so the nudge fired for every new
  // (plan-native) harness and pointed at a removed surface. The positive
  // replacement — a "create your first plan" onboarding nudge at the /adv
  // Plans level — is a deliberate UX design task tracked as P-004/P-005 in
  // spec-md-ui-deprecation-cleanup-2026-05-30, not a copy swap.
  /**
   * Map of pluginName → list of `required` field names that are absent
   * or empty in the user's per-harness config. Drives the red-tint on
   * harness-toolbar action buttons and the per-plugin Config tab badges.
   * Refetched whenever the active harness or its enabled plugins change.
   */
  const [pluginsMissing, setPluginsMissing] = useState<Record<string, string[]>>({});
  /**
   * Refresh the missing-required-config map when the active harness or
   * its enabled-plugin list changes. Fetches each enabled plugin's
   * config in parallel and intersects against `configSchema.required`.
   */
  // Eager via Zero — pluginConfigs.byHarness returns one row per
  // (harnessSlug, pluginSlug) for the workspace. Replaces the lazy
  // /api/plugins/configs?harness=X&plugins=a,b,c batched round-trip on
  // every (activeSlug, installedPlugins, enabledByHarness) change.
  // Plugin enable/disable + config saves push updates same-frame.
  const { data: pluginConfigRows } = useSyncQuery<{
    harnessSlug: string;
    pluginSlug: string;
    config: Record<string, unknown> | null;
  }>({
    queryName: 'pluginConfigs.byHarness',
    args: { harnessSlug: activeSlug ?? '', workspaceId: __pluginEnablesWs },
    enabled: !!activeSlug && !!__pluginEnablesWs,
  });
  useEffect(() => {
    if (!activeSlug || !installedPlugins) return;
    const enabled = enabledByHarness[activeSlug] ?? [];
    if (enabled.length === 0) { setPluginsMissing({}); return; }
    type Candidate = {
      manifestName: string;
      dirSlug: string;
      required: string[];
    };
    const candidates: Candidate[] = [];
    for (const slug of enabled) {
      const manifest = installedPlugins.find((p) => {
        const dirSlug = p.path ? pluginSlugFromPath(p.path, p.name) : null;
        return p.name === slug || dirSlug === slug;
      });
      if (!manifest) continue;
      const schema = (manifest as { configSchema?: { required?: string[]; properties?: Record<string, { default?: unknown }> } }).configSchema;
      const required = schema?.required ?? [];
      if (required.length === 0) continue;
      const dirSlug = manifest.path ? pluginSlugFromPath(manifest.path, manifest.name) : manifest.name;
      candidates.push({ manifestName: manifest.name, dirSlug, required });
    }
    const out: Record<string, string[]> = {};
    if (candidates.length === 0) { setPluginsMissing(out); return; }
    const configByDirSlug = new Map<string, Record<string, unknown>>();
    if (Array.isArray(pluginConfigRows)) {
      for (const r of pluginConfigRows) {
        configByDirSlug.set(r.pluginSlug, (r.config ?? {}) as Record<string, unknown>);
      }
    }
    for (const c of candidates) {
      const cfg = configByDirSlug.get(c.dirSlug) ?? {};
      const missing = c.required.filter((field) => {
        const v = cfg[field];
        if (v === undefined || v === null) return true;
        if (typeof v === 'string' && v.length === 0) return true;
        return false;
      });
      if (missing.length > 0) out[c.manifestName] = missing;
    }
    setPluginsMissing(out);
  }, [activeSlug, installedPlugins, enabledByHarness, pluginConfigRows]);
  const [isCompact, setIsCompact] = useState(false);
  const esRef = useRef<{ close: () => void } | null>(null);
  const searchParams = useSearchParams();
  // Both `?project=<slug>` and `?slug=<slug>` work — `slug` is the
  // common shorthand most other handlers in the app use (recorders,
  // toast helpers, plugin routes), so accepting it here lets bookmarks
  // / direct deep links / `notify` action hrefs survive without a
  // redirect dance.
  const projectQueryParam = searchParams?.get('project') ?? searchParams?.get('slug') ?? null;
  // URL path takes precedence over query param + localStorage. When the
  // dashboard is mounted under /harness/<slug>/, that slug is the source
  // of truth — we shouldn't surreptitiously fall back to whatever was
  // last stored in localStorage when the user types the URL by hand.
  const routeParams = useParams<{ slug?: string | string[] }>();
  const projectPathParam = (() => {
    const v = routeParams?.slug;
    if (Array.isArray(v)) return v[0] ?? null;
    return v ?? null;
  })();


  useEffect(() => {
    document.body.classList.toggle('h-harness-top-collapsed', topChromeCollapsed);
    return () => document.body.classList.remove('h-harness-top-collapsed');
  }, [topChromeCollapsed]);
  useEffect(() => {
    fetch('/api/harness/projects/lite')
      .then((r) => r.json())
      .then((d) => {
        const nextProjects = d.projects ?? [];
        setProjects(nextProjects);
        if (!nextProjects.length) return;
        // Precedence: URL path > ?project= query > localStorage > first project.
        const fromPath = projectPathParam && nextProjects.find((p: ProjectEntry) => p.slug === projectPathParam)
          ? projectPathParam
          : null;
        const fromQuery = projectQueryParam && nextProjects.find((p: ProjectEntry) => p.slug === projectQueryParam)
          ? projectQueryParam
          : null;
        const saved = window.localStorage.getItem(wsLocalKey('harness.activeProject'));
        const savedProject = saved ? nextProjects.find((p: ProjectEntry) => p.slug === saved) : null;
        setActiveSlug((current) => {
          if (fromPath) return fromPath;
          if (fromQuery) return fromQuery;
          if (current && nextProjects.some((p: ProjectEntry) => p.slug === current)) return current;
          return savedProject?.slug ?? nextProjects[0].slug;
        });
      })
      .catch((e) => toast.error(`Failed to load projects: ${e}`));
  }, [projectQueryParam, projectPathParam]);

  useEffect(() => {
    if (!activeSlug) return;
    try { window.localStorage.setItem(wsLocalKey('harness.activeProject'), activeSlug); } catch {}
  }, [activeSlug]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const sync = () => setIsCompact(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!activeSlug) return;
    setStatus(null);
    setAgents([]);
    setIssues('');
    setLogEvents([]);
    setSelectedAgent(null);
    preloadGitLog(activeSlug, 300);
    // Warm the dynamic GitGraphPanel chunk so the first left-pane click doesn't pay Turbopack compile cost.
    import('@restart/git-graph').catch(() => {});

    // Initial /status and /agents fetches were here in a Promise.all alongside
    // /issues — they're now owned by the useQuery hooks above which fire on
    // mount and refetch every 5s. /issues moved to a Zero subscription on
    // text-artifacts (above), so the issues.md ribbon is eager + live.

    // Subscribe to the structured JSONL stream. Server backfills the last
    // 500 events on connect, then live-tails via fs.watch.
    const source = createResilientEventSource({
      url: `/api/harness/${activeSlug}/log/stream?phase=${activePhase}&tail=500`,
      handlers: {
        log: (data) => {
          try {
            const evt = JSON.parse(data) as import('@restart/ui-primitives').LogEvent;
            setLogEvents((prev) => {
              const next = [...prev, evt];
              return next.length > 5000 ? next.slice(-5000) : next;
            });
          } catch { /* ignore malformed event */ }
        },
        rotated: () => setLogEvents([]),
        features: (data) => {
          try {
            const features = JSON.parse(data);
            setStatus((prev) => prev ? { ...prev, features } : prev);
          } catch { /* ignore */ }
        },
      },
    });
    esRef.current = source;

    return () => { source.close(); esRef.current = null; };
  }, [activeSlug, activePhase]);

  // Polling: 5 endpoints refetched every 5 s while the dashboard is open.
  // Replaces a hand-rolled `setInterval` + 5x `fetch().then(setX)` loop.
  // Wins from going through TanStack Query (already provided by HarnessZeroProvider):
  //   - dedup with other panels that read the same keys (SummaryPanel,
  //     CollapsedRails, ArchitectInbox, ProposalsPanel, IssuesList) once
  //     they migrate to the same keys
  //   - request abort when the slug changes mid-flight
  //   - stale-while-revalidate: switching slugs and back doesn't flash empty
  //   - no overlapping in-flight requests if a previous fetch hasn't returned
  // Preserves existing setStatus/setAgents/setReviewCount/setLanes/
  // setPendingProposals state shape so downstream consumers don't change.
  const enablePoll = !!activeSlug;
  // When the phases flag is off, every subscription, REST call, and Zero
  // query must thread the orchestrator's canonical 'staging' phase, not
  // whatever the URL `?phase=` happens to be. Without this, two browsers
  // hitting the same harness with different sticky URLs (e.g. one tab
  // opened pre-2026-05-14 when 'production' was the default, another
  // opened post-2026-05-14 when 'staging' is the default) saw different
  // lane subscriptions and disagreed about which agents were running.
  // The useEffect above repairs the URL but only after the first render;
  // hardcoding here makes the very first render correct too. With the
  // flag ON, multi-phase users still get full URL-driven phase routing.
  const phaseKey = harnessPhasesEnabled ? activePhase : ('staging' as Phase);
  const activeWorkspaceParam = useWorkspaceId();
  const slugForPoll = activeSlug ?? '';
  // /status: still REST-polled for fields the orchestrator doesn't write
  // (alive, escalated, smokeFail, mission* tokens). The Phase-3 harnessStatus
  // Zero subscription below pushes iteration + counts + status flag live,
  // so this poll covers only the slow-moving residual fields. 30s cadence
  // is the right balance — escalation/smoke-fail are rare events; immediate
  // updates after launch/resume already trigger a manual setStatus refetch
  // via the inline `fetch('/api/harness/<slug>/status?...')` calls in
  // event handlers below.
  const harnessStatusQuery = useQuery({
    queryKey: ['harness', slugForPoll, 'status', phaseKey],
    queryFn: ({ signal }) => fetch(`/api/harness/${slugForPoll}/status?phase=${phaseKey}`, { signal }).then((r) => r.json()),
    enabled: enablePoll,
    refetchInterval: 30000,
    staleTime: 15000,
  });
  // Eager subscription to text-artifacts (issues.md, memory/*, prompts/*,
  // plan-review.md, etc). Replaces the lazy `/issues?phase=` fetch that
  // ran on mount — `issues` ribbon now hydrates same-frame.
  const { data: zeroTextArtifactRows } = useSyncQuery<{
    harnessSlug: string;
    relPath: string;
    content: string;
    updatedAt: number;
  }>({
    queryName: 'harnessTextArtifact.byHarness',
    args: activeSlug ? { harnessSlug: activeSlug } : undefined,
    enabled: !!activeSlug,
  });
  useEffect(() => {
    if (!Array.isArray(zeroTextArtifactRows)) return;
    const issuesRow = zeroTextArtifactRows.find((r) => r.relPath === 'issues.md');
    setIssues(issuesRow?.content ?? '');
  }, [zeroTextArtifactRows]);

  // Eager subscription to per-feature operator notes. Replaces the lazy
  // /features/<id>/notes fetch in OperatorNoteForm and FeaturePeekPanel —
  // clicking "steer" or opening the side panel now shows existing notes
  // same-frame instead of after a round trip.
  const { data: zeroFeatureNotesRows } = useSyncQuery<{
    harnessSlug: string;
    featureId: string;
    content: string;
    updatedAt: number;
  }>({
    queryName: 'featureNotes.byHarness',
    args: activeSlug ? { harnessSlug: activeSlug } : undefined,
    enabled: !!activeSlug,
  });
  const notesByFeatureId = useMemo(() => {
    const m = new Map<string, string>();
    if (!Array.isArray(zeroFeatureNotesRows)) return m;
    for (const r of zeroFeatureNotesRows) m.set(r.featureId, r.content ?? '');
    return m;
  }, [zeroFeatureNotesRows]);

  // Per-feature debugger-role notes. PG mirror of .harness/debug/<id>.md
  // via the harness-fs-watcher; subscription means FeaturePeekPanel
  // renders the debug section same-frame.
  const { data: zeroDebugNotesRows } = useSyncQuery<{
    harnessSlug: string;
    featureId: string;
    content: string;
    mtimeMs: number;
  }>({
    queryName: 'featureDebugNotes.byHarness',
    args: activeSlug ? { harnessSlug: activeSlug } : undefined,
    enabled: !!activeSlug,
  });
  const debugNotesByFeatureId = useMemo(() => {
    const m = new Map<string, string>();
    if (!Array.isArray(zeroDebugNotesRows)) return m;
    for (const r of zeroDebugNotesRows) m.set(r.featureId, r.content ?? '');
    return m;
  }, [zeroDebugNotesRows]);

  // Per-feature PR URL+state. PG mirror of .harness/prs.json via fs-watcher.
  const { data: zeroPrsRows } = useSyncQuery<{
    harnessSlug: string;
    featureId: string;
    prUrl: string;
    prState: string;
    openedTs: number;
    updatedTs: number;
  }>({
    queryName: 'featurePrs.byHarness',
    args: activeSlug ? { harnessSlug: activeSlug } : undefined,
    enabled: !!activeSlug,
  });
  const prsByFeatureId = useMemo(() => {
    const m = new Map<string, { url: string; state: string; openedTs: number }>();
    if (!Array.isArray(zeroPrsRows)) return m;
    for (const r of zeroPrsRows) m.set(r.featureId, { url: r.prUrl, state: r.prState, openedTs: r.openedTs });
    return m;
  }, [zeroPrsRows]);

  // Phase 3: orchestrator-written status. Pushes iteration + counts + the
  // 'idle/running/stalled/paused/error' flag live, replacing the parts of
  // /status that need to update faster than 5s.
  const { data: zeroStatusRows } = useSyncQuery<{
    iteration: number;
    totalFeatures: number;
    passedCount: number;
    todoCount: number;
    blockedCount: number;
    status: string;
    lastActiveTs?: number;
    costUsd?: number;
  }>({
    queryName: 'harnessStatus.byHarness',
    args: { harnessSlug: slugForPoll, workspaceId: activeWorkspaceParam, phase: phaseKey },
    enabled: enablePoll,
  });
  // /agents REST poll dropped: pre-flight A confirmed Zero already provides
  // agent_runs via the per-harness namespace (see zeroAgentRows below).
  // The /agents endpoint stays as a PG-reading shim for any non-dashboard
  // caller; the dashboard no longer hits it.
  // /reviews + /proposals: when on staging (the only phase the FS watcher
  // Reviews via Zero (Item 2: phase-aware watcher mirrors all phased
  // worktrees, so this is correct on testing/production tiles too).
  const { data: zeroReviewRows } = useSyncQuery<{ resolved: boolean }>({
    queryName: 'pendingReviews.byHarness',
    args: {
      harnessSlug: slugForPoll,
      workspaceId: activeWorkspaceParam,
      phase: phaseKey,
      includeResolved: false,
    },
    enabled: enablePoll,
  });
  // Phase 3: lanes via Zero. Replaces /lanes 5s poll. Run.sh's pg_write_lane
  // upserts on lane assignment, pg_clear_lanes empties at iteration end.
  // The harness-status-sweep drops orphans whose recorded PID is gone.
  const { data: zeroLaneRows } = useSyncQuery<{
    role: string;
    featureId?: string | null;
    pid?: number | null;
    startedAt: number;
  }>({
    queryName: 'harnessLanes.byHarness',
    args: { harnessSlug: slugForPoll, workspaceId: activeWorkspaceParam, phase: phaseKey },
    enabled: enablePoll,
  });
  // Proposals via Zero (Item 2). Phase 2.5 added rich columns (status,
  // verdict, applied/rejected timestamps) to harness_proposals_shared so
  // we read them directly instead of inferring from the JSON payload.
  const { data: zeroProposalRows } = useSyncQuery<{ status?: string }>({
    queryName: 'proposalsShared.byHarness',
    args: {
      harnessSlug: slugForPoll,
      workspaceId: activeWorkspaceParam,
      phase: phaseKey,
    },
    enabled: enablePoll,
  });
  // Propagate query results into the existing local state so downstream
  // panels (which read status/agents/reviewCount/lanes/pendingProposals
  // via prop drilling) don't need to change.
  useEffect(() => {
    if (harnessStatusQuery.data && !harnessStatusQuery.data.error) {
      setStatus((prev) => {
        const next = harnessStatusQuery.data as Status;
        // Features are owned by the Zero subscription (ordered by updatedTs
        // DESC). The REST /status payload returns the same rows ordered by
        // id ASC; letting it overwrite causes the list to visibly reorder
        // every 30s as the two sources race. Preserve whatever Zero last
        // set if we already have it.
        if (prev && Array.isArray(prev.features) && prev.features.length > 0) {
          return { ...next, features: prev.features };
        }
        return next;
      });
    }
  }, [harnessStatusQuery.data]);
  // Phase 3: layer Zero-pushed iteration + counts on top of /status. Only
  // overrides the fields the orchestrator writes; alive/escalated/smokeFail/
  // mission* etc. continue to come from the REST poll above.
  //
  // Sentinel: a row with iteration=0 + lastActiveTs=null means the table
  // exists but no real run.sh has written to it yet (placeholder rows from
  // the orchestrator endpoint's first call, or curl tests). Don't override
  // the /status poll values in that case — let the legitimate FS-derived
  // numbers stand until run.sh actually runs an iteration.
  useEffect(() => {
    const row = Array.isArray(zeroStatusRows) ? zeroStatusRows[0] : zeroStatusRows;
    if (!row) return;
    const isPlaceholder =
      (row.iteration ?? 0) === 0 && (row.lastActiveTs ?? null) == null;
    if (isPlaceholder) return;
    setStatus((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        iteration: typeof row.iteration === 'number' ? row.iteration : prev.iteration,
        counts: {
          ...prev.counts,
          total: row.totalFeatures ?? prev.counts?.total ?? 0,
          passed: row.passedCount ?? prev.counts?.passed ?? 0,
          todo: row.todoCount ?? prev.counts?.todo ?? 0,
          blocked: row.blockedCount ?? prev.counts?.blocked ?? 0,
        },
        ...(typeof row.costUsd === 'number' ? { missionCostUsd: row.costUsd } : {}),
      };
    });
  }, [zeroStatusRows]);
  useEffect(() => {
    if (Array.isArray(zeroReviewRows)) setReviewCount(zeroReviewRows.length);
  }, [zeroReviewRows]);
  // Phase 3: lanes from Zero. The dashboard's `lanes` state shape (declared
  // at the useState above) is the same as the legacy /api/harness/<slug>/lanes
  // REST response: { lanes: Array<{pid, featureId, startedAt, elapsedSeconds,
  // alive}>, max }. Adapt Zero rows into that shape so the existing consumers
  // (lines ~3179, 3394, 3396, 3403) keep working without per-callsite changes.
  //
  // Notes on the missing fields:
  //   - pid: Zero rows don't carry it (orchestrator owns the lifecycle now).
  //     Set to 0; consumers don't read it. Sweeper uses agent_runs.running
  //     instead of /proc-walking pids, so we no longer need it client-side.
  //   - alive: rows in harness_lanes are currently-held by definition. The
  //     30s sweeper deletes orphans whose owning agent_runs row has
  //     running=false. So treat any present row as alive.
  //   - elapsedSeconds: derived from startedAt + Date.now().
  //   - max: derived from harnessProjectFiles.byHarness Zero subscription
  //     (config.json's parallelWorkers.max). Editable from the dashboard's
  //     running-stat popover (ParallelWorkersStat).
  const [maxWorkers, setMaxWorkers] = useState<number>(1);
  // Eager via Zero — harnessProjectFiles.byHarness mirrors PG's
  // harness_shared.harness_project_files row that holds config.json.
  // Replaces the lazy /spec?phase= round-trip on slug/phase changes;
  // maxWorkers updates same-frame whenever another tab edits config.
  // REST callback retained as back-stop for harnesses that pre-date
  // the project-files mirror.
  const { data: laneConfigRows } = useSyncQuery<{
    harnessSlug: string;
    config?: string | null;
  }>({
    queryName: 'harnessProjectFiles.byHarness',
    args: { harnessSlug: activeSlug ?? '' },
    enabled: !!activeSlug,
  });
  useEffect(() => {
    if (!Array.isArray(laneConfigRows) || laneConfigRows.length === 0) return;
    const cfgRaw = laneConfigRows[0]?.config;
    if (typeof cfgRaw !== 'string' || !cfgRaw.trim()) { setMaxWorkers(1); return; }
    try {
      const cfg = JSON.parse(cfgRaw);
      const m = Number(cfg?.parallelWorkers?.max);
      setMaxWorkers(Number.isFinite(m) && m > 0 ? Math.floor(m) : 1);
    } catch { /* keep previous on parse failure */ }
  }, [laneConfigRows]);

  useEffect(() => {
    if (!Array.isArray(zeroLaneRows)) return;
    const nowMs = Date.now();
    const lanesArr = zeroLaneRows.map((row) => {
      const startedAt = Number(row.startedAt) || 0;
      return {
        pid: 0,
        featureId: row.featureId ?? '',
        startedAt,
        elapsedSeconds: startedAt > 0 ? Math.max(0, Math.floor((nowMs - startedAt) / 1000)) : 0,
        alive: true,
      };
    });
    setLanes({ lanes: lanesArr, max: maxWorkers });
  }, [zeroLaneRows, maxWorkers]);
  useEffect(() => {
    if (Array.isArray(zeroProposalRows)) {
      // Phase 2.5: shared mirror table now has the rich `status` column.
      // Pending = anything not explicitly applied/rejected.
      const pending = zeroProposalRows.filter((r) => {
        const s = r.status;
        return !s || s === 'pending';
      }).length;
      setPendingProposals(pending);
    }
  }, [zeroProposalRows]);

  // ── Zero live feature subscription ─────────────────────────────────────
  // Subscribe to harness_shared.harness_features_consolidated via the
  // single `featuresConsolidated.bySlug` query. Slug-agnostic: any
  // harness in the registry can be queried without code changes.
  // (Migration 029 made consolidated the canonical store. Per-slug
  // featuresXxx queries are deprecated.)
  const featuresQueryName = activeSlug ? 'featuresConsolidated.bySlug' : null;
  const { data: zeroFeatureRows, loading: featuresLoading } = useSyncQuery<FeatureRow>({
    queryName: featuresQueryName ?? 'featuresConsolidated.bySlug',
    args: activeSlug ? { harnessSlug: activeSlug } : undefined,
    enabled: !!featuresQueryName,
  });
  useEffect(() => {
    // Wait until polling has at least one response before applying — the
    // initial empty array would clobber any polled-from-REST features.
    if (!featuresQueryName || featuresLoading || !Array.isArray(zeroFeatureRows)) return;
    type LocalFeatureRow = { featureId: string; title: string; summary?: string | null; status: string; attempts: number | string; claims?: string | null; sourcePlanSlug?: string | null };
    const adapted: Feature[] = (zeroFeatureRows as unknown as LocalFeatureRow[]).map((zf) => ({
      id: zf.featureId,
      title: zf.title,
      summary: zf.summary ?? undefined,
      status: zf.status as FeatureStatus,
      attempts: Number(zf.attempts) || 0,
      claims: zf.claims ? safeParseClaims(zf.claims) : undefined,
      sourcePlanSlug: zf.sourcePlanSlug ?? undefined,
    }));
    setStatus((prev) => {
      if (!prev) {
        // Zero arrived before any polled status; synthesize a minimal one.
        return {
          project: { slug: activeSlug ?? '', path: '' },
          features: adapted,
          counts: {},
          iteration: 0,
          lastDecision: null,
          alive: false,
          escalated: false,
        } as Status;
      }
      const sameLength = prev.features.length === adapted.length;
      if (sameLength) {
        const same = prev.features.every((f, i) => {
          const a = adapted[i];
          return (
            f.id === a.id &&
            f.title === a.title &&
            f.status === a.status &&
            f.attempts === a.attempts
          );
        });
        if (same) return prev;
      }
      return { ...prev, features: adapted };
    });
  }, [featuresQueryName, zeroFeatureRows, featuresLoading, activeSlug]);

  // ── Zero live agent_runs subscription ──────────────────────────────────
  // Replaces the polled /agents fetch. Polling still happens (in the EventSource
  // handler below) but only as a sync ping that triggers the API's FS scan +
  // PG dual-write — the data the UI displays comes from Zero.
  // Slug-agnostic agent runs query (Migration 031). One query for ANY harness;
  // server-side `.recent` caps at 50 to keep wire bytes small for the chat
  // history adapter (the panel further trims to 200 client-side, kept for
  // back-compat with the old slice math).
  const { data: zeroAgentRows, loading: agentRunsLoading } = useSyncQuery<AgentRunConsolidatedRow>({
    queryName: 'agentRunsConsolidated.recent',
    args: activeSlug ? { harnessSlug: activeSlug } : undefined,
    enabled: !!activeSlug,
  });
  useEffect(() => {
    if (!activeSlug || agentRunsLoading || !Array.isArray(zeroAgentRows)) return;
    type LocalAgentRunRow = { runId: string; role: string; ts: number | string; sizeBytes: number | string };
    const adapted: AgentRun[] = (zeroAgentRows as unknown as LocalAgentRunRow[])
      .slice(0, 200)
      .map((r) => ({
        runId: r.runId,
        role: r.role,
        ts: Number(r.ts) || 0,
        sizeBytes: Number(r.sizeBytes) || 0,
      }));
    setAgents(adapted);
  }, [activeSlug, zeroAgentRows, agentRunsLoading]);

  const loadAgent = useCallback(async (runId: string) => {
    // Instant-paint: render the inspector shell from already-cached
    // agentRunsConsolidated metadata so the panel opens same-frame even
    // before the heavy /agents/<runId> JSONL parse returns. The full
    // payload (timeline + per-event tokens etc.) replaces the stub when
    // fetch resolves; the live-poll effect below handles further updates.
    const meta = Array.isArray(zeroAgentRows)
      ? (zeroAgentRows as Array<{ runId: string; role?: string; featureId?: string | null; ts?: number; durationMs?: number; costUsd?: number; inputTokens?: number; outputTokens?: number; running?: boolean }>).find((r) => r.runId === runId)
      : undefined;
    if (meta) {
      setSelectedAgent({
        runId,
        role: meta.role ?? '',
        feature_id: meta.featureId ?? null,
        ts: meta.ts ?? 0,
        durationMs: meta.durationMs ?? 0,
        costUsd: meta.costUsd ?? 0,
        inputTokens: meta.inputTokens ?? 0,
        outputTokens: meta.outputTokens ?? 0,
        running: meta.running ?? false,
        timeline: [],
      } as unknown as AgentDetail);
    }
    // Bound the fetch — when PG is down or the dev server is mid-compile,
    // /agents/<runId> can hang for tens of seconds before Node's default
    // socket timeout fires. Without an AbortSignal here, the inspector
    // panel sits on the meta-stub spinner forever. 20s gives a slow
    // first-render of large JSONL room while still surfacing real hangs.
    try {
      const res = await fetch(
        `/api/harness/${activeSlug}/agents/${runId}?phase=${activePhase}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) {
        toast.error(`Failed to load run ${runId}: ${res.status}`);
        return;
      }
      const r = await res.json();
      if (r?.error) {
        toast.error(`Run ${runId}: ${r.error}`);
        return;
      }
      setSelectedAgent(r as AgentDetail);
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError'
        ? `Run ${runId} took >20s — server may be backed up or PG unreachable. Check dev.log.`
        : `Network error loading run ${runId}: ${(e as Error).message}`;
      toast.error(msg);
    }
  }, [activeSlug, activePhase, zeroAgentRows]);


  useEffect(() => {
    if (agentPollRef.current) { clearInterval(agentPollRef.current); agentPollRef.current = null; }
    if (!selectedAgent || !activeSlug) return;
    const isLive = !selectedAgent.timeline?.some((e) => e.kind === 'result');
    if (!isLive) return;
    agentPollRef.current = setInterval(async () => {
      try {
        // 5s timeout — short enough that a hung response doesn't pile up
        // overlapping fetches if the server is slow (interval is 2s).
        const res = await fetch(
          `/api/harness/${activeSlug}/agents/${selectedAgent.runId}?phase=${activePhase}`,
          { signal: AbortSignal.timeout(5_000) },
        );
        if (!res.ok) return;
        const r = await res.json();
        if (!r?.error) setSelectedAgent(r as AgentDetail);
      } catch {}
    }, 2000);
    return () => { if (agentPollRef.current) { clearInterval(agentPollRef.current); agentPollRef.current = null; } };
  }, [selectedAgent?.runId, activeSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetFeature = useCallback(async (id: string) => {
    if (!activeSlug) return;
    if (!await askConfirm({
      title: `Reset ${id}?`,
      body: 'Feature returns to todo with attempts=0. Any in-flight work on this feature is interrupted.',
      confirmLabel: 'Reset',
      destructive: true,
    })) return;
    await fetch(`/api/harness/${activeSlug}/features/${id}/reset?phase=${activePhase}`, { method: 'POST' });
    toast.success(`${id} reset`);
  }, [activeSlug, activePhase, askConfirm]);

  const launchHarness = useCallback(async () => {
    if (!activeSlug) return;
    try {
      const res = await fetch(`/api/harness/${activeSlug}/launch?phase=${activePhase}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = await res.json();
      toast.success('Harness launched', { description: d.logPath });
      setTimeout(() => {
        fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then((next) => setStatus((prev) => prev && Array.isArray(prev.features) && prev.features.length > 0 ? { ...next, features: prev.features } : next)).catch(() => {});
      }, 2000);
    } catch (e) {
      toast.error('Launch failed', { description: String(e) });
    }
  }, [activeSlug, activePhase]);

  // Poll the scoper-result endpoint until the wrapper signals completion,
  // then surface the agent's terminal summary line as a follow-up toast.
  // Polls every 5s up to ~10 minutes; gives up silently if it doesn't
  // finish in that window (scoper rarely runs that long).
  const pollScoperResult = useCallback(async (
    slug: string,
    invocationId: string,
    modeLabel: string,
    narrationOpKind?: 'replan' | 'cleanup',
    narrationHandle?: { cancel(): void },
  ) => {
    const start = Date.now();
    const maxMs = 10 * 60 * 1000;
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const r = await fetch(`/api/harness/${slug}/scoper-result/${invocationId}`);
        if (!r.ok) continue;
        const d = await r.json();
        if (d.done) {
          if (d.summary) {
            toast.success(`${modeLabel} done`, { description: d.summary });
          }
          // Side-channel TTS narration fires once the scoper actually
          // finishes. counts come straight from the endpoint's parse —
          // they may be undefined for runs that don't emit them.
          if (narrationOpKind) {
            const { announceOpEnd } = await import('@/lib/voice-narration');
            announceOpEnd(narrationOpKind, { outcome: 'ok', slug, counts: d.counts }, narrationHandle);
          }
          return;
        }
      } catch { /* keep polling */ }
    }
    // Timed out — narrate a "still working" rather than a failure since
    // the scoper might still be alive but our poll window expired.
    if (narrationOpKind) {
      const { announceOpEnd } = await import('@/lib/voice-narration');
      announceOpEnd(narrationOpKind, { outcome: 'fail', slug, reason: 'timed out polling' }, narrationHandle);
    }
  }, []);

  const replanHarness = useCallback(async () => {
    if (!activeSlug) return;
    const { announceOpStart, announceOpEnd } = await import('@/lib/voice-narration');
    const handle = announceOpStart('replan', { slug: activeSlug });
    try {
      const res = await fetch(`/api/harness/${activeSlug}/replan`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = await res.json();
      toast.success('Replan started', {
        description: 'Scoper is folding new plan items into the work queue. Updates will appear in a few minutes.',
      });
      if (d.invocationId) {
        // Poll fires completion narration when the scoper finishes,
        // and clears the mid-timer via the handle. Fire-and-forget.
        void pollScoperResult(activeSlug, d.invocationId, 'Replan', 'replan', handle);
      } else {
        handle.cancel();
      }
    } catch (e) {
      announceOpEnd('replan', { outcome: 'fail', reason: 'request rejected', slug: activeSlug }, handle);
      toast.error('Replan failed', { description: String(e) });
    }
  }, [activeSlug, pollScoperResult]);

  const proposeHarness = useCallback(async () => {
    if (!activeSlug) return;
    try {
      const res = await fetch(`/api/harness/${activeSlug}/product-review`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      toast.success('Propose started', {
        description: 'Scoper is reading the active plan and drafting proposals. New cards will appear in the Proposals tab in a few minutes.',
      });
    } catch (e) {
      toast.error('Propose failed', { description: String(e) });
    }
  }, [activeSlug]);

  const cleanupHarness = useCallback(async () => {
    if (!activeSlug) return;
    if (!await askConfirm({
      title: 'Run cleanup?',
      body: 'Scoper will deprecate features whose claims no longer match the active plan and modify partial-matches. No new features will be added. Code is not auto-removed.',
      confirmLabel: 'Run cleanup',
    })) return;
    const { announceOpStart, announceOpEnd } = await import('@/lib/voice-narration');
    const handle = announceOpStart('cleanup', { slug: activeSlug });
    try {
      const res = await fetch(`/api/harness/${activeSlug}/cleanup`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = await res.json();
      toast.success('Cleanup started', {
        description: 'Scoper is comparing existing features against the active plan. Updates will appear in a few minutes.',
      });
      if (d.invocationId) {
        void pollScoperResult(activeSlug, d.invocationId, 'Cleanup', 'cleanup', handle);
      } else {
        handle.cancel();
      }
    } catch (e) {
      announceOpEnd('cleanup', { outcome: 'fail', reason: 'request rejected', slug: activeSlug }, handle);
      toast.error('Cleanup failed', { description: String(e) });
    }
  }, [activeSlug, pollScoperResult, askConfirm]);

  const stopHarness = useCallback(async () => {
    if (!activeSlug) return;
    if (!await askConfirm({
      title: `Stop harness ${activeSlug}?`,
      body: 'Send SIGTERM to the harness process. In-flight work will be interrupted.',
      confirmLabel: 'Send SIGTERM',
      destructive: true,
    })) return;
    try {
      const res = await fetch(`/api/harness/${activeSlug}/stop?phase=${activePhase}`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = await res.json();
      toast.success(`Stopped ${d.killed?.length ?? 0} process(es)`);
    } catch (e) {
      toast.error('Stop failed', { description: String(e) });
    }
  }, [activeSlug, activePhase, askConfirm]);

  // ─── Linear-inspired extensions ─────

  const setFeatureStatus = useCallback(async (id: string, s: FeatureStatus) => {
    if (!activeSlug) return;
    // Optimistic local update so the UI reflects the click immediately.
    // Revert on PATCH failure. The peek panel syncs from this via the
    // useEffect below (peekFeature ← status.features[id]).
    let prevStatus: FeatureStatus | undefined;
    setStatus((curr) => {
      if (!curr) return curr;
      const i = curr.features.findIndex((f) => f.id === id);
      if (i < 0) return curr;
      prevStatus = curr.features[i].status as FeatureStatus;
      const next = curr.features.slice();
      next[i] = { ...next[i], status: s };
      return { ...curr, features: next };
    });
    try {
      const res = await fetch(`/api/harness/${activeSlug}/features/${id}?phase=${activePhase}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: s }),
      });
      if (res.ok) {
        toast.success(`${id} → ${s}`);
        // Refetch authoritative state so derived counts (todo/passed/blocked)
        // and any server-side side effects (attempts, last_run, etc.) catch up.
        // Matches the pattern at HarnessDashboard.tsx:4205/4751/4812.
        fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`)
          .then((r) => r.json())
          .then((next) => setStatus((prev) => prev && Array.isArray(prev.features) && prev.features.length > 0 ? { ...next, features: prev.features.map((f) => next.features.find((nf: Feature) => nf.id === f.id) ?? f) } : next))
          .catch(() => {});
      } else {
        toast.error(`Failed: ${res.status}`);
        // Revert.
        if (prevStatus !== undefined) {
          setStatus((curr) => {
            if (!curr) return curr;
            const i = curr.features.findIndex((f) => f.id === id);
            if (i < 0) return curr;
            const next = curr.features.slice();
            next[i] = { ...next[i], status: prevStatus! };
            return { ...curr, features: next };
          });
        }
      }
    } catch (e) {
      toast.error(`Network error: ${(e as Error).message}`);
      if (prevStatus !== undefined) {
        setStatus((curr) => {
          if (!curr) return curr;
          const i = curr.features.findIndex((f) => f.id === id);
          if (i < 0) return curr;
          const next = curr.features.slice();
          next[i] = { ...next[i], status: prevStatus! };
          return { ...curr, features: next };
        });
      }
    }
  }, [activeSlug, activePhase]);

  const batchReset = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) =>
      fetch(`/api/harness/${activeSlug}/features/${id}/reset?phase=${activePhase}`, { method: 'POST' })
    ));
    toast.success(`Reset ${ids.length} features`);
  }, [activeSlug]);

  const batchDelete = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) =>
      fetch(`/api/harness/${activeSlug}/features/${id}?phase=${activePhase}`, { method: 'DELETE' })
    ));
    toast.success(`Deleted ${ids.length} features`);
    if (peekFeature && ids.includes(peekFeature.id)) setPeekFeature(null);
  }, [activeSlug, peekFeature]);

  // Command palette + cheat-sheet + tab navigation. All shortcuts are
  // sourced from the registry so the settings page can rebind them.
  const [showShortcutsCheatSheet, setShowShortcutsCheatSheet] = useState(false);
  useShortcut('palette.toggle', () => setPaletteOpen((o) => !o));
  useShortcut('shortcuts.show', () => setShowShortcutsCheatSheet(true));

  // Linear-style `g <letter>` two-stroke tab navigation.
  useShortcut('goto.dashboard', () => { if (activeSlug) void setActivePanel('dashboard'); }, {}, [activeSlug]);
  useShortcut('goto.summary', () => { if (activeSlug) void setActivePanel('summary'); }, {}, [activeSlug]);
  useShortcut('goto.config', () => { if (activeSlug) void setActivePanel('config'); }, {}, [activeSlug]);
  useShortcut('goto.brainstorm', () => { if (activeSlug) void setActivePanel('brainstorm'); }, {}, [activeSlug]);
  useShortcut('goto.proposals', () => { if (activeSlug) void setActivePanel('proposals'); }, {}, [activeSlug]);
  useShortcut('goto.experts', () => { if (activeSlug) void setActivePanel('experts'); }, {}, [activeSlug]);
  useShortcut('goto.insights', () => { if (activeSlug) void setActivePanel('insights'); }, {}, [activeSlug]);


  // Keep peekFeature in sync with latest features data so status transitions
  // propagate into the open peek panel.
  useEffect(() => {
    if (!peekFeature || !status) return;
    const fresh = status.features.find((f) => f.id === peekFeature.id);
    if (fresh && (fresh.status !== peekFeature.status || fresh.attempts !== peekFeature.attempts)) {
      setPeekFeature(fresh);
    }
  }, [status, peekFeature]);

  const totalCount = status?.features.length ?? 0;
  const passedCount = status?.counts.passed ?? 0;
  const todoCount = status?.counts.todo ?? 0;
  const blockedCount = status?.counts.blocked ?? 0;
  const progressPct = totalCount ? Math.round((passedCount / totalCount) * 100) : 0;

  // Sync status to the focus-handler ref every render. Refs may be written
  // during render in React; this keeps handleArchitectFocus's closure
  // current without forcing the callback identity to change.
  statusRefForFocus.current = status;

  // Stable features reference: when status updates but features array's
  // identities are unchanged (same id+status+attempts), return the previous
  // array so React.memo on FeatureList can short-circuit. Without this, the
  // dashboard's frequent setStatus calls (Zero pushes, polling fallbacks)
  // would create a new features array reference each time and force
  // FeatureList to re-render its 92-row tree.
  const featuresArrayRef = useRef<Feature[] | null>(null);
  const featuresStable: Feature[] = useMemo(() => {
    const next = (status?.features ?? []) as Feature[];
    const prev = featuresArrayRef.current;
    if (prev && prev.length === next.length) {
      let same = true;
      for (let i = 0; i < next.length; i++) {
        const a = prev[i]; const b = next[i];
        if (a !== b && (a.id !== b.id || a.status !== b.status || a.attempts !== b.attempts || a.title !== b.title)) {
          same = false;
          break;
        }
      }
      if (same) return prev;
    }
    featuresArrayRef.current = next;
    return next;
  }, [status?.features]);

  const sortedFeatures = useMemo(() => {
    if (!status) return [];
    return [...status.features].sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status);
      const bi = STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
  }, [status]);

  const statusSummary = useMemo(() => {
    const features = status?.features ?? [];
    return STATUS_ORDER.map((featureStatus) => ({
      status: featureStatus,
      label: STATUS_LABELS[featureStatus],
      count: features.filter((f) => f.status === featureStatus).length,
    })).filter((entry) => entry.count > 0);
  }, [status]);

  const commands: Command[] = useMemo(() => {
    const cs: Command[] = [];
    for (const p of projects) {
      cs.push({
        id: `proj:${p.slug}`, section: 'Projects',
        title: p.slug, subtitle: p.path, icon: '📁',
        perform: () => setActiveSlug(p.slug),
      });
      cs.push({
        id: `proj:${p.slug}:vscode`, section: 'Projects',
        title: `Open ${p.slug} in VSCode`, subtitle: p.path, icon: '</>',
        keywords: 'vscode code editor open folder',
        perform: () => openInVSCode(p.path),
      });
    }
    if (activeSlug && status) {
      if (status.alive) {
        cs.push({ id: 'stop', section: 'Control', title: 'Stop harness', icon: '■', perform: stopHarness });
        cs.push({
          id: 'pause', section: 'Control', title: 'Pause harness (SIGSTOP)',
          icon: '⏸', keywords: 'pause suspend stop',
          perform: async () => {
            try {
              const r = await fetch(`/api/harness/${activeSlug}/pause`, { method: 'POST' });
              const d = await r.json();
              toast.info(`paused ${d.paused?.length ?? 0} process(es)`);
            } catch (e) { toast.error(String(e)); }
          },
        });
        cs.push({
          id: 'unpause', section: 'Control', title: 'Unpause harness (SIGCONT)',
          icon: '▶', keywords: 'unpause resume continue',
          perform: async () => {
            try {
              const r = await fetch(`/api/harness/${activeSlug}/unpause`, { method: 'POST' });
              const d = await r.json();
              toast.info(`resumed ${d.resumed?.length ?? 0} process(es)`);
            } catch (e) { toast.error(String(e)); }
          },
        });
      } else {
        cs.push({ id: 'start', section: 'Control', title: 'Start harness', icon: '▶', perform: launchHarness });
      }
      cs.push({
        id: 'replan',
        section: 'Control',
        title: 'Replan — fold new plan items into the work queue',
        icon: '🔄',
        keywords: 'replan rescope refresh queue plan scoper',
        perform: replanHarness,
      });
      cs.push({
        id: 'cleanup',
        section: 'Control',
        title: 'Cleanup — deprecate or modify features that no longer match the active plan',
        icon: '🧹',
        keywords: 'cleanup deprecate prune retire scoper stale orphan',
        perform: cleanupHarness,
      });
      cs.push({ id: 'config', section: 'Control', title: 'Edit config', icon: '✎', keywords: 'config agents contract json', perform: () => setActivePanel('config') });
      cs.push({ id: 'vscode', section: 'Control', title: 'Open current project in VSCode', icon: '</>', keywords: 'vscode code editor open folder', perform: () => openInVSCode(status.project.path) });
      cs.push({ id: 'triage', section: 'Control', title: 'Triage — stuck/blocked/failing features', icon: '🔺', keywords: 'escalation blocked', perform: () => setShowTriage(true) });
      cs.push({ id: 'insights', section: 'Control', title: 'Insights — analytics', icon: '📊', keywords: 'analytics histogram', perform: () => setActivePanel('insights') });
      cs.push({ id: 'hooks', section: 'Control', title: 'Hooks — edit pre/post lifecycle scripts', icon: '⚡', keywords: 'hook script pre post worker validator escalate', perform: () => setShowHooks(true) });
      cs.push({ id: 'intervene', section: 'Control', title: 'Intervene — send note to orchestrator', icon: '💬', keywords: 'note supervisor guidance', perform: () => setShowIntervention(true) });
      cs.push({ id: 'usage', section: 'Control', title: 'Usage — per-role cost breakdown', icon: '💵', keywords: 'cost tokens money spend', perform: () => setShowUsage(true) });
      if (snapshotsEnabled) cs.push({ id: 'snapshots', section: 'Control', title: 'Snapshots — rollback mission state', icon: '⟲', keywords: 'checkpoint rollback history restore', perform: () => setShowSnapshots(true) });
      cs.push({ id: 'decisions', section: 'Control', title: 'Decisions — orchestrator verb timeline', icon: '🧠', keywords: 'decision orchestrator verb ghost parser', perform: () => setShowDecisions(true) });
      cs.push({ id: 'smoke', section: 'Control', title: 'Smoke test — service gate (claudecode-orchestrator)', icon: '💨', keywords: 'smoke test gate service url check', perform: () => setShowSmokeTest(true) });
      cs.push({ id: 'identity', section: 'Control', title: 'Identity — cross-mission role memory (Agent-Swarm)', icon: '🧬', keywords: 'identity role memory cross mission learned patterns', perform: () => setShowIdentity(true) });
      cs.push({
        id: 'checkpoint-request', section: 'Control',
        title: 'Request checkpoint — pause harness for human approval',
        icon: '⏸', keywords: 'checkpoint pause hermes gate approval',
        perform: async () => {
          const name = await askPrompt({
            title: 'Request checkpoint',
            label: 'Checkpoint name',
            body: 'A human approval gate will pause the harness with this name. Letters, numbers, dots, dashes, and underscores only.',
            defaultValue: 'manual',
            placeholder: 'e.g. before-migration',
            submitLabel: 'Next',
            validate: (v) => /^[A-Za-z0-9_.-]+$/.test(v) ? null : 'Letters, numbers, dot/dash/underscore only',
          });
          if (!name) return;
          const cleanName = name.replace(/[^A-Za-z0-9_.-]/g, '');
          if (!cleanName) { toast.error('invalid name'); return; }
          const message = await askPrompt({
            title: `Checkpoint "${cleanName}"`,
            label: 'Context message (optional)',
            body: 'Describe why this checkpoint is being requested. Visible to the human approver. Leave blank if no context needed.',
            placeholder: 'waiting for schema review…',
            submitLabel: 'Request checkpoint',
            allowEmpty: true,
          });
          if (message === null) return;
          try {
            const r = await fetch(`/api/harness/${activeSlug}/checkpoint/${encodeURIComponent(cleanName)}/request`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ message }),
            });
            const d = await r.json();
            if (d.ok) toast.success(`checkpoint "${cleanName}" requested`);
            else toast.error(`request failed: ${d.error ?? 'unknown'}`);
          } catch (e) { toast.error(String(e)); }
        },
      });
      cs.push({ id: 'screenshots', section: 'Control', title: 'Screenshots — visual history', icon: '📸', keywords: 'screenshot image visual capture', perform: () => setShowScreenshots(true) });
      cs.push({ id: 'newfeat', section: 'Control', title: 'Create new feature', icon: '＋', keywords: 'add feature', perform: () => setEditingFeature('new') });
      if (templatesEnabled) cs.push({ id: 'templates', section: 'Control', title: 'Start from template — seed SPEC.md + AGENTS.md', icon: '📋', keywords: 'template starter bootstrap spec', perform: () => setShowTemplates(true) });
      cs.push({ id: 'archives', section: 'Control', title: 'Archives — snapshot / restore mission state', icon: '📦', keywords: 'archive restore backup reset', perform: () => setShowArchives(true) });
      cs.push({ id: 'intel', section: 'Control', title: 'Intel — tool-invocation telemetry', icon: '🔭', keywords: 'intel telemetry spawn tool invocation gitnexus repomix code2prompt diff pack', perform: () => setShowIntel(true) });
      cs.push({
        id: 'supervisor', section: 'Control',
        title: 'Run supervisor — fresh review of mission',
        icon: '🧭', keywords: 'supervisor review check-in',
        perform: async () => {
          toast.info('Running supervisor…');
          const { announceOpStart, announceOpEnd } = await import('@/lib/voice-narration');
          const handle = announceOpStart('supervisor');
          try {
            const r = await fetch(`/api/harness/${activeSlug}/supervisor?phase=${activePhase}`, { method: 'POST' });
            const d = await r.json();
            if (d.ok) {
              toast.success(`${d.outcome || 'supervisor complete'}`, { duration: 6000 });
              announceOpEnd('supervisor', { outcome: 'ok', reason: d.outcome }, handle);
            } else {
              toast.error(`supervisor failed: ${d.error ?? 'unknown'}`);
              announceOpEnd('supervisor', { outcome: 'fail', reason: d.error ?? 'unknown' }, handle);
            }
          } catch (e) {
            toast.error(String(e));
            announceOpEnd('supervisor', { outcome: 'fail', reason: 'request error' }, handle);
          }
        },
      });
      // Note: a second `id: 'replan'` command was here (legacy destructive
      // variant calling /replan with `overwrite: true`). Removed because (a)
      // it duplicates id 'replan' above, causing React's "two children with
      // same key" error on every render and an infinite Fast Refresh loop,
      // and (b) the unified MODE=replan delta-merge path is non-destructive
      // and the only one we want users to invoke.
    }
    for (const f of status?.features ?? []) {
      cs.push({
        id: `feat:${f.id}`, section: 'Features',
        title: `${f.id} · ${f.title}`,
        subtitle: `${f.status}${f.attempts ? ` · ${f.attempts} attempts` : ''}`,
        keywords: `${f.status} feature`,
        icon: '◇',
        perform: () => setPeekFeature(f),
      });
      cs.push({
        id: `diff:${f.id}`, section: 'Features',
        title: `${f.id} · view diff`,
        subtitle: `git diff main...harness/${f.id}`,
        keywords: `diff ${f.id} ${f.status}`,
        icon: '⎇',
        perform: () => setDiffFeatureId(f.id),
      });
    }
    for (const r of agents.slice(0, 20)) {
      cs.push({
        id: `run:${r.runId}`, section: 'Agent runs',
        title: `${r.role} · ${r.runId.slice(-20)}`,
        subtitle: new Date(r.ts).toLocaleString(),
        icon: '○',
        perform: () => loadAgent(r.runId),
      });
    }
    // Always-available navigation commands so the palette never lands
    // empty (e.g. on first open before projects load).
    cs.push(
      { id: 'nav:marketplace', section: 'Navigate', title: 'Marketplace', icon: '🛒', keywords: 'marketplace plugins templates browse', perform: () => { navigateClient('/marketplace'); } },
      { id: 'nav:harnesses', section: 'Navigate', title: 'Installed harnesses', icon: '📦', keywords: 'harnesses installed projects list', perform: () => { navigateClient('/installed/harnesses'); } },
      { id: 'nav:plugins', section: 'Navigate', title: 'Installed plugins', icon: '🔌', keywords: 'plugins installed list', perform: () => { navigateClient('/installed/plugins'); } },
      { id: 'nav:snapshots', section: 'Navigate', title: 'Snapshots', icon: '⟲', keywords: 'snapshots backups', perform: () => { navigateClient('/installed/snapshots'); } },
      { id: 'nav:settings', section: 'Navigate', title: 'Settings', icon: '⚙', keywords: 'settings operator oracle voice', perform: () => { navigateClient('/settings/operator'); } },
      { id: 'nav:setup', section: 'Navigate', title: 'Setup guide', icon: '📖', keywords: 'setup install help getting started', perform: () => { navigateClient('/setup'); } },
      { id: 'nav:support', section: 'Navigate', title: 'Support', icon: '💬', keywords: 'support help troubleshoot', perform: () => { navigateClient('/support'); } },
    );
    // Documented keyboard shortcuts. The palette has no power to
    // re-bind these — these entries are reference-only, surfaced here
    // so the palette doubles as a shortcuts cheat-sheet.
    cs.push(
      { id: 'kbd:cmdk', section: 'Keyboard shortcuts', title: 'Open command palette', icon: '⌨', shortcut: '⌘K', keywords: 'command palette search', perform: () => setPaletteOpen(true) },
      { id: 'kbd:operator', section: 'Keyboard shortcuts', title: 'Open Papercup panel', icon: '⌨', shortcut: '⌘K, O', keywords: 'operator panel concierge', perform: () => { /* triggered via handler in OperatorPanel */ } },
      { id: 'kbd:feature-jk', section: 'Keyboard shortcuts', title: 'Feature list — move selection', icon: '⌨', shortcut: 'J / K', keywords: 'feature list navigate move', perform: () => { /* see FeatureList */ } },
      { id: 'kbd:feature-enter', section: 'Keyboard shortcuts', title: 'Feature list — open selected', icon: '⌨', shortcut: '↵', keywords: 'feature list open enter', perform: () => { /* see FeatureList */ } },
      { id: 'kbd:feature-r', section: 'Keyboard shortcuts', title: 'Feature list — reset selected', icon: '⌨', shortcut: 'R', keywords: 'feature list reset', perform: () => { /* see FeatureList */ } },
    );

    // Registry-derived palette items — every CommandDef tagged with
    // `paletteEntry` shows up here automatically. New palette entries
    // are added by registering a def, not by editing this file.
    try {
      const ws = (typeof window !== 'undefined'
        ? new URL(window.location.href).searchParams.get('ws')
        : null) ?? 'default';
      const tabId = typeof window !== 'undefined'
        ? (window.sessionStorage.getItem('pc-voice-tab-id') ?? undefined)
        : undefined;
      // palette-shim is statically imported — it's a thin layer over the
      // registry, already loaded when the dashboard is open. (Was a CJS
      // require(), which is undefined in the Vite browser bundle.)
      const registryItems = buildRegistryPaletteItems({ workspace: ws, sessionId: tabId });
      cs.push(...registryItems);
    } catch (err) {
      // If the registry hasn't loaded yet (rare — the palette is built
      // long after page mount), skip silently. Items will appear on the
      // next memo run.
      void err;
    }
    return cs;
  }, [projects, activeSlug, status, agents, launchHarness, stopHarness, loadAgent]);

  const triageCount = useMemo(
    () => (status?.features ?? []).filter((f) => f.status === 'blocked' || f.status === 'failing' || f.attempts >= 3).length,
    [status],
  );

  const activeProject = useMemo(
    () => projects.find((p) => p.slug === activeSlug) ?? null,
    [projects, activeSlug],
  );
  const activeProjectPath = status?.project.path ?? activeProject?.path ?? '';

  const activeLanes = useMemo(
    () => [...(lanes?.lanes ?? [])].filter((lane) => lane.alive).sort((a, b) => a.startedAt - b.startedAt),
    [lanes],
  );

  const isBrainstormPanel = activePanel === 'brainstorm';

  const recentAgentsContent = agents.length === 0 ? (
    <div className="h-empty">
      <span>No agent runs yet.</span>
    </div>
  ) : (
    <RecentAgentsTable agents={agents} onSelect={loadAgent} />
  );

  useGSAP(
    () => {
      if (!rootRef.current || !fancyEffectsEnabled) return;
      const q = gsap.utils.selector(rootRef.current);
      const intro = gsap.timeline({ defaults: { ease: 'power3.out' } });
      const topChromeTargets = q('.h-header, .h-quick-action-row, .h-tabs.h-main-tabs');

      // Panel changes re-run this GSAP context. The top chrome is persistent
      // page furniture, so keep it stable instead of replaying the HUD intro
      // when switching between Brainstorm / Proposals / Dashboard / etc.
      gsap.set(topChromeTargets, { autoAlpha: 1, y: 0 });
      gsap.set(topChromeTargets, { clearProps: 'opacity,visibility,transform' });

      intro.fromTo(
        q('.h-hud-dial'),
        { autoAlpha: 0, scale: 0.72, rotate: -42 },
        { autoAlpha: 1, scale: 1, rotate: 0, duration: 0.96 },
        0,
      );
      intro.fromTo(
        q('.h-dashboard-panel-anchor'),
        { autoAlpha: 0, y: 28, rotationX: 8 },
        { autoAlpha: 1, y: 0, rotationX: 0, duration: 0.64, stagger: 0.08 },
        0.22,
      );

      // Idle/ambient animations (rotating dial rings, scanline sweep, grid
      // scroll, node hover-bob, pulse dots, brightness pulse) are now driven
      // by pure CSS @keyframes in harness.css. GSAP rAF tweens for these
      // were running ~22 long-tasks/sec at idle and producing 600+ DOM
      // mutations per 8-second window — the dominant cost on the harness
      // page even with no PG writes happening. Pure CSS animation runs on
      // the compositor thread and doesn't touch React's commit path.
      // Status-alive variants are toggled via the `is-live` class on
      // .h-hud-overlay (set by the alive prop) and CSS rules.

      return () => {
        intro.kill();
      };
    },
    { scope: rootRef, dependencies: [fancyEffectsEnabled, activePanel, topChromeCollapsed, !!status?.alive, activeLanes.length, todoCount] },
  );

  return (
    <RTooltip.Provider delayDuration={400}>
    <div
      ref={rootRef}
      data-hud-panel={activePanel}
      className={`h-root h-root--maximal-hud${embeddedPanelChrome ? ' h-root--embedded-panel' : ''}${isBrainstormPanel ? ' brainstorm-mode' : ''}${topChromeCollapsed ? ' top-chrome-collapsed' : ''}`}
    >
      {confirmEl}
      {promptEl}
      {!embeddedPanelChrome && (
        <HarnessHudOverlay
          alive={!!status?.alive}
          activePanel={activePanel}
          laneCount={activeLanes.length}
          pendingCount={todoCount}
          escalated={!!status?.escalated}
        />
      )}
      {/* Toaster is mounted globally in app/layout.tsx (outside <main>)
          so it can stack above pc-header. A page-level Toaster trapped
          inside <main z:70> cannot visually escape. */}

      {!embeddedPanelChrome && (
        <CollapseTopSectionPortalButton
          collapsed={topChromeCollapsed}
          onToggle={() => { void setTopChromeCollapsed(!topChromeCollapsed); }}
        />
      )}
      {!topChromeCollapsed && (
        <>
          {/* ── Mission header ─────────────────────────────────── */}
          <div className={`h-header${status?.alive ? ' alive' : ''}`}>

          <div className="h-header-main">
          <div className="h-project-card">
            <div className="h-project-topline">
              {activeSlug && (
                <div className="h-project-phases">
                  <PhaseTabs
                    slug={activeSlug}
                    activePhase={activePhase}
                    onChange={setActivePhase}
                    phasesEnabled={harnessPhasesEnabled}
                  />
                </div>
              )}

              {status && (
                <span className="h-project-badges">
                  <span className={`h-status-chip ${status.alive ? 'live' : 'idle'}`}>
                    <span className={`h-pulse-dot ${status.alive ? 'live' : 'idle'}`} />
                    {status.alive ? 'running' : 'idle'}
                  </span>
                </span>
              )}
            </div>
            <RSelect.Root
              value={activeSlug ?? ''}
              onValueChange={(next) => {
                setActiveSlug(next);
                // Keep the URL path in sync with the dropdown on the legacy
                // /harness route. ADV embeds only want ?slug= state; rewriting
                // the path from inside /adv would eject the user back to OPS.
                if (!embeddedPanelChrome && typeof window !== 'undefined' && next) {
                  const target = `/harness/${encodeURIComponent(next)}`;
                  if (window.location.pathname !== target) {
                    window.history.replaceState(null, '', target + window.location.search);
                  }
                }
              }}
            >
              <RSelect.Trigger className="h-project" aria-label="Select harness project">
                <RSelect.Value placeholder="— pick a project —" />
                <RSelect.Icon><LChevronDown size={11} /></RSelect.Icon>
              </RSelect.Trigger>
              <RSelect.Portal>
                <RSelect.Content position="popper" sideOffset={4} style={{ zIndex: 70, minWidth: 'var(--radix-select-trigger-width)', background: '#0b1220', color: 'var(--fg)', border: '1px solid color-mix(in oklab, var(--accent), transparent 62%)', borderRadius: 10, padding: 6, boxShadow: '0 18px 54px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.06)', fontSize: 12 }}>
                  <RSelect.Viewport>
                    {/* Layer 3-E: group by harness_kind so the org/department hierarchy is visible. */}
                    {(['org', 'department', 'coding'] as const).map((kind) => {
                      const kindProjects = projects.filter((p) => ((p as any).harness_kind ?? 'coding') === kind);
                      if (kindProjects.length === 0) return null;
                      const labels: Record<typeof kind, string> = {
                        org: 'Org (parent harnesses)',
                        department: 'Departments (children)',
                        coding: 'Coding projects',
                      } as const;
                      return (
                        <RSelect.Group key={kind}>
                          <RSelect.Label style={{ padding: '6px 8px 4px', color: 'var(--fg-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
                            {labels[kind]}
                          </RSelect.Label>
                          {kindProjects.map((p) => (
                            <RSelect.Item key={p.slug} value={p.slug} className="h-select-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 8px', borderRadius: 3, outline: 'none', cursor: 'pointer' }}>
                              <RSelect.ItemText>{p.slug}{p.hasState ? '' : ' (no state)'}</RSelect.ItemText>
                              <RSelect.ItemIndicator><LCheck size={11} /></RSelect.ItemIndicator>
                            </RSelect.Item>
                          ))}
                        </RSelect.Group>
                      );
                    })}
                  </RSelect.Viewport>
                </RSelect.Content>
              </RSelect.Portal>
            </RSelect.Root>
            <div className="h-project-meta">
              <span className="h-project-path">
                {activeProjectPath || 'Choose a workspace to view agents, logs, issues, docs, and VSCode.'}
              </span>
              {status && (
                <span className="h-project-meta-status">
                  <span className="h-project-progress">{progressPct}% complete</span>
                  <span className="h-project-count todo"><strong>{todoCount}</strong> todo</span>
                  <span className="h-project-count blocked"><strong>{blockedCount}</strong> blocked</span>
                  <span className="h-project-count passed"><strong>{passedCount}</strong> passed</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {status ? (
          <div className="h-header-side">
            <div className="h-stats">
              <Tooltip label="Total pulses — every orchestrator main-loop tick across all runs of this harness.">
                <div title={`Total pulses: ${status.iteration}`}>
                  <StatCard
                    label="pulse"
                    value={`#${status.iteration}`}
                    icon={<Activity size={13} />}
                  />
                </div>
              </Tooltip>
              {lanes && Array.isArray(lanes.lanes) && activeSlug && (() => {
                const activeLanes = lanes.lanes.filter((l) => l.alive);
                const activeCount = activeLanes.length;
                const title = activeCount > 0
                  ? `Active lanes:\n${activeLanes.map((l) => `  ${l.featureId} · ${l.elapsedSeconds}s`).join('\n')}`
                  : 'No active lanes — adjust max in the Settings tab.';
                return (
                  <div title={title}>
                    <StatCard label="Lanes" value={`${activeCount}/${lanes.max}`} />
                  </div>
                );
              })()}
              <Tooltip label="Features passed out of total in this harness queue">
                <div title={`${passedCount} passed out of ${totalCount} features`}>
                  <StatCard
                    label="passed"
                    value={`${passedCount}/${totalCount}`}
                    tone={progressPct === 100 ? 'good' : undefined}
                    icon={<CheckCircle2 size={13} />}
                  />
                </div>
              </Tooltip>
              {typeof status.missionCostUsd === 'number' && status.missionCostUsd > 0 && (
                <Tooltip label="Open the Insights tab">
                  <button
                    className="h-stat-button"
                    onClick={() => setActivePanel('insights')}
                  >
                    <StatCard
                      label="$ spent"
                      value={`${status.missionCostUsd.toFixed(2)}`}
                      icon={<Coins size={13} />}
                    />
                  </button>
                </Tooltip>
              )}
              {activeSlug && <HealthBadge slug={activeSlug} />}
              {activeSlug && localGithubUser && (
                <div style={{ position: 'relative' }}>
                  <SyncWithMainBadge
                    harnessSlug={activeSlug}
                    githubUserId={localGithubUser.id}
                    onClick={() => setShowSyncDialog((v) => !v)}
                  />
                  {showSyncDialog && (
                    <SyncWithMainDialog
                      harnessSlug={activeSlug}
                      githubUserId={localGithubUser.id}
                      onClose={() => setShowSyncDialog(false)}
                    />
                  )}
                </div>
              )}
              {status?.discord_channel_url && (
                <DiscordChannelLink discordChannelUrl={status.discord_channel_url} />
              )}
              {typeof status.pendingCheckpoints === 'number' && status.pendingCheckpoints > 0 && (
                <div title={`${status.pendingCheckpoints} checkpoint${status.pendingCheckpoints === 1 ? '' : 's'} awaiting grant`}>
                  <StatCard
                    label="checkpoints"
                    value={`${status.pendingCheckpoints} pending`}
                    tone="warn"
                    icon={<AlertTriangle size={13} />}
                  />
                </div>
              )}
              {typeof status.activeCompetitions === 'number' && status.activeCompetitions > 0 && (
                <div title={`${status.activeCompetitions} synthesis run${status.activeCompetitions === 1 ? '' : 's'} in progress (workers committed, synthesizer + validator pending)`}>
                  <StatCard
                    label="syntheses"
                    value={String(status.activeCompetitions)}
                  />
                </div>
              )}
              {status.smokeFail && (
                <Tooltip label="Last smoke test failed — click to view">
                  <button
                    className="h-stat-button"
                    onClick={() => setShowSmokeTest(true)}
                  >
                    <StatCard label="smoke" value="FAIL" tone="bad" />
                  </button>
                </Tooltip>
              )}
              {status && (
                <Tooltip label="Command palette (⌘K)">
                  <button
                    className="h-btn ghost h-key-btn"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => setPaletteOpen(true)}
                  >
                    ⌘K
                  </button>
                </Tooltip>
              )}
            </div>
            {status && (
              <div className="h-header-actions h-header-actions-row">
                <Tooltip label="Triage — features needing attention">
                  <button
                    className={`h-btn ${triageCount > 0 ? 'danger' : 'ghost'}`}
                    onClick={() => setShowTriage(true)}
                  >
                    <AlertTriangle size={13} /> triage{triageCount > 0 ? ` · ${triageCount}` : ''}
                  </button>
                </Tooltip>
                <Tooltip label="Propose — run the scoper agent (MODE=proposal) to read the active plan and suggest scoped features in the Proposals tab">
                  <button className="h-btn ghost" onClick={proposeHarness}>
                    <Lightbulb size={13} /> propose
                  </button>
                </Tooltip>
                <Tooltip label="Replan — fold new plan items into the work queue without restarting the harness">
                  <button className="h-btn ghost" onClick={replanHarness}>
                    <RefreshCw size={13} /> replan
                  </button>
                </Tooltip>
                <Tooltip label="Cleanup — deprecate or modify existing features that no longer match the active plan (won't add new ones)">
                  <button className="h-btn ghost" onClick={cleanupHarness}>
                    <Wrench size={13} /> cleanup
                  </button>
                </Tooltip>
                {activeSlug && templatesEnabled && (
                  <Tooltip label="Save current harness as a reusable template (recipe; no in-flight state)">
                    <SaveTemplateButton slug={activeSlug} />
                  </Tooltip>
                )}
                {activeSlug && snapshotsEnabled && <SaveSnapshotButton slug={activeSlug} />}
              </div>
            )}

          </div>
        ) : (
          <div className="h-header-empty">
            <span>Pick a project, then use <strong>⌘K</strong> for every harness action.</span>
          </div>
        )}
      </div>

      {activeSlug && (
        <ActiveAgentsBar
          slug={activeSlug}
          phase={activePhase}
          // `null` while we haven't received /status yet → loading state
          // in the bar. After the first response, real true/false.
          alive={status === null ? null : !!status.alive}
          runs={(Array.isArray(zeroLaneRows) ? zeroLaneRows : [])
            .map((l) => ({
              // Use the real runId format that the orchestrator's invoke()
              // function writes to <startedAt-seconds>-<role>[-<featureId>].jsonl,
              // so onPillClick → loadAgent(runId) hits the right
              // /api/harness/<slug>/agents/<runId> shape.
              runId: `${Math.floor(Number(l.startedAt) / 1000)}-${l.role}${l.featureId ? `-${l.featureId}` : ''}`,
              role: l.role,
              featureId: l.featureId ?? null,
              ts: Math.floor(Number(l.startedAt) / 1000),
            }))
            .sort((a, b) => a.ts - b.ts)}
          onPillClick={loadAgent}
          onStart={launchHarness}
          onStop={stopHarness}
        />
      )}

      {/* Plan review + checkpoint banners surface above the plugin-actions row
          so user-required decisions don't get hidden under tool buttons. */}
      {!embeddedPanelChrome && activeSlug && <PlanReviewBanner slug={activeSlug} />}
      {!embeddedPanelChrome && activeSlug && <CheckpointBanner slug={activeSlug} />}

      {!embeddedPanelChrome && activeSlug && status && (
        <HarnessQuickActionRow
          harnessSlug={activeSlug}
          installed={installedPlugins ?? []}
          enabledSlugs={enabledByHarness[activeSlug] ?? []}
          pluginsMissing={pluginsMissing}
          onGoToPluginConfig={(pluginName) => {
            void setConfigPane(pluginName);
            void setActivePanel('config');
          }}
        />
      )}

      {!embeddedPanelChrome && activeSlug && status && (
        <EscalationBanner
          slug={activeSlug}
          escalated={status.escalated}
          onResumed={() => {
            fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then((next) => setStatus((prev) => prev && Array.isArray(prev.features) && prev.features.length > 0 ? { ...next, features: prev.features } : next)).catch(() => {});
          }}
        />
      )}



        </>
      )}


      {/* ── Main-area tab switcher ─────────────────────────────── */}
      <Tabs.Root
        value={activePanel}
        onValueChange={(v) => setActivePanel(v as MainPanel)}
        className="h-tab-strip"
      >
        <Tabs.List className="h-tabs h-main-tabs" aria-label="Harness workspace sections">
          <Tooltip label={activeSlug ? 'Brainstorm — write, mindmap, canvas, chat with Claude' : 'Select a project to brainstorm'}>
            <Tabs.Trigger value="brainstorm" className="h-tab h-tab--brainstorm" disabled={!activeSlug}>
              <Lightbulb size={13} /> brainstorm
            </Tabs.Trigger>
          </Tooltip>
          <Tooltip label={activeSlug ? `Product proposals — scope expansion from the active plan${pendingProposals > 0 ? ` · ${pendingProposals} pending` : ''}` : 'Select a project to view proposals'}>
            <Tabs.Trigger value="proposals" className="h-tab h-tab--proposals" disabled={!activeSlug}>
              🪄 proposals
              {pendingProposals > 0 && <span className="h-tab-count">{pendingProposals}</span>}
            </Tabs.Trigger>
          </Tooltip>
          <Tooltip label={activeSlug ? 'Experts — instanced spec-authoring agents (one per high-level feature area)' : 'Select a project to view experts'}>
            <Tabs.Trigger value="experts" className="h-tab h-tab--experts" disabled={!activeSlug}>
              🧠 experts
            </Tabs.Trigger>
          </Tooltip>
          <Tooltip label="Harness dashboard — feature queue, agents, logs, issues">
            <Tabs.Trigger value="dashboard" className="h-tab h-tab--dashboard">
              <LayoutDashboard size={13} /> dashboard
            </Tabs.Trigger>
          </Tooltip>
          {designEnabled && (
          <Tooltip label={activeSlug ? 'Design — IR specs, registry, tokens, sketches, regressions' : 'Select a project to enter the design tab'}>
            <Tabs.Trigger value="design" className="h-tab h-tab--design" disabled={!activeSlug}>
              <Palette size={13} /> design
            </Tabs.Trigger>
          </Tooltip>
          )}
          <Tooltip label={activeSlug ? 'Project summary — high-level changelog of what has been built' : 'Select a project to view summary'}>
            <Tabs.Trigger value="summary" className="h-tab h-tab--summary" disabled={!activeSlug}>
              <FileText size={13} /> summary
            </Tabs.Trigger>
          </Tooltip>
          {/* docs / vscode / pi tabs are now plugin-mounted (see pluginTabs below). */}
          {/* Plugin-mounted tabs use the tab itself as the only control. */}
          {pluginTabs.filter((pt) => !pt.replaces.includes('pi') || testingEnabled).map((pt) => (
            <PluginTabTrigger
              key={`${pt.pluginSlug}:${pt.tabId}`}
              pluginSlug={pt.pluginSlug}
              pluginVersion={pt.pluginVersion}
              tabId={pt.tabId}
              label={pt.label}
              icon={pt.icon}
              activeSlug={activeSlug}
              onDisabled={() => {
                setPluginRefreshKey((k) => k + 1);
                setInstalledPluginsRefreshKey((k) => k + 1);
              }}
            />
          ))}
          <Tooltip label={activeSlug ? 'Pull requests — view, approve, and merge PRs for this harness' : 'Select a project to view PRs'}>
            <Tabs.Trigger value="prs" className="h-tab h-tab--prs" disabled={!activeSlug}>
              <GitPullRequest size={13} /> prs
            </Tabs.Trigger>
          </Tooltip>
          <Tooltip label={activeSlug ? 'Insights — analytics' : 'Select a project to view insights'}>
            <Tabs.Trigger value="insights" className="h-tab h-tab--insights" disabled={!activeSlug}>
              <TrendingUp size={13} /> insights
            </Tabs.Trigger>
          </Tooltip>
          <Tooltip label={activeSlug ? 'Edit AGENTS.md / config.json' : 'Select a project to edit config'}>
            <Tabs.Trigger value="config" className="h-tab h-tab--config" disabled={!activeSlug}>
              <SlidersHorizontal size={13} /> config
            </Tabs.Trigger>
          </Tooltip>
          <Tooltip label={activeSlug ? 'Per-harness settings (parallel workers, adaptive tiers, telemetry)' : 'Select a project to edit settings'}>
            <Tabs.Trigger value="settings" className="h-tab h-tab--settings" disabled={!activeSlug}>
              <Settings size={13} aria-hidden /> settings
            </Tabs.Trigger>
          </Tooltip>
          {testingEnabled && (
          <AddPluginButton
            activeSlug={activeSlug}
            alreadyEnabled={new Set(activeSlug ? enabledByHarness[activeSlug] ?? [] : [])}
            installed={installedPlugins}
            error={installedPluginsError}
            onEnabled={() => {
              setPluginRefreshKey((k) => k + 1);
              setInstalledPluginsRefreshKey((k) => k + 1);
            }}
            onRetry={() => setInstalledPluginsRefreshKey((k) => k + 1)}
          />
          )}
        </Tabs.List>
      </Tabs.Root>

      {!status && (
        <div className="h-guide-strip">
          {activeSlug ? <Loader2 size={14} className="h-spin" /> : <Activity size={14} />}
          <span>{activeSlug ? `Loading ${activeSlug} mission state…` : 'Pick a project to unlock docs, VSCode, logs, issues, and agent controls.'}</span>
          <Tooltip label="Open the command palette (⌘K)"><button className="h-guide-action" onClick={() => setPaletteOpen(true)} aria-label="Open the command palette">Open commands</button></Tooltip>
        </div>
      )}

      {/* ── Main area ──────────────────────────────────────────── */}
      <div className={`h-main-shell ${resolvedPanel === 'dashboard' ? 'dashboard' : resolvedPanel === 'brainstorm' ? 'brainstorm-full' : 'embed'}`}>
        {LEGACY_ALIASES.includes(resolvedPanel) && (
          <div role="status" aria-live="polite" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--fg-mute, #94a3b8)', fontSize: 13 }}>
            <span aria-hidden="true" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent', animation: 'pc-spin 800ms linear infinite' }} />
            <span>{activeSlug ? `Loading ${resolvedPanel} plugin…` : `Pick a harness to use the "${resolvedPanel}" panel.`}</span>
          </div>
        )}
        {/*
          Tab panels stay mounted in <ReactActivity mode="hidden"> so switching
          between them is a CSS visibility flip rather than a full React
          remount. React 19's Activity also pauses effects/timers on the
          hidden subtree, so each panel's polling stops while it's not
          visible (re-runs on reactivation, fresh data within one cycle).
          See the perf audit notes — this trades initial mount work for
          instant tab switches and avoids piling N panels' poll loops on
          top of each other.
        */}
        <ReactActivity mode={resolvedPanel === 'brainstorm' ? 'visible' : 'hidden'}>
          {activeSlug && (resolvedPanel === 'brainstorm' || everMountedPanels.has('brainstorm')) && <BrainstormFull slug={activeSlug} />}
        </ReactActivity>
        <ReactActivity mode={resolvedPanel === 'proposals' ? 'visible' : 'hidden'}>
          {activeSlug && proposalsEverMounted && (
            <ProposalsPanel
              slug={activeSlug}
              architectInbox={
                <ArchitectInbox slug={activeSlug} onFeatureFocus={handleArchitectFocus} />
              }
            />
          )}
        </ReactActivity>
        <ReactActivity mode={resolvedPanel === 'summary' ? 'visible' : 'hidden'}>
          {activeSlug && (resolvedPanel === 'summary' || everMountedPanels.has('summary')) && (
            <SummaryPanel
              slug={activeSlug}
              onOpenFeature={(fid) => {
                const f = status?.features.find((ff) => ff.id === fid);
                if (f) {
                  setPeekFeature(f);
                } else {
                  setActivePanel('dashboard');
                }
              }}
            />
          )}
        </ReactActivity>
        <ReactActivity mode={resolvedPanel === 'design' && designEnabled ? 'visible' : 'hidden'}>
          {activeSlug && designEnabled && (resolvedPanel === 'design' || everMountedPanels.has('design')) && <DesignDashboard slug={activeSlug} />}
        </ReactActivity>
        {/* Plugin-mounted tabs: pick whichever plugin matches the active panel
            via the plugin:<id> prefix. iframeUrl is null when the plugin's
            manifest doesn't expose one of the conventional config keys. */}
        {resolvedPanel.startsWith('plugin:') && activeSlug && (() => {
          const tabId = resolvedPanel.slice('plugin:'.length);
          const pt = pluginTabs.filter((t) => !t.replaces.includes('pi') || testingEnabled).find((t) => t.tabId === tabId);
          if (!pt) {
            return (
              <div style={{ flex: 1, padding: 24, color: 'var(--fg-dim)' }}>
                Plugin tab not found.
              </div>
            );
          }
          // Inline-dock mode: host renders the plugin's component directly
          // without an intermediate iframe. Today only @papercupai/pi-coding
          // uses this — the /pi iframe deadlocks in Next dev (see
          // InlinePiDock comment). Plugins opt in via "embedMode": "inline-dock"
          // in their dashboardTabs manifest entry. The host has to know
          // which dock to render for which (componentRoot, componentId)
          // pair — currently only PiTerminalsDock from @restart/papercup-shared
          // is wired here. Other plugins requesting inline-dock fall back
          // to React-mode below.
          if (pt.embedMode === 'inline-dock'
              && pt.componentRoot === '@restart/papercup-shared'
              && pt.componentId === 'PiTerminalsDock') {
            return (
              <div key={`${pt.pluginSlug}:${pt.tabId}`} className="h-plugin-embed-shell h-plugin-embed-shell--pi" style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }}>
                <InlinePiDock slug={activeSlug} />
              </div>
            );
          }
          if (pt.iframeUrl) {
            // Include activeSlug in the key so the iframe element is
            // recreated on harness switch. Without this, the iframe's
            // src prop changes but third-party services (code-server)
            // sometimes ignore subsequent navigations and re-show the
            // previously-cached workspace. Forcing remount guarantees a
            // fresh load.
            return <PluginIframeWithLoader key={`${pt.pluginSlug}:${pt.tabId}:${activeSlug}`} url={pt.iframeUrl} title={pt.label} />;
          }
          if (pt.componentRoot && pt.componentId) {
            return (
              <PluginReactTab
                key={`${pt.pluginSlug}:${pt.tabId}`}
                pluginName={pt.pluginSlug}
                componentRoot={pt.componentRoot}
                componentId={pt.componentId}
                slug={activeSlug}
                label={pt.label}
              />
            );
          }
          return (
            <div style={{ flex: 1, padding: 24, color: 'var(--fg-dim)' }}>
              <strong>{pt.label}</strong> ({pt.pluginSlug}@{pt.pluginVersion}) is enabled but
              declares neither an iframeUrl nor a (componentRoot, componentId) pair. Update the
              plugin manifest, or run{' '}
              <code>papercusp plugin config {pt.pluginSlug} --harness {activeSlug}</code>.
            </div>
          );
        })()}
        <ReactActivity mode={resolvedPanel === 'insights' ? 'visible' : 'hidden'}>
          {status && (resolvedPanel === 'insights' || everMountedPanels.has('insights')) && (
            <InsightsPanel
              inline
              slug={activeSlug ?? undefined}
              features={status.features as any}
              totalCostUsd={status.missionCostUsd ?? 0}
              totalInputTokens={status.missionInputTokens ?? 0}
              totalOutputTokens={status.missionOutputTokens ?? 0}
              iteration={status.iteration}
              onClose={() => setActivePanel('dashboard')}
            />
          )}
        </ReactActivity>
        <ReactActivity mode={resolvedPanel === 'prs' ? 'visible' : 'hidden'}>
          {activeSlug && (resolvedPanel === 'prs' || everMountedPanels.has('prs')) && (
            <PrsTab harnessSlug={activeSlug} />
          )}
        </ReactActivity>
        <ReactActivity mode={resolvedPanel === 'experts' ? 'visible' : 'hidden'}>
          {activeSlug && (resolvedPanel === 'experts' || everMountedPanels.has('experts')) && (
            <ExpertsPanel
              harnessSlug={activeSlug}
              onClose={() => setActivePanel('dashboard')}
            />
          )}
        </ReactActivity>
        <ReactActivity mode={resolvedPanel === 'config' ? 'visible' : 'hidden'}>
          {activeSlug && status && (resolvedPanel === 'config' || everMountedPanels.has('config')) && (
            <ConfigPanel
              harnessSlug={activeSlug}
              projectPath={status.project.path}
              alive={status.alive}
              onClose={() => setActivePanel('dashboard')}
              installedPlugins={installedPlugins ?? []}
              enabledSlugs={enabledByHarness[activeSlug] ?? []}
              pluginCount={enabledByHarness[activeSlug]?.length ?? 0}
              onPluginsChange={() => {
                setPluginRefreshKey((k) => k + 1);
                setInstalledPluginsRefreshKey((k) => k + 1);
              }}
              activePane={configPane}
              onPaneChange={(p) => void setConfigPane(p)}
              pluginsMissing={pluginsMissing}
            />
          )}
        </ReactActivity>
        <ReactActivity mode={resolvedPanel === 'settings' ? 'visible' : 'hidden'}>
          {activeSlug && (resolvedPanel === 'settings' || everMountedPanels.has('settings')) && (
            <HarnessSettingsPanel slug={activeSlug} phase={activePhase} />
          )}
        </ReactActivity>
        <ReactActivity mode={resolvedPanel === 'dashboard' ? 'visible' : 'hidden'}>
          <>
            {isCompact ? (
            <div className="h-compact-dashboard">
              <div className="h-dashboard-panel-anchor" data-dashboard-panel="features" suppressHydrationWarning tabIndex={-1}>
                <Panel title="Feature queue" count={totalCount} className="h-feature-queue-panel">
                <FeatureList
                  slug={activeSlug ?? ''}
                  features={featuresStable}
                  activeFeatureId={peekFeature?.id ?? null}
                  onSelect={handleSelectFeature}
                  onReset={resetFeature}
                  onEdit={handleEditFeature}
                  onSwitchToPi={handleSwitchToPi}
                  onAdd={handleAddFeature}
                  onBatchReset={batchReset}
                  onBatchDelete={batchDelete}
                  notesByFeatureId={notesByFeatureId}
                />
              </Panel>
              </div>

              {activeSlug && (
                <div
                  className="h-compact-panel h-compact-inbox h-dashboard-panel-anchor h-dashboard-left-pane"
                  data-dashboard-panel="git" suppressHydrationWarning
                  tabIndex={-1}
                  style={{
                    background: 'var(--bg-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                  }}
                >
                  <SingleSubpanelHeader id="git" label="git" />
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <GitGraphPanel slug={activeSlug} />
                  </div>
                </div>
              )}

              <div className="h-dashboard-panel-anchor" data-dashboard-panel="agents" suppressHydrationWarning tabIndex={-1}>
                <Panel title="Recent agents" count={agents.length}>
                {recentAgentsContent}
              </Panel>
              </div>

              <div className="h-dashboard-panel-anchor" data-dashboard-panel="logs" suppressHydrationWarning tabIndex={-1}>
                <Panel title="run.log" count="live">
                <LogView
                  events={logEvents}
                  newestFirst
                  contextId={activeSlug ?? undefined}
                  onLoadOlder={async (before) => {
                    if (!activeSlug) return { hasMore: false };
                    const r = await fetch(
                      `/api/harness/${activeSlug}/log/history?before=${encodeURIComponent(before)}&limit=500`,
                    );
                    if (!r.ok) throw new Error(`history fetch ${r.status}`);
                    const d = await r.json() as { events: import('@restart/ui-primitives').LogEvent[]; hasMore: boolean };
                    setLogEvents((prev) => [...d.events, ...prev]);
                    return { hasMore: d.hasMore };
                  }}
                />
              </Panel>
              </div>

              <div className="h-dashboard-panel-anchor" data-dashboard-panel="issues" suppressHydrationWarning tabIndex={-1}>
                <IssuesPanel slug={activeSlug ?? ''} reportMd={issues} phase={activePhase} />
              </div>
            </div>
          ) : (
        <div className="h-dashboard-grid" style={{ display: 'flex', gap: 6, height: '100%', minHeight: 0, flex: 1 }}>
          {activeSlug && (
            <CollapsedGitRail
              slug={activeSlug}
              onExpand={() => setGitCollapsed((c) => !c)}
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
        <PanelGroup orientation="horizontal">
          {activeSlug && !gitCollapsed && (
            <>
              <RPanel
                defaultSize="30%"
                minSize="20%"
                maxSize="48%"
                collapsible
                collapsedSize={0}
              >
                <div className="h-dashboard-panel-anchor h-dashboard-left-pane" data-dashboard-panel="git" suppressHydrationWarning tabIndex={-1} style={{
                  height: '100%',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}>
                  <SingleSubpanelHeader id="git" label="git" />
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <GitGraphPanel slug={activeSlug} />
                  </div>
                </div>
              </RPanel>
              <Separator className="h-resize-h" style={{ margin: '0 6px' }} />
            </>
          )}
          <RPanel defaultSize="82%">
            <PanelGroup orientation="vertical">
              {/* Top: Feature queue, full width */}
              <RPanel defaultSize="40%" minSize="20%">
                <div className="h-dashboard-panel-anchor" data-dashboard-panel="features" suppressHydrationWarning tabIndex={-1}>
                  <Panel title="Feature queue" count={totalCount} className="h-feature-queue-panel">
                    <FeatureList
                      slug={activeSlug ?? ''}
                      features={featuresStable}
                      activeFeatureId={peekFeature?.id ?? null}
                      onSelect={handleSelectFeature}
                      onReset={resetFeature}
                      onEdit={handleEditFeature}
                      onSwitchToPi={handleSwitchToPi}
                      onAdd={handleAddFeature}
                      onBatchReset={batchReset}
                      onBatchDelete={batchDelete}
                      notesByFeatureId={notesByFeatureId}
                    />
                  </Panel>
                </div>
              </RPanel>
              <Separator className="h-resize-v" style={{ margin: '6px 0' }} />
              {/* Middle: Issues / Tests / Report tabs, full width */}
              <RPanel defaultSize="35%" minSize="20%">
                <div className="h-dashboard-panel-anchor" data-dashboard-panel="issues" suppressHydrationWarning tabIndex={-1}>
                  <IssuesPanel slug={activeSlug ?? ''} reportMd={issues} phase={activePhase} />
                </div>
              </RPanel>
              <Separator className="h-resize-v" style={{ margin: '6px 0' }} />
              {/* Bottom row: Recent agents + run.log side-by-side, compact */}
              <RPanel defaultSize="25%" minSize="12%">
                <PanelGroup orientation="horizontal">
                  <RPanel defaultSize="50%" minSize="20%">
                    <div className="h-dashboard-panel-anchor" data-dashboard-panel="agents" suppressHydrationWarning tabIndex={-1}>
                      <Panel title="Recent agents" count={agents.length}>
                        {recentAgentsContent}
                      </Panel>
                    </div>
                  </RPanel>
                  <Separator className="h-resize-h" style={{ margin: '0 6px' }} />
                  <RPanel defaultSize="50%" minSize="20%">
                    <div className="h-dashboard-panel-anchor" data-dashboard-panel="logs" suppressHydrationWarning tabIndex={-1}>
                      <Panel title="run.log" count="live">
                        <LogView
                          events={logEvents}
                          newestFirst
                          contextId={activeSlug ?? undefined}
                          onLoadOlder={async (before) => {
                            if (!activeSlug) return { hasMore: false };
                            const r = await fetch(
                              `/api/harness/${activeSlug}/log/history?before=${encodeURIComponent(before)}&limit=500`,
                            );
                            if (!r.ok) throw new Error(`history fetch ${r.status}`);
                            const d = await r.json() as { events: import('@restart/ui-primitives').LogEvent[]; hasMore: boolean };
                            setLogEvents((prev) => [...d.events, ...prev]);
                            return { hasMore: d.hasMore };
                          }}
                        />
                      </Panel>
                    </div>
                  </RPanel>
                </PanelGroup>
              </RPanel>
            </PanelGroup>
          </RPanel>
        </PanelGroup>
          </div>
        </div>
          )}
          </>
        </ReactActivity>
      </div>

      {/* ── Command palette (⌘K) ──────────────────────────── */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />

      {/* ── Keyboard-shortcut cheat-sheet (?) ─────────────── */}
      <ShortcutsCheatSheet
        open={showShortcutsCheatSheet}
        onClose={() => setShowShortcutsCheatSheet(false)}
      />

      {/* ── Feature peek panel ────────────────────────────── */}
      {/* Mount unconditionally so the vaul drawer + focus-trap + body-lock
          setup happens once at dashboard load, not on every open. The panel
          renders null internally while peekFeature is null (until the first
          click), then keeps a sticky reference so subsequent open/close
          cycles just toggle the drawer's `open` prop instead of unmounting
          the whole tree. Removes the perceptible click-to-paint lag. */}
      <FeaturePeekPanel
        slug={activeSlug ?? ''}
        feature={peekFeature as any}
        agents={agents as any}
        issues={issues}
        onClose={() => setPeekFeature(null)}
        onReset={resetFeature}
        onEdit={() => { if (peekFeature) { setEditingFeature(peekFeature); setPeekFeature(null); } }}
        onInspectRun={loadAgent}
        onSetStatus={(id, s) => setFeatureStatus(id, s as FeatureStatus)}
        onSwitchToPi={() => setActivePanel('pi')}
        notesForFeature={peekFeature ? (notesByFeatureId.get(peekFeature.id) ?? '') : ''}
        debugNoteForFeature={peekFeature ? (debugNotesByFeatureId.get(peekFeature.id) ?? null) : null}
        prForFeature={peekFeature ? (prsByFeatureId.get(peekFeature.id) ?? null) : null}
      />

      {/* ── Triage queue ──────────────────────────────────── */}
      {showTriage && status && (
        <TriageQueue
          features={status.features as any}
          issues={issues}
          onClose={() => setShowTriage(false)}
          onOpenFeature={(id) => {
            const f = status.features.find((ff) => ff.id === id);
            if (f) { setPeekFeature(f); setShowTriage(false); }
          }}
          onReset={(id) => { resetFeature(id); }}
          onUnblock={(id) => setFeatureStatus(id, 'todo')}
          onSkip={(id) => setFeatureStatus(id, 'passed')}
        />
      )}

      {/* ── Agent inspector modal ─────────────────────────── */}
      {selectedAgent && (
        <AgentInspector
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          onRefresh={() => loadAgent(selectedAgent.runId)}
        />
      )}

      {/* ── Hooks panel ───────────────────────────────────── */}
      {showHooks && activeSlug && status && (
        <div data-harness-modal="true">
          <HooksPanel
            slug={activeSlug}
            alive={status.alive}
            onClose={() => setShowHooks(false)}
          />
        </div>
      )}

      {/* ── Intervention panel ────────────────────────────── */}
      {showIntervention && activeSlug && status && (
        <div data-harness-modal="true">
          <InterventionPanel
            slug={activeSlug}
            alive={status.alive}
            onClose={() => setShowIntervention(false)}
          />
        </div>
      )}

      {/* ── Usage panel ───────────────────────────────────── */}
      {showUsage && activeSlug && (
        <div data-harness-modal="true">
          <UsagePanel
            slug={activeSlug}
            onClose={() => setShowUsage(false)}
          />
        </div>
      )}

      {/* ── Snapshots panel ───────────────────────────────── */}
      {showSnapshots && activeSlug && snapshotsEnabled && (
        <div data-harness-modal="true">
          <SnapshotsPanel
            slug={activeSlug}
            onClose={() => setShowSnapshots(false)}
            onRestored={() => {
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then((next) => setStatus((prev) => prev && Array.isArray(prev.features) && prev.features.length > 0 ? { ...next, features: prev.features } : next)).catch(() => {});
            }}
          />
        </div>
      )}

      {/* ── Screenshots panel ─────────────────────────────── */}
      {showScreenshots && activeSlug && (
        <div data-harness-modal="true">
          <ScreenshotsPanel
            slug={activeSlug}
            onClose={() => setShowScreenshots(false)}
          />
        </div>
      )}

      {/* ── Decisions panel ───────────────────────────────── */}
      {showDecisions && activeSlug && (
        <div data-harness-modal="true">
          <DecisionsPanel
            slug={activeSlug}
            onClose={() => setShowDecisions(false)}
          />
        </div>
      )}

      {/* ── Smoke test panel ──────────────────────────────── */}
      {showSmokeTest && activeSlug && (
        <div data-harness-modal="true">
          <SmokeTestPanel
            slug={activeSlug}
            onClose={() => setShowSmokeTest(false)}
          />
        </div>
      )}

      {/* ── Identity panel ────────────────────────────────── */}
      {showIdentity && (
        <div data-harness-modal="true">
          <IdentityPanel onClose={() => setShowIdentity(false)} />
        </div>
      )}

      {/* ── Feature diff modal ────────────────────────────── */}
      {diffFeatureId && activeSlug && (
        <div data-harness-modal="true">
          <FeatureDiffModal
            slug={activeSlug}
            featureId={diffFeatureId}
            onClose={() => setDiffFeatureId(null)}
          />
        </div>
      )}

      {/* ── Archives panel ────────────────────────────────── */}
      {showArchives && activeSlug && (
        <div data-harness-modal="true">
          <ArchivesPanel
            slug={activeSlug}
            onClose={() => setShowArchives(false)}
            onChanged={() => {
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then((next) => setStatus((prev) => prev && Array.isArray(prev.features) && prev.features.length > 0 ? { ...next, features: prev.features } : next)).catch(() => {});
            }}
          />
        </div>
      )}

      {/* ── Intel panel — tool-invocation telemetry ──────── */}
      {showIntel && activeSlug && (
        <div data-harness-modal="true">
          <IntelPanel
            slug={activeSlug}
            onClose={() => setShowIntel(false)}
          />
        </div>
      )}

      {/* ── Templates modal ───────────────────────────────── */}
      {showTemplates && activeSlug && templatesEnabled && (
        <div data-harness-modal="true">
          <TemplatesModal
            slug={activeSlug}
            onClose={() => setShowTemplates(false)}
            onBootstrapped={() => {
              // SPEC.md content may have changed; refetch spec + status
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then((next) => setStatus((prev) => prev && Array.isArray(prev.features) && prev.features.length > 0 ? { ...next, features: prev.features } : next)).catch(() => {});
            }}
          />
        </div>
      )}

      {/* The "Recent actions" log was relocated to the chrome bar (the
          Activity-icon button next to the bell, see RecentActionsCenter).
          The old in-dashboard <LazyDetails> block at the bottom of the
          page is gone — replaced by a single popover that's reachable
          from any panel without scrolling. */}

      {/* ── Feature editor modal ──────────────────────────── */}
      {editingFeature !== null && activeSlug && (
        <div data-harness-modal="true">
          <FeatureEditor
            slug={activeSlug}
            feature={editingFeature === 'new' ? null : editingFeature}
            onClose={() => setEditingFeature(null)}
            onSaved={() => {
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then((next) => setStatus((prev) => prev && Array.isArray(prev.features) && prev.features.length > 0 ? { ...next, features: prev.features } : next)).catch(() => {});
            }}
          />
        </div>
      )}
    </div>
    </RTooltip.Provider>
  );
}

// ─── Recent agents table ──────────────────────────────────────────────

function roleClass(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function RecentAgentsTable({
  agents, onSelect,
}: {
  agents: AgentRun[];
  onSelect: (runId: string) => void;
}) {
  const columns: ColumnDef<AgentRun>[] = [
    {
      key: 'when',
      header: 'when',
      width: '88px',
      render: ({ row }) => (
        <span className="h-agent-time-cell nowrap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="h-agent-dot" aria-hidden="true" />
          <span>{fmtAgo(row.ts)}</span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'role',
      width: '118px',
      render: ({ row }) => {
        const cls = roleClass(row.role);
        return <span className={`h-agent-role ${cls}`}>{row.role}</span>;
      },
    },
    {
      key: 'runId',
      header: 'run id',
      width: '132px',
      render: ({ row }) => (
        <span className="h-agent-runid-pill mono runid" title={row.runId} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>
          {row.runId.slice(0, 14)}…
        </span>
      ),
    },
    {
      key: 'size',
      header: 'size',
      width: '72px',
      align: 'right',
      render: ({ row }) => (
        <span className="h-agent-size-pill muted mono" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
          {fmtBytes(row.sizeBytes)}
        </span>
      ),
    },
  ];

  // Keep the legacy h-agent-row/role-{cls} classes so existing CSS hover
  // rules (left-border accent, color-coded role tints) keep applying.
  const richRowProps = (ctx: { row: AgentRun }) => {
    const cls = roleClass(ctx.row.role);
    return {
      className: `h-agent-row role-${cls}`,
      tabIndex: 0,
      'aria-label': `Inspect ${ctx.row.role} run ${ctx.row.runId}`,
    };
  };

  return (
    <RichGrid<AgentRun>
      rows={agents}
      columns={columns}
      getRowId={(r) => r.runId}
      onRowClick={(r) => onSelect(r.runId)}
      rowProps={richRowProps}
      inline
    />
  );
}


// ─── Single-tab subpanel header ─────────────────────────────────
// Matches the chrome of the original LeftPaneTabs strip — a single
// uppercase tab pill in a bordered top bar — so the parent panel still
// has the visual "subpanel inside parent panel" structure even though
// the inbox/git toggle has been removed (each is now its own parent).
export function SingleSubpanelHeader({ id, label }: { id: 'inbox' | 'git'; label: string }) {
  const Icon = id === 'inbox' ? Inbox : GitBranch;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2,
      padding: '4px 6px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-2)',
      flexShrink: 0,
    }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: 'var(--fg)',
          background: 'var(--bg-3)',
          border: '1px solid var(--border)',
          borderRadius: 4,
        }}
      >
        <Icon size={12} />
        {label}
      </span>
    </div>
  );
}

// ─── Tabbed Issues panel ──────────────────────────────────────────

function IssuesPanel({ slug, reportMd, phase }: { slug: string; reportMd: string; phase: Phase }) {
  const [tab, setTab] = useQueryState('validationTab', parseAsStringEnum<'issues' | 'report' | 'tests'>(['issues', 'report', 'tests']).withDefault('issues'));
  const [issueCount, setIssueCount] = useState<number | null>(null);
  const harnessPhasesEnabled = useFlag(FLAGS.HARNESS_PHASES);

  // Wrap with `<Panel>` so the maximize/restore button (provided by
  // `Panel` and styled via `.h-panel-maximize`) shows up consistently
  // with Feature queue / Recent agents / run.log. The panel's tab strip
  // is passed as `actions` so it sits inline with the title row instead
  // of pushing the body down. Padded={false} to keep the existing
  // edge-to-edge body layout.
  const tabs = (
    <>
      <Tooltip label="Open issue tracker — bugs and concerns surfaced by validators">
        <button
          className={`h-tab${tab === 'issues' ? ' on' : ''}`}
          onClick={() => setTab('issues')}
        >
          issues
          {issueCount !== null && <span className="h-tab-count">{issueCount}</span>}
        </button>
      </Tooltip>
      {harnessPhasesEnabled ? (
        <Tooltip label="Show test claims and validator outcomes">
          <button
            className={`h-tab${tab === 'tests' ? ' on' : ''}`}
            onClick={() => setTab('tests')}
          >
            tests
          </button>
        </Tooltip>
      ) : null}
      <Tooltip label="Show the validator's prose report for the latest run">
        <button
          className={`h-tab${tab === 'report' ? ' on' : ''}`}
          onClick={() => setTab('report')}
        >
          report
          {reportMd && <span className="h-tab-count">{reportMd.length > 0 ? 'md' : ''}</span>}
        </button>
      </Tooltip>
    </>
  );

  return (
    <Panel title="Issues" actions={tabs}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {tab === 'issues' && <IssuesList slug={slug} onCount={setIssueCount} />}
        {tab === 'tests' && <TestsTab slug={slug} phase={phase} />}
        {tab === 'report' && <MarkdownView source={reportMd} />}
      </div>
    </Panel>
  );
}

// ─── Agent inspector ──────────────────────────────────────────────

function AgentInspector({
  agent, onClose, onRefresh,
}: {
  agent: AgentDetail;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const done = agent.timeline.some((e) => e.kind === 'result');
  const lastResult = agent.timeline.findLast?.((e) => e.kind === 'result');

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Agent ${agent.runId}`}
      srOnlyTitle
      zIndex={50}
      overlayStyle={{ background: 'rgba(0,0,0,0.7)' }}
      contentStyle={{
        background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8,
        width: '90vw', height: '86vh', display: 'flex', flexDirection: 'column',
      }}
    >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--fg)' }}>{agent.runId}</span>
          <span className={`h-pill ${done ? 'passed' : 'in_progress'}`}>
            <span className="h-pill-dot" />
            {done ? 'complete' : 'streaming'}
          </span>
          {agent.totalCostUsd > 0 && (
            <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
              ${agent.totalCostUsd.toFixed(4)}
              {agent.totalInputTokens ? <> · {agent.totalInputTokens.toLocaleString()}in / {agent.totalOutputTokens.toLocaleString()}out</> : null}
              {lastResult?.durationMs ? <> · {(lastResult.durationMs / 1000).toFixed(1)}s</> : null}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Tooltip label="Refresh the data shown in this panel">
              <button className="h-btn ghost" onClick={onRefresh}><RotateCcw size={12} /> refresh</button>
            </Tooltip>
            <Tooltip label="Close this panel">
              <button className="h-btn ghost" onClick={onClose}>close</button>
            </Tooltip>
          </div>
        </div>
        {agent.timeline.length === 0 && (
          <div className="h-empty"><Loader2 size={18} className="h-empty-icon" style={{ animation: 'spin 1s linear infinite' }} /><span>Waiting for first event…</span></div>
        )}
        <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
          {agent.timeline.map((e, i) => <TimelineBlock key={i} entry={e} />)}
        </div>
        {agent.stderr && agent.stderr.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', padding: 10, maxHeight: '18vh', overflow: 'auto' }}>
            <div style={{ fontSize: 11, color: 'var(--bad)', fontWeight: 600, marginBottom: 4 }}>stderr ({agent.stderr.length} chars)</div>
            <pre style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace', color: 'color-mix(in oklab, var(--bad), white 30%)', whiteSpace: 'pre-wrap', margin: 0 }}>{agent.stderr}</pre>
          </div>
        )}
    </Modal>
  );
}

function TimelineBlock({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'text') {
    return <div className="h-tl-block text">{entry.text}</div>;
  }
  if (entry.kind === 'tool_use') {
    return (
      <div className="h-tl-block tool">
        <div className="h-tl-tag"><Wrench size={10} /> {entry.toolName}</div>
        <JsonTree data={entry.toolInput} />
      </div>
    );
  }
  if (entry.kind === 'tool_result') {
    const text = entry.text ?? '';
    // Heuristic: if it looks like JSON, tree-view it; otherwise show as text
    const trimmed = text.trim();
    const isJson = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
    return (
      <div className="h-tl-block result">
        <div className="h-tl-tag"><ArrowRight size={10} /> tool result</div>
        {isJson ? <JsonTree data={trimmed} /> : (
          <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--fg)' }}>{text.slice(0, 4000)}{text.length > 4000 ? '…' : ''}</div>
        )}
      </div>
    );
  }
  if (entry.kind === 'result') {
    return (
      <div className="h-tl-block result">
        <div className="h-tl-tag"><CheckCircle2 size={10} /> final result {entry.costUsd != null && <span style={{ color: 'var(--fg-dim)', fontWeight: 400 }}>· ${entry.costUsd.toFixed(4)}</span>}</div>
        <div>{entry.text}</div>
      </div>
    );
  }
  if (entry.kind === 'status') {
    return <div className="h-tl-block status">· {entry.text}</div>;
  }
  if (entry.kind === 'error') {
    return (
      <div className="h-tl-block error">
        <div className="h-tl-tag"><AlertTriangle size={10} /> error</div>
        <div>{entry.text}</div>
      </div>
    );
  }
  return null;
}
