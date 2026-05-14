/**
 * RealLogsPanel — recent structured log events backed by
 * /api/harness/<slug>/log/history.
 *
 * Compact list view with source + level coloring. Auto-refresh 3s.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PanelComponentProps } from './panel-registry';

interface LogEvent {
  ts: string;
  source: string;
  level?: string;
  msg: string;
}

interface LogResponse {
  events: LogEvent[];
}

const LEVEL_COLORS: Record<string, string> = {
  error: '#f87171',
  warn: '#fbbf24',
  info: '#94a3b8',
  debug: '#64748b',
  trace: '#475569',
};

type LevelFilter = 'all' | 'error' | 'warn' | 'info';

export function RealLogsPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const [data, setData] = useState<LogResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('');

  useEffect(() => {
    if (!slug) return;
    let cancel = false;
    const load = async () => {
      try {
        const r = await fetch(
          `/api/harness/${encodeURIComponent(slug)}/log/history?limit=200`,
        );
        if (!r.ok) throw new Error(`status ${r.status}`);
        const j: LogResponse = await r.json();
        if (cancel) return;
        setData(j);
        api.setTitle(`Logs: ${slug} (${j.events.length})`);
      } catch (e) {
        if (cancel) return;
        setError(e as Error);
      }
    };
    load();
    const id = setInterval(load, 3_000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, [slug, api]);

  const filtered = useMemo(() => {
    if (!data) return [];
    let xs = data.events;
    if (filter !== 'all') {
      xs = xs.filter((e) => (e.level ?? '').toLowerCase() === filter);
    }
    if (sourceFilter) {
      xs = xs.filter((e) =>
        e.source.toLowerCase().includes(sourceFilter.toLowerCase()),
      );
    }
    return xs;
  }, [data, filter, sourceFilter]);

  if (!slug)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--muted-foreground,#888)' }}>
        No harness slug in params.
      </div>
    );
  if (error)
    return <div style={{ padding: 16, fontSize: 13, color: '#f87171' }}>Failed: {error.message}</div>;
  if (!data)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--muted-foreground,#888)' }}>
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
          background: 'var(--card, #1a1a1a)',
          flexShrink: 0,
          alignItems: 'center',
        }}
      >
        {(['all', 'error', 'warn', 'info'] as LevelFilter[]).map((key) => {
          const active = filter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              style={{
                padding: '2px 6px',
                fontSize: 11,
                background: active ? 'var(--accent,#2a2a2a)' : 'transparent',
                color: LEVEL_COLORS[key] ?? 'var(--foreground,#ccc)',
                border: '1px solid var(--border,#333)',
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              {key}
            </button>
          );
        })}
        <input
          type="text"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          placeholder="source filter"
          style={{
            marginLeft: 8,
            padding: '2px 6px',
            fontSize: 11,
            background: 'transparent',
            color: 'var(--foreground,#ccc)',
            border: '1px solid var(--border,#333)',
            borderRadius: 3,
            flex: 1,
            minWidth: 80,
          }}
        />
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          fontSize: 11,
          fontFamily: 'ui-monospace, monospace',
          background: '#0a0a0a',
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--muted-foreground,#888)' }}>
            No events match.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {filtered.map((e, idx) => {
              const t = new Date(e.ts);
              const time = isNaN(t.getTime()) ? '' : t.toLocaleTimeString();
              const lvl = (e.level ?? 'info').toLowerCase();
              return (
                <li
                  key={`${e.ts}-${idx}`}
                  style={{
                    display: 'flex',
                    gap: 6,
                    padding: '2px 8px',
                    borderBottom: '1px solid #1a1a1a',
                    color: '#aaa',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  <span style={{ color: '#555', flexShrink: 0, minWidth: 70 }}>{time}</span>
                  <span
                    style={{
                      color: LEVEL_COLORS[lvl] ?? '#888',
                      flexShrink: 0,
                      minWidth: 38,
                      textTransform: 'uppercase',
                    }}
                  >
                    {lvl}
                  </span>
                  <span
                    style={{
                      color: '#666',
                      flexShrink: 0,
                      minWidth: 80,
                      maxWidth: 160,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={e.source}
                  >
                    {e.source}
                  </span>
                  <span style={{ flex: 1 }}>{e.msg}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
