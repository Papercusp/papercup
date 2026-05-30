'use client';

// adv:agents — recent agent runs for the harness. Ports the legacy
// RealAgentsPanel onto the /adv data pattern: live via the Zero overlay
// (`agentRunsConsolidated.bySlug`) with a one-shot REST bootstrap, no 5s
// polling timer. Running/All toggle, role-coloured rows, blue-frost tokens.
//
// Role colours come from the canonical getRoleStyle() in app/harness/theme.ts
// (the same source the legacy /harness uses) so a role renders the same hue
// on every surface — no local divergent role palette.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { RefreshCw } from 'lucide-react';
import { RichGrid, type ColumnDef } from '@restart/grid-core';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { getRoleStyle } from '../../harness/theme';
import { Tooltip } from '../../harness/Tooltip';
import { useHarnessAgents, type HarnessAgentRun } from './useHarnessData';

function fmtAge(ms: number | undefined): string {
  if (!ms) return '—';
  const age = Math.max(0, Date.now() - ms);
  if (age < 60_000) return `${Math.floor(age / 1000)}s`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  return `${Math.floor(age / 86_400_000)}d`;
}

function fmtBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export default function AdvAgentsPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const { agents, loading, error, refresh } = useHarnessAgents(slug);
  // showAll persists in the URL (nuqs) so it survives reload + is agent-driveable.
  const [showAll, setShowAll] = useQueryState('agentsAll', parseAsBoolean.withDefault(false));
  // Clicking a row with a feature jumps the Detail pane to that feature.
  const [, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo<HarnessAgentRun[]>(() => {
    if (!agents) return [];
    const xs = showAll ? agents : agents.filter((r) => r.running);
    // Most recent first (running rows float up via lastEventTs/ts).
    return [...xs].sort((a, b) => (b.lastEventTs ?? b.ts ?? 0) - (a.lastEventTs ?? a.ts ?? 0));
  }, [agents, showAll]);

  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 12,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [visible, rowVirtualizer]);

  const columns = useMemo<ColumnDef<HarnessAgentRun>[]>(() => [
    {
      key: 'running',
      header: '',
      headerText: '',
      width: '22px',
      render: ({ row }) => (
        <Tooltip label={row.running ? 'running' : 'idle'}>
          <span className={`pc-adv-agents__dot${row.running ? ' is-running' : ''}`} aria-hidden />
        </Tooltip>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      headerText: 'Role',
      width: '104px',
      toCopyText: (r) => r.role,
      render: ({ row }) => {
        const rs = getRoleStyle(row.role);
        return (
          <span className="pc-adv-agents__role">
            <span className="pc-adv-agents__role-dot" style={{ background: rs.solid }} aria-hidden />
            {rs.label.toLowerCase()}
          </span>
        );
      },
    },
    {
      key: 'run',
      header: 'Run',
      headerText: 'Run',
      width: 1,
      toCopyText: (r) => r.runId,
      render: ({ row }) => (
        <span className="pc-adv-agents__cellrow">
          <Tooltip label={row.runId}>
            <span className="pc-adv-agents__run">{row.runId}</span>
          </Tooltip>
          {row.featureId ? <span className="pc-adv-agents__feat">{row.featureId}</span> : null}
        </span>
      ),
    },
    {
      key: 'size',
      header: 'Size',
      headerText: 'Size',
      width: '58px',
      align: 'right',
      toCopyText: (r) => fmtBytes(r.sizeBytes),
      render: ({ row }) => <span className="pc-adv-agents__num">{fmtBytes(row.sizeBytes)}</span>,
    },
    {
      key: 'age',
      header: 'Age',
      headerText: 'Age',
      width: '48px',
      align: 'right',
      render: ({ row }) => (
        <Tooltip label={row.lastEventTs ? new Date(row.lastEventTs).toISOString() : ''}>
          <span className="pc-adv-agents__num">{fmtAge(row.lastEventTs ?? row.ts)}</span>
        </Tooltip>
      ),
    },
  ], []);

  if (!slug) {
    return <div className="pc-adv-agents__empty">No harness slug in params.</div>;
  }

  const runningCount = agents?.filter((r) => r.running).length ?? 0;

  return (
    <div className="pc-adv-agents">
      <div className="pc-adv-agents__bar">
        <button
          type="button"
          className="pc-adv-agents__toggle"
          aria-pressed={showAll}
          onClick={() => void setShowAll((v) => !v)}
        >
          {showAll ? 'All' : 'Running only'} <span className="pc-adv-agents__count">{visible.length}</span>
        </button>
        {!showAll && runningCount === 0 && agents && agents.length > 0 ? (
          <span className="pc-adv-agents__hint">{agents.length} total — none running</span>
        ) : null}
        <Tooltip label="Refresh agent runs">
          <button type="button" className="pc-adv-agents__refresh" onClick={() => refresh()} aria-label="Refresh agent runs">
            <RefreshCw size={12} aria-hidden />
          </button>
        </Tooltip>
      </div>

      <div ref={scrollRef} className="pc-adv-agents__list">
        {error ? (
          <div className="pc-adv-agents__empty pc-adv-agents__empty--err">Failed: {error}</div>
        ) : loading ? (
          <div className="pc-adv-agents__empty">Loading {slug}…</div>
        ) : (
          <RichGrid<HarnessAgentRun>
            inline
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: visible.length,
              rowAt: (i) => visible[i],
            }}
            columns={columns}
            getRowId={(r) => r.runId}
            onRowClick={(r) => { if (r.featureId) void setSelectedId(r.featureId); }}
            headerHeight={26}
            rowMinHeight={32}
            headerStyle={{
              background: 'var(--bg-2, rgba(255,255,255,0.045))',
              color: 'var(--fg-mute, #7f9bb4)',
              borderBottom: '1px solid var(--border, rgba(125,211,252,0.15))',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
            empty={
              <div className="pc-adv-agents__empty">
                {showAll ? 'No agent runs for this harness yet.' : 'No agents running.'}
              </div>
            }
          />
        )}
      </div>

      <style>{`
        .pc-adv-agents { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-1, #0b1220); }
        .pc-adv-agents__bar {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 8px; flex-shrink: 0;
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.15));
        }
        .pc-adv-agents__toggle {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 2px 9px; font-size: 11px; color: var(--fg);
          background: transparent;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.15));
          border-radius: 999px; cursor: pointer;
        }
        .pc-adv-agents__toggle[aria-pressed="true"] {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 45%);
        }
        .pc-adv-agents__count { font-variant-numeric: tabular-nums; color: var(--fg-mute); font-size: 10px; }
        .pc-adv-agents__hint { font-size: 10px; color: var(--fg-mute); }
        .pc-adv-agents__refresh {
          margin-left: auto; display: inline-flex; align-items: center;
          padding: 4px; color: var(--fg-mute); background: transparent;
          border: 0; border-radius: 4px; cursor: pointer;
        }
        .pc-adv-agents__refresh:hover { color: var(--fg); border-color: var(--accent); }
        .pc-adv-agents__list { flex: 1; min-height: 0; overflow: auto; }
        .pc-adv-agents__dot {
          display: inline-block; width: 7px; height: 7px; border-radius: 50%;
          background: color-mix(in oklab, var(--fg-mute), transparent 30%);
        }
        .pc-adv-agents__dot.is-running {
          background: var(--good, #4ade80);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--good, #4ade80), transparent 78%);
        }
        .pc-adv-agents__role {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 11px; font-weight: 600; color: var(--fg, #e7f7ff);
        }
        .pc-adv-agents__role-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .pc-adv-agents__cellrow { display: inline-flex; align-items: baseline; gap: 8px; min-width: 0; width: 100%; }
        .pc-adv-agents__run {
          flex: 1; min-width: 0; font-family: ui-monospace, monospace; font-size: 10px;
          color: var(--fg-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pc-adv-agents__feat {
          font-family: ui-monospace, monospace; font-size: 10px; flex-shrink: 0;
          color: var(--accent-strong, #7dd3fc);
        }
        .pc-adv-agents__num {
          font-size: 10px; color: var(--fg-mute); font-variant-numeric: tabular-nums;
        }
        .pc-adv-agents__empty { padding: 16px; font-size: 13px; color: var(--fg-mute); }
        .pc-adv-agents__empty--err { color: var(--bad, #f87171); }
      `}</style>
    </div>
  );
}
