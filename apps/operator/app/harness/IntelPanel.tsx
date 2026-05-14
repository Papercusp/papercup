'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString, parseAsBoolean } from 'nuqs';
import { Modal } from './Modal';
import { RichGrid, type ColumnDef } from '@restart/grid-core';

/**
 * IntelPanel — surfaces what the projected-tool registry has produced
 * for this harness. Phase 1 ships the Spawns sub-tab only (recent
 * tool_invocations rows scoped to the harness, parent→child tree once
 * Phase 9 lights up parent_spawn_id).
 *
 * Fetches via /api/harness/:slug/intel/spawn-tree (session-scoped, no
 * bearer). Polls every 30s while open; cancels on close.
 */

type Status = 'ok' | 'error' | 'timeout' | 'quota-exceeded' | 'role-not-allowed';

interface Row {
  id: number;
  toolName: string;
  pluginName: string;
  role: string;
  featureId: string | null;
  chunkId: string | null;
  runId: string | null;
  spawnId: string;
  parentSpawnId: string | null;
  windowKey: string;
  invokedAtMs: number;
  durationMs: number | null;
  status: Status;
  outputRef: string | null;
  outputSize: number | null;
  errorMessage: string | null;
  depth: number;
  rootSpawnId: string;
}

type SubTab = 'spawns' | 'pack' | 'diff' | 'graph';

interface ArtifactRow {
  id: number;
  pluginName: string;
  toolName: string;
  role: string;
  featureId: string | null;
  runId: string | null;
  spawnId: string;
  invokedAtMs: number;
  durationMs: number | null;
  outputRef: string | null;
  outputSize: number | null;
  kind: 'pack' | 'diff' | 'other';
}

interface Props {
  slug: string;
  onClose: () => void;
}

const POLL_INTERVAL_MS = 30_000;

const STATUS_LABEL: Record<Status, string> = {
  'ok': 'ok',
  'error': 'error',
  'timeout': 'timeout',
  'quota-exceeded': 'quota',
  'role-not-allowed': 'role',
};

const STATUS_COLOR: Record<Status, string> = {
  'ok': 'var(--good)',
  'error': 'var(--bad)',
  'timeout': 'var(--warn)',
  'quota-exceeded': 'var(--warn)',
  'role-not-allowed': 'var(--fg-mute)',
};

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function IntelPanel({ slug, onClose }: Props) {
  const [subTab, setSubTab] = useState<SubTab>('spawns');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');

  const fetchSpawnTree = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: '500' });
    if (statusFilter !== 'all') params.set('status', statusFilter);
    const r = await fetch(`/api/harness/${slug}/intel/spawn-tree?${params}`, { signal });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }
    const data = await r.json();
    setRows(data.rows ?? []);
  }, [slug, statusFilter]);

  const fetchArtifacts = useCallback(async (kind: 'pack' | 'diff' | 'all', signal?: AbortSignal) => {
    const params = new URLSearchParams({ kind, limit: '200' });
    const r = await fetch(`/api/harness/${slug}/intel/artifacts?${params}`, { signal });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }
    const data = await r.json();
    setArtifacts(data.rows ?? []);
  }, [slug]);

  const fetchActive = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      if (subTab === 'spawns') await fetchSpawnTree(signal);
      else if (subTab === 'pack') await fetchArtifacts('pack', signal);
      else if (subTab === 'diff') await fetchArtifacts('diff', signal);
      // graph sub-tab: no auto-fetch (user-driven query)
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [subTab, fetchSpawnTree, fetchArtifacts]);

  // Reset displayed data when switching sub-tabs so the previous tab's
  // rows don't flash through during the initial fetch.
  useEffect(() => {
    if (subTab === 'spawns') setArtifacts(null);
    else setRows(null);
  }, [subTab]);

  useEffect(() => {
    const ac = new AbortController();
    void fetchActive(ac.signal);
    const t = window.setInterval(() => {
      void fetchActive(ac.signal);
    }, POLL_INTERVAL_MS);
    return () => {
      ac.abort();
      window.clearInterval(t);
    };
  }, [fetchActive]);

  const summary = useMemo(() => {
    if (!rows) return null;
    const byStatus: Record<string, number> = {};
    const byTool: Record<string, number> = {};
    let totalDuration = 0;
    let durationCount = 0;
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byTool[r.toolName] = (byTool[r.toolName] ?? 0) + 1;
      if (r.durationMs != null) {
        totalDuration += r.durationMs;
        durationCount += 1;
      }
    }
    return {
      total: rows.length,
      byStatus,
      byTool,
      avgDuration: durationCount > 0 ? totalDuration / durationCount : 0,
    };
  }, [rows]);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Intel"
      srOnlyTitle
      zIndex={60}
      contentStyle={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        width: '85vw',
        maxWidth: 1300,
        height: '80vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'system-ui, sans-serif',
        color: 'var(--fg)',
      }}
    >
      <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <strong>Intel — {slug}</strong>
        <span style={{ fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: '0.75rem' }}>tool-invocation telemetry</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--fg-mute)' }}>auto-refresh 30s</span>
        <button
          onClick={() => void fetchActive()}
          disabled={loading}
          style={{ padding: '4px 10px', fontSize: 12 }}
        >
          {loading ? 'refreshing…' : 'refresh'}
        </button>
        <button onClick={onClose} style={{ padding: '4px 10px', fontSize: 12 }}>close</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 8, padding: '0.5rem 1rem 1rem' }}>
        <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>
          {(['spawns', 'pack', 'diff', 'graph'] as SubTab[]).map((t) => (
            <button
              key={t}
              className={`h-tab${subTab === t ? ' on' : ''}`}
              onClick={() => setSubTab(t)}
            >
              {t}
              {t === 'spawns' && summary && <span className="h-tab-count">{summary.total}</span>}
              {(t === 'pack' || t === 'diff') && artifacts && subTab === t && (
                <span className="h-tab-count">{artifacts.length}</span>
              )}
            </button>
          ))}
        </div>

        {subTab === 'spawns' && (
          <SpawnsTab
            rows={rows}
            error={error}
            summary={summary}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
          />
        )}
        {(subTab === 'pack' || subTab === 'diff') && (
          <ArtifactsTab kind={subTab} rows={artifacts} error={error} />
        )}
        {subTab === 'graph' && <GraphTab slug={slug} />}
      </div>
    </Modal>
  );
}

function SpawnsTab({
  rows,
  error,
  summary,
  statusFilter,
  onStatusFilter,
}: {
  rows: Row[] | null;
  error: string | null;
  summary: { total: number; byStatus: Record<string, number>; byTool: Record<string, number>; avgDuration: number } | null;
  statusFilter: Status | 'all';
  onStatusFilter: (s: Status | 'all') => void;
}) {
  if (error) {
    return (
      <div style={{ padding: 16, color: 'var(--bad)' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }
  if (!rows) {
    return <div style={{ padding: 24, color: 'var(--fg-mute)', textAlign: 'center' }}>loading…</div>;
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: 24, color: 'var(--fg-mute)', textAlign: 'center' }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>no tool invocations yet</div>
        <div style={{ fontSize: 12 }}>
          Tools run in here when an agent (or the dashboard) calls a projected tool —
          repomix, fetch-plus, gitnexus, code2prompt, firecrawl, or any of the built-ins.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8, height: '100%' }}>
      {summary && (
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--fg-dim)', flexWrap: 'wrap' }}>
          <span>
            <strong>{summary.total}</strong> calls (24h)
          </span>
          <span>avg <strong>{fmtDuration(Math.round(summary.avgDuration))}</strong></span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              className={`h-tab${statusFilter === 'all' ? ' on' : ''}`}
              onClick={() => onStatusFilter('all')}
              style={{ fontSize: 11, padding: '2px 6px' }}
            >
              all
            </button>
            {(Object.keys(summary.byStatus) as Status[]).map((s) => (
              <button
                key={s}
                className={`h-tab${statusFilter === s ? ' on' : ''}`}
                onClick={() => onStatusFilter(s)}
                style={{ fontSize: 11, padding: '2px 6px' }}
              >
                {STATUS_LABEL[s] ?? s} ({summary.byStatus[s]})
              </button>
            ))}
          </span>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <RichGrid<Row>
          columns={SPAWNS_COLUMNS}
          rows={rows}
          getRowId={(r) => String(r.id)}
          rowMinHeight={28}
          headerHeight={28}
        />
      </div>
    </div>
  );
}

const SPAWNS_COLUMNS: ColumnDef<Row>[] = [
  {
    key: 'when', header: 'when', width: 1.2,
    toCopyText: (r) => new Date(r.invokedAtMs).toISOString(),
    render: ({ row }) => <>{fmtTs(row.invokedAtMs)}</>,
  },
  {
    key: 'tool', header: 'tool', width: 2,
    toCopyText: (r) => `${'·'.repeat(r.depth)}${r.toolName}`,
    render: ({ row }) => (
      <span style={{ fontFamily: 'monospace' }}>
        {row.depth > 0 && <span style={{ opacity: 0.5 }}>{'·'.repeat(row.depth)} </span>}
        {row.toolName}
      </span>
    ),
  },
  {
    key: 'role', header: 'role', width: 1,
    toCopyText: (r) => r.role,
    render: ({ row }) => <>{row.role}</>,
  },
  {
    key: 'status', header: 'status', width: 1.2,
    toCopyText: (r) => STATUS_LABEL[r.status] ?? r.status,
    render: ({ row }) => (
      <span style={{ color: STATUS_COLOR[row.status] }}>
        {STATUS_LABEL[row.status] ?? row.status}
        {row.errorMessage && <span title={row.errorMessage} style={{ marginLeft: 4, opacity: 0.6 }}>ⓘ</span>}
      </span>
    ),
  },
  {
    key: 'dur', header: 'dur', width: 0.8,
    toCopyText: (r) => fmtDuration(r.durationMs),
    render: ({ row }) => <>{fmtDuration(row.durationMs)}</>,
  },
  {
    key: 'output', header: 'output', width: 1,
    toCopyText: (r) => r.outputRef ? `${fmtBytes(r.outputSize)} ${r.outputRef}` : '',
    render: ({ row }) => row.outputRef ? (
      <span title={row.outputRef} style={{ fontFamily: 'monospace', opacity: 0.8 }}>
        📄 {fmtBytes(row.outputSize)}
      </span>
    ) : <>—</>,
  },
  {
    key: 'feat', header: 'feat / chunk', width: 1.5,
    toCopyText: (r) => `${r.featureId ?? ''}${r.chunkId ? ` / ${r.chunkId}` : ''}`,
    render: ({ row }) => (
      <span style={{ fontFamily: 'monospace', opacity: 0.7 }}>
        {row.featureId ?? '—'}
        {row.chunkId ? <span style={{ opacity: 0.5 }}> / {row.chunkId}</span> : null}
      </span>
    ),
  },
  {
    key: 'spawn', header: 'spawn', width: 1,
    toCopyText: (r) => r.spawnId,
    render: ({ row }) => (
      <span title={row.spawnId} style={{ fontFamily: 'monospace', opacity: 0.7 }}>
        {row.spawnId.length > 12 ? row.spawnId.slice(0, 12) + '…' : row.spawnId}
      </span>
    ),
  },
];

function ArtifactsTab({
  kind,
  rows,
  error,
}: {
  kind: 'pack' | 'diff';
  rows: ArtifactRow[] | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div style={{ padding: 16, color: 'var(--bad)' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }
  if (!rows) {
    return <div style={{ padding: 24, color: 'var(--fg-mute)', textAlign: 'center' }}>loading…</div>;
  }
  if (rows.length === 0) {
    const blurb = kind === 'pack'
      ? 'Run repomix.pack or code2prompt.pack against this harness to populate.'
      : 'Run code2prompt.diff against this harness to populate.';
    return (
      <div style={{ padding: 24, color: 'var(--fg-mute)', textAlign: 'center' }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>no {kind} artifacts in the last 7 days</div>
        <div style={{ fontSize: 12 }}>{blurb}</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
      <RichGrid<ArtifactRow>
        columns={ARTIFACTS_COLUMNS}
        rows={rows}
        getRowId={(r) => String(r.id)}
        rowMinHeight={28}
        headerHeight={28}
      />
    </div>
  );
}

const ARTIFACTS_COLUMNS: ColumnDef<ArtifactRow>[] = [
  { key: 'when', header: 'when', width: 1.2, toCopyText: (r) => new Date(r.invokedAtMs).toISOString(), render: ({ row }) => <>{fmtTs(row.invokedAtMs)}</> },
  { key: 'tool', header: 'tool', width: 2, toCopyText: (r) => r.toolName, render: ({ row }) => <span style={{ fontFamily: 'monospace' }}>{row.toolName}</span> },
  { key: 'role', header: 'role', width: 1, toCopyText: (r) => r.role, render: ({ row }) => <>{row.role}</> },
  { key: 'feat', header: 'feat', width: 1.5, toCopyText: (r) => r.featureId ?? '', render: ({ row }) => <span style={{ fontFamily: 'monospace', opacity: 0.7 }}>{row.featureId ?? '—'}</span> },
  { key: 'size', header: 'size', width: 0.8, toCopyText: (r) => fmtBytes(r.outputSize), render: ({ row }) => <>{fmtBytes(row.outputSize)}</> },
  { key: 'dur', header: 'dur', width: 0.8, toCopyText: (r) => fmtDuration(r.durationMs), render: ({ row }) => <>{fmtDuration(row.durationMs)}</> },
  {
    key: 'artifact', header: 'artifact', width: 2.5,
    toCopyText: (r) => r.outputRef ?? '(inline)',
    render: ({ row }) => row.outputRef ? <ArtifactLink path={row.outputRef} /> : <span style={{ opacity: 0.5 }}>(inline result; no scratch file)</span>,
  },
];

function ArtifactLink({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard?.writeText(path).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => { /* ignore */ },
    );
  }, [path]);
  // Truncate display path to last 60 chars; full path on hover.
  const display = path.length > 60 ? '…' + path.slice(-60) : path;
  return (
    <span
      onClick={onCopy}
      title={`${path}\n\nclick to copy path`}
      style={{ fontFamily: 'monospace', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
    >
      📄 {display}{copied && <span style={{ marginLeft: 6, color: 'var(--good)' }}>✓ copied</span>}
    </span>
  );
}

interface GraphResult {
  processes: Array<{
    name?: string;
    rank?: number;
    score?: number;
    symbols?: Array<{ uid?: string; name?: string; kind?: string; file?: string; module?: string }>;
  }>;
  process_symbols?: Array<{ uid?: string; name?: string; kind?: string; file?: string; module?: string }>;
  definitions?: Array<{ uid?: string; name?: string; kind?: string; file?: string }>;
  timing?: { wall?: number; bm25?: number; vector?: number };
}

/**
 * Parse the gitnexus.query result envelope. Upstream returns
 * `{ content: [{ type: 'text', text: '<json>\n\n---\n<markdown footer>' }] }`,
 * so we slice off the footer and JSON.parse the prefix.
 */
function parseGraphResult(text: string): GraphResult | null {
  if (!text) return null;
  const sep = text.indexOf('\n\n---\n');
  const jsonPart = sep >= 0 ? text.slice(0, sep) : text;
  try {
    return JSON.parse(jsonPart) as GraphResult;
  } catch {
    return null;
  }
}

function GraphTab({ slug }: { slug: string }) {
  // Deep-linkable + agent-visible.
  const [query, setQuery] = useQueryState('intelQuery', parseAsString.withDefault(''));
  const [taskContext, setTaskContext] = useQueryState('intelContext', parseAsString.withDefault(''));
  const [limit, setLimit] = useState(5);
  const [result, setResult] = useState<GraphResult | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useQueryState('intelAdvanced', parseAsBoolean.withDefault(false));

  const submit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setRawText(null);
    try {
      // Spawn URL for the architect role — this is a dashboard-driven call,
      // not an agent-driven one, but the gitnexus tool requires role+run+spawn
      // params for the framework's gating to know who's calling.
      const spawnParams = new URLSearchParams({
        harness: slug,
        workspace: 'default',
        role: 'architect',
        run: `intel-${Date.now()}`,
        spawn: `intel-graph-${Date.now()}`,
      });
      const body: Record<string, unknown> = { query: query.trim(), limit };
      if (taskContext.trim()) body.task_context = taskContext.trim();
      const r = await fetch(`/api/plugins/gitnexus/query?${spawnParams}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`);
      }
      const data = await r.json();
      const text = data?.content?.[0]?.text ?? '';
      setRawText(text);
      const parsed = parseGraphResult(text);
      setResult(parsed);
      if (!parsed) setError('gitnexus returned a non-JSON response — see raw text below.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [query, taskContext, limit, slug]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 12, height: '100%' }}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search the code graph — e.g. &quot;auth token validation&quot;, &quot;find and replace&quot;"
            style={{ flex: 1, padding: '6px 10px', fontSize: 13, fontFamily: 'system-ui', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--fg)' }}
            autoFocus
          />
          <button type="submit" disabled={loading || !query.trim()} style={{ padding: '6px 14px', fontSize: 13 }}>
            {loading ? 'querying…' : 'query'}
          </button>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{ padding: '6px 10px', fontSize: 12, opacity: 0.7 }}
          >
            {showAdvanced ? 'hide' : 'advanced'}
          </button>
        </div>
        {showAdvanced && (
          <div style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--fg-mute)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              context
              <input
                type="text"
                value={taskContext}
                onChange={(e) => setTaskContext(e.target.value)}
                placeholder="e.g. &quot;adding OAuth support&quot; — helps ranking"
                style={{ width: 320, padding: '4px 8px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--fg)' }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              limit
              <input
                type="number"
                value={limit}
                min={1}
                max={50}
                onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 5)))}
                style={{ width: 60, padding: '4px 8px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--fg)' }}
              />
            </label>
          </div>
        )}
      </form>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {error && (
          <div style={{ padding: 12, color: 'var(--bad)', fontSize: 12 }}>
            <strong>error:</strong> {error}
          </div>
        )}
        {!result && !rawText && !error && !loading && (
          <div style={{ padding: 24, color: 'var(--fg-mute)', textAlign: 'center', fontSize: 12 }}>
            <div style={{ fontSize: 14, marginBottom: 8 }}>code-graph search</div>
            <div>
              Submit a natural-language or keyword query. Returns ranked execution flows
              (processes) and their symbols, plus standalone type definitions.
            </div>
            <div style={{ marginTop: 12, opacity: 0.7 }}>
              Powered by <code>gitnexus.query</code> — bm25 keyword + semantic vector search,
              ranked via reciprocal rank fusion.
            </div>
            <div style={{ marginTop: 8, opacity: 0.7 }}>
              Run <code>npx gitnexus analyze</code> in your project root once before querying.
            </div>
          </div>
        )}
        {result && <GraphResultView result={result} />}
        {!result && rawText && (
          <pre style={{ padding: 12, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--fg-mute)' }}>
            {rawText}
          </pre>
        )}
      </div>
    </div>
  );
}

function GraphResultView({ result }: { result: GraphResult }) {
  const processes = result.processes ?? [];
  const definitions = result.definitions ?? [];
  const timing = result.timing;
  const isEmpty = processes.length === 0 && definitions.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {timing && (
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--fg-mute)', fontFamily: 'monospace' }}>
          <span>wall {fmtDuration(Math.round(timing.wall ?? 0))}</span>
          {typeof timing.bm25 === 'number' && <span>bm25 {timing.bm25.toFixed(0)}ms</span>}
          {typeof timing.vector === 'number' && <span>vector {timing.vector.toFixed(0)}ms</span>}
        </div>
      )}

      {isEmpty && (
        <div style={{ padding: 16, color: 'var(--fg-mute)', fontSize: 12 }}>
          no matches — try a broader query, or run <code>gitnexus analyze</code> against the project.
        </div>
      )}

      {processes.length > 0 && (
        <section>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--fg-mute)', letterSpacing: 0.5, marginBottom: 6 }}>
            processes ({processes.length}) — ranked by relevance
          </div>
          {processes.map((p, i) => (
            <div key={i} style={{ marginBottom: 12, padding: 10, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4 }}>
              <div style={{ fontFamily: 'monospace', fontSize: 13, color: 'var(--fg)', marginBottom: 4 }}>
                {p.name ?? `process ${i + 1}`}
                {typeof p.score === 'number' && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--fg-mute)' }}>score {p.score.toFixed(2)}</span>}
              </div>
              {Array.isArray(p.symbols) && p.symbols.length > 0 && (
                <div role="list" style={{ display: 'grid', gridTemplateColumns: '20% 1fr auto', columnGap: 8, rowGap: 2, fontSize: 11, marginTop: 4 }}>
                  {p.symbols.map((s, j) => (
                    <div key={j} role="listitem" style={{ display: 'contents' }}>
                      <span style={{ ...td, fontFamily: 'monospace', color: '#a78bfa' }}>{s.kind ?? '?'}</span>
                      <span style={{ ...td, fontFamily: 'monospace', color: 'var(--fg)' }}>{s.name ?? s.uid ?? '?'}</span>
                      <span style={{ ...td, fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: 10 }}>{s.file ?? ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {definitions.length > 0 && (
        <section>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--fg-mute)', letterSpacing: 0.5, marginBottom: 6 }}>
            definitions ({definitions.length}) — types/interfaces not in any process
          </div>
          <div role="list" style={{ display: 'grid', gridTemplateColumns: '15% 1fr auto', columnGap: 8, rowGap: 2, fontSize: 11 }}>
            {definitions.map((d, i) => (
              <div key={i} role="listitem" style={{ display: 'contents' }}>
                <span style={{ ...td, fontFamily: 'monospace', color: '#a78bfa' }}>{d.kind ?? '?'}</span>
                <span style={{ ...td, fontFamily: 'monospace', color: 'var(--fg)' }}>{d.name ?? '?'}</span>
                <span style={{ ...td, fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: 10 }}>{d.file ?? ''}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  fontWeight: 600,
  fontSize: 11,
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
  letterSpacing: 0.5,
};

const td: React.CSSProperties = {
  padding: '4px 8px',
  whiteSpace: 'nowrap',
};
