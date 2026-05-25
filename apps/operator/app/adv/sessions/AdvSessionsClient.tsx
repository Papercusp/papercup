'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import * as Tabs from '@radix-ui/react-tabs';
import { Activity, ChevronRight, FolderKanban, TerminalSquare, Zap } from 'lucide-react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@/app/harness/Button';
import { Select } from '@/app/harness/Select';
import { Tooltip } from '@/app/harness/Tooltip';
import { launchOmpAgent } from '@/lib/native-omp-launch';
import { usePlanList } from '../../admin/plans/plans-api';

interface SessionRow {
  id: number;
  workspaceId: string;
  planSlug: string | null;
  mode: 'omp' | 'console';
  terminalBin: string | null;
  pid: number | null;
  windowId: string | null;
  ompThreadId: string | null;
  label: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

interface OmpSessionMatch {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  title: string;
  matchKind: 'exact-cwd' | 'cwd-prefix' | 'time-only';
  timeDriftMs: number;
}

interface OmpMessageSnippet {
  id?: string;
  timestamp?: string;
  role: string;
  toolName?: string;
  isError?: boolean;
  text: string;
}

interface OmpTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'abandoned';
  notes?: string[];
}

interface OmpTodoPhase {
  name: string;
  tasks: OmpTodoItem[];
}

interface OmpToolSummary {
  toolName: string;
  calls: number;
  results: number;
  errors: number;
  lastUsedAt?: string;
}

interface OmpSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  assistantTurnsWithUsage: number;
}

interface OmpSessionState {
  header: {
    id: string;
    cwd: string;
    timestamp: string;
    title?: string;
  };
  filePath: string;
  totalLines: number;
  countsByType: Record<string, number>;
  messages: {
    total: number;
    user: number;
    assistant: number;
    toolResults: number;
  };
  /** Optional — older API responses (pre-token-spend) omit these. */
  models?: string[];
  latestModel?: string | null;
  usage?: OmpSessionUsage;
  latestMessages: OmpMessageSnippet[];
  todos: OmpTodoPhase[];
  toolCounts: OmpToolSummary[];
  jobs: OmpMessageSnippet[];
  goals: OmpMessageSnippet[];
  compactions: OmpMessageSnippet[];
  handoffs: OmpMessageSnippet[];
}

const EMPTY_USAGE: OmpSessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  assistantTurnsWithUsage: 0,
};

/** Always returns a populated usage block — missing fields default
 *  to 0 so the UI never tries to read `.totalTokens` off undefined. */
function normalizeUsage(u: OmpSessionUsage | undefined): OmpSessionUsage {
  if (!u) return EMPTY_USAGE;
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0,
    totalTokens: u.totalTokens ?? 0,
    totalCostUsd: u.totalCostUsd ?? 0,
    assistantTurnsWithUsage: u.assistantTurnsWithUsage ?? 0,
  };
}

interface OmpMemoryState {
  ok?: boolean;
  backend?: unknown;
  hindsight?: {
    apiUrl?: unknown;
    scoping?: unknown;
    autoRecall?: unknown;
    autoRetain?: unknown;
    retainMode?: unknown;
    recallBudget?: unknown;
    recallMaxTokens?: unknown;
  };
  error?: string;
}

interface SessionStateResponse {
  ok: boolean;
  advSession: SessionRow | null;
  match: OmpSessionMatch | null;
  state: OmpSessionState | null;
  memory: OmpMemoryState;
  error: string | null;
}

interface SessionSearchMatch {
  session: {
    id: string;
    title: string;
    cwd: string;
    timestamp: string;
  };
  line: number;
  entryId?: string;
  timestamp?: string;
  type: string;
  role?: string;
  toolName?: string;
  snippet: string;
  contextBefore: string[];
  contextAfter: string[];
}

interface SessionSearchResponse {
  ok: boolean;
  query: string;
  matches: SessionSearchMatch[];
  truncated: boolean;
  searchedSessions: number;
  error?: string | null;
}

type SessionPanel = 'overview' | 'context' | 'history' | 'todos' | 'jobs' | 'goal' | 'tools' | 'memory' | 'handoff';

const SESSION_PANELS: Array<{ value: SessionPanel; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'context', label: 'Context' },
  { value: 'history', label: 'History' },
  { value: 'todos', label: 'Todos' },
  { value: 'jobs', label: 'Jobs' },
  { value: 'goal', label: 'Goal' },
  { value: 'tools', label: 'Tools' },
  { value: 'memory', label: 'Memory' },
  { value: 'handoff', label: 'Handoff' },
];

const PLAN_SELECT_PLACEHOLDER = '__select_plan__';
const MODEL_SELECT_DEFAULT = '__default_model__';

const OMP_MODEL_OPTIONS = [
  { value: MODEL_SELECT_DEFAULT, label: 'Default' },
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'haiku', label: 'Claude Haiku' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
];

interface RowSummary {
  model: string | null;
  totalTokens: number;
  totalCostUsd: number;
  /** OMP session id (UUIDv7) from the JSONL header — the canonical
   *  thread id used by `omp -r <id>` to resume. Captured lazily on
   *  every row so Resume-by-ID never needs a prompt. */
  ompSessionId: string | null;
  /** How many user turns the transcript recorded. Zero means OMP
   *  opened but the user never typed anything — same noise category
   *  as dead-on-arrival, just discovered after the fact. Such rows
   *  get hidden from the list. */
  userMessageCount: number;
  loaded: boolean;
}

export default function AdvSessionsClient() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aliveByPid, setAliveByPid] = useState<Record<number, boolean>>({});
  const [refreshTick, setRefreshTick] = useState(0);
  const [summaryByRowId, setSummaryByRowId] = useState<Record<number, RowSummary>>({});
  const [launchPlanSlug, setLaunchPlanSlug] = useQueryState('newPlan', parseAsString);
  const [launchModel, setLaunchModel] = useQueryState(
    'model',
    parseAsString.withDefault(''),
  );
  const [selectedSessionId, setSelectedSessionId] = useQueryState('session', parseAsString);
  // Plan groups start collapsed; user-expanded ones are pinned in the
  // URL. nuqs so reloads keep the user's open set.
  const [expandedGroups, setExpandedGroups] = useQueryState(
    'expand',
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  const [panel, setPanel] = useQueryState('panel', parseAsString.withDefault('overview'));
  const [historyQuery, setHistoryQuery] = useQueryState('q', parseAsString.withDefault(''));
  const [launchingNew, setLaunchingNew] = useState(false);
  const [stateData, setStateData] = useState<SessionStateResponse | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);
  const [searchData, setSearchData] = useState<SessionSearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const planList = usePlanList({ includeArchived: true, includeLegacy: true });

  const activePanel = isSessionPanel(panel) ? panel : 'overview';

  const fetchRows = useCallback(async () => {
    try {
      const r = await fetch('/api/adv/sessions', { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { rows: SessionRow[] };
      setRows(data.rows ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetchRows();
  }, [fetchRows, refreshTick]);

  // Auto-refresh while there are active terminals. The exit watcher
  // on the server marks rows as ended in PG when a terminal closes,
  // but the client doesn't learn about it without a fetch — without
  // this poll a user could close a window and see the row stay
  // "active" with a Focus button that doesn't work. 3s feels alive
  // without hammering. Stops polling when no active rows are visible.
  useEffect(() => {
    if (!rows) return;
    const hasActive = rows.some((r) => r.endedAt == null);
    if (!hasActive) return;
    const id = window.setInterval(() => fetchRows(), 3000);
    return () => window.clearInterval(id);
  }, [rows, fetchRows]);

  // Lazy-load token/cost/model summary for each OMP row so the main
  // card surfaces spend without the user having to click into the
  // detail panel. Cached per id; refreshTick busts the cache.
  //
  // Only fetches summaries for rows we don't yet have. The 3s
  // auto-refresh polls /api/adv/sessions (cheap) but doesn't re-hit
  // /state for every OMP row — that path reads JSONL files off disk
  // and shouldn't run on every poll. Explicit refresh (refreshTick
  // bump from the Refresh button or a fresh launch) re-fetches all.
  useEffect(() => {
    if (!rows) return;
    const ompRows = rows.filter((r) => r.mode === 'omp');
    if (ompRows.length === 0) return;
    const missing = ompRows.filter((r) => !summaryByRowId[r.id]?.loaded);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const updates: Record<number, RowSummary> = {};
      await Promise.all(
        missing.map(async (row) => {
          // Default: row is "loaded but empty" — filtered out by the
          // visibleRows guard. Any successful state load overwrites
          // these defaults below. This way a transcript that's gone
          // (rotated, deleted, never finished) is filtered out the
          // same as a dead-on-arrival row instead of sitting in
          // "loading…" forever.
          const fallback: RowSummary = {
            model: null,
            totalTokens: 0,
            totalCostUsd: 0,
            ompSessionId: null,
            userMessageCount: 0,
            loaded: true,
          };
          try {
            const r = await fetch(`/api/adv/sessions/state?id=${row.id}`, {
              headers: { accept: 'application/json' },
            });
            if (!r.ok) {
              updates[row.id] = fallback;
              return;
            }
            const data = (await r.json()) as SessionStateResponse;
            const s = data.state;
            if (!s) {
              updates[row.id] = fallback;
              return;
            }
            const usage = normalizeUsage(s.usage);
            updates[row.id] = {
              model: s.latestModel ?? null,
              totalTokens: usage.totalTokens,
              totalCostUsd: usage.totalCostUsd,
              ompSessionId: s.header?.id ?? null,
              userMessageCount: s.messages?.user ?? 0,
              loaded: true,
            };
          } catch {
            updates[row.id] = fallback;
          }
        }),
      );
      if (!cancelled && Object.keys(updates).length > 0) {
        setSummaryByRowId((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => { cancelled = true; };
  }, [rows, summaryByRowId]);

  // Explicit refresh wipes the summary cache so the next render
  // re-fetches every OMP row's usage. Bumping refreshTick is the
  // Refresh button's signal.
  useEffect(() => {
    if (refreshTick > 0) setSummaryByRowId({});
  }, [refreshTick]);

  // Re-check pid liveness when the row list changes. For rows the DB
  // says are still active, ask the operator whether the pid is alive —
  // child-exit listener can miss exits across operator restarts.
  useEffect(() => {
    if (!rows) return;
    const activeWithPid = rows.filter((r) => r.endedAt == null && r.pid != null);
    if (activeWithPid.length === 0) return;
    let cancelled = false;
    (async () => {
      const updates: Record<number, boolean> = {};
      for (const row of activeWithPid) {
        try {
          const r = await fetch(`/api/adv/sessions/alive?pid=${row.pid}`);
          if (!r.ok) continue;
          const data = (await r.json()) as { alive: boolean };
          updates[row.pid!] = data.alive;
        } catch { /* swallow */ }
      }
      if (!cancelled) setAliveByPid((prev) => ({ ...prev, ...updates }));
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const selectedRow = useMemo(() => {
    if (!rows || !selectedSessionId) return null;
    const id = Number(selectedSessionId);
    if (!Number.isFinite(id)) return null;
    return rows.find((row) => row.id === id) ?? null;
  }, [rows, selectedSessionId]);

  useEffect(() => {
    if (!selectedRow) {
      setStateData(null);
      setStateError(null);
      setSearchData(null);
      return;
    }
    let cancelled = false;
    setStateLoading(true);
    setStateError(null);
    (async () => {
      try {
        const r = await fetch(`/api/adv/sessions/state?id=${selectedRow.id}`, {
          headers: { accept: 'application/json' },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as SessionStateResponse;
        if (!cancelled) setStateData(data);
      } catch (e: unknown) {
        if (!cancelled) {
          setStateError(e instanceof Error ? e.message : String(e));
          setStateData(null);
        }
      } finally {
        if (!cancelled) setStateLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRow, refreshTick]);

  useEffect(() => {
    const q = historyQuery.trim();
    if (!selectedRow || activePanel !== 'history' || q.length === 0) {
      setSearchData(null);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({ id: String(selectedRow.id), q, limit: '50' });
        const r = await fetch(`/api/adv/sessions/search?${params.toString()}`, {
          headers: { accept: 'application/json' },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as SessionSearchResponse;
        if (!cancelled) setSearchData(data);
      } catch (e: unknown) {
        if (!cancelled) {
          setSearchData({
            ok: false,
            query: q,
            matches: [],
            truncated: false,
            searchedSessions: 0,
          });
          toast.error(`Session search failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePanel, historyQuery, selectedRow]);

  const isActive = useCallback(
    (row: SessionRow): boolean => {
      if (row.endedAt != null) return false;
      if (row.pid == null) return false;
      // Default to "active" until the liveness check returns false.
      return aliveByPid[row.pid] !== false;
    },
    [aliveByPid],
  );

  const selectedLaunchPlan = useMemo(
    () => (planList.data?.plans ?? []).find((p) => p.slug === launchPlanSlug) ?? null,
    [launchPlanSlug, planList.data],
  );
  const launchPlanOptions = useMemo(
    () => [
      { value: PLAN_SELECT_PLACEHOLDER, label: planList.loading ? 'Loading plans…' : 'Select plan…' },
      ...(planList.data?.plans ?? []).map((plan) => ({
        value: plan.slug,
        label: plan.title?.trim() || plan.slug,
      })),
    ],
    [planList.data, planList.loading],
  );


  const launchNewSession = useCallback(async () => {
    if (!selectedLaunchPlan) {
      toast.error('Choose a plan before launching a session.');
      return;
    }
    if (launchingNew) return;
    setLaunchingNew(true);
    try {
      const model = launchModel.trim();
      const label = selectedLaunchPlan.title?.trim() || selectedLaunchPlan.slug;
      const result = await launchOmpAgent({
        slug: null,
        planSlug: selectedLaunchPlan.slug,
        label,
        model: model || null,
      });
      if (result.ok) {
        toast.success(
          `OMP launched for ${label}${model ? ` (${model})` : ''}.`,
          { duration: 3000 },
        );
        setRefreshTick((t) => t + 1);
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunchingNew(false);
    }
  }, [launchModel, launchingNew, selectedLaunchPlan]);

  const focusRow = useCallback(async (row: SessionRow) => {
    if (!row.pid && !row.windowId) {
      toast.error('No pid or window id recorded for this session — cannot focus.');
      return;
    }
    try {
      const r = await fetch('/api/adv/sessions/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: row.id, pid: row.pid, windowId: row.windowId }),
      });
      const data = (await r.json().catch(() => null)) as
        | { status?: string; error?: string }
        | null;
      if (!r.ok || data?.status !== 'ok') {
        toast.error(`Focus failed: ${data?.error ?? `HTTP ${r.status}`}`);
        return;
      }
      toast.success('Window focused.', { duration: 2000 });
    } catch (e: unknown) {
      toast.error(`Focus failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Option A — open a fresh OMP at the same plan. No session id;
  // new conversation, same workspace context.
  const freshRow = useCallback(async (row: SessionRow) => {
    const result = await launchOmpAgent({
      slug: null,
      planSlug: row.planSlug,
      label: row.label ?? row.planSlug ?? `fresh-${row.id}`,
    });
    if (result.ok) {
      toast.success('OMP launched (fresh session).', { duration: 3000 });
      setRefreshTick((t) => t + 1);
    } else if (result.installCmd) {
      toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
    } else {
      toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
    }
  }, []);

  // Option B — resume an OMP session by id. The id is tracked
  // automatically: we prefer the row's PG-recorded `ompThreadId`
  // (populated by `resolveAndStoreOmpThreadIdForAdvSession`), and
  // fall back to the session header id from the loaded state. No
  // user prompt — if neither exists, the button is disabled and a
  // toast explains why on click.
  const resolveResumeId = useCallback(
    (row: SessionRow): string | null => {
      // 1. PG-stored thread id wins — it's the persisted, canonical link.
      const stored = row.ompThreadId?.trim();
      if (stored) return stored;
      // 2. Otherwise, the lazy summary's captured header id (works
      //    for any row that's been listed, not just the selected one).
      const summaryId = summaryByRowId[row.id]?.ompSessionId?.trim();
      if (summaryId) return summaryId;
      // 3. Last resort: in-memory header id from the loaded state
      //    (covers the freshly-selected case before the summary
      //    populates).
      if (selectedRow?.id === row.id) {
        const headerId = stateData?.state?.header.id?.trim();
        if (headerId) return headerId;
      }
      return null;
    },
    [selectedRow, stateData, summaryByRowId],
  );

  const resumeByIdRow = useCallback(async (row: SessionRow) => {
    const id = resolveResumeId(row);
    if (!id) {
      toast.error(
        'No OMP session id tracked for this row yet. Select the session first so the id can be loaded.',
      );
      return;
    }
    const result = await launchOmpAgent({
      slug: null,
      planSlug: row.planSlug,
      label: row.label ?? row.planSlug ?? `resume-${row.id}`,
      resumeSessionId: id,
    });
    if (result.ok) {
      toast.success(`OMP resumed (${id.slice(0, 12)}…).`, { duration: 3000 });
      setRefreshTick((t) => t + 1);
    } else if (result.installCmd) {
      toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
    } else {
      toast.error(`Resume failed: ${result.error ?? 'unknown error'}`);
    }
  }, [resolveResumeId]);

  // Filter rows before grouping:
  //   - drop OMP rows whose summary loaded with 0 user messages (the
  //     terminal opened but the user never typed; same noise category
  //     as dead-on-arrival, just discovered after the fact)
  //   - rows still loading are kept; they'll get filtered when the
  //     summary arrives
  const visibleRows = useMemo(() => {
    return (rows ?? []).filter((r) => {
      if (r.mode !== 'omp') return true;
      const s = summaryByRowId[r.id];
      if (!s?.loaded) return true;
      return s.userMessageCount > 0;
    });
  }, [rows, summaryByRowId]);

  const grouped = useMemo(() => groupRows(visibleRows), [visibleRows]);
  const stats = useMemo(() => summarizeRows(rows ?? []), [rows]);

  // If the user deep-links to a session inside a collapsed group,
  // auto-expand that group so the row is visible. Don't fight the
  // user — only adds keys, never removes.
  useEffect(() => {
    if (!selectedRow) return;
    const group = grouped.find((g) => g.rows.some((r) => r.id === selectedRow.id));
    if (!group) return;
    if (expandedGroups.includes(group.key)) return;
    void setExpandedGroups([...expandedGroups, group.key]);
  }, [selectedRow, grouped, expandedGroups, setExpandedGroups]);

  return (
    <div className="pc-adv-sessions">
      <header className="pc-adv-sessions__head">
        <div className="pc-adv-sessions__head-copy">
          <span className="pc-adv-sessions__kicker">Session recovery</span>
          <h2>Agent sessions</h2>
          <p className="pc-adv-sessions__subhead">
            View current and previous agent sessions, recover them or locate them on your desktop
          </p>
        </div>
        <div className="pc-adv-sessions__launch-card" aria-label="Launch a new OMP session">
          <div className="pc-adv-sessions__launch-copy">
            <strong>Start from plan context</strong>
            <span>Pick a plan and model; the new terminal opens with the right briefing.</span>
          </div>
          <div className="pc-adv-sessions__head-actions">
            <Select
              triggerClassName="pc-adv-sessions__select pc-adv-sessions__select--plan"
              value={launchPlanSlug ?? PLAN_SELECT_PLACEHOLDER}
              onChange={(value) => void setLaunchPlanSlug(value === PLAN_SELECT_PLACEHOLDER ? null : value)}
              disabled={planList.loading}
              ariaLabel="Plan for new session"
              options={launchPlanOptions}
            />
            <Select
              triggerClassName="pc-adv-sessions__select pc-adv-sessions__select--model"
              value={launchModel || MODEL_SELECT_DEFAULT}
              onChange={(value) => void setLaunchModel(value === MODEL_SELECT_DEFAULT ? '' : value)}
              ariaLabel="Model for new session"
              options={OMP_MODEL_OPTIONS}
            />
            <Button
              variant="primary"
              className="pc-adv-sessions__btn pc-adv-sessions__btn--primary pc-adv-sessions__launch-btn"
              onClick={launchNewSession}
              disabled={launchingNew || !selectedLaunchPlan}
            >
              {launchingNew ? 'Launching…' : 'Create new session'}
            </Button>
            <button
              type="button"
              className="pc-adv-sessions__refresh"
              onClick={() => setRefreshTick((t) => t + 1)}
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <div className="pc-adv-sessions__statstrip" aria-label="Session summary">
        <SummaryStat label="Sessions" value={rows ? stats.total : '—'} icon={<TerminalSquare size={15} />} />
        <SummaryStat label="Active" value={rows ? stats.active : '—'} icon={<Activity size={15} />} tone="active" />
        <SummaryStat label="OMP" value={rows ? stats.omp : '—'} icon={<Zap size={15} />} />
        <SummaryStat label="Plans" value={rows ? stats.planCount : '—'} icon={<FolderKanban size={15} />} />
      </div>
      {error ? <p className="pc-adv-sessions__error">Failed to load: {error}</p> : null}
      {rows === null && !error ? <p className="pc-adv-sessions__placeholder">Loading…</p> : null}
      {rows && rows.length === 0 ? (
        <p className="pc-adv-sessions__placeholder">
          No agent sessions recorded yet. Launches from the Plans tab will appear here.
        </p>
      ) : null}

      <div className="pc-adv-sessions__layout">
        <div className="pc-adv-sessions__listpane">
          {grouped.map((group) => {
            const isExpanded = expandedGroups.includes(group.key);
            const activeCount = group.rows.filter((r) => r.endedAt == null).length;
            return (
              <Collapsible.Root
                className="pc-adv-sessions__group"
                key={group.key}
                open={isExpanded}
                onOpenChange={(open) =>
                  void setExpandedGroups(
                    open
                      ? Array.from(new Set([...expandedGroups, group.key]))
                      : expandedGroups.filter((k) => k !== group.key),
                  )
                }
              >
                <Collapsible.Trigger asChild>
                  <button type="button" className="pc-adv-sessions__group-head">
                    <ChevronRight className="pc-adv-sessions__group-chevron" size={13} aria-hidden />
                    <span className="pc-adv-sessions__group-title">
                      {group.planSlug ?? '(no plan)'}
                    </span>
                    <span className="pc-adv-sessions__group-count">{group.rows.length}</span>
                    {activeCount > 0 ? (
                      <span className="pc-adv-sessions__group-active">
                        {activeCount} active
                      </span>
                    ) : (
                      <Tooltip label={`Last active ${new Date(group.lastActiveMs).toLocaleString()}`}>
                        <span className="pc-adv-sessions__group-last-active">
                          last active {formatLastActive(group.lastActiveMs)}
                        </span>
                      </Tooltip>
                    )}
                  </button>
                </Collapsible.Trigger>
                <Collapsible.Content className="pc-adv-sessions__group-content">
                  <ul className="pc-adv-sessions__list">
                    {group.rows.map((row) => {
                      const active = isActive(row);
                      const selected = selectedRow?.id === row.id;
                      return (
                        <li
                          key={row.id}
                          className={`pc-adv-sessions__row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
                        >
                          <button
                            type="button"
                            className="pc-adv-sessions__row-main"
                            onClick={() => void setSelectedSessionId(String(row.id))}
                          >
                            <span className="pc-adv-sessions__row-meta">
                              <span className={`pc-adv-sessions__badge pc-adv-sessions__badge--${row.mode}`}>
                                {row.mode}
                              </span>
                              <span className="pc-adv-sessions__row-label">
                                {row.label ?? row.terminalBin ?? `#${row.id}`}
                              </span>
                              <span className="pc-adv-sessions__row-times">
                                {formatCardDateTime(row.startedAt)}
                                {row.endedAt ? ` · ${formatCardDateTime(row.endedAt)}` : ''}
                              </span>
                            </span>
                            <RowUsagePills summary={summaryByRowId[row.id]} mode={row.mode} />
                          </button>
                          <div className="pc-adv-sessions__row-actions">
                            {active ? (
                              <button
                                type="button"
                                className="pc-adv-sessions__btn pc-adv-sessions__btn--primary"
                                onClick={() => focusRow(row)}
                              >
                                Focus window
                              </button>
                            ) : (
                              <>
                                <Tooltip label="Open a new OMP terminal at this plan (fresh conversation)">
                                  <button
                                    type="button"
                                    className="pc-adv-sessions__btn"
                                    onClick={() => freshRow(row)}
                                  >
                                    Fresh OMP
                                  </button>
                                </Tooltip>
                                {(() => {
                                  const resumeId = resolveResumeId(row);
                                  const resumeLabel = resumeId
                                    ? `Resume OMP with this session's tracked id (${resumeId.slice(0, 12)}…)`
                                    : 'No OMP session id tracked yet — select this session first.';
                                  return (
                                    <Tooltip label={resumeLabel}>
                                      <span className="pc-adv-sessions__tooltip-trigger">
                                        <button
                                          type="button"
                                          className="pc-adv-sessions__btn pc-adv-sessions__btn--primary"
                                          onClick={() => resumeByIdRow(row)}
                                          disabled={!resumeId}
                                        >
                                          Resume
                                        </button>
                                      </span>
                                    </Tooltip>
                                  );
                                })()}
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </Collapsible.Content>
              </Collapsible.Root>
            );
          })}
        </div>

        <SessionDetail
          row={selectedRow}
          stateData={stateData}
          loading={stateLoading}
          error={stateError}
          panel={activePanel}
          onPanelChange={(next) => void setPanel(next)}
          historyQuery={historyQuery}
          onHistoryQueryChange={(next) => void setHistoryQuery(next || null)}
          searchData={searchData}
          searchLoading={searchLoading}
          onRefresh={() => setRefreshTick((t) => t + 1)}
        />
      </div>

      <style>{`
        .pc-adv-sessions {
          display: grid;
          gap: 14px;
          padding: 18px;
          color: var(--fg-dim);
        }
        .pc-adv-sessions__head {
          display: grid;
          grid-template-columns: minmax(260px, 0.72fr) minmax(420px, 1.28fr);
          gap: 14px;
          align-items: stretch;
        }
        .pc-adv-sessions__head-copy,
        .pc-adv-sessions__launch-card {
          border: 1px solid var(--border);
          border-radius: 16px;
          background:
            radial-gradient(circle at top left, color-mix(in oklab, var(--accent), transparent 86%), transparent 34%),
            linear-gradient(180deg, color-mix(in oklab, var(--bg-2), white 4%), color-mix(in oklab, var(--bg), transparent 6%));
        }
        .pc-adv-sessions__head-copy {
          display: grid;
          align-content: center;
          gap: 6px;
          min-width: 0;
          padding: 16px;
        }
        .pc-adv-sessions__kicker {
          color: var(--accent);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.12em;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-adv-sessions__head h2 {
          margin: 0;
          color: var(--fg);
          font-size: 22px;
          font-weight: 760;
          letter-spacing: -0.02em;
          line-height: 1.08;
        }
        .pc-adv-sessions__subhead {
          margin: 0;
          max-width: 54ch;
          color: var(--fg-mute);
          font-size: 12px;
          line-height: 1.45;
        }
        .pc-adv-sessions__launch-card {
          display: grid;
          gap: 12px;
          padding: 14px;
        }
        .pc-adv-sessions__launch-copy {
          display: grid;
          gap: 3px;
        }
        .pc-adv-sessions__launch-copy strong {
          color: var(--fg);
          font-size: 13px;
        }
        .pc-adv-sessions__launch-copy span {
          color: var(--fg-mute);
          font-size: 12px;
        }
        .pc-adv-sessions__head-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          flex-wrap: wrap;
        }
        .pc-adv-sessions__statstrip {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
        }
        .pc-adv-sessions__stat {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: 14px;
          background: color-mix(in oklab, var(--bg-2), white 2%);
        }
        .pc-adv-sessions__stat.is-active {
          border-color: var(--border-strong);
          background: color-mix(in oklab, var(--accent), transparent 88%);
        }
        .pc-adv-sessions__stat-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 10px;
          color: var(--accent);
          background: color-mix(in oklab, var(--accent), transparent 88%);
          flex: 0 0 auto;
        }
        .pc-adv-sessions__stat-copy {
          display: grid;
          gap: 1px;
          min-width: 0;
        }
        .pc-adv-sessions__stat-copy strong {
          color: var(--fg);
          font-size: 18px;
          line-height: 1;
        }
        .pc-adv-sessions__stat-copy span {
          color: var(--fg-mute);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .pc-adv-sessions__layout {
          display: grid;
          grid-template-columns: minmax(360px, 0.92fr) minmax(420px, 1.08fr);
          gap: 16px;
          align-items: start;
        }
        .pc-adv-sessions__listpane,
        .pc-adv-sessions__detail {
          min-width: 0;
          border: 1px solid var(--border);
          border-radius: 16px;
          background:
            linear-gradient(180deg, color-mix(in oklab, var(--bg-2), white 2%), color-mix(in oklab, var(--bg), transparent 4%));
        }
        .pc-adv-sessions__listpane {
          max-height: calc(100vh - 320px);
          overflow: auto;
          padding: 10px;
          scrollbar-width: thin;
        }
        .pc-adv-sessions__select {
          display: inline-flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 32px;
          min-width: 132px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: color-mix(in oklab, var(--bg-2), white 4%);
          color: var(--fg);
          font: inherit;
          font-size: 12px;
          font-weight: 650;
          padding: 0 9px;
          cursor: pointer;
          outline: none;
        }
        .pc-adv-sessions__select:hover {
          border-color: var(--border-strong);
          background: var(--bg-3);
        }
        .pc-adv-sessions__select:focus-visible {
          outline: 2px solid color-mix(in oklab, var(--accent), transparent 30%);
          outline-offset: 2px;
        }
        .pc-adv-sessions__select[data-disabled] {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .pc-adv-sessions__select--plan {
          flex: 1 1 260px;
          min-width: min(100%, 260px);
          max-width: 420px;
        }
        .pc-adv-sessions__refresh,
        .pc-adv-sessions__btn {
          all: unset;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 30px;
          padding: 0 11px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: color-mix(in oklab, var(--bg-2), white 2%);
          color: var(--fg);
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease;
        }
        .pc-adv-sessions__refresh:hover,
        .pc-adv-sessions__btn:hover {
          border-color: var(--border-strong);
          background: var(--bg-3);
        }
        .pc-adv-sessions__refresh:focus-visible,
        .pc-adv-sessions__btn:focus-visible {
          outline: 2px solid color-mix(in oklab, var(--accent), transparent 28%);
          outline-offset: 2px;
        }
        .pc-adv-sessions__btn--primary {
          border-color: color-mix(in oklab, var(--accent), transparent 48%);
          background: color-mix(in oklab, var(--accent), var(--bg) 72%);
          color: var(--fg);
        }
        .pc-adv-sessions__launch-btn {
          min-width: 142px;
        }
        .pc-adv-sessions__btn:disabled {
          opacity: 0.48;
          cursor: not-allowed;
          transform: none;
        }
        .pc-adv-sessions__tooltip-trigger {
          display: inline-flex;
        }
        .pc-adv-sessions__error,
        .pc-adv-sessions__placeholder {
          margin: 0;
          padding: 12px;
          border-radius: 12px;
          background: color-mix(in oklab, var(--bg-2), white 2%);
          color: var(--fg-mute);
          font-size: 13px;
          line-height: 1.45;
        }
        .pc-adv-sessions__error {
          color: var(--bad);
          border: 1px solid color-mix(in oklab, var(--bad), transparent 58%);
          background: color-mix(in oklab, var(--bad), transparent 92%);
        }
        .pc-adv-sessions__group + .pc-adv-sessions__group {
          margin-top: 8px;
        }
        .pc-adv-sessions__group-head {
          all: unset;
          box-sizing: border-box;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 8px 9px;
          width: 100%;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: color-mix(in oklab, var(--bg-2), white 1%);
          transition: background-color 120ms ease, border-color 120ms ease;
        }
        .pc-adv-sessions__group-head:hover {
          background: var(--bg-3);
          border-color: var(--border-strong);
        }
        .pc-adv-sessions__group-head:focus-visible {
          outline: 2px solid color-mix(in oklab, var(--accent), transparent 30%);
          outline-offset: 2px;
        }
        .pc-adv-sessions__group-chevron {
          color: var(--fg-mute);
          flex: 0 0 auto;
          transition: transform 140ms ease, color 120ms ease;
        }
        .pc-adv-sessions__group-head[data-state="open"] .pc-adv-sessions__group-chevron {
          transform: rotate(90deg);
          color: var(--accent);
        }
        .pc-adv-sessions__group-title {
          color: var(--fg);
          font-size: 13px;
          font-weight: 740;
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pc-adv-sessions__group-count {
          color: var(--fg-mute);
          font-family: ui-monospace, monospace;
          font-size: 11px;
        }
        .pc-adv-sessions__group-active {
          padding: 2px 7px;
          border: 1px solid color-mix(in oklab, var(--accent), transparent 56%);
          border-radius: 999px;
          background: color-mix(in oklab, var(--accent), transparent 86%);
          color: var(--accent);
          font-size: 10px;
          font-weight: 750;
          letter-spacing: 0.04em;
        }
        .pc-adv-sessions__group-last-active {
          padding: 2px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: color-mix(in oklab, var(--fg-mute), transparent 88%);
          color: var(--fg-mute);
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.02em;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .pc-adv-sessions__group-content {
          padding: 7px 0 2px;
        }
        .pc-adv-sessions__list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: grid;
          gap: 7px;
        }
        .pc-adv-sessions__row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: center;
          gap: 12px;
          padding: 10px;
          border: 1px solid color-mix(in oklab, var(--border), transparent 25%);
          border-radius: 13px;
          background: color-mix(in oklab, var(--bg), white 2%);
          transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
        }
        .pc-adv-sessions__row:hover {
          border-color: var(--border-strong);
          background: color-mix(in oklab, var(--bg-3), var(--bg) 72%);
        }
        .pc-adv-sessions__row.is-active {
          border-color: color-mix(in oklab, var(--accent), transparent 48%);
          background: color-mix(in oklab, var(--accent), transparent 91%);
        }
        .pc-adv-sessions__row.is-selected {
          border-color: color-mix(in oklab, var(--warn), transparent 38%);
          box-shadow: 0 0 0 1px color-mix(in oklab, var(--warn), transparent 82%) inset;
        }
        .pc-adv-sessions__row-main {
          all: unset;
          cursor: pointer;
          min-width: 0;
          display: grid;
          gap: 6px;
        }
        .pc-adv-sessions__row-main:focus-visible {
          outline: 2px solid color-mix(in oklab, var(--accent), transparent 24%);
          outline-offset: 3px;
          border-radius: 8px;
        }
        .pc-adv-sessions__row-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          font-size: 12px;
        }
        .pc-adv-sessions__row-hint {
          color: var(--fg-mute);
          font-size: 11px;
        }
        .pc-adv-sessions__badge {
          padding: 2px 7px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 780;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .pc-adv-sessions__badge--omp {
          background: color-mix(in oklab, var(--accent), transparent 84%);
          color: var(--accent);
        }
        .pc-adv-sessions__badge--console {
          background: color-mix(in oklab, var(--warn), transparent 86%);
          color: var(--warn);
        }
        .pc-adv-sessions__row-label {
          color: var(--fg);
          font-size: 13px;
          font-weight: 700;
        }
        .pc-adv-sessions__row-times {
          color: var(--fg-mute);
        }
        .pc-adv-sessions__row-usage {
          display: flex;
          align-items: center;
          gap: 5px;
          flex-wrap: wrap;
        }
        .pc-adv-sessions__row-usage-pill {
          display: inline-block;
          padding: 2px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: color-mix(in oklab, var(--bg-2), white 2%);
          color: var(--fg-dim);
          font-family: ui-monospace, monospace;
          font-size: 10px;
          font-weight: 650;
          letter-spacing: 0.02em;
          white-space: nowrap;
        }
        .pc-adv-sessions__row-usage-pill--model {
          border-color: color-mix(in oklab, var(--accent), transparent 54%);
          background: color-mix(in oklab, var(--accent), transparent 86%);
          color: var(--accent);
        }
        .pc-adv-sessions__row-usage-pill--cost {
          border-color: color-mix(in oklab, var(--good), transparent 56%);
          background: color-mix(in oklab, var(--good), transparent 88%);
          color: var(--good);
        }
        .pc-adv-sessions__row-usage--loading .pc-adv-sessions__row-usage-pill {
          opacity: 0.5;
          background: transparent;
        }
        .pc-adv-sessions__row-pid,
        .pc-adv-sessions__mono {
          color: var(--fg-mute);
          font-family: ui-monospace, monospace;
          font-size: 11px;
          word-break: break-all;
        }
        .pc-adv-sessions__row-actions {
          display: flex;
          gap: 7px;
          flex-shrink: 0;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .pc-adv-sessions__detail {
          position: sticky;
          top: 12px;
          display: grid;
          grid-template-rows: auto auto minmax(0, 1fr);
          max-height: calc(100vh - 166px);
          overflow: hidden;
        }
        .pc-adv-sessions__detail-head {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 13px 14px;
          border-bottom: 1px solid var(--border);
          background: color-mix(in oklab, var(--bg-2), white 2%);
        }
        .pc-adv-sessions__detail-title {
          display: grid;
          gap: 4px;
          min-width: 0;
        }
        .pc-adv-sessions__detail-title h3 {
          margin: 0;
          color: var(--fg);
          font-size: 15px;
          line-height: 1.25;
        }
        .pc-adv-sessions__detail-sub {
          color: var(--fg-mute);
          font-size: 12px;
        }
        .pc-adv-sessions__panel-tabs {
          padding: 10px 12px;
          border-bottom: 1px solid var(--border);
        }
        .pc-adv-sessions__panel-tablist {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .pc-adv-sessions__panel-tab {
          all: unset;
          cursor: pointer;
          padding: 5px 9px;
          border: 1px solid var(--border);
          border-radius: 999px;
          color: var(--fg-dim);
          font-size: 11px;
          font-weight: 760;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .pc-adv-sessions__panel-tab:hover {
          border-color: var(--border-strong);
          color: var(--fg);
          background: var(--bg-3);
        }
        .pc-adv-sessions__panel-tab[aria-selected="true"],
        .pc-adv-sessions__panel-tab[data-state="active"] {
          border-color: var(--accent);
          background: var(--accent);
          color: var(--accent-ink);
        }
        .pc-adv-sessions__panel-tab:focus-visible {
          outline: 2px solid color-mix(in oklab, var(--accent), transparent 30%);
          outline-offset: 2px;
        }
        .pc-adv-sessions__panel {
          display: grid;
          gap: 12px;
          min-height: 0;
          overflow: auto;
          padding: 14px;
        }
        .pc-adv-sessions__cards {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 8px;
        }
        .pc-adv-sessions__card {
          display: grid;
          gap: 3px;
          padding: 10px;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: color-mix(in oklab, var(--bg-2), white 2%);
        }
        .pc-adv-sessions__card-label {
          color: var(--fg-mute);
          font-size: 10px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .pc-adv-sessions__card-value {
          color: var(--fg);
          font-size: 14px;
          font-weight: 760;
        }
        .pc-adv-sessions__section {
          display: grid;
          gap: 8px;
        }
        .pc-adv-sessions__section h4 {
          margin: 0;
          color: var(--fg);
          font-size: 12px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .pc-adv-sessions__snippet-list {
          display: grid;
          gap: 7px;
        }
        .pc-adv-sessions__snippet,
        .pc-adv-sessions__todo-phase,
        .pc-adv-sessions__data-list {
          border: 1px solid var(--border);
          border-radius: 12px;
          background: color-mix(in oklab, var(--bg-2), white 1%);
        }
        .pc-adv-sessions__snippet {
          padding: 9px;
        }
        .pc-adv-sessions__snippet-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 4px;
          color: var(--fg-mute);
          font-size: 11px;
        }
        .pc-adv-sessions__snippet-text {
          margin: 0;
          color: var(--fg-dim);
          font-size: 12px;
          line-height: 1.45;
          white-space: pre-wrap;
        }
        .pc-adv-sessions__todo-phase {
          padding: 10px;
        }
        .pc-adv-sessions__todo-phase h4 {
          margin: 0 0 7px;
          color: var(--fg);
          font-size: 13px;
        }
        .pc-adv-sessions__todo-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: grid;
          gap: 5px;
        }
        .pc-adv-sessions__todo-item {
          color: var(--fg-dim);
          font-size: 12px;
        }
        .pc-adv-sessions__todo-item[data-status="completed"] { color: var(--good); }
        .pc-adv-sessions__todo-item[data-status="in_progress"] { color: var(--warn); }
        .pc-adv-sessions__todo-item[data-status="abandoned"] { color: var(--bad); }
        .pc-adv-sessions__data-list {
          overflow: hidden;
        }
        .pc-adv-sessions__data-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          align-items: center;
          padding: 8px 10px;
          color: var(--fg-dim);
          font-size: 12px;
        }
        .pc-adv-sessions__data-row + .pc-adv-sessions__data-row {
          border-top: 1px solid var(--border);
        }
        .pc-adv-sessions__data-row strong {
          color: var(--fg);
        }
        .pc-adv-sessions__data-row--head {
          color: var(--fg-mute);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .pc-adv-sessions__data-list--tools .pc-adv-sessions__data-row {
          grid-template-columns: minmax(150px, 1.4fr) repeat(3, minmax(56px, 0.45fr)) minmax(112px, 0.8fr);
        }
        .pc-adv-sessions__bad {
          color: var(--bad);
          font-weight: 750;
        }
        .pc-adv-sessions__search {
          display: flex;
          gap: 8px;
        }
        .pc-adv-sessions__search input {
          flex: 1;
          min-width: 0;
        }
        @media (max-width: 1100px) {
          .pc-adv-sessions__head,
          .pc-adv-sessions__layout {
            grid-template-columns: 1fr;
          }
          .pc-adv-sessions__detail {
            position: static;
            max-height: none;
          }
          .pc-adv-sessions__listpane {
            max-height: none;
          }
        }
        @media (max-width: 720px) {
          .pc-adv-sessions {
            padding: 12px;
          }
          .pc-adv-sessions__statstrip {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .pc-adv-sessions__head-actions,
          .pc-adv-sessions__row {
            align-items: stretch;
            grid-template-columns: 1fr;
          }
          .pc-adv-sessions__select,
          .pc-adv-sessions__btn,
          .pc-adv-sessions__refresh,
          .pc-adv-sessions__tooltip-trigger {
            width: 100%;
          }
          .pc-adv-sessions__row-actions {
            justify-content: stretch;
          }
          .pc-adv-sessions__data-list--tools .pc-adv-sessions__data-row {
            grid-template-columns: 1fr 1fr;
          }
          .pc-adv-sessions__data-row--head {
            display: none;
          }
        }
      `}</style>
    </div>
  );
}

function SessionDetail({
  row,
  stateData,
  loading,
  error,
  panel,
  onPanelChange,
  historyQuery,
  onHistoryQueryChange,
  searchData,
  searchLoading,
  onRefresh,
}: {
  row: SessionRow | null;
  stateData: SessionStateResponse | null;
  loading: boolean;
  error: string | null;
  panel: SessionPanel;
  onPanelChange: (panel: SessionPanel) => void;
  historyQuery: string;
  onHistoryQueryChange: (query: string) => void;
  searchData: SessionSearchResponse | null;
  searchLoading: boolean;
  onRefresh: () => void;
}) {
  if (!row) {
    return (
      <aside className="pc-adv-sessions__detail">
        <div className="pc-adv-sessions__panel">
          <p className="pc-adv-sessions__placeholder">
            Select a session to inspect its OMP transcript state, todos, tools, Hindsight config, and handoff context.
          </p>
        </div>
      </aside>
    );
  }

  const state = stateData?.state ?? null;
  const title = state?.header.title || row.label || row.planSlug || `Session #${row.id}`;

  return (
    <aside className="pc-adv-sessions__detail">
      <header className="pc-adv-sessions__detail-head">
        <div className="pc-adv-sessions__detail-title">
          <h3>{title}</h3>
          <span className="pc-adv-sessions__detail-sub">
            {row.mode} · started {formatDate(row.startedAt)}
            {state?.header.id ? ` · ${state.header.id.slice(0, 13)}…` : ''}
          </span>
        </div>
        <button type="button" className="pc-adv-sessions__refresh" onClick={onRefresh}>
          Reload state
        </button>
      </header>

      <Tabs.Root
        value={panel}
        onValueChange={(value) => onPanelChange(value as SessionPanel)}
        className="pc-adv-sessions__panel-tabs"
      >
        <Tabs.List className="pc-adv-sessions__panel-tablist" aria-label="Session detail panels">
          {SESSION_PANELS.map((p) => (
            <Tabs.Trigger key={p.value} value={p.value} className="pc-adv-sessions__panel-tab">
              {p.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>

      <div className="pc-adv-sessions__panel">
        {loading ? <p className="pc-adv-sessions__placeholder">Loading OMP session state…</p> : null}
        {error ? <p className="pc-adv-sessions__error">Failed to load OMP state: {error}</p> : null}
        {!loading && !error && row.mode !== 'omp' ? (
          <p className="pc-adv-sessions__placeholder">
            This is a console session, not an OMP transcript. Focus or resume controls still work; OMP state panels apply to OMP rows.
          </p>
        ) : null}
        {!loading && !error && row.mode === 'omp' && !state ? (
          <p className="pc-adv-sessions__placeholder">
            No matching OMP JSONL session found yet. If this terminal just launched, wait for OMP to write its session header and refresh.
          </p>
        ) : null}
        {state ? (
          <SessionPanelContent
            panel={panel}
            row={row}
            stateData={stateData}
            historyQuery={historyQuery}
            onHistoryQueryChange={onHistoryQueryChange}
            searchData={searchData}
            searchLoading={searchLoading}
          />
        ) : null}
      </div>
    </aside>
  );
}

function SessionPanelContent({
  panel,
  row,
  stateData,
  historyQuery,
  onHistoryQueryChange,
  searchData,
  searchLoading,
}: {
  panel: SessionPanel;
  row: SessionRow;
  stateData: SessionStateResponse | null;
  historyQuery: string;
  onHistoryQueryChange: (query: string) => void;
  searchData: SessionSearchResponse | null;
  searchLoading: boolean;
}) {
  const state = stateData?.state;
  if (!state) return null;

  if (panel === 'todos') return <TodosPanel phases={state.todos} />;
  if (panel === 'tools') return <ToolsPanel tools={state.toolCounts} />;
  if (panel === 'jobs') return <SnippetPanel title="Job tool events" empty="No persisted job tool events in this session." snippets={state.jobs} />;
  if (panel === 'goal') return <SnippetPanel title="Goal tool events" empty="No persisted goal tool events in this session." snippets={state.goals} />;
  if (panel === 'memory') return <MemoryPanel memory={stateData?.memory} />;
  if (panel === 'context') return <ContextPanel row={row} stateData={stateData} state={state} />;
  if (panel === 'handoff') {
    return (
      <>
        <SnippetPanel title="Handoffs" empty="No handoff entries found in this session." snippets={state.handoffs} />
        <SnippetPanel title="Compactions" empty="No compaction entries found in this session." snippets={state.compactions} />
      </>
    );
  }
  if (panel === 'history') {
    return (
      <HistoryPanel
        query={historyQuery}
        onQueryChange={onHistoryQueryChange}
        latestMessages={state.latestMessages}
        searchData={searchData}
        loading={searchLoading}
      />
    );
  }

  const usage = normalizeUsage(state.usage);
  const models = state.models ?? [];
  return (
    <>
      <div className="pc-adv-sessions__cards">
        <MetricCard label="Model" value={formatModelLabel(state.latestModel ?? null) ?? '—'} />
        <MetricCard label="Total tokens" value={formatCompactNumber(usage.totalTokens)} />
        <MetricCard label="Cost (USD)" value={formatCostUsd(usage.totalCostUsd)} />
        <MetricCard label="Messages" value={state.messages.total} />
        <MetricCard label="User turns" value={state.messages.user} />
        <MetricCard label="Tool results" value={state.messages.toolResults} />
      </div>
      {usage.assistantTurnsWithUsage > 0 ? (
        <div className="pc-adv-sessions__cards">
          <MetricCard label="Input tokens" value={formatCompactNumber(usage.inputTokens)} />
          <MetricCard label="Output tokens" value={formatCompactNumber(usage.outputTokens)} />
          <MetricCard label="Cache read" value={formatCompactNumber(usage.cacheReadTokens)} />
          <MetricCard label="Cache write" value={formatCompactNumber(usage.cacheWriteTokens)} />
        </div>
      ) : null}
      {models.length > 1 ? (
        <div className="pc-adv-sessions__section">
          <h4>Models used</h4>
          <p className="pc-adv-sessions__snippet-text">{models.map(formatModelLabel).join(' → ')}</p>
        </div>
      ) : null}
      <div className="pc-adv-sessions__section">
        <h4>OMP session</h4>
        <div className="pc-adv-sessions__snippet">
          <div className="pc-adv-sessions__snippet-meta">
            <span>{state.header.id}</span>
            <span>{formatDate(state.header.timestamp)}</span>
            {stateData?.match ? (
              <span>
                match {stateData.match.matchKind} · {Math.round(stateData.match.timeDriftMs / 1000)}s drift
              </span>
            ) : null}
          </div>
          <p className="pc-adv-sessions__snippet-text">
            {state.header.title || '(untitled)'}{'\n'}
            cwd: <span className="pc-adv-sessions__mono">{state.header.cwd}</span>{'\n'}
            file: <span className="pc-adv-sessions__mono">{state.filePath}</span>{'\n'}
            adv row: #{row.id} · plan {row.planSlug ?? '(none)'}
          </p>
        </div>
      </div>
      <SnippetPanel title="Latest transcript snippets" empty="No messages found." snippets={state.latestMessages} />
    </>
  );
}

function ContextPanel({
  row,
  stateData,
  state,
}: {
  row: SessionRow;
  stateData: SessionStateResponse | null;
  state: OmpSessionState;
}) {
  const effectiveAdv = stateData?.advSession ?? row;
  const match = stateData?.match;
  const counts = Object.entries(state.countsByType).sort((a, b) => b[1] - a[1]);
  const searchInstruction =
    `Use omp:sessions op='search' sessionId='${state.header.id}' query='<decision/error/file>' ` +
    `or open /adv/sessions?session=${row.id}&panel=history&q=<query>.`;
  return (
    <>
      <div className="pc-adv-sessions__section">
        <h4>Successor context pointer</h4>
        <div className="pc-adv-sessions__snippet">
          <p className="pc-adv-sessions__snippet-text">
            If the next agent needs context for a decision, search this origin OMP session before guessing.{'\n'}
            <span className="pc-adv-sessions__mono">{searchInstruction}</span>
          </p>
        </div>
      </div>

      <div className="pc-adv-sessions__section">
        <h4>Identity and linkage</h4>
        <div className="pc-adv-sessions__snippet">
          <p className="pc-adv-sessions__snippet-text">
            adv row: #{row.id} · plan {row.planSlug ?? '(none)'} · pid {row.pid ?? '—'}{'\n'}
            stored omp_thread_id: <span className="pc-adv-sessions__mono">{effectiveAdv.ompThreadId ?? 'not linked yet'}</span>{'\n'}
            current OMP id: <span className="pc-adv-sessions__mono">{state.header.id}</span>{'\n'}
            match: {match ? `${match.matchKind} · ${Math.round(match.timeDriftMs / 1000)}s drift` : 'direct id'}{'\n'}
            cwd: <span className="pc-adv-sessions__mono">{state.header.cwd}</span>{'\n'}
            file: <span className="pc-adv-sessions__mono">{state.filePath}</span>
          </p>
        </div>
      </div>

      <div className="pc-adv-sessions__section">
        <h4>Persisted entry types</h4>
        {counts.length === 0 ? (
          <p className="pc-adv-sessions__placeholder">No persisted entries found.</p>
        ) : (
          <div className="pc-adv-sessions__data-list" role="list">
            {counts.map(([type, count]) => (
              <div className="pc-adv-sessions__data-row" role="listitem" key={type}>
                <span className="pc-adv-sessions__mono">{type}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function TodosPanel({ phases }: { phases: OmpTodoPhase[] }) {
  if (phases.length === 0) {
    return <p className="pc-adv-sessions__placeholder">No todo_write state found in this session.</p>;
  }
  return (
    <div className="pc-adv-sessions__section">
      {phases.map((phase) => (
        <div className="pc-adv-sessions__todo-phase" key={phase.name}>
          <h4>{phase.name}</h4>
          <ul className="pc-adv-sessions__todo-list">
            {phase.tasks.map((task) => (
              <li className="pc-adv-sessions__todo-item" data-status={task.status} key={`${phase.name}:${task.content}`}>
                {statusGlyph(task.status)} {task.content}
                {task.notes?.length ? ` (+${task.notes.length} note${task.notes.length === 1 ? '' : 's'})` : ''}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ToolsPanel({ tools }: { tools: OmpToolSummary[] }) {
  if (tools.length === 0) {
    return <p className="pc-adv-sessions__placeholder">No tool results found in this session.</p>;
  }
  return (
    <div className="pc-adv-sessions__data-list pc-adv-sessions__data-list--tools" role="list">
      <div className="pc-adv-sessions__data-row pc-adv-sessions__data-row--head" aria-hidden>
        <span>Tool</span>
        <span>Calls</span>
        <span>Results</span>
        <span>Errors</span>
        <span>Last used</span>
      </div>
      {tools.map((tool) => (
        <div className="pc-adv-sessions__data-row pc-adv-sessions__data-row--tools" role="listitem" key={tool.toolName}>
          <span className="pc-adv-sessions__mono">{tool.toolName}</span>
          <strong>{tool.calls}</strong>
          <span>{tool.results}</span>
          <span className={tool.errors > 0 ? 'pc-adv-sessions__bad' : undefined}>{tool.errors}</span>
          <span>{tool.lastUsedAt ? formatDate(tool.lastUsedAt) : '—'}</span>
        </div>
      ))}
    </div>
  );
}

function MemoryPanel({ memory }: { memory: OmpMemoryState | undefined }) {
  if (!memory) return <p className="pc-adv-sessions__placeholder">Memory config unavailable.</p>;
  if (memory.ok === false) {
    return <p className="pc-adv-sessions__error">Could not read OMP memory config: {memory.error}</p>;
  }
  const hindsight = memory.hindsight ?? {};
  return (
    <>
      <div className="pc-adv-sessions__cards">
        <MetricCard label="Backend" value={String(memory.backend ?? 'unknown')} />
        <MetricCard label="Auto recall" value={String(hindsight.autoRecall ?? 'unknown')} />
        <MetricCard label="Auto retain" value={String(hindsight.autoRetain ?? 'unknown')} />
        <MetricCard label="Scoping" value={String(hindsight.scoping ?? 'unknown')} />
      </div>
      <div className="pc-adv-sessions__section">
        <h4>Hindsight</h4>
        <div className="pc-adv-sessions__snippet">
          <p className="pc-adv-sessions__snippet-text">
            apiUrl: <span className="pc-adv-sessions__mono">{String(hindsight.apiUrl ?? 'unset')}</span>{'\n'}
            retainMode: {String(hindsight.retainMode ?? 'unknown')}{'\n'}
            recallBudget: {String(hindsight.recallBudget ?? 'unknown')}{'\n'}
            recallMaxTokens: {String(hindsight.recallMaxTokens ?? 'unknown')}
          </p>
        </div>
      </div>
    </>
  );
}

function HistoryPanel({
  query,
  onQueryChange,
  latestMessages,
  searchData,
  loading,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  latestMessages: OmpMessageSnippet[];
  searchData: SessionSearchResponse | null;
  loading: boolean;
}) {
  const trimmed = query.trim();
  return (
    <>
      <div className="pc-adv-sessions__search">
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search this OMP transcript for decisions, errors, files…"
          aria-label="Search OMP session history"
        />
      </div>
      {loading ? <p className="pc-adv-sessions__placeholder">Searching…</p> : null}
      {searchData?.ok === false && searchData.error ? (
        <p className="pc-adv-sessions__error">Search failed: {searchData.error}</p>
      ) : null}
      {trimmed.length > 0 && !loading ? (
        <div className="pc-adv-sessions__section">
          <h4>
            Search results
            {searchData ? ` · ${searchData.matches.length}${searchData.truncated ? '+' : ''}` : ''}
          </h4>
          {searchData && searchData.matches.length > 0 ? (
            <div className="pc-adv-sessions__snippet-list">
              {searchData.matches.map((match) => (
                <div className="pc-adv-sessions__snippet" key={`${match.session.id}:${match.line}:${match.entryId ?? ''}`}>
                  <div className="pc-adv-sessions__snippet-meta">
                    <span>line {match.line}</span>
                    <span>{match.role ?? match.type}</span>
                    {match.toolName ? <span>{match.toolName}</span> : null}
                    {match.timestamp ? <span>{formatDate(match.timestamp)}</span> : null}
                  </div>
                  <p className="pc-adv-sessions__snippet-text">{match.snippet}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="pc-adv-sessions__placeholder">No matches.</p>
          )}
        </div>
      ) : null}
      {trimmed.length === 0 ? (
        <SnippetPanel title="Latest transcript snippets" empty="No messages found." snippets={latestMessages} />
      ) : null}
    </>
  );
}

function SnippetPanel({
  title,
  empty,
  snippets,
}: {
  title: string;
  empty: string;
  snippets: OmpMessageSnippet[];
}) {
  return (
    <div className="pc-adv-sessions__section">
      <h4>{title}</h4>
      {snippets.length === 0 ? (
        <p className="pc-adv-sessions__placeholder">{empty}</p>
      ) : (
        <div className="pc-adv-sessions__snippet-list">
          {snippets.map((snippet, index) => (
            <div className="pc-adv-sessions__snippet" key={`${snippet.id ?? index}:${snippet.timestamp ?? ''}`}>
              <div className="pc-adv-sessions__snippet-meta">
                <span>{snippet.role}</span>
                {snippet.toolName ? <span>{snippet.toolName}</span> : null}
                {snippet.isError ? <span>error</span> : null}
                {snippet.timestamp ? <span>{formatDate(snippet.timestamp)}</span> : null}
              </div>
              <p className="pc-adv-sessions__snippet-text">{snippet.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Inline pills on the row card — model + tokens + cost. Quiet
 *  placeholder while the lazy summary load is in flight; nothing
 *  rendered for console rows (no JSONL → no usage). */
function RowUsagePills({
  summary,
  mode,
}: {
  summary: RowSummary | undefined;
  mode: 'omp' | 'console';
}) {
  if (mode !== 'omp') return null;
  if (!summary || !summary.loaded) {
    return (
      <span className="pc-adv-sessions__row-usage pc-adv-sessions__row-usage--loading">
        <span className="pc-adv-sessions__row-usage-pill">loading usage…</span>
      </span>
    );
  }
  const modelLabel = formatModelLabel(summary.model);
  return (
    <span className="pc-adv-sessions__row-usage">
      {modelLabel ? (
        <span
          className="pc-adv-sessions__row-usage-pill pc-adv-sessions__row-usage-pill--model"
          title={summary.model ?? undefined}
        >
          {modelLabel}
        </span>
      ) : null}
      {summary.totalTokens > 0 ? (
        <span className="pc-adv-sessions__row-usage-pill" title="Total tokens (input + output + cache)">
          {formatCompactNumber(summary.totalTokens)} tok
        </span>
      ) : null}
      {summary.totalCostUsd > 0 ? (
        <span className="pc-adv-sessions__row-usage-pill pc-adv-sessions__row-usage-pill--cost" title="USD cost reported by OMP">
          {formatCostUsd(summary.totalCostUsd)}
        </span>
      ) : null}
    </span>
  );
}
function SummaryStat({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  tone?: 'active';
}) {
  return (
    <div className={`pc-adv-sessions__stat${tone === 'active' ? ' is-active' : ''}`}>
      <span className="pc-adv-sessions__stat-icon" aria-hidden>{icon}</span>
      <span className="pc-adv-sessions__stat-copy">
        <strong>{value}</strong>
        <span>{label}</span>
      </span>
    </div>
  );
}

function summarizeRows(rows: SessionRow[]) {
  const planKeys = new Set<string>();
  let active = 0;
  let omp = 0;
  let linked = 0;
  for (const row of rows) {
    planKeys.add(row.planSlug ?? '(no plan)');
    if (row.endedAt == null) active += 1;
    if (row.mode === 'omp') omp += 1;
    if (row.ompThreadId?.trim()) linked += 1;
  }
  return {
    total: rows.length,
    active,
    omp,
    linked,
    planCount: planKeys.size,
  };
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="pc-adv-sessions__card">
      <span className="pc-adv-sessions__card-label">{label}</span>
      <span className="pc-adv-sessions__card-value">{value}</span>
    </div>
  );
}

function isSessionPanel(value: string): value is SessionPanel {
  return SESSION_PANELS.some((panel) => panel.value === value);
}

function statusGlyph(status: OmpTodoItem['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '→';
  if (status === 'abandoned') return '✕';
  return '○';
}

/** Most-recent activity timestamp for a row: endedAt when set,
 *  otherwise startedAt. Used to sort groups + render the
 *  "last active" pill on inactive groups. */
function rowActivityMs(r: SessionRow): number {
  const stamp = r.endedAt ?? r.startedAt;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : 0;
}

interface GroupRow {
  key: string;
  planSlug: string | null;
  rows: SessionRow[];
  /** Most-recent activity across all rows in the group. Drives the
   *  group sort (newest first) and the "last active" pill. */
  lastActiveMs: number;
}

function groupRows(rows: SessionRow[]): GroupRow[] {
  const map = new Map<string, { planSlug: string | null; rows: SessionRow[] }>();
  for (const r of rows) {
    const key = r.planSlug ?? '_';
    let g = map.get(key);
    if (!g) {
      g = { planSlug: r.planSlug, rows: [] };
      map.set(key, g);
    }
    g.rows.push(r);
  }
  const groups: GroupRow[] = Array.from(map.entries()).map(([key, g]) => ({
    key,
    planSlug: g.planSlug,
    rows: g.rows,
    lastActiveMs: g.rows.reduce((acc, r) => Math.max(acc, rowActivityMs(r)), 0),
  }));
  // Most-recently-active plans first.
  groups.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return groups;
}

/** Compact "last active" label — same shape as the row times. */
function formatLastActive(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const ageMs = Date.now() - ms;
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (ageMs < 2 * minute) return 'just now';
  if (ageMs < hour) return `${Math.floor(ageMs / minute)}m ago`;
  if (ageMs < day) return `${Math.floor(ageMs / hour)}h ago`;
  if (ageMs < 30 * day) return `${Math.floor(ageMs / day)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  });
}

/** Compact human-readable model label: "claude-opus-4-7" → "Opus 4.7".
 *  Falls through to the raw id for unknowns so unfamiliar providers
 *  still surface something. Null pass-through. */
function formatModelLabel(model: string | null): string | null {
  if (!model) return null;
  // Anthropic: claude-{family}-{version}[-suffix]
  const m = /^claude-(opus|sonnet|haiku)-?(\d[\w.-]*)?/i.exec(model);
  if (m) {
    const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
    const ver = m[2] ? ` ${m[2].replace(/-/g, '.')}` : '';
    return `${family}${ver}`;
  }
  // GPT: gpt-{ver}[-suffix]
  const g = /^gpt-?(\d[\w.-]*)/i.exec(model);
  if (g) return `GPT-${g[1]!.replace(/-/g, '.')}`;
  return model;
}

/** 12345 → "12.3K"; 1234567 → "1.23M". Whole numbers under 1k stay bare. */
function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** USD with sensible precision: <$0.01 → "<$0.01"; <$1 → "$0.123";
 *  ≥$1 → "$12.34". Zero pass-through. */
function formatCostUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '$0';
  if (amount < 0.01) return '<$0.01';
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}
function formatCardDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString(undefined, {
      month: 'numeric',
      day: 'numeric',
    });
    const time = d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}