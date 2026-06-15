'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsStringEnum, parseAsString } from 'nuqs';

type Workflow = {
  workflow_uuid: string;
  name: string;
  status: string;
  queue_name: string | null;
  application_version: string | null;
  recovery_attempts: string | number;
  deduplication_id: string | null;
  created_at: string;
  updated_at: string;
  error: string;
};
type QueueRow = { queue_name: string; depth: number; active: number };
type CountRow = { status: string; n: number };
type Payload = { enabled: boolean; counts: CountRow[]; workflows: Workflow[]; queues: QueueRow[] };

/** Pure: format an epoch-ms string to a locale time, or em-dash for non-positive/NaN. Exported for tests. */
export const fmt = (epochMs: string): string => {
  const n = Number(epochMs);
  return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString() : '—';
};

/** Pure: workflow-status → swatch color. Exported for tests. */
export const statusColor = (s: string): string =>
  s === 'SUCCESS' ? '#86efac'
    : s === 'ERROR' || s.includes('MAX_RECOVERY') ? '#fca5a5'
      : s === 'PENDING' || s === 'ENQUEUED' ? '#fde68a'
        : '#dbeafe';

export default function DbosClient() {
  // URL-backed state per repo convention (nuqs), so agents + deep links work.
  const [view, setView] = useQueryState(
    'view',
    parseAsStringEnum<'workflows' | 'queues'>(['workflows', 'queues']).withDefault('workflows'),
  );
  const [status, setStatus] = useQueryState('status', parseAsString);
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      const r = await fetch(`/api/admin/dbos/status${qs}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as Payload);
      setState('ok');
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setState('error');
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ padding: 16, color: '#dbeafe', fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        {(['workflows', 'queues'] as const).map((v) => (
          <button key={v} onClick={() => void setView(v)} style={tabBtn(view === v)}>{v}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button onClick={() => void load()} style={tabBtn(false)}>↻ refresh</button>
      </div>

      {state === 'loading' && <p style={{ opacity: 0.6 }}>Loading…</p>}
      {state === 'error' && <p style={{ color: '#fca5a5' }}>Error: {err}</p>}
      {state === 'ok' && data && !data.enabled && (
        <p style={{ opacity: 0.75, maxWidth: 560, lineHeight: 1.5 }}>
          DBOS is not running — the <code>dbos</code> schema doesn’t exist yet. Enable it with{' '}
          <code>PAPERCUSP_DBOS_ENABLE=1</code> (and <code>PAPERCUSP_DBOS_AUTOLOOP=1</code> for the
          AutoLoop migration), then restart the operator.
        </p>
      )}
      {state === 'ok' && data?.enabled && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {data.counts.map((c) => (
              <button key={c.status} onClick={() => void setStatus(status === c.status ? null : c.status)} style={pill(status === c.status)}>
                {c.status}: <b>{c.n}</b>
              </button>
            ))}
            {data.counts.length === 0 && <span style={{ opacity: 0.6 }}>no workflows yet</span>}
          </div>

          {view === 'workflows' ? (
            <table style={tbl}>
              <thead>
                <tr>{['workflow', 'name', 'status', 'queue', 'ver', 'recov', 'dedup', 'created'].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {data.workflows.map((w) => (
                  <tr key={w.workflow_uuid}>
                    <td style={tdMono} title={w.workflow_uuid}>{w.workflow_uuid.slice(0, 8)}</td>
                    <td style={td}>{w.name}</td>
                    <td style={{ ...td, color: statusColor(w.status) }}>{w.status}{w.error ? ` — ${w.error}` : ''}</td>
                    <td style={td}>{w.queue_name ?? '—'}</td>
                    <td style={tdMono} title={w.application_version ?? ''}>{w.application_version?.slice(0, 10) ?? '—'}</td>
                    <td style={td}>{String(w.recovery_attempts)}</td>
                    <td style={tdMono} title={w.deduplication_id ?? ''}>{w.deduplication_id ? '✓' : '—'}</td>
                    <td style={td}>{fmt(w.created_at)}</td>
                  </tr>
                ))}
                {data.workflows.length === 0 && <tr><td style={td} colSpan={8}>no workflows for this filter</td></tr>}
              </tbody>
            </table>
          ) : (
            <table style={tbl}>
              <thead><tr>{['queue', 'depth', 'active'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {data.queues.map((q) => (
                  <tr key={q.queue_name}><td style={tdMono}>{q.queue_name}</td><td style={td}>{q.depth}</td><td style={td}>{q.active}</td></tr>
                ))}
                {data.queues.length === 0 && <tr><td style={td} colSpan={3}>no queued work</td></tr>}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

const tabBtn = (on: boolean): CSSProperties => ({
  padding: '5px 12px', borderRadius: 8, border: '1px solid rgba(103,232,249,0.25)',
  background: on ? 'rgba(17,34,53,0.98)' : 'rgba(255,255,255,0.02)',
  color: on ? '#f7fdff' : 'rgba(214,236,248,0.72)', cursor: 'pointer', fontSize: 12,
});
const pill = (on: boolean): CSSProperties => ({
  padding: '3px 10px', borderRadius: 999,
  border: `1px solid ${on ? 'rgba(103,232,249,0.5)' : 'rgba(103,232,249,0.18)'}`,
  background: on ? 'color-mix(in srgb, var(--bg-raised), transparent 2%)' : 'transparent', color: '#dbeafe', cursor: 'pointer', fontSize: 12,
});
const tbl: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
const th: CSSProperties = {
  textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid rgba(103,232,249,0.18)',
  color: 'color-mix(in srgb, var(--accent-soft), transparent 30%)', fontWeight: 650, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.06em',
};
const td: CSSProperties = { padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'top' };
const tdMono: CSSProperties = { ...td, fontFamily: 'ui-monospace, Menlo, monospace' };
