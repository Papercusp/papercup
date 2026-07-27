'use client';

import { useMemo, type CSSProperties, type ReactElement } from 'react';
import { useQueryState, parseAsBoolean, parseAsString } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';

// `@/app/...` (not a relative path): this component is rendered from BOTH trees —
// apps/operator's own /admin/tasks page and operator-vite's route + left-rail tab —
// and the alias is the form both resolve, matching every sibling admin pane.
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { Table, type TableColumn } from '@/app/harness/Table';

/**
 * /admin/tasks — the Task Manager pane
 * (task-manager-no-escape-2026-07-27, P-018).
 *
 * Deliberately modelled on /admin/schedules, because they are the same idea one
 * axis apart: that page is the inventory of everything RECURRING, this is the
 * inventory of everything RUNNING. Same posture too — nuqs-backed filters so agents
 * and deep links work, and READ-ONLY. The kill/freeze/limit verbs are capability-
 * gated MCP tools; a dashboard read must not be able to end someone's work.
 *
 * Data comes from the `taskManager.inventory` SYNC query, not a bare fetch — see the
 * comment on the hook below (WI-6475). Rendered from BOTH trees: apps/operator's own
 * /admin/tasks page and operator-vite's route + left-rail Tasks tab.
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
      return 'var(--bad)';
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
/** Header cells stay pinned while a long task list scrolls under them. */
const head: CSSProperties = { textAlign: 'left', position: 'sticky', top: 0, background: 'var(--bg, #111)' };

/** The task table's columns. Declared once at module scope (not rebuilt per render)
 *  because every cell renderer here is a pure function of its row. */
const TASK_COLUMNS: TableColumn<Row>[] = [
  {
    key: 'state',
    header: 'state',
    headerStyle: head,
    // Colour is per-ROW (it encodes the state), so it lives in render, not cellStyle.
    render: (r) => <span style={{ color: stateColor(r.state) }}>{r.state}</span>,
    cellStyle: cell,
    // The taskId + scope unit are what you need to act on a row via `processes:*`,
    // so keep them reachable on hover rather than widening the table for them.
    cellTitle: (r) => `${r.taskId}${r.scopeUnit ? ` · ${r.scopeUnit}` : ''}`,
  },
  { key: 'class', header: 'class', headerStyle: head, render: (r) => r.class, cellStyle: cell },
  {
    key: 'title',
    header: 'title',
    headerStyle: head,
    render: (r) => r.title,
    cellStyle: { ...cell, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' },
    cellTitle: (r) => r.title,
  },
  { key: 'launchedBy', header: 'launched by', headerStyle: head, render: (r) => r.launchedBy, cellStyle: cell },
  { key: 'workItem', header: 'work-item', headerStyle: head, render: (r) => r.workItemId ?? '—', cellStyle: cell },
  { key: 'age', header: 'age', headerStyle: head, render: (r) => fmtAge(r.startedAt), cellStyle: cell },
  { key: 'rss', header: 'rss', headerStyle: head, render: (r) => fmtBytes(r.rssBytes), cellStyle: cell },
  { key: 'peak', header: 'peak', headerStyle: head, render: (r) => fmtBytes(r.peakRssBytes), cellStyle: cell },
  { key: 'cpu', header: 'cpu', headerStyle: head, render: (r) => fmtCpu(r.cpuUsec), cellStyle: cell },
  { key: 'pids', header: 'pids', headerStyle: head, render: (r) => r.pids ?? '—', cellStyle: cell },
  {
    key: 'conf',
    header: 'conf',
    headerStyle: head,
    // Dimmed when unconfined: a pid-only row is tracked but NOT cgroup-bounded.
    render: (r) => <span style={{ opacity: r.confined ? 1 : 0.5 }}>{r.confined ? 'cgroup' : 'pid'}</span>,
    cellStyle: cell,
  },
];

export default function TasksClient(): ReactElement {
  const [stateFilter, setStateFilter] = useQueryState('state', parseAsString);
  const [classFilter, setClassFilter] = useQueryState('class', parseAsString);
  const [includeEnded, setIncludeEnded] = useQueryState('ended', parseAsBoolean.withDefault(false));
  const [liveView, setLiveView] = useQueryState('live', parseAsBoolean.withDefault(true));

  // Reads through the sync layer, NOT a bare fetch (WI-6475). Two reasons, and the
  // first is a hard bug rather than a style point: a native webview fetch does not
  // ride the sys:http IPC bridge that injects the loopback-superuser bearer, so it
  // resolves `unverified-loopback` and the VT-gated /api/admin/tasks/inventory route
  // refuses it — the pane rendered "Load failed: HTTP 403" for the owner on every
  // desktop shell (EI-338; see endpoint-route/__tests__/auth-posture.test.ts). The
  // sync transport is `auth:'loopback'` and is admitted. Second, `fetch +
  // setInterval` is the exact hand-rolled pattern the repo bans — @papercusp/sync is
  // the one audited path, and it is what every sibling rail tab already uses.
  //
  // `staleTime` carries the old 5s poll cadence: fast enough to feel live, close
  // enough to the reconciler's 30s tick, and it does NOT scan while unmounted.
  const q = useSyncQuery<Payload>({
    queryName: 'taskManager.inventory',
    args: {
      ...(stateFilter ? { state: stateFilter } : {}),
      ...(classFilter ? { cls: classFilter } : {}),
      ...(includeEnded ? { includeEnded: true } : {}),
      ...(liveView ? { live: true } : {}),
    },
    staleTime: 5_000,
  });

  const data = q.data?.[0] ?? null;
  const error = q.error ? String((q.error as Error).message ?? q.error) : null;

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

      {error && <div style={{ color: 'var(--bad)', marginBottom: 12 }}>Load failed: {error}</div>}

      {/* The no-escape signal, first, because it is the one thing here that means
          something is wrong rather than merely busy. */}
      {live?.degraded && (
        <div style={{ ...cell, border: '1px solid var(--warn)', marginBottom: 12 }}>
          ⚠ Live scan degraded — {live.degradedReason}. The ledger below is still shown, but nothing is being closed
          out while the scan cannot be trusted.
        </div>
      )}
      {unaccountedGroups.length > 0 && (
        <div style={{ marginBottom: 16, border: '1px solid var(--bad)', borderRadius: 4 }}>
          <div style={{ ...cell, fontWeight: 600, color: 'var(--bad)', borderBottom: 'none' }}>
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
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          state{' '}
          <Select
            ariaLabel="filter by task state"
            value={stateFilter ?? ''}
            onChange={(v) => void setStateFilter(v || null)}
            options={[
              { value: '', label: 'all' },
              ...['pending', 'running', 'exited', 'killed', 'timed_out', 'stranded', 'unaccounted'].map((s) => ({
                value: s,
                label: s,
              })),
            ]}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          class{' '}
          <Select
            ariaLabel="filter by task class"
            value={classFilter ?? ''}
            onChange={(v) => void setClassFilter(v || null)}
            options={[
              { value: '', label: 'all' },
              ...Object.keys(data?.summary.byClass ?? {}).map((c) => ({ value: c, label: c })),
            ]}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Checkbox ariaLabel="include finished tasks" checked={includeEnded} onChange={(v) => void setIncludeEnded(v)} />{' '}
          include finished
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Checkbox ariaLabel="live kernel scan" checked={liveView} onChange={(v) => void setLiveView(v)} /> live kernel
          scan
        </label>
        <span style={{ opacity: 0.6, marginLeft: 'auto' }}>
          {data?.summary.total ?? 0} row(s)
          {live?.scan ? ` · ${live.scan.processes} process(es) scanned` : ''}
          {live?.foreign ? ` · ${live.foreign} foreign group(s)` : ''}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <Table
          style={{ minWidth: 1100, ...mono }}
          columns={TASK_COLUMNS}
          rows={data?.rows ?? []}
          getRowKey={(r) => r.taskId}
          emptyLabel={
            <>
              No tasks. If that is surprising, check that the reconcile routine is armed (
              <a href="/admin/schedules">/admin/schedules</a> → <code>task-reconcile</code>).
            </>
          }
        />
      </div>
    </div>
  );
}
