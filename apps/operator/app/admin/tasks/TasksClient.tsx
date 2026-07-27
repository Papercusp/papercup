'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { useQueryState, parseAsBoolean, parseAsString } from 'nuqs';

/**
 * /admin/tasks — the Task Manager pane
 * (task-manager-no-escape-2026-07-27, P-018).
 *
 * Deliberately modelled on /admin/schedules, because they are the same idea one
 * axis apart: that page is the inventory of everything RECURRING, this is the
 * inventory of everything RUNNING. Same posture too — self-fetching client, nuqs-
 * backed filters so agents and deep links work, and READ-ONLY. The kill/freeze/
 * limit verbs are capability-gated MCP tools; a dashboard fetch must not be able to
 * end someone's work.
 *
 * What this shows that no process table can: WHO launched each task, for which
 * work-item, under what budget, and what it is costing right now. The `unaccounted`
 * bucket at the top is the no-escape signal — processes inside our cgroup slice
 * that no chokepoint registered.
 */

type Row = {
  taskId: string;
  parentTaskId: string | null;
  rootTaskId: string;
  class: string;
  title: string;
  state: string;
  launchedBy: string;
  workItemId: string | null;
  planSlug: string | null;
  startedAt: string;
  endedAt: string | null;
  confined: boolean;
  scopeUnit: string | null;
  rssBytes: number | null;
  peakRssBytes: number | null;
  cpuUsec: number | null;
  pids: number | null;
  memoryMaxBytes: number | null;
  deadlineAt: string | null;
  exitCode: number | null;
  exitReason: string | null;
  logPath: string | null;
};

type Live = {
  alive?: number;
  stranded?: number;
  unaccounted?: number;
  unaccountedPids?: number;
  foreign?: number;
  overdue?: number;
  degraded?: boolean;
  degradedReason?: string;
  scan?: { ownedRootExists: boolean; ownedTruncated: boolean; foreignTruncated: boolean; processes: number };
  unaccounted_?: never;
  unaccountedGroups?: { cgroupPath: string; pids: number[]; sample: string }[];
  error?: string;
};

type Payload = {
  enabled: boolean;
  summary: { total: number; byState: Record<string, number>; byClass: Record<string, number> };
  live: (Live & { unaccounted?: number | { cgroupPath: string; pids: number[]; sample: string }[] }) | null;
  rows: Row[];
};

// ── pure formatters (exported for tests) ────────────────────────────────────

/** Bytes → a human size. `null` renders as an em-dash, NEVER as 0 — a fabricated
 *  zero reads as a real measurement in a pane whose job is finding what eats RAM. */
export const fmtBytes = (b: number | null): string => {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

export const fmtCpu = (usec: number | null): string =>
  usec == null ? '—' : usec < 1_000_000 ? `${Math.round(usec / 1000)} ms` : `${Math.round(usec / 1_000_000)} s`;

/** ISO → a compact age. The pane cares about "how long has this been running",
 *  not the wall-clock instant it started. */
export const fmtAge = (iso: string): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
};

export const stateColor = (state: string): string => {
  switch (state) {
    case 'running':
      return 'var(--accent)';
    case 'pending':
      return 'var(--warn)';
    case 'unaccounted':
      return 'var(--danger, #e5484d)';
    case 'stranded':
    case 'timed_out':
      return 'var(--warn)';
    case 'foreign':
      return 'var(--muted, #888)';
    default:
      return 'var(--fg)';
  }
};

const mono: CSSProperties = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 };
const cell: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border, #2a2a2a)', ...mono };
const head: CSSProperties = { ...cell, fontWeight: 600, position: 'sticky', top: 0, background: 'var(--bg, #111)' };

export default function TasksClient(): ReactElement {
  const [stateFilter, setStateFilter] = useQueryState('state', parseAsString);
  const [classFilter, setClassFilter] = useQueryState('class', parseAsString);
  const [includeEnded, setIncludeEnded] = useQueryState('ended', parseAsBoolean.withDefault(false));
  const [liveView, setLiveView] = useQueryState('live', parseAsBoolean.withDefault(true));

  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (stateFilter) qs.set('state', stateFilter);
    if (classFilter) qs.set('class', classFilter);
    if (includeEnded) qs.set('includeEnded', '1');
    if (liveView) qs.set('live', '1');
    try {
      const res = await fetch(`/api/admin/tasks/inventory?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as Payload);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [stateFilter, classFilter, includeEnded, liveView]);

  useEffect(() => {
    void load();
    // A pane whose whole purpose is "what is happening right now" has to refresh.
    // 5s matches the reconciler's 30s cadence closely enough to feel live without
    // hammering a scan on every tick.
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const live = data?.live ?? null;
  const unaccountedGroups = useMemo(() => {
    const u = live && 'unaccounted' in live ? (live as { unaccounted?: unknown }).unaccounted : undefined;
    return Array.isArray(u) ? (u as { cgroupPath: string; pids: number[]; sample: string }[]) : [];
  }, [live]);

  if (data && !data.enabled) {
    return (
      <div style={{ padding: 24, ...mono }}>
        Task manager is disabled (<code>papercusp-task-manager</code> is off). Spawns still run — they are just
        unconfined and unledgered. Flip it at <a href="/admin/features">/admin/features</a>.
      </div>
    );
  }

  return (
    <div style={{ padding: 16, ...mono }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Task Manager</h1>
      <p style={{ opacity: 0.7, marginBottom: 12, maxWidth: 780 }}>
        Every task this operator launched, with the provenance a process table cannot give: who started it, for which
        work-item, under what budget, and what it costs. Read-only — kill / freeze / limit are the{' '}
        <code>processes:*</code> tools.
      </p>

      {error && <div style={{ color: 'var(--danger, #e5484d)', marginBottom: 12 }}>Load failed: {error}</div>}

      {/* The no-escape signal, first, because it is the one thing here that means
          something is wrong rather than merely busy. */}
      {live?.degraded && (
        <div style={{ ...cell, border: '1px solid var(--warn)', marginBottom: 12 }}>
          ⚠ Live scan degraded — {live.degradedReason}. The ledger below is still shown, but nothing is being closed
          out while the scan cannot be trusted.
        </div>
      )}
      {unaccountedGroups.length > 0 && (
        <div style={{ marginBottom: 16, border: '1px solid var(--danger, #e5484d)', borderRadius: 4 }}>
          <div style={{ ...cell, fontWeight: 600, color: 'var(--danger, #e5484d)', borderBottom: 'none' }}>
            {unaccountedGroups.length} unaccounted cgroup(s) — running inside our slice with no ledger row
          </div>
          {unaccountedGroups.slice(0, 8).map((g) => (
            <div key={g.cgroupPath} style={{ ...cell, opacity: 0.85 }}>
              <div>{g.cgroupPath}</div>
              <div style={{ opacity: 0.7 }}>
                {g.pids.length} pid(s) · {g.sample}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label>
          state{' '}
          <select value={stateFilter ?? ''} onChange={(e) => void setStateFilter(e.target.value || null)}>
            <option value="">all</option>
            {['pending', 'running', 'exited', 'killed', 'timed_out', 'stranded', 'unaccounted'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          class{' '}
          <select value={classFilter ?? ''} onChange={(e) => void setClassFilter(e.target.value || null)}>
            <option value="">all</option>
            {Object.keys(data?.summary.byClass ?? {}).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={includeEnded} onChange={(e) => void setIncludeEnded(e.target.checked)} />{' '}
          include finished
        </label>
        <label>
          <input type="checkbox" checked={liveView} onChange={(e) => void setLiveView(e.target.checked)} /> live
          kernel scan
        </label>
        <span style={{ opacity: 0.6, marginLeft: 'auto' }}>
          {data?.summary.total ?? 0} row(s)
          {live?.scan ? ` · ${live.scan.processes} process(es) scanned` : ''}
          {live?.foreign ? ` · ${live.foreign} foreign group(s)` : ''}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1100 }}>
          <thead>
            <tr>
              {['state', 'class', 'title', 'launched by', 'work-item', 'age', 'rss', 'peak', 'cpu', 'pids', 'conf'].map(
                (h) => (
                  <th key={h} style={{ ...head, textAlign: 'left' }}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((r) => (
              <tr key={r.taskId} title={`${r.taskId}${r.scopeUnit ? ` · ${r.scopeUnit}` : ''}`}>
                <td style={{ ...cell, color: stateColor(r.state) }}>{r.state}</td>
                <td style={cell}>{r.class}</td>
                <td style={{ ...cell, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</td>
                <td style={cell}>{r.launchedBy}</td>
                <td style={cell}>{r.workItemId ?? '—'}</td>
                <td style={cell}>{fmtAge(r.startedAt)}</td>
                <td style={cell}>{fmtBytes(r.rssBytes)}</td>
                <td style={cell}>{fmtBytes(r.peakRssBytes)}</td>
                <td style={cell}>{fmtCpu(r.cpuUsec)}</td>
                <td style={cell}>{r.pids ?? '—'}</td>
                <td style={{ ...cell, opacity: r.confined ? 1 : 0.5 }}>{r.confined ? 'cgroup' : 'pid'}</td>
              </tr>
            ))}
            {(data?.rows ?? []).length === 0 && (
              <tr>
                <td style={{ ...cell, opacity: 0.6 }} colSpan={11}>
                  No tasks. If that is surprising, check that the reconcile routine is armed
                  (<a href="/admin/schedules">/admin/schedules</a> → <code>task-reconcile</code>).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
