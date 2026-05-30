'use client';

// adv:agents — recent agent runs for the harness. Ports the legacy
// RealAgentsPanel onto the /adv data pattern: live via the Zero overlay
// (`agentRunsConsolidated.bySlug`) with a one-shot REST bootstrap, no 5s
// polling timer. Running/All toggle, role-coloured rows, blue-frost tokens.

import { useMemo, useState } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { RefreshCw } from 'lucide-react';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { useHarnessAgents, type HarnessAgentRun } from './useHarnessData';

// Per-role accent. Token-first with hex fallbacks so it renders sanely
// even before the theme pass wires every role var. The theme agent owns
// the final palette; these are functional defaults.
const ROLE_ACCENT: Record<string, string> = {
  scoper: 'var(--sky-400, #38bdf8)',
  architect: 'var(--violet-400, #a78bfa)',
  worker: 'var(--good, #4ade80)',
  validator: 'var(--warn, #fbbf24)',
  reviewer: 'var(--sky-300, #7dd3fc)',
  debugger: 'var(--bad, #f87171)',
  documenter: 'var(--accent, #38bdf8)',
  curator: 'var(--violet-400, #a78bfa)',
  operator: 'var(--accent, #38bdf8)',
  oracle: 'var(--good, #4ade80)',
  expert: '#f472b6',
};

function roleAccent(role: string): string {
  return ROLE_ACCENT[role] ?? 'var(--fg-mute)';
}

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

  const visible = useMemo<HarnessAgentRun[]>(() => {
    if (!agents) return [];
    const xs = showAll ? agents : agents.filter((r) => r.running);
    // Most recent first (running rows float up via lastEventTs/ts).
    return [...xs].sort((a, b) => (b.lastEventTs ?? b.ts ?? 0) - (a.lastEventTs ?? a.ts ?? 0));
  }, [agents, showAll]);

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
        <button
          type="button"
          className="pc-adv-agents__refresh"
          onClick={() => refresh()}
          aria-label="Refresh agent runs"
          title="Refresh"
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>

      <div className="pc-adv-agents__list">
        {error ? (
          <div className="pc-adv-agents__empty pc-adv-agents__empty--err">Failed: {error}</div>
        ) : loading ? (
          <div className="pc-adv-agents__empty">Loading {slug}…</div>
        ) : visible.length === 0 ? (
          <div className="pc-adv-agents__empty">
            {showAll ? 'No agent runs for this harness yet.' : 'No agents running.'}
          </div>
        ) : (
          <ul className="pc-adv-agents__rows">
            {visible.map((r) => (
              <li key={r.runId} className="pc-adv-agents__row">
                <span
                  className={`pc-adv-agents__dot${r.running ? ' is-running' : ''}`}
                  title={r.running ? 'running' : 'idle'}
                  aria-hidden
                />
                <span className="pc-adv-agents__role" style={{ color: roleAccent(r.role) }}>
                  {r.role}
                </span>
                <span className="pc-adv-agents__run" title={r.runId}>
                  {r.runId}
                </span>
                {r.featureId ? <span className="pc-adv-agents__feat">{r.featureId}</span> : null}
                <span className="pc-adv-agents__size">{fmtBytes(r.sizeBytes)}</span>
                <span className="pc-adv-agents__age" title={r.lastEventTs ? new Date(r.lastEventTs).toISOString() : ''}>
                  {fmtAge(r.lastEventTs ?? r.ts)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <style>{`
        .pc-adv-agents { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .pc-adv-agents__bar {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 8px; flex-shrink: 0;
          border-bottom: 1px solid color-mix(in oklab, var(--border), transparent 25%);
          background: color-mix(in oklab, var(--bg-2, #0f1722), transparent 25%);
        }
        .pc-adv-agents__toggle {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 2px 9px; font-size: 11px; color: var(--fg);
          background: transparent;
          border: 1px solid color-mix(in oklab, var(--border), transparent 10%);
          border-radius: 999px; cursor: pointer;
        }
        .pc-adv-agents__toggle[aria-pressed="true"] {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 82%);
          border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 45%);
        }
        .pc-adv-agents__count {
          font-variant-numeric: tabular-nums;
          color: var(--fg-mute); font-size: 10px;
        }
        .pc-adv-agents__hint { font-size: 10px; color: var(--fg-mute); }
        .pc-adv-agents__refresh {
          margin-left: auto; display: inline-flex; align-items: center;
          padding: 4px; color: var(--fg-mute); background: transparent;
          border: 0; border-radius: 4px; cursor: pointer;
        }
        .pc-adv-agents__refresh:hover { color: var(--fg); background: color-mix(in oklab, var(--fg), transparent 90%); }
        .pc-adv-agents__list { flex: 1; min-height: 0; overflow: auto; }
        .pc-adv-agents__rows { margin: 0; padding: 0; list-style: none; }
        .pc-adv-agents__row {
          display: flex; align-items: baseline; gap: 8px;
          padding: 6px 12px;
          border-bottom: 1px solid color-mix(in oklab, var(--border), transparent 55%);
          font-size: 12px;
        }
        .pc-adv-agents__dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: color-mix(in oklab, var(--fg-mute), transparent 30%);
          flex-shrink: 0; align-self: center;
        }
        .pc-adv-agents__dot.is-running {
          background: var(--good, #4ade80);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--good, #4ade80), transparent 78%);
        }
        .pc-adv-agents__role { min-width: 72px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
        .pc-adv-agents__run {
          flex: 1; min-width: 0; font-family: ui-monospace, monospace; font-size: 10px;
          color: var(--fg-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pc-adv-agents__feat {
          font-family: ui-monospace, monospace; font-size: 10px; flex-shrink: 0;
          color: color-mix(in oklab, var(--accent, #38bdf8), var(--fg) 30%);
        }
        .pc-adv-agents__size, .pc-adv-agents__age {
          font-size: 10px; color: var(--fg-mute); text-align: right;
          font-variant-numeric: tabular-nums; flex-shrink: 0;
        }
        .pc-adv-agents__size { min-width: 48px; }
        .pc-adv-agents__age { min-width: 28px; }
        .pc-adv-agents__empty { padding: 16px; font-size: 13px; color: var(--fg-mute); }
        .pc-adv-agents__empty--err { color: var(--bad, #f87171); }
      `}</style>
    </div>
  );
}
