'use client';

import { useMemo, useState } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { useSyncQuery } from '@restart/sync';
import { Modal } from './Modal';
import { RichGrid, type ColumnDef } from '@restart/grid-core';
import { Checkbox } from './Checkbox';

interface Decision {
  ts: number;
  iso: string;
  verb: string;
  args: string;
  iteration: number | null;
  isGhost: boolean;
}

interface Payload {
  decisions: Decision[];
  total: number;
  recognized: number;
  ghosts: number;
  ghostRate: number;
  byVerb: Record<string, number>;
}

// Row shape from harness_shared.harness_decisions (parsed run.log tail
// mirrored by harness-fs-watcher.ts).
type HarnessDecisionRow = {
  harnessSlug: string;
  lineHash: string;
  ts: number;
  iso: string;
  verb: string;
  args: string;
  iteration?: number | null;
  isGhost: boolean;
  workspaceId: string;
};

interface Props {
  slug: string;
  onClose: () => void;
}

const VERB_COLOR: Record<string, string> = {
  NEXT_WORKER: '#3b82f6',
  NEXT_VALIDATOR: '#a855f7',
  NEXT_ARCHITECT: '#f59e0b',
  ESCALATE: '#ef4444',
  CONVERTED: '#10b981',
  DONE: '#10b981',
};

function fmtTs(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function DecisionsPanel({ slug, onClose }: Props) {
  const [hideGhosts, setHideGhosts] = useQueryState('hideGhosts', parseAsBoolean.withDefault(false));

  // Live-pushed via Zero (harness_shared.harness_decisions, parsed from
  // .harness/logs/run.log tail by harness-fs-watcher.ts). Replaces
  // useSseOrPoll(/decisions/sse, load, 5000). Aggregate stats are
  // computed client-side from the row set.
  const { data: decisionRows, error } = useSyncQuery<HarnessDecisionRow>({
    queryName: 'harnessDecisions.byHarness',
    args: { harnessSlug: slug },
  });
  const data = useMemo<Payload | null>(() => {
    if (!decisionRows) return null;
    const decisions: Decision[] = decisionRows.map((r) => ({
      ts: r.ts,
      iso: r.iso,
      verb: r.verb,
      args: r.args,
      iteration: r.iteration ?? null,
      isGhost: r.isGhost,
    }));
    const byVerb: Record<string, number> = {};
    let ghosts = 0;
    for (const d of decisions) {
      if (d.isGhost) ghosts += 1;
      else byVerb[d.verb] = (byVerb[d.verb] ?? 0) + 1;
    }
    return {
      decisions,
      total: decisions.length,
      recognized: decisions.length - ghosts,
      ghosts,
      ghostRate: decisions.length > 0 ? ghosts / decisions.length : 0,
      byVerb,
    };
  }, [decisionRows]);
  const err = error ? String(error) : null;

  const filtered = useMemo(() => {
    if (!data) return [];
    const list = hideGhosts ? data.decisions.filter((d) => !d.isGhost) : data.decisions;
    return list.slice().reverse();
  }, [data, hideGhosts]);

  const maxVerb = useMemo(() => {
    if (!data) return 0;
    return Math.max(1, ...Object.values(data.byVerb));
  }, [data]);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Decisions`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, width: '80vw', maxWidth: 1100, height: '75vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: 'var(--fg)' }}
    >
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Decisions — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: '0.75rem' }}>orchestrator verb timeline</span>
          <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', color: '#d1d5db', cursor: 'pointer' }}>
            <Checkbox checked={hideGhosts} onChange={setHideGhosts} ariaLabel="Hide ghosts" />
            hide ghosts
          </label>
          <span style={{ fontSize: '0.75rem', color: 'var(--fg-mute)' }}>auto-refresh 5s</span>
          {err && <span style={{ color: '#f87171', fontSize: '0.8rem' }}>err: {err}</span>}
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        {/* Summary strip */}
        {data && (
          <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', gap: '1.25rem', fontSize: '0.8rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span><span style={{ color: 'var(--fg-mute)' }}>total</span> <b style={{ fontFamily: 'monospace' }}>{data.total}</b></span>
            <span><span style={{ color: 'var(--fg-mute)' }}>recognized</span> <b style={{ fontFamily: 'monospace', color: '#10b981' }}>{data.recognized}</b></span>
            <span><span style={{ color: 'var(--fg-mute)' }}>ghosts</span> <b style={{ fontFamily: 'monospace', color: data.ghosts > 0 ? '#f87171' : '#10b981' }}>{data.ghosts}</b></span>
            <span>
              <span style={{ color: 'var(--fg-mute)' }}>ghost rate</span>{' '}
              <b style={{ fontFamily: 'monospace', color: data.ghostRate >= 0.05 ? '#f87171' : '#10b981' }}>
                {(data.ghostRate * 100).toFixed(1)}%
              </b>
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {Object.entries(data.byVerb).sort((a, b) => b[1] - a[1]).map(([v, n]) => (
                <span key={v} title={`${v}: ${n}`} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                  fontSize: '0.7rem', fontFamily: 'monospace',
                  padding: '0.1rem 0.45rem',
                  border: `1px solid ${VERB_COLOR[v] ?? '#374151'}`,
                  background: `color-mix(in oklab, ${VERB_COLOR[v] ?? '#374151'}, transparent 85%)`,
                  borderRadius: 3,
                  color: VERB_COLOR[v] ?? '#d1d5db',
                }}>
                  {v} <span style={{ opacity: 0.7 }}>{n}</span>
                  <span style={{
                    display: 'inline-block', width: Math.max(2, (n / maxVerb) * 60), height: 4,
                    background: VERB_COLOR[v] ?? '#374151', borderRadius: 2,
                  }} />
                </span>
              ))}
            </span>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {!data ? (
            <div style={{ padding: '2rem', color: 'var(--fg-mute)', textAlign: 'center' }}>loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '2rem', color: 'var(--fg-mute)', textAlign: 'center' }}>
              {data.total === 0 ? 'No orchestrator decisions yet.' : 'No decisions match filter.'}
            </div>
          ) : (
            <DecisionsGrid rows={filtered} />
          )}
        </div>
      </Modal>
  );
}

function DecisionsGrid({ rows }: { rows: Decision[] }) {
  const columns: ColumnDef<Decision>[] = useMemo(
    () => [
      {
        key: 'when',
        header: 'When',
        width: 1.5,
        sortKey: 'ts',
        defaultSortDir: 'desc',
        render: ({ row }) => (
          <span style={{ color: 'var(--fg-mute)', fontFamily: 'monospace', fontSize: '0.75rem' }}>
            {fmtTs(row.ts)}
          </span>
        ),
      },
      {
        key: 'iter',
        header: 'Iter',
        width: 0.4,
        align: 'right',
        sortKey: 'iteration',
        render: ({ row }) => (
          <span style={{ fontFamily: 'monospace', color: '#d1d5db' }}>
            {row.iteration ?? '—'}
          </span>
        ),
      },
      {
        key: 'verb',
        header: 'Verb',
        width: 1.5,
        sortKey: 'verb',
        render: ({ row }) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontFamily: 'monospace', fontSize: '0.75rem',
              padding: '0.1rem 0.4rem',
              border: `1px solid ${row.isGhost ? 'var(--fg-mute)' : (VERB_COLOR[row.verb] ?? '#374151')}`,
              borderRadius: 3,
              color: row.isGhost ? 'var(--fg-mute)' : (VERB_COLOR[row.verb] ?? '#d1d5db'),
              background: row.isGhost ? 'transparent' : `color-mix(in oklab, ${VERB_COLOR[row.verb] ?? '#374151'}, transparent 88%)`,
            }}>
              {row.verb}
            </span>
            {row.isGhost && <span style={{ fontSize: '0.7rem', color: '#f87171' }}>ghost</span>}
          </span>
        ),
      },
      {
        key: 'args',
        header: 'Args',
        width: 4,
        render: ({ row }) => (
          <span style={{
            fontFamily: 'monospace',
            color: '#d1d5db',
            fontSize: '0.75rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {row.args || <span style={{ color: '#4b5563' }}>—</span>}
          </span>
        ),
      },
    ],
    [],
  );
  // Preserve the ghost-row dimming via getRowBg+rowProps so existing CSS visuals
  // (faded opacity for ghost decisions) still apply.
  const richRowProps = (ctx: { row: Decision }) =>
    ctx.row.isGhost
      ? { style: { opacity: 0.6 } as React.CSSProperties }
      : {};
  return (
    <RichGrid<Decision>
      rows={rows}
      columns={columns}
      getRowId={(d) => `${d.ts}-${d.verb}-${d.iteration ?? 0}`}
      rowProps={richRowProps}
      inline
    />
  );
}
