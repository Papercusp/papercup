'use client';

/**
 * Operator UI for `harness_shared.prompt_compositions` telemetry.
 *
 * Surfaces per-invoke prompt size breakdowns so we can verify cache
 * discipline (stable preamble vs volatile trailing zone). Tokens ≈
 * chars/4 — UI displays both.
 *
 * Two views:
 *   - Recent rows table (default): latest 100 invokes for the harness.
 *   - Optional `featureId` filter: scope to a single feature when
 *     embedded in FeaturePeekPanel (deferred — keeping this standalone).
 */

import { useCallback, useEffect, useState } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

interface Row {
  id: number;
  ts_ms: number;
  role: string;
  feature_id: string | null;
  run_id: string;
  total_chars: number;
  substrate_chars: number;
  history_chars: number;
}

function fmtWhen(ts_ms: number): string {
  return new Date(ts_ms).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export interface PromptBudgetSummary {
  count: number;
  total: number;
  substrate: number;
  history: number;
  avgTotal: number;
  maxTotal: number;
  /** Percent of total chars that are substrate (0–100, rounded). */
  substratePct: number;
  /** Percent of total chars that are history (0–100, rounded). */
  historyPct: number;
}

/**
 * Aggregate the visible window of prompt-composition rows into the header
 * summary stats (avg/max total, substrate/history share). Extracted so the
 * "is cache discipline working" math is testable without a live fetch. Returns
 * zeroed pcts for an empty window (the component renders the empty-state instead).
 */
export function aggregatePromptBudget(rows: Array<Pick<Row, 'total_chars' | 'substrate_chars' | 'history_chars'>>): PromptBudgetSummary {
  const total = rows.reduce((a, r) => a + r.total_chars, 0);
  const substrate = rows.reduce((a, r) => a + r.substrate_chars, 0);
  const history = rows.reduce((a, r) => a + r.history_chars, 0);
  const avgTotal = rows.length ? Math.round(total / rows.length) : 0;
  const maxTotal = rows.reduce((a, r) => Math.max(a, r.total_chars), 0);
  return {
    count: rows.length,
    total,
    substrate,
    history,
    avgTotal,
    maxTotal,
    substratePct: total > 0 ? Math.round((substrate / total) * 100) : 0,
    historyPct: total > 0 ? Math.round((history / total) * 100) : 0,
  };
}

const SUBTLE = 'var(--fg-mute)';
const BORDER = '1px solid var(--border)';

export function PromptBudgetView({
  slug,
  featureId,
}: {
  slug: string;
  /** Optional — restrict to one feature. Omit for harness-wide view. */
  featureId?: string;
}): JSX.Element {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = featureId
        ? `/api/harness/${slug}/prompt-budget?feature_id=${encodeURIComponent(featureId)}&limit=100`
        : `/api/harness/${slug}/prompt-budget?limit=100`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { rows: Row[] };
      setRows(data.rows ?? []);
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [slug, featureId]);

  useEffect(() => { void reload(); }, [reload]);

  if (loading) return <div style={{ fontSize: 12, color: SUBTLE }}>Loading prompt budget…</div>;
  if (error) return <div style={{ fontSize: 12, color: 'var(--bad,#d97757)' }}>Error: {error}</div>;
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 12, color: SUBTLE }}>
        No prompt-composition rows yet. They appear after the orchestrator
        runs against PG (set <code>PAPERCUSP_USE_PG_STATE=1</code>).
      </div>
    );
  }

  // Aggregate stats across the visible window — quick "is cache discipline
  // working" signal without needing a chart library.
  const { avgTotal, maxTotal, substratePct, historyPct } = aggregatePromptBudget(rows);

  const columns: ColumnDef<Row>[] = [
    {
      key: 'when', header: 'When', width: 1.2, align: 'left',
      toCopyText: (r) => fmtWhen(r.ts_ms),
      render: ({ row }) => <>{fmtWhen(row.ts_ms)}</>,
    },
    {
      key: 'role', header: 'Role', width: 1, align: 'left',
      toCopyText: (r) => r.role,
      render: ({ row }) => <>{row.role}</>,
    },
    {
      key: 'feature', header: 'Feature', width: 2, align: 'left',
      toCopyText: (r) => r.feature_id ?? '',
      render: ({ row }) => <span style={{ fontFamily: 'monospace' }}>{row.feature_id ?? '—'}</span>,
    },
    {
      key: 'total', header: 'Total', width: 1.2, align: 'right',
      toCopyText: (r) => String(r.total_chars),
      render: ({ row }) => <>{row.total_chars.toLocaleString()}</>,
    },
    {
      key: 'substrate', header: 'Substrate', width: 1.2, align: 'right',
      toCopyText: (r) => String(r.substrate_chars),
      render: ({ row }) => <span style={{ color: SUBTLE }}>{row.substrate_chars.toLocaleString()}</span>,
    },
    {
      key: 'history', header: 'History', width: 1.2, align: 'right',
      toCopyText: (r) => String(r.history_chars),
      render: ({ row }) => <span style={{ color: SUBTLE }}>{row.history_chars.toLocaleString()}</span>,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: SUBTLE, flexWrap: 'wrap' }}>
        <span><strong>{rows.length}</strong> invokes</span>
        <span>avg <strong>{avgTotal.toLocaleString()}</strong> chars (~{Math.round(avgTotal / 4).toLocaleString()} tok)</span>
        <span>max <strong>{maxTotal.toLocaleString()}</strong> chars</span>
        <span>substrate <strong>{substratePct}%</strong></span>
        <span>history <strong>{historyPct}%</strong></span>
        <button type="button" onClick={() => void reload()} style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 8px' }}>
          Refresh
        </button>
      </div>
      <div style={{ height: 300, border: BORDER, borderRadius: 4 }}>
        <RichGrid
          columns={columns}
          rows={rows}
          getRowId={(r) => String(r.id)}
          rowMinHeight={28}
          headerHeight={28}
        />
      </div>
    </div>
  );
}


