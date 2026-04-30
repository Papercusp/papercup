'use client';

import './harness.css';
import * as Tabs from '@radix-ui/react-tabs';
import * as RSelect from '@radix-ui/react-select';
import * as RTooltip from '@radix-ui/react-tooltip';
import { Check as LCheck, ChevronDown as LChevronDown } from 'lucide-react';
import { Modal } from './Modal';
import { Tooltip } from './Tooltip';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@rocicorp/zero/react';
import {
  queries,
  slugToFeaturesKey,
  slugToAgentRunsKey,
  type FeatureRow,
  type AgentRunRow,
} from '@restart/zero-harness';
import { RichGrid, type ColumnDef } from '@restart/grid-core';
import { useParams, useSearchParams } from 'next/navigation';
import { useQueryState, parseAsBoolean, parseAsString, parseAsStringEnum } from 'nuqs';
import dynamic from 'next/dynamic';
import { Toaster, toast } from 'sonner';
import { Group as PanelGroup, Panel as RPanel, Separator } from 'react-resizable-panels';
import {
  Activity, Play, Square, SlidersHorizontal, RotateCcw,
  Coins, TrendingUp, CheckCircle2, AlertTriangle, Loader2, Wrench, ArrowRight,
  Code2, BookOpen, LayoutDashboard, Lightbulb, FileText,
  // Icons available to plugin manifests via dashboardTabs[].icon
  Terminal, Code, Plus, Puzzle, Database, Cloud, MessageSquare,
  Zap, Bell, Calendar, Folder, FolderOpen, Globe, GitBranch, Inbox,
  Layers, Mail, Search, Settings, Send, Server, Shield, Star, Tag,
  Image as ImageIcon, Music, Video, Box, Download, Upload, Link as LinkIcon,
  CheckSquare, ListChecks, BarChart, PieChart, LineChart,
} from 'lucide-react';

// Plugin manifests reference icons by string name (e.g. "BookOpen", "Code").
// Resolve to a lucide component, with Puzzle as the catch-all fallback so
// plugins always render *something* even if they pick an unsupported name.
const PLUGIN_ICON_MAP: Record<string, React.ComponentType<{ size?: number | string }>> = {
  Activity, ArrowRight, AlertTriangle, BarChart, Bell, BookOpen, Box, Calendar,
  CheckCircle2, CheckSquare, Cloud, Code, Code2, Coins, Database, Download,
  FileText, Folder, FolderOpen, GitBranch, Globe, Image: ImageIcon, Inbox,
  Layers, LayoutDashboard, Lightbulb, LineChart, Link: LinkIcon, ListChecks,
  Loader2, Mail, MessageSquare, Music, PieChart, Play, Plus, Puzzle, RotateCcw,
  Search, Send, Server, Settings, Shield, Slack: MessageSquare, SlidersHorizontal, Square,
  Star, Tag, Terminal, TrendingUp, Upload, Video, Wrench, Zap,
};
function PluginIcon({ name, size = 13 }: { name?: string | null; size?: number }) {
  const Icon = (name && PLUGIN_ICON_MAP[name]) ?? Puzzle;
  return <Icon size={size} />;
}

const CODE_SERVER_PORT = 8082;
const DOCS_VIEWER_URL = 'http://127.0.0.1:4325';

function vscodeUrl(projectPath: string): string {
  if (typeof window === 'undefined') return '#';
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${CODE_SERVER_PORT}/?folder=${encodeURIComponent(projectPath)}`;
}

function docsUrl(slug: string): string {
  return `${DOCS_VIEWER_URL}/projects/${slug}/`;
}

const VSCODE_WINDOW_NAME = 'harness-vscode';

function openInVSCode(projectPath: string) {
  const url = vscodeUrl(projectPath);
  if (url === '#') return;
  window.open(url, VSCODE_WINDOW_NAME);
}

type MainPanel = 'brainstorm' | 'proposals' | 'git' | 'dashboard' | 'summary' | 'docs' | 'vscode' | 'pi' | 'insights' | 'config' | `plugin:${string}`;

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
import PluginReactTab from '../../lib/PluginReactTab';
import FeatureList from './FeatureList';
import FeaturePeekPanel from './FeaturePeekPanel';
import PulseFeed, { usePulse } from './PulseFeed';
import InsightsPanel from './InsightsPanel';
import TriageQueue from './TriageQueue';
import ArchitectInbox from './ArchitectInbox';
import PiTerminalsDock from './PiTerminalsDock';
import PhaseTabs, { type Phase } from './PhaseTabs';
import TestsTab from './TestsTab';
import ProposalsPanel from './ProposalsPanel';

/**
 * Wrap a `dynamic()` import with retry + visible loading state so that a
 * one-off chunk fetch failure (services flapping, dev rebuild, network
 * blip) doesn't leave the panel area silently empty. Without this,
 * `dynamic(() => import(x))` swallows the import error and renders
 * nothing — there's no signal that anything went wrong, and the user
 * has to refresh the page to recover.
 */
function dynamicWithRetry<T>(
  loader: () => Promise<T>,
  label: string,
  pickComponent?: (mod: T) => React.ComponentType<any>,
) {
  const importer = async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Race the import against an 8s timeout — if the chunk fetches but the
        // module's top-level evaluation hangs (e.g. an internal dep is stalled),
        // we want to fall through to retry/fallback instead of spinning forever.
        const mod = await Promise.race([
          loader(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('import timeout')), 8000)),
        ]) as T;
        return pickComponent ? pickComponent(mod) : (mod as any);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    // Give up — render a compact failure chip so optional panels don't blow up
    // the dashboard layout while still giving the operator an escape hatch.
    const Fallback = () => (
      <div className="h-dynamic-fallback" role="status">
        <span>Could not load <strong>{label}</strong>.</span>
        <span className="h-dynamic-fallback-detail">
          {String((lastErr as any)?.message ?? lastErr).slice(0, 120)}
        </span>
        <Tooltip label="Reload the page">
          <button type="button" onClick={() => location.reload()}>reload</button>
        </Tooltip>
      </div>
    );
    return Fallback as any;
  };
  return dynamic(importer, {
    ssr: false,
    loading: () => (
      <div className="h-dynamic-loading" role="status">
        loading <em>{label}</em>…
      </div>
    ),
  });
}

const SpecEditor = dynamicWithRetry(() => import('./SpecEditor'), 'SpecEditor');
const ManifestSpecEditor = dynamicWithRetry(() => import('./ManifestSpecEditor'), 'ManifestSpecEditor');
const EscalationBanner = dynamicWithRetry(() => import('./EscalationBanner'), 'EscalationBanner');
const CheckpointBanner = dynamicWithRetry(() => import('./CheckpointBanner'), 'CheckpointBanner');
const GitGraphPanelLib = dynamicWithRetry(
  () => import('@restart/git-graph').then((m) => ({ default: m.GitGraphPanel })),
  'GitGraphPanel',
);
function GitGraphPanel({ slug }: { slug: string }) {
  return (
    <GitGraphPanelLib
      scope={`harness:${slug}`}
      gitLogUrl={(limit: number) => `/api/harness/${slug}/git/log?limit=${limit}`}
      showCommitUrl={(sha: string) => `/api/harness/${slug}/git/show/${sha}`}
    />
  );
}
const BrainstormFull = dynamicWithRetry(() => import('./brainstorm/BrainstormFull'), 'Brainstorm', (m: any) => m.BrainstormFull);
const HooksPanel = dynamicWithRetry(() => import('./HooksPanel'), 'HooksPanel');
const FeatureEditor = dynamicWithRetry(() => import('./FeatureEditor'), 'FeatureEditor');
const InterventionPanel = dynamicWithRetry(() => import('./InterventionPanel'), 'InterventionPanel');
const UsagePanel = dynamicWithRetry(() => import('./UsagePanel'), 'UsagePanel');
const SnapshotsPanel = dynamicWithRetry(() => import('./SnapshotsPanel'), 'SnapshotsPanel');
const ScreenshotsPanel = dynamicWithRetry(() => import('./ScreenshotsPanel'), 'ScreenshotsPanel');
const TemplatesModal = dynamicWithRetry(() => import('./TemplatesModal'), 'TemplatesModal');
const FeatureDiffModal = dynamicWithRetry(() => import('./FeatureDiffModal'), 'FeatureDiffModal');
const ArchivesPanel = dynamicWithRetry(() => import('./ArchivesPanel'), 'ArchivesPanel');
const DecisionsPanel = dynamicWithRetry(() => import('./DecisionsPanel'), 'DecisionsPanel');
const HealthBadge = dynamicWithRetry(() => import('./HealthBadge'), 'HealthBadge');
const SmokeTestPanel = dynamicWithRetry(() => import('./SmokeTestPanel'), 'SmokeTestPanel');
const IdentityPanel = dynamic(() => import('./IdentityPanel'), { ssr: false });
const PlanReviewBanner = dynamic(() => import('./PlanReviewBanner'), { ssr: false });
const SummaryPanel = dynamic(() => import('./SummaryPanel'), { ssr: false });

// ─── Types ─────────────────────────────────────────────────────────────

type FeatureStatus = 'todo' | 'in_progress' | 'validating' | 'failing' | 'passed' | 'blocked';

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
const FOCUS_ORDER: FeatureStatus[] = ['failing', 'blocked', 'in_progress', 'validating', 'todo', 'passed'];
const STATUS_LABELS: Record<FeatureStatus, string> = {
  todo: 'todo',
  in_progress: 'running',
  validating: 'validating',
  failing: 'failing',
  passed: 'passed',
  blocked: 'blocked',
};

function focusVerb(status: FeatureStatus): string {
  switch (status) {
    case 'failing': return 'Needs recovery';
    case 'blocked': return 'Needs decision';
    case 'in_progress': return 'Watch current run';
    case 'validating': return 'Await validation';
    case 'todo': return 'Next up';
    case 'passed': return 'Recently passed';
    default: return 'Focus';
  }
}

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
 * Plugin tab trigger with a settings popover. Click the ⓘ adornment to see
 * version + a link to the marketplace-ops audit page. The popover closes on
 * Escape or click-outside.
 */
function PluginTabTrigger({ pluginSlug, pluginVersion, tabId, label, icon, activeSlug, onDisabled }: {
  pluginSlug: string;
  pluginVersion: string;
  tabId: string;
  label: string;
  icon: string | null;
  activeSlug: string | null;
  onDisabled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function disable() {
    if (!activeSlug) return;
    if (!confirm(`Disable ${pluginSlug} in ${activeSlug}?\n\nThe plugin's config will be preserved.`)) return;
    setBusy(true);
    try {
      const r = await fetch('/api/plugins/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: pluginSlug, harnesses: [activeSlug], disable: true }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error('Disable failed', { description: d.results?.[0]?.log?.slice(-300) ?? d.error });
        return;
      }
      toast.success(`${pluginSlug} disabled in ${activeSlug}`);
      setOpen(false);
      onDisabled();
    } catch (e: any) {
      toast.error(`Disable failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-plugin-popover]')) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [open]);
  return (
    <div data-plugin-popover style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <Tooltip label={`${label} — from ${pluginSlug}@${pluginVersion}`}>
        <Tabs.Trigger value={`plugin:${tabId}`} className="h-tab" disabled={!activeSlug}>
          <PluginIcon name={icon} /> {label}
        </Tabs.Trigger>
      </Tooltip>
      <Tooltip label="Plugin info">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(!open); }}
          style={{
            marginLeft: -4, padding: '0 4px', background: 'transparent',
            border: 'none', color: 'var(--text-3)', cursor: 'pointer',
            fontSize: 11, lineHeight: 1,
          }}
        >ⓘ</button>
      </Tooltip>
      {open ? (
        <div
          data-plugin-popover
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4,
            zIndex: 100, minWidth: 240,
            background: 'var(--bg-1)', color: 'var(--text-1)',
            border: '1px solid var(--border-1)', borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
            padding: 12, fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4, fontFamily: "'SF Mono', monospace", wordBreak: 'break-all' }}>
            {pluginSlug}
          </div>
          <div style={{ color: 'var(--text-2)', marginBottom: 8 }}>
            v{pluginVersion} · contributes &ldquo;{label}&rdquo; tab
          </div>
          <a
            href={`http://localhost:3001/papercusp-marketplace-ops/plugins/${encodeURIComponent(pluginSlug)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'block', color: 'var(--accent-1, #0ea5e9)', fontSize: 11, marginBottom: 4, textDecoration: 'none' }}
            onClick={() => setOpen(false)}
          >
            View audit log on Marketplace Ops →
          </a>
          <a
            href={`http://localhost:3001/papercusp-marketplace-ops/explore/${encodeURIComponent(pluginSlug)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'block', color: 'var(--accent-1, #0ea5e9)', fontSize: 11, textDecoration: 'none', marginBottom: 8 }}
            onClick={() => setOpen(false)}
          >
            View README + signature →
          </a>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <Tooltip label="Disable this plugin in the active harness (config preserved)">
              <button
              type="button"
              onClick={disable}
              disabled={busy || !activeSlug}
              style={{
                width: '100%', padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                background: 'transparent', color: '#fca5a5',
                border: '1px solid var(--border)', borderRadius: 4,
              }}
            >
              {busy ? 'Disabling…' : `Disable in ${activeSlug ?? '…'}`}
            </button>
            </Tooltip>
          </div>
        </div>
      ) : null}
    </div>
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
    <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <iframe
        src={url}
        title={title}
        onLoad={() => setLoaded(true)}
        style={{ flex: 1, border: 'none', width: '100%', height: '100%', background: 'var(--bg-2)' }}
      />
      {!loaded ? (
        <div
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 12,
            background: 'var(--bg-2)',
            color: 'var(--text-2)',
            fontSize: 13,
            transition: 'opacity 200ms',
            pointerEvents: 'none',
          }}
        >
          <div
            aria-hidden
            style={{
              width: 28, height: 28, borderRadius: '50%',
              border: '2px solid var(--border-1)', borderTopColor: 'var(--accent-1, #0ea5e9)',
              animation: 'papercusp-spin 0.8s linear infinite',
            }}
          />
          <div>{title} — loading…</div>
          {showHint ? (
            <div style={{ fontSize: 11, color: 'var(--text-3)', maxWidth: 360, textAlign: 'center' }}>
              Still loading? The plugin service may not be running. Try opening{' '}
              <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-1, #0ea5e9)', textDecoration: 'underline', pointerEvents: 'auto' }}>
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
function pluginSlugFromPath(path: string | null | undefined, fallbackName: string): string {
  if (!path) return fallbackName;
  const parts = path.replace(/\/$/, '').split('/');
  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  if (parent && parent.startsWith('@')) return `${parent}/${last}`;
  return last ?? fallbackName;
}

interface InstalledPluginInfo {
  name: string;
  version?: string;
  description?: string;
  source?: string;
  icon?: string;
  /** Absolute on-disk path; basename is the dir slug the CLI keys
   *  enable/disable by (independent of scoped manifest.name). */
  path?: string;
  dashboardTabs?: Array<{ id?: string; label?: string; icon?: string }>;
}

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
      {open && coords ? (
        <div
          data-add-plugin-popover
          style={{
            position: 'fixed', top: coords.top, right: coords.right,
            zIndex: 1000, minWidth: 320, maxWidth: 400,
            background: 'var(--bg-1)', color: 'var(--text-1)',
            border: '1px solid var(--border)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            padding: 8,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '4px 8px 8px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
            Add to <code style={{ fontSize: 11 }}>{activeSlug}</code>
          </div>
          {error ? (
            <div style={{ padding: '12px 8px', fontSize: 12, color: 'var(--text-3)' }}>
              <div style={{ color: '#fca5a5', marginBottom: 6 }}>Couldn't load plugins.</div>
              <div style={{ marginBottom: 8, fontSize: 11 }}>{error}</div>
              <Tooltip label="Retry plugin discovery">
                <button
                type="button"
                onClick={onRetry}
                style={{
                  padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                  background: 'var(--bg-2)', border: '1px solid var(--border)',
                  color: 'var(--text-1)', borderRadius: 4,
                }}
              >Retry</button>
              </Tooltip>
            </div>
          ) : installed === null ? (
            <div style={{ padding: '12px 8px', fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>
          ) : candidates.length === 0 ? (
            <div style={{ padding: '12px 8px', fontSize: 12, color: 'var(--text-3)' }}>
              {(installed?.length ?? 0) === 0
                ? <>No plugins installed. <a href="/marketplace/plugins" style={{ color: 'var(--accent)' }}>Browse plugins →</a></>
                : <>All installed plugins are already enabled here. <a href="/marketplace/plugins" style={{ color: 'var(--accent)' }}>Browse marketplace →</a></>}
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 320, overflowY: 'auto' }}>
              {candidates.map((p) => {
                const tabIcon = p.dashboardTabs?.[0]?.icon ?? p.icon ?? null;
                return (
                  <li key={p.name}>
                    <Tooltip label="Enable this plugin in the active harness">
                      <button
                      type="button"
                      onClick={() => enable(p)}
                      disabled={busy !== null}
                      style={{
                        width: '100%', textAlign: 'left', padding: '8px 10px',
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--text-1)', fontSize: 12, borderRadius: 4,
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
                        <div style={{ fontWeight: 500 }}>{p.name}{p.version ? <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> @{p.version}</span> : null}</div>
                        {p.description && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.4 }}>{p.description}</div>}
                      </span>
                    </button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface EnabledPluginManifest extends InstalledPluginInfo {
  capabilities?: string[];
  actions?: Array<{ id?: string; name?: string; label?: string; description?: string; params?: Record<string, unknown> }>;
  routines?: Array<{ name?: string; trigger?: string }>;
  configSchema?: { properties?: Record<string, { default?: unknown; description?: string }> };
}

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
    return <SpecEditor inline slug={slug} projectPath={projectPath} alive={alive} onClose={onClose} />;
  }
  if (configFiles && configFiles.length > 0) {
    return <ManifestSpecEditor inline slug={slug} projectPath={projectPath} alive={alive} onClose={onClose} configFiles={configFiles} />;
  }
  return <SpecEditor inline slug={slug} projectPath={projectPath} alive={alive} onClose={onClose} />;
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
        action: { label: 'Open Snapshots', onClick: () => { window.location.href = '/snapshots'; } },
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
    width: '100%', padding: '6px 8px', background: 'var(--bg-mute)',
    border: '1px solid var(--border)', borderRadius: 4, color: 'var(--fg)', fontSize: 13,
  };
  const checkRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6 };

  return (
    <>
      <Tooltip label="Save current harness state as a tarball">
        <button type="button" className="h-btn ghost" onClick={() => setOpen(true)} disabled={busy}>
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
          <input type="checkbox" checked={includeOperatorNotes} onChange={(e) => setIncludeOperatorNotes(e.target.checked)} />
          Operator notes
        </label>
        <label style={checkRow}>
          <input type="checkbox" checked={includeAgentTranscripts} onChange={(e) => setIncludeAgentTranscripts(e.target.checked)} />
          Agent transcripts
        </label>
        <label style={checkRow}>
          <input type="checkbox" checked={includeGit} onChange={(e) => setIncludeGit(e.target.checked)} />
          .git directory <span style={{ color: 'var(--fg-mute)' }}>(large)</span>
        </label>
        <label style={checkRow}>
          <input type="checkbox" checked={acceptVerifiedSecrets} onChange={(e) => setAcceptVerifiedSecrets(e.target.checked)} />
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
function PluginToolbarActions({ harnessSlug, installed, enabledSlugs }: {
  harnessSlug: string;
  installed: InstalledPluginInfo[];
  enabledSlugs: string[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // Build the toolbar action list: every action of every enabled plugin
  // whose `surfaces` includes 'harness-toolbar'.
  const enabledSet = new Set(enabledSlugs);
  const toolbarActions: Array<{ pluginName: string; pluginDirSlug: string; pluginIcon: string | null;
    name: string; label: string; }> = [];
  for (const p of installed) {
    const dirSlug = pluginSlugFromPath(p.path, p.name);
    if (!(enabledSet.has(p.name) || enabledSet.has(dirSlug))) continue;
    const actions = (p as { actions?: Array<{ name?: string; label?: string; surfaces?: string[] }> }).actions ?? [];
    for (const a of actions) {
      if (!a.name) continue;
      if (!Array.isArray(a.surfaces) || !a.surfaces.includes('harness-toolbar')) continue;
      toolbarActions.push({
        pluginName: p.name,
        pluginDirSlug: dirSlug,
        pluginIcon: p.icon ?? null,
        name: a.name,
        label: a.label ?? a.name,
      });
    }
  }
  if (toolbarActions.length === 0) return null;

  async function invoke(action: typeof toolbarActions[number]) {
    setBusy(action.pluginDirSlug + '/' + action.name);
    try {
      const r = await fetch('/api/plugins/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: action.pluginDirSlug, action: action.name, harness: harnessSlug }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`${action.label} failed`, { description: d.error ?? d.log?.slice(-300) });
        return;
      }
      toast.success(`${action.label} fired`, { description: typeof d.result === 'string' ? d.result.slice(0, 200) : 'Check action history.' });
    } catch (e: any) {
      toast.error(`${action.label} failed: ${e?.message ?? e}`);
    } finally { setBusy(null); }
  }

  return (
    <>
      {toolbarActions.map((a) => {
        const key = a.pluginDirSlug + '/' + a.name;
        return (
          <Tooltip key={key} label={`${a.label} — from ${a.pluginName}`}>
            <button
              type="button"
              className="h-btn ghost"
              onClick={() => invoke(a)}
              disabled={busy === key}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <PluginIcon name={a.pluginIcon} size={13} />
              {busy === key ? '…' : a.label}
            </button>
          </Tooltip>
        );
      })}
    </>
  );
}

/**
 * Config tab body. Sub-nav between "Spec" (SPEC.md / AGENTS.md / config.json
 * editor) and "Plugins" (per-harness plugin list with actions, events,
 * required capabilities, and disable/invoke controls). Replaces the older
 * plain-SpecEditor body so action-only plugins have a visible home.
 */
function ConfigPanel({
  harnessSlug, projectPath, alive, onClose,
  installedPlugins, enabledSlugs, pluginCount, onPluginsChange,
}: {
  harnessSlug: string;
  projectPath: string;
  alive: boolean;
  onClose: () => void;
  installedPlugins: InstalledPluginInfo[];
  enabledSlugs: string[];
  pluginCount: number;
  onPluginsChange: () => void;
}) {
  type SubPane = 'spec' | 'plugins';
  const [pane, setPane] = useState<SubPane>('spec');
  const TabBtn = ({ id, label, count }: { id: SubPane; label: string; count?: number }) => (
    <button
      type="button"
      onClick={() => setPane(id)}
      className="h-tab"
      aria-pressed={pane === id}
      style={{
        background: pane === id ? 'var(--bg-1)' : 'transparent',
        border: '1px solid',
        borderColor: pane === id ? 'var(--border)' : 'transparent',
        color: pane === id ? 'var(--text-1)' : 'var(--text-3)',
        padding: '4px 12px',
        fontSize: 13,
        cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        borderRadius: 6,
      }}
    >
      {id === 'spec' ? <SlidersHorizontal size={13} /> : <Puzzle size={13} />}
      {label}
      {typeof count === 'number' && count > 0 && (
        <span className="h-tab-count" style={{ marginLeft: 4 }}>{count}</span>
      )}
    </button>
  );
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 20px',
        borderBottom: '1px solid var(--border)',
      }}>
        <TabBtn id="spec" label="Spec" />
        <TabBtn id="plugins" label="Plugins" count={pluginCount} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex' }}>
        {pane === 'spec' ? (
          <ManifestOrLegacySpecEditor
            slug={harnessSlug}
            projectPath={projectPath}
            alive={alive}
            onClose={onClose}
          />
        ) : (
          <PluginsPanel
            harnessSlug={harnessSlug}
            installed={installedPlugins}
            enabledSlugs={enabledSlugs}
            onChange={onPluginsChange}
          />
        )}
      </div>
    </div>
  );
}

function PluginsPanel({ harnessSlug, installed, enabledSlugs, onChange }: {
  harnessSlug: string;
  installed: InstalledPluginInfo[];
  enabledSlugs: string[];
  onChange: () => void;
}) {
  const enabledManifests = useMemo(() => {
    const out: EnabledPluginManifest[] = [];
    for (const slug of enabledSlugs) {
      const m = installed.find((p) => {
        const dirSlug = p.path ? pluginSlugFromPath(p.path, p.name) : null;
        return p.name === slug || dirSlug === slug;
      });
      if (m) out.push(m as EnabledPluginManifest);
    }
    return out;
  }, [installed, enabledSlugs]);

  return (
    <div style={{ flex: 1, padding: '20px 28px', overflowY: 'auto', color: 'var(--text-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <Puzzle size={20} />
        <h2 style={{ margin: 0, fontSize: 22 }}>Plugins enabled in {harnessSlug}</h2>
      </div>
      <p style={{ color: 'var(--text-3)', marginTop: 0, marginBottom: 24, fontSize: 13 }}>
        Every plugin currently active in this harness. Use the <code style={inlineCode}>+ plugin</code> button
        in the tab strip to enable more.
      </p>

      {enabledManifests.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-3)' }}>
          <p style={{ margin: 0, fontSize: 14 }}>No plugins enabled in this harness yet.</p>
          <p style={{ margin: '8px 0 0', fontSize: 12 }}>
            Click the <code style={inlineCode}>+ plugin</code> button in the tab strip to add one,
            or browse <a href="/marketplace/plugins" style={{ color: 'var(--accent)' }}>the marketplace</a>.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {enabledManifests.map((p) => (
            <PluginPanelCard
              key={p.name}
              plugin={p}
              harnessSlug={harnessSlug}
              onChange={onChange}
            />
          ))}
        </div>
      )}
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
  const configPath = `~/.papercusp/harnesses/${harnessSlug}/plugin-configs/${dirSlug}.json`;
  const secretCaps = (plugin.capabilities ?? []).filter((c) => c.startsWith('secrets:read:'));
  const eventListens = (plugin.capabilities ?? []).filter((c) => c.startsWith('events:listen:'));
  const httpFetches = (plugin.capabilities ?? []).filter((c) => c.startsWith('http:fetch:'));

  async function disable() {
    if (!confirm(`Disable ${plugin.name} in ${harnessSlug}?\n\nThe plugin's config will be preserved.`)) return;
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
    <div className="pc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <span style={{
          flex: '0 0 auto', width: 40, height: 40, borderRadius: 8,
          background: 'rgba(99, 102, 241, 0.15)', color: '#a5b4fc',
          border: '1px solid rgba(99, 102, 241, 0.3)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <PluginIcon name={tabIcon} size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>{plugin.name}</h3>
            <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: "'SF Mono', monospace" }}>
              v{plugin.version}
            </span>
            {(plugin.dashboardTabs?.length ?? 0) === 0 && (
              <span style={{
                fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
                padding: '2px 6px', borderRadius: 4,
                background: 'rgba(99, 102, 241, 0.15)', color: '#a5b4fc',
              }}>action-only</span>
            )}
          </div>
          {plugin.description && (
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
              {plugin.description}
            </p>
          )}
        </div>
        <Tooltip label="Disable this plugin (config preserved)">
          <button
          onClick={disable}
          disabled={busy}
          className="pc-button"
          style={{ background: 'transparent', color: '#fca5a5', border: '1px solid var(--border)', flex: '0 0 auto' }}
        >
          {busy ? 'Disabling…' : 'Disable'}
        </button>
        </Tooltip>
      </div>

      {(plugin.actions?.length ?? 0) > 0 && (
        <div>
          <div style={sectionLabel}>Actions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {plugin.actions!.map((a) => {
              const id = a.id ?? a.name ?? '?';
              return (
                <div key={id} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '8px 12px', background: 'var(--bg-1)', borderRadius: 6,
                  border: '1px solid var(--border)',
                }}>
                  <code style={{ fontSize: 12, fontFamily: "'SF Mono', monospace", flex: '0 0 auto' }}>{id}</code>
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text-3)' }}>
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
        <div>
          <div style={sectionLabel}>Listens to events</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {eventListens.map((c) => (
              <span key={c} style={tagStyle}>{c.replace('events:listen:', '')}</span>
            ))}
          </div>
        </div>
      )}

      {(secretCaps.length > 0 || httpFetches.length > 0) && (
        <div>
          <div style={sectionLabel}>Required capabilities</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {secretCaps.map((c) => {
              const key = c.replace('secrets:read:', '');
              return <span key={c} style={{ ...tagStyle, color: '#fbbf24', borderColor: 'rgba(251, 191, 36, 0.3)', background: 'rgba(251, 191, 36, 0.1)' }} title={`Set this with: papercusp secrets set ${key} <value>`}>secret: {key}</span>;
            })}
            {httpFetches.map((c) => (
              <span key={c} style={tagStyle}>http: {c.replace('http:fetch:', '')}</span>
            ))}
          </div>
          {secretCaps.length > 0 && (
            <p style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>
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

function PluginConfigEditor({ harnessSlug, dirSlug, configPath, configSchema, defaultConfig }: {
  harnessSlug: string;
  dirSlug: string;
  configPath: string;
  configSchema?: { properties?: Record<string, { default?: unknown; description?: string }> };
  defaultConfig?: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!open || loaded !== null) return;
    fetch(`/api/plugins/config?harness=${encodeURIComponent(harnessSlug)}&plugin=${encodeURIComponent(dirSlug)}`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => {
        const cfg = d?.config ?? {};
        setLoaded(cfg);
        setDraft(JSON.stringify(cfg, null, 2));
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, [open, loaded, harnessSlug, dirSlug]);

  function reset() {
    if (loaded) setDraft(JSON.stringify(loaded, null, 2));
    setError(null);
  }
  function loadDefaults() {
    const obj: Record<string, unknown> = { ...(defaultConfig ?? {}) };
    if (configSchema?.properties) {
      for (const [k, v] of Object.entries(configSchema.properties)) {
        if (!(k in obj) && v.default !== undefined) obj[k] = v.default;
      }
    }
    setDraft(JSON.stringify(obj, null, 2));
    setError(null);
  }

  async function save() {
    let parsed: unknown;
    try { parsed = JSON.parse(draft); } catch (e: any) {
      setError(`Invalid JSON: ${e?.message ?? e}`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('Config must be a JSON object.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const r = await fetch('/api/plugins/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harness: harnessSlug, plugin: dirSlug, config: parsed }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setLoaded(parsed as Record<string, unknown>);
      setSavedAt(Date.now());
      toast.success(`Config saved for ${dirSlug}`);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally { setSaving(false); }
  }

  const dirty = loaded !== null && draft !== JSON.stringify(loaded, null, 2);
  const schemaKeys = Object.keys(configSchema?.properties ?? {});

  return (
    <div style={{
      marginTop: 4, padding: '8px 12px', background: 'var(--bg-1)', borderRadius: 6,
      border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          <span style={{ fontWeight: 600, color: 'var(--text-2)', marginRight: 8 }}>Config</span>
          <code style={{ fontFamily: "'SF Mono', monospace", fontSize: 11 }}>{configPath}</code>
          {schemaKeys.length > 0 && (
            <span style={{ marginLeft: 12, color: 'var(--text-3)' }}>
              keys: {schemaKeys.map((k) => <code key={k} style={{ ...inlineCode, fontSize: 10, marginLeft: 4 }}>{k}</code>)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={open ? 'Close the plugin config editor' : 'Open the plugin config editor'}
          style={{
            fontSize: 11, padding: '2px 10px', cursor: 'pointer',
            background: 'transparent', color: 'var(--text-2)',
            border: '1px solid var(--border)', borderRadius: 4,
          }}
        >{open ? 'Close editor' : 'Edit config'}</button>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {error && (
            <div style={{
              marginBottom: 8, padding: '6px 10px',
              background: '#450a0a', color: '#fca5a5',
              border: '1px solid #7f1d1d', borderRadius: 4,
              fontSize: 11,
            }}>{error}</div>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={Math.min(20, Math.max(6, draft.split('\n').length + 1))}
            style={{
              width: '100%', boxSizing: 'border-box',
              fontFamily: "'SF Mono', monospace", fontSize: 12,
              padding: 10, borderRadius: 4,
              background: 'var(--bg-2)', color: 'var(--text-1)',
              border: '1px solid var(--border)',
              resize: 'vertical',
            }}
            placeholder='{ "key": "value" }'
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Tooltip label="Save plugin config changes">
              <button
              type="button"
              onClick={save}
              disabled={saving || !dirty}
              className="pc-button"
              style={{ fontSize: 12, padding: '4px 12px' }}
            >{saving ? 'Saving…' : dirty ? 'Save' : 'No changes'}</button>
            </Tooltip>
            <Tooltip label="Discard unsaved config changes">
              <button
              type="button"
              onClick={reset}
              disabled={saving || !dirty}
              style={{
                fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                background: 'transparent', color: 'var(--text-3)',
                border: '1px solid var(--border)', borderRadius: 4,
              }}
            >Reset</button>
            </Tooltip>
            <Tooltip label="Replace draft with the plugin's defaultConfig + configSchema defaults">
              <button
              type="button"
              onClick={loadDefaults}
              disabled={saving}
              style={{
                fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                background: 'transparent', color: 'var(--text-3)',
                border: '1px solid var(--border)', borderRadius: 4,
              }}
            >Load defaults</button>
            </Tooltip>
            {savedAt && !dirty && (
              <span style={{ fontSize: 10, color: '#86efac' }}>
                ✓ saved {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)' }}>
              CLI:{' '}
              <code style={inlineCode}>papercusp plugin config {dirSlug} --harness {harnessSlug}</code>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--text-3)', marginBottom: 8,
};
const tagStyle: React.CSSProperties = {
  fontSize: 11, fontFamily: "'SF Mono', monospace",
  padding: '2px 8px', borderRadius: 4,
  background: 'var(--bg-1)', border: '1px solid var(--border)',
  color: 'var(--text-2)',
};

export default function HarnessDashboard() {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

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
  const [enabledByHarness, setEnabledByHarness] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30000);
    fetch('/api/plugins/enabled', { cache: 'no-store', signal: ac.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => setEnabledByHarness(d?.enabled ?? {}))
      .catch(() => { /* best-effort; popover still works without this */ })
      .finally(() => clearTimeout(t));
    return () => { clearTimeout(t); ac.abort(); };
  }, [installedPluginsRefreshKey]);
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
          }));
        setPluginTabs(tabs);
      } catch {
        // best-effort — fall back to legacy tabs
      }
    })();
    return () => { cancelled = true; };
  }, [activeSlug, pluginRefreshKey]);
  // Pattern 1 — built-in tab ids hidden when a plugin tab declares
  // `replaces: ['<id>']`. Per-tab opt-in (replaces the previous coarse
  // PAPERCUSP_TABS_FROM_PLUGINS env flag).
  const replacedTabIds = useMemo(() => {
    const set = new Set<string>();
    for (const t of pluginTabs) for (const r of t.replaces) set.add(r);
    return set;
  }, [pluginTabs]);
  const legacyTabSuppressed = (id: 'docs' | 'vscode' | 'pi'): boolean =>
    replacedTabIds.has(id);
  const [status, setStatus] = useState<Status | null>(null);
  const [agents, setAgents] = useState<AgentRun[]>([]);
  const [issues, setIssues] = useState<string>('');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentDetail | null>(null);
  const agentPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [peekFeature, setPeekFeature] = useState<Feature | null>(null);
  // Left sidebar defaults to 'inbox'; user can flip to git graph via toggle.
  const [leftPane, setLeftPane] = useQueryState(
    'left',
    parseAsStringEnum<'inbox' | 'git'>(['inbox', 'git']).withDefault('inbox'),
  );
  const [activePhase, setActivePhase] = useQueryState(
    'phase',
    parseAsStringEnum<Phase>(['staging', 'testing', 'production']).withDefault('staging'),
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
  const [diffFeatureId, setDiffFeatureId] = useQueryState('diff', parseAsString);
  const [editingFeature, setEditingFeature] = useState<Feature | null | 'new'>(null);
  const [lanes, setLanes] = useState<{ lanes: Array<{ pid: number; featureId: string; startedAt: number; elapsedSeconds: number; alive: boolean }>; max: number } | null>(null);
  const [pendingProposals, setPendingProposals] = useState(0);
  const [activePanel, setActivePanel] = useQueryState('panel', parseAsString.withDefault('dashboard'));
  const [topChromeCollapsed, setTopChromeCollapsed] = useQueryState('chromeCollapsed', parseAsBoolean.withDefault(false));
  // When the user clicks "open in pi" on a feature, scope the pi pane to
  // that feature's worktree instead of the project root. Cleared when the
  // pane is opened from the bare 'pi' tab.
  const [piLaneId, setPiLaneId] = useState<string | null>(null);
  const [isCompact, setIsCompact] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const searchParams = useSearchParams();
  const projectQueryParam = searchParams?.get('project') ?? null;
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
    fetch('/api/harness/projects')
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
        const saved = window.localStorage.getItem('harness.activeProject');
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
    try { window.localStorage.setItem('harness.activeProject', activeSlug); } catch {}
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
    setLogLines([]);
    setSelectedAgent(null);
    preloadGitLog(activeSlug, 300);
    // Warm the dynamic GitGraphPanel chunk so the first left-pane click doesn't pay Turbopack compile cost.
    import('@restart/git-graph').catch(() => {});

    const loadAll = async () => {
      try {
        const q = `?phase=${activePhase}`;
        const [statusRes, agentsRes, issuesRes, logRes] = await Promise.all([
          fetch(`/api/harness/${activeSlug}/status${q}`).then((r) => r.json()),
          fetch(`/api/harness/${activeSlug}/agents${q}`).then((r) => r.json()),
          fetch(`/api/harness/${activeSlug}/issues${q}`).then((r) => r.json()),
          fetch(`/api/harness/${activeSlug}/logs/run${q}`).then((r) => r.json()),
        ]);
        if (statusRes.error) throw new Error(statusRes.error);
        setStatus(statusRes);
        setAgents(agentsRes.runs ?? []);
        setIssues(issuesRes.issues ?? '');
        setLogLines((logRes.log ?? '').split('\n').filter(Boolean));
      } catch (e) {
        toast.error(String(e));
      }
    };
    loadAll();

    const es = new EventSource(`/api/harness/${activeSlug}/stream?phase=${activePhase}`);
    esRef.current = es;

    es.addEventListener('log', (ev) => {
      const chunk = (ev as MessageEvent).data as string;
      setLogLines((prev) => {
        const next = [...prev, ...chunk.split('\n').filter(Boolean)];
        return next.length > 5000 ? next.slice(-5000) : next;
      });
    });

    es.addEventListener('features', (ev) => {
      try {
        const features = JSON.parse((ev as MessageEvent).data);
        setStatus((prev) => prev ? { ...prev, features } : prev);
      } catch {}
    });

    es.onerror = () => { /* auto-reconnect */ };

    return () => { es.close(); esRef.current = null; };
  }, [activeSlug, activePhase]);

  useEffect(() => {
    if (!activeSlug) return;
    const q = `?phase=${activePhase}`;
    const t = setInterval(() => {
      fetch(`/api/harness/${activeSlug}/status${q}`).then((r) => r.json()).then(setStatus).catch(() => {});
      fetch(`/api/harness/${activeSlug}/agents${q}`).then((r) => r.json()).then((d) => setAgents(d.runs ?? [])).catch(() => {});
      fetch(`/api/harness/${activeSlug}/reviews${q}`).then((r) => r.json()).then((d) => setReviewCount((d.reviews ?? []).length)).catch(() => {});
      fetch(`/api/harness/${activeSlug}/lanes${q}`).then((r) => r.json()).then(setLanes).catch(() => {});
      fetch(`/api/harness/${activeSlug}/proposals`).then((r) => r.json()).then((d) => {
        const pending = (d.proposals ?? []).filter((p: any) => p.status === 'pending').length;
        setPendingProposals(pending);
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [activeSlug, activePhase]);

  // ── Zero live feature subscription ─────────────────────────────────────
  // Subscribe to harness_<slug>.harness_features via the harness Zero
  // (zero-cache-harness :4849). Replaces /status's features field whenever
  // a row from Zero is available, so feature updates propagate live (~3s).
  // Falls back to polled features for unknown slugs.
  const slugKey = useMemo(
    () => (activeSlug ? slugToFeaturesKey(activeSlug) : null),
    [activeSlug],
  );
  const featuresQuery = useMemo(() => {
    if (!slugKey) return null;
    const ns = (queries as Record<string, unknown>)[slugKey] as
      | { all: () => unknown }
      | undefined;
    return ns?.all() ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugKey]);
  const [zeroFeatureRows, zeroFeatureInfo] = useQuery(
    (featuresQuery ?? (queries.featuresSheets.all() as unknown)) as never,
  );
  useEffect(() => {
    if (!featuresQuery) return;
    // Wait until Zero finishes its initial CVR (info.type === 'complete').
    // Before that, zeroFeatureRows is the optimistic-empty array — applying
    // it would clobber the polled features with [].
    const info = zeroFeatureInfo as { type?: string } | undefined;
    if (info?.type !== 'complete') return;
    if (!Array.isArray(zeroFeatureRows)) return;
    const adapted: Feature[] = (zeroFeatureRows as FeatureRow[]).map((zf) => ({
      id: zf.featureId,
      title: zf.title,
      summary: zf.summary ?? undefined,
      status: zf.status as FeatureStatus,
      attempts: Number(zf.attempts) || 0,
      claims: zf.claims ? safeParseClaims(zf.claims) : undefined,
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
  }, [featuresQuery, zeroFeatureRows, zeroFeatureInfo, activeSlug]);

  // ── Zero live agent_runs subscription ──────────────────────────────────
  // Replaces the polled /agents fetch. Polling still happens (in the EventSource
  // handler below) but only as a sync ping that triggers the API's FS scan +
  // PG dual-write — the data the UI displays comes from Zero.
  const agentRunsKey = useMemo(
    () => (activeSlug ? slugToAgentRunsKey(activeSlug) : null),
    [activeSlug],
  );
  const agentRunsQuery = useMemo(() => {
    if (!agentRunsKey) return null;
    const ns = (queries as Record<string, unknown>)[agentRunsKey] as
      | { all: () => unknown }
      | undefined;
    return ns?.all() ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentRunsKey]);
  const [zeroAgentRows, zeroAgentInfo] = useQuery(
    (agentRunsQuery ?? (queries.agentRunsSheets.all() as unknown)) as never,
  );
  useEffect(() => {
    if (!agentRunsQuery) return;
    const info = zeroAgentInfo as { type?: string } | undefined;
    if (info?.type !== 'complete') return;
    if (!Array.isArray(zeroAgentRows)) return;
    const adapted: AgentRun[] = (zeroAgentRows as AgentRunRow[])
      .slice(0, 200)
      .map((r) => ({
        runId: r.runId,
        role: r.role,
        ts: Number(r.ts) || 0,
        sizeBytes: Number(r.sizeBytes) || 0,
      }));
    setAgents(adapted);
  }, [agentRunsQuery, zeroAgentRows, zeroAgentInfo]);

  const loadAgent = useCallback(async (runId: string) => {
    const r = await fetch(`/api/harness/${activeSlug}/agents/${runId}?phase=${activePhase}`).then((r) => r.json());
    setSelectedAgent(r as AgentDetail);
  }, [activeSlug, activePhase]);


  useEffect(() => {
    if (agentPollRef.current) { clearInterval(agentPollRef.current); agentPollRef.current = null; }
    if (!selectedAgent || !activeSlug) return;
    const isLive = !selectedAgent.timeline?.some((e) => e.kind === 'result');
    if (!isLive) return;
    agentPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/harness/${activeSlug}/agents/${selectedAgent.runId}?phase=${activePhase}`).then((r) => r.json());
        setSelectedAgent(r as AgentDetail);
      } catch {}
    }, 2000);
    return () => { if (agentPollRef.current) { clearInterval(agentPollRef.current); agentPollRef.current = null; } };
  }, [selectedAgent?.runId, activeSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetFeature = useCallback(async (id: string) => {
    if (!activeSlug) return;
    if (!confirm(`Reset ${id} to todo with attempts=0?`)) return;
    await fetch(`/api/harness/${activeSlug}/features/${id}/reset?phase=${activePhase}`, { method: 'POST' });
    toast.success(`${id} reset`);
  }, [activeSlug]);

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
        fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
      }, 2000);
    } catch (e) {
      toast.error('Launch failed', { description: String(e) });
    }
  }, [activeSlug]);

  const stopHarness = useCallback(async () => {
    if (!activeSlug) return;
    if (!confirm(`Send SIGTERM to the harness process for ${activeSlug}?`)) return;
    try {
      const res = await fetch(`/api/harness/${activeSlug}/stop?phase=${activePhase}`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = await res.json();
      toast.success(`Stopped ${d.killed?.length ?? 0} process(es)`);
    } catch (e) {
      toast.error('Stop failed', { description: String(e) });
    }
  }, [activeSlug]);

  // ─── Linear-inspired extensions ─────

  const setFeatureStatus = useCallback(async (id: string, s: FeatureStatus) => {
    if (!activeSlug) return;
    const res = await fetch(`/api/harness/${activeSlug}/features/${id}?phase=${activePhase}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: s }),
    });
    if (res.ok) toast.success(`${id} → ${s}`);
    else toast.error(`Failed: ${res.status}`);
  }, [activeSlug]);

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

  // ⌘K toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);


  // Keep peekFeature in sync with latest features data so status transitions
  // propagate into the open peek panel.
  useEffect(() => {
    if (!peekFeature || !status) return;
    const fresh = status.features.find((f) => f.id === peekFeature.id);
    if (fresh && (fresh.status !== peekFeature.status || fresh.attempts !== peekFeature.attempts)) {
      setPeekFeature(fresh);
    }
  }, [status, peekFeature]);

  // Pulse feed derived from feature snapshots.
  const pulseEvents = usePulse(
    (status?.features ?? EMPTY_FEATURES) as unknown as Parameters<typeof usePulse>[0],
    status?.iteration ?? 0,
    status?.escalated ?? false,
  );

  const totalCount = status?.features.length ?? 0;
  const passedCount = status?.counts.passed ?? 0;
  const todoCount = status?.counts.todo ?? 0;
  const blockedCount = status?.counts.blocked ?? 0;
  const progressPct = totalCount ? Math.round((passedCount / totalCount) * 100) : 0;

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

  const focusFeature = useMemo(() => {
    const features = status?.features ?? [];
    for (const featureStatus of FOCUS_ORDER) {
      const match = features.find((f) => f.status === featureStatus);
      if (match) return match;
    }
    return null;
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
      cs.push({ id: 'config', section: 'Control', title: 'Edit config / spec', icon: '✎', keywords: 'spec agents contract', perform: () => setActivePanel('config') });
      cs.push({ id: 'vscode', section: 'Control', title: 'Open current project in VSCode', icon: '</>', keywords: 'vscode code editor open folder', perform: () => openInVSCode(status.project.path) });
      cs.push({ id: 'triage', section: 'Control', title: 'Triage — stuck/blocked/failing features', icon: '🔺', keywords: 'escalation blocked', perform: () => setShowTriage(true) });
      cs.push({ id: 'insights', section: 'Control', title: 'Insights — analytics', icon: '📊', keywords: 'analytics histogram', perform: () => setActivePanel('insights') });
      cs.push({ id: 'hooks', section: 'Control', title: 'Hooks — edit pre/post lifecycle scripts', icon: '⚡', keywords: 'hook script pre post worker validator escalate', perform: () => setShowHooks(true) });
      cs.push({ id: 'intervene', section: 'Control', title: 'Intervene — send note to orchestrator', icon: '💬', keywords: 'note supervisor guidance', perform: () => setShowIntervention(true) });
      cs.push({ id: 'usage', section: 'Control', title: 'Usage — per-role cost breakdown', icon: '💵', keywords: 'cost tokens money spend', perform: () => setShowUsage(true) });
      cs.push({ id: 'snapshots', section: 'Control', title: 'Snapshots — rollback mission state', icon: '⟲', keywords: 'checkpoint rollback history restore', perform: () => setShowSnapshots(true) });
      cs.push({ id: 'decisions', section: 'Control', title: 'Decisions — orchestrator verb timeline', icon: '🧠', keywords: 'decision orchestrator verb ghost parser', perform: () => setShowDecisions(true) });
      cs.push({ id: 'smoke', section: 'Control', title: 'Smoke test — service gate (claudecode-orchestrator)', icon: '💨', keywords: 'smoke test gate service url check', perform: () => setShowSmokeTest(true) });
      cs.push({ id: 'identity', section: 'Control', title: 'Identity — cross-mission role memory (Agent-Swarm)', icon: '🧬', keywords: 'identity role memory cross mission learned patterns', perform: () => setShowIdentity(true) });
      cs.push({
        id: 'checkpoint-request', section: 'Control',
        title: 'Request checkpoint — pause harness for human approval',
        icon: '⏸', keywords: 'checkpoint pause hermes gate approval',
        perform: async () => {
          const name = typeof window !== 'undefined' ? window.prompt('Checkpoint name (letters/numbers/-_. only):', 'manual') : null;
          if (!name) return;
          const cleanName = name.replace(/[^A-Za-z0-9_.-]/g, '');
          if (!cleanName) { toast.error('invalid name'); return; }
          const message = typeof window !== 'undefined' ? window.prompt('Context message (optional):', '') : '';
          try {
            const r = await fetch(`/api/harness/${activeSlug}/checkpoint/${encodeURIComponent(cleanName)}/request`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ message: message ?? '' }),
            });
            const d = await r.json();
            if (d.ok) toast.success(`checkpoint "${cleanName}" requested`);
            else toast.error(`request failed: ${d.error ?? 'unknown'}`);
          } catch (e) { toast.error(String(e)); }
        },
      });
      cs.push({ id: 'screenshots', section: 'Control', title: 'Screenshots — visual history', icon: '📸', keywords: 'screenshot image visual capture', perform: () => setShowScreenshots(true) });
      cs.push({ id: 'newfeat', section: 'Control', title: 'Create new feature', icon: '＋', keywords: 'add feature', perform: () => setEditingFeature('new') });
      cs.push({ id: 'templates', section: 'Control', title: 'Start from template — seed SPEC.md + AGENTS.md', icon: '📋', keywords: 'template starter bootstrap spec', perform: () => setShowTemplates(true) });
      cs.push({ id: 'archives', section: 'Control', title: 'Archives — snapshot / restore mission state', icon: '📦', keywords: 'archive restore backup reset', perform: () => setShowArchives(true) });
      cs.push({
        id: 'supervisor', section: 'Control',
        title: 'Run supervisor — fresh review of mission',
        icon: '🧭', keywords: 'supervisor review check-in',
        perform: async () => {
          toast.info('Running supervisor…');
          try {
            const r = await fetch(`/api/harness/${activeSlug}/supervisor?phase=${activePhase}`, { method: 'POST' });
            const d = await r.json();
            if (d.ok) toast.success(`${d.outcome || 'supervisor complete'}`, { duration: 6000 });
            else toast.error(`supervisor failed: ${d.error ?? 'unknown'}`);
          } catch (e) { toast.error(String(e)); }
        },
      });
      cs.push({
        id: 'replan', section: 'Control',
        title: 'Re-plan — regenerate features.json + contract from SPEC.md',
        icon: '🔄', keywords: 'replan regenerate planner spec',
        perform: async () => {
          if (!confirm('Re-run the planner? Current features.json + contract will be backed up and replaced.')) return;
          toast.info('Re-planning… (may take a few minutes)');
          try {
            const r = await fetch(`/api/harness/${activeSlug}/replan?phase=${activePhase}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ overwrite: true }),
            });
            const d = await r.json();
            if (d.ok && d.produced) toast.success(`re-planned — backup at ${d.backupDir}`, { duration: 6000 });
            else toast.error(`replan: ${d.error ?? 'did not produce artifacts'}`);
            fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
          } catch (e) { toast.error(String(e)); }
        },
      });
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
      <Loader2 size={20} className="h-empty-icon h-spin" />
      <span>No agent runs yet.</span>
    </div>
  ) : (
    <RecentAgentsTable agents={agents} onSelect={loadAgent} />
  );

  return (
    <RTooltip.Provider delayDuration={400}>
    <div className={`h-root${isBrainstormPanel ? ' brainstorm-mode' : ''}${topChromeCollapsed ? ' top-chrome-collapsed' : ''}`}>
      <Toaster theme="dark" position="bottom-right" richColors />

      {!topChromeCollapsed && (
        <>
      {/* ── Mission header ─────────────────────────────────── */}
      <div className={`h-header${status?.alive ? ' alive' : ''}`}>
        <Tooltip label="Collapse the top header section to free vertical space">
          <button
          type="button"
          className="h-top-collapse-btn h-top-collapse-inline"
          onClick={() => setTopChromeCollapsed(true)}
          aria-expanded={!topChromeCollapsed}
        >
          Collapse top section
        </button>
        </Tooltip>
        <div className="h-header-main">
          <div className="h-brand">
            <span className="h-brand-kicker"><Activity size={12} /> autonomous workspace</span>
            <span className="h-title">Harness Control</span>
          </div>

          <div className="h-project-card">
            <div className="h-project-topline">
              {activeSlug && (
                <div className="h-project-phases">
                  <PhaseTabs slug={activeSlug} activePhase={activePhase} onChange={setActivePhase} />
                </div>
              )}
              {status && (
                <div className="h-project-topline-statuses">
                  <div className="h-overview-pulse h-project-pulse">
                    <PulseFeed
                      compact
                      events={pulseEvents}
                      onOpenFeature={(id) => {
                        const f = status.features.find((ff) => ff.id === id);
                        if (f) setPeekFeature(f);
                      }}
                    />
                  </div>
                  {lanes && (
                    <div className="h-overview-lanes h-project-lanes" aria-label="Now running lanes">
                      <div className="h-running-head">
                        <span>Now running</span>
                        <strong>{activeLanes.length}/{lanes.max}</strong>
                      </div>
                      <div className="h-running-lanes">
                        {Array.from({ length: Math.max(lanes.max, activeLanes.length, 1) }).map((_, index) => {
                          const lane = activeLanes[index];
                          if (!lane) {
                            return <span key={`idle-${index}`} className="h-running-lane idle">available lane</span>;
                          }
                          const feature = status.features.find((f) => f.id === lane.featureId);
                          return (
                            <button
                              key={`${lane.pid}-${lane.featureId}`}
                              className="h-running-lane live"
                              onClick={() => { if (feature) setPeekFeature(feature); }}
                              title={`PID ${lane.pid} · ${lane.featureId}`}
                            >
                              <span className="h-running-dot" />
                              <span className="h-running-id">{lane.featureId}</span>
                              <span className="h-running-title">{feature?.title ?? 'working'}</span>
                              <span className="h-running-time">{fmtDuration(lane.elapsedSeconds)}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
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
                // Keep the URL path in sync with the dropdown so the URL
                // remains the canonical source of truth across reloads.
                if (typeof window !== 'undefined' && next) {
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
                <RSelect.Content position="popper" sideOffset={4} style={{ zIndex: 70, minWidth: 'var(--radix-select-trigger-width)', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', fontSize: 12 }}>
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
              <StatCard
                label="iter"
                value={status.iteration}
                icon={<Activity size={13} />}
              />
              <StatCard
                label="passed"
                value={`${passedCount}/${totalCount}`}
                tone={progressPct === 100 ? 'good' : undefined}
                icon={<CheckCircle2 size={13} />}
              />
              {typeof status.missionCostUsd === 'number' && status.missionCostUsd > 0 && (
                <Tooltip label="Open per-role cost breakdown">
                  <button
                    className="h-stat-button"
                    onClick={() => setShowUsage(true)}
                  >
                    <StatCard
                      label="spent"
                      value={`${status.missionCostUsd.toFixed(2)}`}
                      icon={<Coins size={13} />}
                    />
                  </button>
                </Tooltip>
              )}
              {activeSlug && <HealthBadge slug={activeSlug} />}
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
                <div title={`${status.activeCompetitions} competition${status.activeCompetitions === 1 ? '' : 's'} in progress`}>
                  <StatCard
                    label="competitions"
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
              {lanes && (lanes.max > 1 || lanes.lanes.filter((l) => l.alive).length > 0) && (() => {
                const alive = lanes.lanes.filter((l) => l.alive);
                const title = alive.length > 0
                  ? `Active lanes:\n${alive.map((l) => `  ${l.featureId} · ${l.elapsedSeconds}s`).join('\n')}`
                  : 'No active lanes';
                return (
                  <div title={title}>
                    <StatCard
                      label="lanes"
                      value={`${alive.length}/${lanes.max}`}
                      tone={alive.length === lanes.max && lanes.max > 1 ? 'good' : undefined}
                    />
                  </div>
                );
              })()}
            </div>

          </div>
        ) : (
          <div className="h-header-empty">
            <span>Pick a project, then use <strong>⌘K</strong> for every harness action.</span>
          </div>
        )}
      </div>

      {activeSlug && (
        <div className="h-phase-plan-row">
          {status && !isBrainstormPanel && focusFeature && (
            <button
              className={`h-focus-card h-phase-plan-focus ${focusFeature.status}`}
              onClick={() => setPeekFeature(focusFeature)}
              title={`Open ${focusFeature.id}`}
            >
              <span className="h-overline">Mission focus</span>
              <strong>{focusVerb(focusFeature.status)}</strong>
              <span className="h-focus-title">
                {focusFeature.id} · {focusFeature.title}
              </span>
            </button>
          )}
          {status && !isBrainstormPanel && triageCount > 0 && (
            <Tooltip label="Open the triage queue (features needing attention)">
              <button
              className="h-overview-action warn h-phase-plan-review"
              onClick={() => setShowTriage(true)}
            >
              Review {triageCount} issue{triageCount === 1 ? '' : 's'}
            </button>
            </Tooltip>
          )}
          <PlanReviewBanner slug={activeSlug} compact />
          {status && (
            <div className="h-header-actions h-phase-plan-actions">
              {status.escalated && (
                <span className="h-escalated-pill">
                  <AlertTriangle size={12} /> escalated
                </span>
              )}
              {status.lastDecision && (
                <span className="h-decision-chip h-phase-plan-decision" title={`Last decision: ${status.lastDecision}`}>
                  <ArrowRight size={11} />
                  <span>decision</span>
                  <strong>{status.lastDecision}</strong>
                </span>
              )}
              <Tooltip label="Command palette (⌘K)">
                <button className="h-btn ghost h-key-btn" onClick={() => setPaletteOpen(true)}>
                  ⌘K
                </button>
              </Tooltip>
              <Tooltip label="Triage — features needing attention">
                <button
                  className={`h-btn ${triageCount > 0 ? 'danger' : 'ghost'}`}
                  onClick={() => setShowTriage(true)}
                >
                  <AlertTriangle size={13} /> triage{triageCount > 0 ? ` · ${triageCount}` : ''}
                </button>
              </Tooltip>
              {activeSlug && (
                <PluginToolbarActions
                  harnessSlug={activeSlug}
                  installed={installedPlugins ?? []}
                  enabledSlugs={enabledByHarness[activeSlug] ?? []}
                />
              )}
              {activeSlug && <SaveSnapshotButton slug={activeSlug} />}
              {status.alive ? (
                <Tooltip label="Stop the autonomous loop for this harness">
                  <button className="h-btn danger" onClick={stopHarness}>
                    <Square size={13} fill="currentColor" /> stop
                  </button>
                </Tooltip>
              ) : (
                <Tooltip label="Start the autonomous loop for this harness">
                  <button className="h-btn primary" onClick={launchHarness}>
                    <Play size={13} fill="currentColor" /> start
                  </button>
                </Tooltip>
              )}
            </div>
          )}
        </div>
      )}

      {activeSlug && status && (
        <EscalationBanner
          slug={activeSlug}
          escalated={status.escalated}
          onResumed={() => {
            fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
          }}
        />
      )}

      {activeSlug && <CheckpointBanner slug={activeSlug} />}



        </>
      )}

      {topChromeCollapsed && (
        <div className="h-top-collapse-row">
          <Tooltip label="Expand the top header section">
            <button
            type="button"
            className="h-top-collapse-btn h-top-collapse-floating"
            onClick={() => setTopChromeCollapsed(false)}
            aria-expanded={!topChromeCollapsed}
          >
            Expand top section
          </button>
          </Tooltip>
        </div>
      )}

      {/* ── Main-area tab switcher ─────────────────────────────── */}
      <Tabs.Root
        value={activePanel}
        onValueChange={(v) => {
          if (v === 'pi') setPiLaneId(null);
          setActivePanel(v as MainPanel);
        }}
        className="h-tab-strip"
      >
        <Tabs.List className="h-tabs h-main-tabs" aria-label="Harness workspace sections">
          <Tooltip label={activeSlug ? 'Brainstorm — write, mindmap, canvas, chat with Claude' : 'Select a project to brainstorm'}>
            <Tabs.Trigger value="brainstorm" className="h-tab" disabled={!activeSlug}>
              <Lightbulb size={13} /> brainstorm
            </Tabs.Trigger>
          </Tooltip>
          <Tooltip label={activeSlug ? `Product proposals — scope expansion from GOAL.md${pendingProposals > 0 ? ` · ${pendingProposals} pending` : ''}` : 'Select a project to view proposals'}>
            <Tabs.Trigger value="proposals" className="h-tab" disabled={!activeSlug}>
              🪄 proposals
              {pendingProposals > 0 && <span className="h-tab-count">{pendingProposals}</span>}
            </Tabs.Trigger>
          </Tooltip>
          <Tooltip label="Harness dashboard — feature queue, agents, logs, issues">
            <Tabs.Trigger value="dashboard" className="h-tab">
              <LayoutDashboard size={13} /> dashboard
            </Tabs.Trigger>
          </Tooltip>
          <Tooltip label={activeSlug ? 'Project summary — high-level changelog of what has been built' : 'Select a project to view summary'}>
            <Tabs.Trigger value="summary" className="h-tab" disabled={!activeSlug}>
              <FileText size={13} /> summary
            </Tabs.Trigger>
          </Tooltip>
          {legacyTabSuppressed('docs') ? null : (
            <Tooltip label={activeSlug ? 'Project docs (requires docs-viewer on :4325)' : 'Select a project to view docs'}>
              <Tabs.Trigger value="docs" className="h-tab" disabled={!activeSlug}>
                <BookOpen size={13} /> docs
              </Tabs.Trigger>
            </Tooltip>
          )}
          {legacyTabSuppressed('vscode') ? null : (
            <Tooltip label={activeSlug ? 'code-server — edit project in VSCode' : 'Select a project to open in VSCode'}>
              <Tabs.Trigger value="vscode" className="h-tab" disabled={!activeSlug}>
                <Code2 size={13} /> vscode
              </Tabs.Trigger>
            </Tooltip>
          )}
          {legacyTabSuppressed('pi') ? null : (
            <Tooltip label={activeSlug ? 'consoles — terminals, agent chats, and other dock panels' : 'Select a project to open consoles'}>
              <Tabs.Trigger value="pi" className="h-tab" disabled={!activeSlug}>
                <Activity size={13} /> consoles
              </Tabs.Trigger>
            </Tooltip>
          )}
          {/* Plugin-mounted tabs. The trigger is the tab itself; a tiny ⓘ
              button next to the label opens a popover with version + a link
              to the marketplace-ops detail page so operators can inspect
              the source of the tab. */}
          {pluginTabs.map((pt) => (
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
          <Tooltip label={activeSlug ? 'Insights — analytics' : 'Select a project to view insights'}>
            <Tabs.Trigger value="insights" className="h-tab" disabled={!activeSlug}>
              <TrendingUp size={13} /> insights
            </Tabs.Trigger>
          </Tooltip>
          <Tooltip label={activeSlug ? 'Edit SPEC.md / AGENTS.md / config.json' : 'Select a project to edit config'}>
            <Tabs.Trigger value="config" className="h-tab" disabled={!activeSlug}>
              <SlidersHorizontal size={13} /> config
            </Tabs.Trigger>
          </Tooltip>
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
        </Tabs.List>
      </Tabs.Root>

      {!status && (
        <div className="h-guide-strip">
          {activeSlug ? <Loader2 size={14} className="h-spin" /> : <Activity size={14} />}
          <span>{activeSlug ? `Loading ${activeSlug} mission state…` : 'Pick a project to unlock docs, VSCode, logs, issues, and agent controls.'}</span>
          <button className="h-guide-action" onClick={() => setPaletteOpen(true)} title="Open the command palette (⌘K)">Open commands</button>
        </div>
      )}

      {/* ── Main area ──────────────────────────────────────────── */}
      <div className={`h-main-shell ${activePanel === 'dashboard' ? 'dashboard' : activePanel === 'brainstorm' ? 'brainstorm-full' : 'embed'}`}>
        {activePanel === 'brainstorm' && activeSlug && (
          <BrainstormFull slug={activeSlug} />
        )}
        {activePanel === 'proposals' && activeSlug && (
          <ProposalsPanel slug={activeSlug} />
        )}
        {activePanel === 'summary' && activeSlug && (
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
        {activePanel === 'docs' && activeSlug && (
          <iframe
            src={docsUrl(activeSlug)}
            title="Project docs"
            style={{ flex: 1, border: 'none', width: '100%', height: '100%', background: 'var(--bg-2)' }}
          />
        )}
        {activePanel === 'vscode' && activeSlug && status && (
          <iframe
            src={vscodeUrl(status.project.path)}
            title="VSCode"
            style={{ flex: 1, border: 'none', width: '100%', height: '100%', background: 'var(--bg-2)' }}
          />
        )}
        {activePanel === 'pi' && activeSlug && (
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <PiTerminalsDock slug={activeSlug} initialLaneId={piLaneId ?? undefined} />
          </div>
        )}
        {/* Plugin-mounted tabs: pick whichever plugin matches the active panel
            via the plugin:<id> prefix. iframeUrl is null when the plugin's
            manifest doesn't expose one of the conventional config keys. */}
        {activePanel.startsWith('plugin:') && activeSlug && (() => {
          const tabId = activePanel.slice('plugin:'.length);
          const pt = pluginTabs.find((t) => t.tabId === tabId);
          if (!pt) {
            return (
              <div style={{ flex: 1, padding: 24, color: 'var(--text-2)' }}>
                Plugin tab not found.
              </div>
            );
          }
          if (pt.iframeUrl) {
            return <PluginIframeWithLoader key={`${pt.pluginSlug}:${pt.tabId}`} url={pt.iframeUrl} title={pt.label} />;
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
            <div style={{ flex: 1, padding: 24, color: 'var(--text-2)' }}>
              <strong>{pt.label}</strong> ({pt.pluginSlug}@{pt.pluginVersion}) is enabled but
              declares neither an iframeUrl nor a (componentRoot, componentId) pair. Update the
              plugin manifest, or run{' '}
              <code>papercusp plugin config {pt.pluginSlug} --harness {activeSlug}</code>.
            </div>
          );
        })()}
        {activePanel === 'insights' && status && (
          <InsightsPanel
            inline
            features={status.features as any}
            totalCostUsd={status.missionCostUsd ?? 0}
            totalInputTokens={status.missionInputTokens ?? 0}
            totalOutputTokens={status.missionOutputTokens ?? 0}
            iteration={status.iteration}
            onClose={() => setActivePanel('dashboard')}
          />
        )}
        {activePanel === 'config' && activeSlug && status && (
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
          />
        )}
        {activePanel === 'dashboard' && (
          <>
            {isCompact ? (
            <div className="h-compact-dashboard">
              <div className="h-dashboard-panel-anchor" data-dashboard-panel="features" tabIndex={-1}>
                <Panel title="Feature queue" count={totalCount} className="h-feature-queue-panel">
                <FeatureList
                  slug={activeSlug ?? ''}
                  features={(status?.features ?? []) as any}
                  activeFeatureId={peekFeature?.id ?? null}
                  onSelect={(f) => setPeekFeature(f as Feature)}
                  onReset={resetFeature}
                  onEdit={(f) => setEditingFeature(f as Feature)}
                  onOpenInPi={(id) => { setPiLaneId(id); setActivePanel('pi'); setPeekFeature(null); }}
                  onSwitchToPi={() => setActivePanel('pi')}
                  onAdd={() => setEditingFeature('new')}
                  onBatchReset={batchReset}
                  onBatchDelete={batchDelete}
                />
              </Panel>
              </div>

              {activeSlug && (
                <div className="h-compact-panel h-compact-inbox h-dashboard-panel-anchor" data-dashboard-panel={leftPane} tabIndex={-1}>
                  <LeftPaneTabs leftPane={leftPane} setLeftPane={setLeftPane} />
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {leftPane === 'inbox' && (
                      <ArchitectInbox
                        slug={activeSlug}
                        onFeatureFocus={(fid) => {
                          const f = status?.features.find((ff) => ff.id === fid);
                          if (f) setPeekFeature(f);
                        }}
                      />
                    )}
                    {leftPane === 'git' && <GitGraphPanel slug={activeSlug} />}
                  </div>
                </div>
              )}

              <div className="h-dashboard-panel-anchor" data-dashboard-panel="agents" tabIndex={-1}>
                <Panel title="Recent agents" count={agents.length}>
                {recentAgentsContent}
              </Panel>
              </div>

              <div className="h-dashboard-panel-anchor" data-dashboard-panel="logs" tabIndex={-1}>
                <Panel title="run.log" count="live">
                <LogView lines={logLines} />
              </Panel>
              </div>

              <div className="h-dashboard-panel-anchor" data-dashboard-panel="issues" tabIndex={-1}>
                <IssuesPanel slug={activeSlug ?? ''} reportMd={issues} phase={activePhase} />
              </div>
            </div>
          ) : (
        <div className="h-dashboard-grid" style={{ display: 'flex', gap: 6, height: '100%', minHeight: 0, flex: 1 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
        <PanelGroup orientation="horizontal">
          {activeSlug && (
            <>
              <RPanel key={leftPane} defaultSize={leftPane === 'git' ? '30%' : '26%'} minSize={leftPane === 'git' ? '20%' : '18%'} maxSize={leftPane === 'git' ? '48%' : '42%'}>
                <div className="h-dashboard-panel-anchor h-dashboard-left-pane" data-dashboard-panel={leftPane} tabIndex={-1} style={{
                  height: '100%',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}>
                  <LeftPaneTabs leftPane={leftPane} setLeftPane={setLeftPane} />
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {leftPane === 'inbox' && (
                      <ArchitectInbox
                        slug={activeSlug}
                        onFeatureFocus={(fid) => {
                          const f = status?.features.find((ff) => ff.id === fid);
                          if (f) setPeekFeature(f);
                        }}
                      />
                    )}
                    {leftPane === 'git' && <GitGraphPanel slug={activeSlug} />}
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
                <div className="h-dashboard-panel-anchor" data-dashboard-panel="features" tabIndex={-1}>
                  <Panel title="Feature queue" count={totalCount} className="h-feature-queue-panel">
                    <FeatureList
                      slug={activeSlug ?? ''}
                      features={(status?.features ?? []) as any}
                      activeFeatureId={peekFeature?.id ?? null}
                      onSelect={(f) => setPeekFeature(f as Feature)}
                      onReset={resetFeature}
                      onEdit={(f) => setEditingFeature(f as Feature)}
                      onOpenInPi={(id) => { setPiLaneId(id); setActivePanel('pi'); setPeekFeature(null); }}
                      onSwitchToPi={() => setActivePanel('pi')}
                      onAdd={() => setEditingFeature('new')}
                      onBatchReset={batchReset}
                      onBatchDelete={batchDelete}
                    />
                  </Panel>
                </div>
              </RPanel>
              <Separator className="h-resize-v" style={{ margin: '6px 0' }} />
              {/* Middle: Issues / Tests / Report tabs, full width */}
              <RPanel defaultSize="35%" minSize="20%">
                <div className="h-dashboard-panel-anchor" data-dashboard-panel="issues" tabIndex={-1}>
                  <IssuesPanel slug={activeSlug ?? ''} reportMd={issues} phase={activePhase} />
                </div>
              </RPanel>
              <Separator className="h-resize-v" style={{ margin: '6px 0' }} />
              {/* Bottom row: Recent agents + run.log side-by-side, compact */}
              <RPanel defaultSize="25%" minSize="12%">
                <PanelGroup orientation="horizontal">
                  <RPanel defaultSize="50%" minSize="20%">
                    <div className="h-dashboard-panel-anchor" data-dashboard-panel="agents" tabIndex={-1}>
                      <Panel title="Recent agents" count={agents.length}>
                        {recentAgentsContent}
                      </Panel>
                    </div>
                  </RPanel>
                  <Separator className="h-resize-h" style={{ margin: '0 6px' }} />
                  <RPanel defaultSize="50%" minSize="20%">
                    <div className="h-dashboard-panel-anchor" data-dashboard-panel="logs" tabIndex={-1}>
                      <Panel title="run.log" count="live">
                        <LogView lines={logLines} />
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
        )}
      </div>

      {/* ── Command palette (⌘K) ──────────────────────────── */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />

      {/* ── Feature peek panel ────────────────────────────── */}
      {peekFeature && (
        <FeaturePeekPanel
          slug={activeSlug ?? ''}
          feature={peekFeature as any}
          agents={agents as any}
          issues={issues}
          onClose={() => setPeekFeature(null)}
          onReset={resetFeature}
          onEdit={() => { setEditingFeature(peekFeature); setPeekFeature(null); }}
          onInspectRun={loadAgent}
          onSetStatus={(id, s) => setFeatureStatus(id, s as FeatureStatus)}
          onOpenInPi={(id) => { setPiLaneId(id); setActivePanel('pi'); setPeekFeature(null); }}
          onSwitchToPi={() => setActivePanel('pi')}
        />
      )}

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
      {showSnapshots && activeSlug && (
        <div data-harness-modal="true">
          <SnapshotsPanel
            slug={activeSlug}
            onClose={() => setShowSnapshots(false)}
            onRestored={() => {
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
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
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
            }}
          />
        </div>
      )}

      {/* ── Templates modal ───────────────────────────────── */}
      {showTemplates && activeSlug && (
        <div data-harness-modal="true">
          <TemplatesModal
            slug={activeSlug}
            onClose={() => setShowTemplates(false)}
            onBootstrapped={() => {
              // SPEC.md content may have changed; refetch spec + status
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
            }}
          />
        </div>
      )}

      {/* ── Feature editor modal ──────────────────────────── */}
      {editingFeature !== null && activeSlug && (
        <div data-harness-modal="true">
          <FeatureEditor
            slug={activeSlug}
            feature={editingFeature === 'new' ? null : editingFeature}
            onClose={() => setEditingFeature(null)}
            onSaved={() => {
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
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
      width: 1.1,
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
      width: 1.0,
      render: ({ row }) => {
        const cls = roleClass(row.role);
        return <span className={`h-agent-role ${cls}`}>{row.role}</span>;
      },
    },
    {
      key: 'runId',
      header: 'run id',
      width: 1.5,
      render: ({ row }) => (
        <span className="mono runid" title={row.runId} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>
          {row.runId.slice(0, 14)}…
        </span>
      ),
    },
    {
      key: 'size',
      header: 'size',
      width: 0.6,
      align: 'right',
      render: ({ row }) => (
        <span className="muted mono" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
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


// ─── Left pane tab selector (inbox / git) ──────────
function LeftPaneTabs({
  leftPane,
  setLeftPane,
}: {
  leftPane: 'inbox' | 'git';
  setLeftPane: (p: 'inbox' | 'git') => void;
}) {
  const tabs: Array<{ id: 'inbox' | 'git'; label: string }> = [
    { id: 'inbox', label: 'inbox' },
    { id: 'git', label: 'git' },
  ];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2,
      padding: '4px 6px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-2)',
      flexShrink: 0,
    }}>
      {tabs.map((t) => {
        const active = leftPane === t.id;
        const Icon = t.id === 'inbox' ? Inbox : GitBranch;
        return (
          <button
            key={t.id}
            onClick={() => setLeftPane(t.id)}
            title={`Switch to ${t.label}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              color: active ? 'var(--fg)' : 'var(--fg-dim)',
              background: active ? 'var(--bg-3)' : 'transparent',
              border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
              borderRadius: 4,
              cursor: 'pointer',
              transition: 'all 120ms ease',
            }}
          >
            <Icon size={12} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Tabbed Issues panel ──────────────────────────────────────────

function IssuesPanel({ slug, reportMd, phase }: { slug: string; reportMd: string; phase: Phase }) {
  const [tab, setTab] = useState<'issues' | 'report' | 'tests'>('issues');
  const [issueCount, setIssueCount] = useState<number | null>(null);

  return (
    <div className="h-panel" style={{ height: '100%' }}>
      <div className="h-tabs">
        <Tooltip label="Open issue tracker — bugs and concerns surfaced by validators">
          <button
          className={`h-tab${tab === 'issues' ? ' on' : ''}`}
          onClick={() => setTab('issues')}
        >
          issues
          {issueCount !== null && <span className="h-tab-count">{issueCount}</span>}
        </button>
        </Tooltip>
        <Tooltip label="Show test claims and validator outcomes">
          <button
          className={`h-tab${tab === 'tests' ? ' on' : ''}`}
          onClick={() => setTab('tests')}
        >
          tests
        </button>
        </Tooltip>
        <Tooltip label="Show the validator's prose report for the latest run">
          <button
          className={`h-tab${tab === 'report' ? ' on' : ''}`}
          onClick={() => setTab('report')}
        >
          report
          {reportMd && <span className="h-tab-count">{reportMd.length > 0 ? 'md' : ''}</span>}
        </button>
        </Tooltip>
      </div>
      <div className="h-panel-body" style={{ display: 'flex', flexDirection: 'column' }}>
        {tab === 'issues' && <IssuesList slug={slug} onCount={setIssueCount} />}
        {tab === 'tests' && <TestsTab slug={slug} phase={phase} />}
        {tab === 'report' && <MarkdownView source={reportMd} />}
      </div>
    </div>
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
