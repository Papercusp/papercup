'use client';

// adv:logs — recent structured log events from run.log.jsonl (+ rotated
// peers) via /log/history. Ports the legacy RealLogsPanel: terminal-style
// time/level/source/message rows, level filter chips + source text filter.
// One-shot read + manual Refresh (no 3s auto-poll, per the /adv ethos).

import { useMemo, useState } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { RefreshCw } from 'lucide-react';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { useHarnessLogs, type HarnessLogEvent } from './useHarnessData';

const LEVEL_FILTERS = ['all', 'error', 'warn', 'info'] as const;
type LevelFilter = (typeof LEVEL_FILTERS)[number];

// Per-level accent — token-first with hex fallbacks (see AdvAgentsPanel).
const LEVEL_ACCENT: Record<string, string> = {
  error: 'var(--bad, #f87171)',
  warn: 'var(--warn, #fbbf24)',
  info: 'var(--sky-300, #7dd3fc)',
  debug: 'var(--fg-mute)',
  trace: 'color-mix(in oklab, var(--fg-mute), transparent 35%)',
};

function levelOf(e: HarnessLogEvent): string {
  return String(e.level ?? 'info').toLowerCase();
}

// The writer's schema is loose — read the message under whichever key it
// used, falling back to a compact dump of the non-envelope fields.
function messageOf(e: HarnessLogEvent): string {
  if (typeof e.msg === 'string') return e.msg;
  if (typeof e.message === 'string') return e.message;
  const { ts: _ts, source: _source, level: _level, msg: _msg, message: _message, ...rest } = e;
  const keys = Object.keys(rest);
  if (keys.length === 0) return '';
  try {
    return JSON.stringify(rest);
  } catch {
    return keys.join(', ');
  }
}

export default function AdvLogsPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const { events, loading, error, refresh } = useHarnessLogs(slug);
  const [filter, setFilter] = useQueryState(
    'logLevel',
    parseAsStringEnum<LevelFilter>([...LEVEL_FILTERS]).withDefault('all'),
  );
  const [sourceFilter, setSourceFilter] = useQueryState('logSource', parseAsString.withDefault(''));

  const filtered = useMemo<HarnessLogEvent[]>(() => {
    if (!events) return [];
    let xs = events;
    if (filter !== 'all') xs = xs.filter((e) => levelOf(e) === filter);
    if (sourceFilter) {
      const q = sourceFilter.toLowerCase();
      xs = xs.filter((e) => String(e.source ?? '').toLowerCase().includes(q));
    }
    return xs;
  }, [events, filter, sourceFilter]);

  if (!slug) {
    return <div className="pc-adv-logs__empty">No harness slug in params.</div>;
  }

  return (
    <div className="pc-adv-logs">
      <div className="pc-adv-logs__bar">
        {LEVEL_FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            className="pc-adv-logs__chip"
            aria-pressed={filter === key}
            onClick={() => void setFilter(key)}
            style={key !== 'all' ? { color: LEVEL_ACCENT[key] } : undefined}
          >
            {key}
          </button>
        ))}
        <input
          type="text"
          className="pc-adv-logs__source"
          value={sourceFilter}
          onChange={(e) => void setSourceFilter(e.target.value)}
          placeholder="source filter"
          aria-label="Filter log events by source"
        />
        <button
          type="button"
          className="pc-adv-logs__refresh"
          onClick={() => refresh()}
          aria-label="Refresh log"
          title="Refresh"
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>

      <div className="pc-adv-logs__body">
        {error ? (
          <div className="pc-adv-logs__empty pc-adv-logs__empty--err">Failed: {error}</div>
        ) : loading ? (
          <div className="pc-adv-logs__empty">Loading {slug}…</div>
        ) : filtered.length === 0 ? (
          <div className="pc-adv-logs__empty">{events && events.length ? 'No events match the filter.' : 'No log events yet.'}</div>
        ) : (
          <ul className="pc-adv-logs__rows">
            {filtered.map((e, idx) => {
              const t = new Date(e.ts);
              const time = isNaN(t.getTime()) ? '' : t.toLocaleTimeString();
              const lvl = levelOf(e);
              return (
                <li key={`${e.ts}-${idx}`} className="pc-adv-logs__row">
                  <span className="pc-adv-logs__time">{time}</span>
                  <span className="pc-adv-logs__level" style={{ color: LEVEL_ACCENT[lvl] ?? 'var(--fg-mute)' }}>
                    {lvl}
                  </span>
                  {e.source ? (
                    <span className="pc-adv-logs__src" title={String(e.source)}>
                      {String(e.source)}
                    </span>
                  ) : null}
                  <span className="pc-adv-logs__msg">{messageOf(e)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <style>{`
        .pc-adv-logs { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .pc-adv-logs__bar {
          display: flex; align-items: center; gap: 4px;
          padding: 6px 8px; flex-shrink: 0;
          border-bottom: 1px solid color-mix(in oklab, var(--border), transparent 25%);
          background: color-mix(in oklab, var(--bg-2, #0f1722), transparent 25%);
        }
        .pc-adv-logs__chip {
          padding: 2px 8px; font-size: 11px; color: var(--fg);
          background: transparent;
          border: 1px solid color-mix(in oklab, var(--border), transparent 25%);
          border-radius: 999px; cursor: pointer; text-transform: lowercase;
        }
        .pc-adv-logs__chip[aria-pressed="true"] {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 50%);
        }
        .pc-adv-logs__source {
          margin-left: 6px; flex: 1; min-width: 80px;
          padding: 2px 8px; font-size: 11px; color: var(--fg);
          background: transparent;
          border: 1px solid color-mix(in oklab, var(--border), transparent 25%);
          border-radius: 6px;
        }
        .pc-adv-logs__source::placeholder { color: var(--fg-mute); }
        .pc-adv-logs__refresh {
          display: inline-flex; align-items: center; padding: 4px;
          color: var(--fg-mute); background: transparent; border: 0;
          border-radius: 4px; cursor: pointer;
        }
        .pc-adv-logs__refresh:hover { color: var(--fg); background: color-mix(in oklab, var(--fg), transparent 90%); }
        .pc-adv-logs__body {
          flex: 1; min-height: 0; overflow: auto;
          font-family: ui-monospace, monospace; font-size: 11px;
          background: color-mix(in oklab, var(--bg, #0a0f16), black 18%);
        }
        .pc-adv-logs__rows { margin: 0; padding: 0; list-style: none; }
        .pc-adv-logs__row {
          display: flex; gap: 8px; padding: 2px 10px;
          border-bottom: 1px solid color-mix(in oklab, var(--border), transparent 70%);
          color: color-mix(in oklab, var(--fg), transparent 18%);
          white-space: pre-wrap; word-break: break-word;
        }
        .pc-adv-logs__time { color: var(--fg-mute); flex-shrink: 0; min-width: 68px; }
        .pc-adv-logs__level { flex-shrink: 0; min-width: 38px; text-transform: uppercase; }
        .pc-adv-logs__src {
          color: color-mix(in oklab, var(--fg-mute), var(--accent, #38bdf8) 25%);
          flex-shrink: 0; min-width: 72px; max-width: 168px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pc-adv-logs__msg { flex: 1; min-width: 0; }
        .pc-adv-logs__empty { padding: 16px; font-size: 13px; color: var(--fg-mute); font-family: var(--font, system-ui); }
        .pc-adv-logs__empty--err { color: var(--bad, #f87171); }
      `}</style>
    </div>
  );
}
