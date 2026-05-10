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

const SUBTLE = 'var(--pc-muted, #9a9a9a)';
const BORDER = '1px solid var(--pc-border, #2a2a2a)';

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
  const total = rows.reduce((a, r) => a + r.total_chars, 0);
  const substrate = rows.reduce((a, r) => a + r.substrate_chars, 0);
  const history = rows.reduce((a, r) => a + r.history_chars, 0);
  const avgTotal = Math.round(total / rows.length);
  const maxTotal = rows.reduce((a, r) => Math.max(a, r.total_chars), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: SUBTLE, flexWrap: 'wrap' }}>
        <span><strong>{rows.length}</strong> invokes</span>
        <span>avg <strong>{avgTotal.toLocaleString()}</strong> chars (~{Math.round(avgTotal / 4).toLocaleString()} tok)</span>
        <span>max <strong>{maxTotal.toLocaleString()}</strong> chars</span>
        <span>substrate <strong>{Math.round((substrate / total) * 100)}%</strong></span>
        <span>history <strong>{Math.round((history / total) * 100)}%</strong></span>
        <button type="button" onClick={() => void reload()} style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 8px' }}>
          Refresh
        </button>
      </div>
      <div style={{ overflowX: 'auto', border: BORDER, borderRadius: 4 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: 'var(--pc-card-bg,#141414)' }}>
              <th style={th}>When</th>
              <th style={th}>Role</th>
              <th style={th}>Feature</th>
              <th style={th}>Total</th>
              <th style={th}>Substrate</th>
              <th style={th}>History</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const when = new Date(r.ts_ms).toLocaleTimeString(undefined, {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
              });
              return (
                <tr key={r.id} style={{ borderTop: BORDER }}>
                  <td style={td}>{when}</td>
                  <td style={td}>{r.role}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{r.feature_id ?? '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.total_chars.toLocaleString()}</td>
                  <td style={{ ...td, textAlign: 'right', color: SUBTLE }}>{r.substrate_chars.toLocaleString()}</td>
                  <td style={{ ...td, textAlign: 'right', color: SUBTLE }}>{r.history_chars.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', fontWeight: 500, fontSize: 10, color: SUBTLE, textTransform: 'uppercase' };
const td: React.CSSProperties = { padding: '3px 8px' };
