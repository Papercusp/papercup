/**
 * RealAgentsPanel — agent runs list backed by /api/harness/<slug>/agents.
 *
 * Auto-refreshes every 5s while panel is visible. Shows role, runId,
 * running status, size, and last-event timestamp.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PanelComponentProps } from './panel-registry';

interface AgentRun {
  runId: string;
  role: string;
  ts?: number;
  sizeBytes: number;
  running: boolean;
  lastEventTs?: number;
}

interface AgentsResponse {
  runs: AgentRun[];
}

const ROLE_COLORS: Record<string, string> = {
  scoper: '#60a5fa',
  worker: 'var(--good)',
  validator: 'var(--warn)',
  curator: '#a78bfa',
  expert: '#f472b6',
  unknown: 'var(--fg-mute)',
};

function fmtAge(ms: number | undefined): string {
  if (!ms) return '—';
  const age = Math.max(0, Date.now() - ms);
  if (age < 60_000) return `${Math.floor(age / 1000)}s`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  return `${Math.floor(age / 86_400_000)}d`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export function RealAgentsPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const [data, setData] = useState<AgentsResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!slug) return;
    let cancel = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/agents`);
        if (!r.ok) throw new Error(`status ${r.status}`);
        const j: AgentsResponse = await r.json();
        if (cancel) return;
        setData(j);
        api.setTitle(`Agents: ${slug} (${j.runs.length})`);
      } catch (e) {
        if (cancel) return;
        setError(e as Error);
      }
    };
    load();
    const id = setInterval(load, 5_000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, [slug, api]);

  const visible = useMemo(() => {
    if (!data) return [];
    return showAll ? data.runs : data.runs.filter((r) => r.running);
  }, [data, showAll]);

  if (!slug)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        No harness slug in params.
      </div>
    );
  if (error)
    return <div style={{ padding: 16, fontSize: 13, color: 'var(--bad)' }}>Failed: {error.message}</div>;
  if (!data)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        Loading {slug}…
      </div>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '6px 8px',
          borderBottom: '1px solid var(--border, #333)',
          background: 'var(--bg-2)',
          flexShrink: 0,
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          style={{
            padding: '2px 8px',
            fontSize: 11,
            background: showAll ? 'var(--accent,#2a2a2a)' : 'transparent',
            color: 'var(--fg)',
            border: '1px solid var(--border,#333)',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          {showAll ? 'All' : 'Running only'} ({visible.length})
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--fg-mute)' }}>
          auto-refresh 5s
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', fontSize: 12 }}>
        {visible.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--fg-mute)' }}>
            No agents match.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {visible.map((r) => (
              <li
                key={r.runId}
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'baseline',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: r.running ? 'var(--good)' : '#444',
                    flexShrink: 0,
                  }}
                  title={r.running ? 'running' : 'idle'}
                />
                <span
                  style={{
                    minWidth: 70,
                    fontSize: 11,
                    color: ROLE_COLORS[r.role] ?? ROLE_COLORS.unknown,
                    fontWeight: 600,
                  }}
                >
                  {r.role}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 10,
                    color: 'var(--fg-mute)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={r.runId}
                >
                  {r.runId}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--fg-mute)',
                    minWidth: 50,
                    textAlign: 'right',
                  }}
                >
                  {fmtBytes(r.sizeBytes)}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--fg-mute)',
                    minWidth: 30,
                    textAlign: 'right',
                  }}
                  title={r.lastEventTs ? new Date(r.lastEventTs).toISOString() : ''}
                >
                  {fmtAge(r.lastEventTs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
