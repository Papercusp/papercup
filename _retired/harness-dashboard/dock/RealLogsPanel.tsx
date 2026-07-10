/**
 * RealLogsPanel — recent structured log events streamed from
 * /api/harness/<slug>/log/stream (SSE; server tails run.log.jsonl).
 *
 * Compact list view with source + level coloring. Log tails are a
 * documented byte-stream exception to useSyncQuery (data-sync §genuine
 * exceptions) — the old 3s fetch poll is gone (audit P-058); appended
 * lines push over SSE. Entries carry a monotonic client id used as the
 * render key (audit P-064 — a ts-idx composite shifts identity as the
 * buffer rolls).
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createResilientEventSource } from '@papercusp/sse';
import type { PanelComponentProps } from './panel-registry';

interface LogEvent {
  ts: string;
  source: string;
  level?: string;
  msg: string;
}

interface KeyedLogEvent extends LogEvent {
  key: number;
}

const LOG_BUFFER_CAP = 500;

const LEVEL_COLORS: Record<string, string> = {
  error: 'var(--bad)',
  warn: 'var(--warn)',
  info: 'var(--fg-mute)',
  debug: '#64748b',
  trace: '#475569',
};

type LevelFilter = 'all' | 'error' | 'warn' | 'info';

export function RealLogsPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const [events, setEvents] = useState<KeyedLogEvent[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('');

  useEffect(() => {
    if (!slug) return;
    setEvents(null);
    setError(null);

    // Coalesce bursts (the connect backfill replays up to 200 lines) into
    // one state update per 100ms window instead of one per SSE event.
    let nextKey = 0;
    let pending: KeyedLogEvent[] = [];
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      setEvents((prev) => [...(prev ?? []), ...batch].slice(-LOG_BUFFER_CAP));
    };
    const scheduleFlush = () => {
      if (flushTimer === null) flushTimer = window.setTimeout(flush, 100);
    };

    const source = createResilientEventSource({
      url: `/api/harness/${encodeURIComponent(slug)}/log/stream?tail=200`,
      handlers: {
        log: (data: string) => {
          try {
            const e = JSON.parse(data) as LogEvent;
            pending.push({
              ts: String(e.ts ?? ''),
              source: String(e.source ?? ''),
              level: e.level,
              msg: String(e.msg ?? (e as { message?: string }).message ?? ''),
              key: nextKey++,
            });
            scheduleFlush();
          } catch {
            /* non-JSON line — skip */
          }
        },
        'backfill-done': () => flush(),
      },
      onStatusChange: (s) => {
        if (s === 'failing') setError(new Error('log stream disconnected — retrying'));
        if (s === 'open') setError(null);
      },
    });
    return () => {
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      source.close();
    };
  }, [slug]);

  useEffect(() => {
    if (events) api.setTitle(`Logs: ${slug} (${events.length})`);
  }, [events, slug, api]);

  const filtered = useMemo(() => {
    if (!events) return [];
    let xs = events;
    if (filter !== 'all') {
      xs = xs.filter((e) => (e.level ?? '').toLowerCase() === filter);
    }
    if (sourceFilter) {
      xs = xs.filter((e) =>
        e.source.toLowerCase().includes(sourceFilter.toLowerCase()),
      );
    }
    return xs;
  }, [events, filter, sourceFilter]);

  if (!slug)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        No harness slug in params.
      </div>
    );
  if (error && !events?.length)
    return <div style={{ padding: 16, fontSize: 13, color: 'var(--bad)' }}>Failed: {error.message}</div>;
  if (!events)
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
                color: LEVEL_COLORS[key] ?? 'var(--fg)',
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
            color: 'var(--fg)',
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
          <div style={{ padding: 16, color: 'var(--fg-mute)' }}>
            No events match.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {filtered.map((e) => {
              const t = new Date(e.ts);
              const time = isNaN(t.getTime()) ? '' : t.toLocaleTimeString();
              const lvl = (e.level ?? 'info').toLowerCase();
              return (
                <li
                  key={e.key}
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
