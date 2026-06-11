'use client';

// adv:logs — recent structured log events from run.log.jsonl (+ rotated
// peers) via /log/history. Ports the legacy RealLogsPanel: terminal-style
// time/level/source/message rows, level filter chips + source text filter.
// One-shot read + manual Refresh (no 3s auto-poll, per the /adv ethos).
//
// Rendered on @papercusp/grid-core RichGrid in LEGACY (non-virtual) mode: the
// feed is bounded (≤300 events from useHarnessLogs) and the message column
// wraps to multiple lines, so auto-height rows are simpler + read better than
// a fixed-height virtualized window.

import { useMemo } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { RefreshCw } from 'lucide-react';
import { RichGrid, usePersistedColumnWidths, type ColumnDef } from '@papercusp/grid-core';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { Tooltip } from '../../harness/Tooltip';
import { useHarnessLogs, type HarnessLogEvent } from './useHarnessData';

const LEVEL_FILTERS = ['all', 'error', 'warn', 'info'] as const;
type LevelFilter = (typeof LEVEL_FILTERS)[number];

// Per-level accent — token-first with hex fallbacks. Log levels are a
// distinct axis from feature/issue status; these map to the shared semantic
// tokens (--bad / --warn / sky) so they stay on-theme.
const LEVEL_ACCENT: Record<string, string> = {
  error: 'var(--bad, #f87171)',
  warn: 'var(--warn, #fbbf24)',
  info: 'var(--accent-strong, #7dd3fc)',
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

type LogRow = { id: string; ev: HarnessLogEvent };

export default function AdvLogsPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const { events, loading, error, refresh } = useHarnessLogs(slug);
  const [filter, setFilter] = useQueryState(
    'logLevel',
    parseAsStringEnum<LevelFilter>([...LEVEL_FILTERS]).withDefault('all'),
  );
  const [sourceFilter, setSourceFilter] = useQueryState('logSource', parseAsString.withDefault(''));
  // Dragged widths survive panel remounts (localStorage — render-only pref).
  const [colWidths, setColWidths] = usePersistedColumnWidths('pc-colw:adv:logs');

  const rows = useMemo<LogRow[]>(() => {
    if (!events) return [];
    let xs = events;
    if (filter !== 'all') xs = xs.filter((e) => levelOf(e) === filter);
    if (sourceFilter) {
      const q = sourceFilter.toLowerCase();
      xs = xs.filter((e) => String(e.source ?? '').toLowerCase().includes(q));
    }
    return xs.map((ev, i) => ({ id: `${i}:${ev.ts ?? ''}`, ev }));
  }, [events, filter, sourceFilter]);

  const columns = useMemo<ColumnDef<LogRow>[]>(() => [
    {
      key: 'time',
      header: 'Time',
      headerText: 'Time',
      width: '76px',
      toCopyText: (r) => {
        const t = new Date(r.ev.ts);
        return isNaN(t.getTime()) ? '' : t.toLocaleTimeString();
      },
      render: ({ row }) => {
        const t = new Date(row.ev.ts);
        return <span className="pc-adv-logs__time">{isNaN(t.getTime()) ? '' : t.toLocaleTimeString()}</span>;
      },
    },
    {
      key: 'level',
      header: 'Lvl',
      headerText: 'Level',
      width: '52px',
      toCopyText: (r) => levelOf(r.ev),
      render: ({ row }) => {
        const lvl = levelOf(row.ev);
        return <span className="pc-adv-logs__level" style={{ color: LEVEL_ACCENT[lvl] ?? 'var(--fg-mute)' }}>{lvl}</span>;
      },
    },
    {
      key: 'source',
      header: 'Source',
      headerText: 'Source',
      width: '150px',
      toCopyText: (r) => String(r.ev.source ?? ''),
      // Native title=, not <Tooltip>: per-row truncation hint in a grid cell —
      // a Radix portal per row is the documented perf anti-pattern.
      render: ({ row }) =>
        row.ev.source ? (
          <span className="pc-adv-logs__src" title={String(row.ev.source)}>
            {String(row.ev.source)}
          </span>
        ) : null,
    },
    {
      key: 'msg',
      header: 'Message',
      headerText: 'Message',
      width: 1,
      toCopyText: (r) => messageOf(r.ev),
      render: ({ row }) => <span className="pc-adv-logs__msg">{messageOf(row.ev)}</span>,
    },
  ], []);

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
        <Tooltip label="Refresh log">
          <button type="button" className="pc-adv-logs__refresh" onClick={() => refresh()} aria-label="Refresh log">
            <RefreshCw size={12} aria-hidden />
          </button>
        </Tooltip>
      </div>

      <div className="pc-adv-logs__body">
        {error ? (
          <div className="pc-adv-logs__empty pc-adv-logs__empty--err">Failed: {error}</div>
        ) : loading ? (
          <div className="pc-adv-logs__empty">Loading {slug}…</div>
        ) : (
          <RichGrid<LogRow>
            inline
            rows={rows}
            columns={columns}
            resizableColumns
            columnWidths={colWidths}
            onColumnWidthsChange={setColWidths}
            getRowId={(r) => r.id}
            headerHeight={26}
            rowMinHeight={24}
            headerStyle={{
              background: 'var(--bg-2, rgba(255,255,255,0.045))',
              color: 'var(--fg-mute, #7f9bb4)',
              borderBottom: '1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%))',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
            empty={
              <div className="pc-adv-logs__empty">
                {events && events.length ? 'No events match the filter.' : 'No log events yet.'}
              </div>
            }
          />
        )}
      </div>

      <style>{`
        .pc-adv-logs { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-1, #0b1220); }
        .pc-adv-logs__bar {
          display: flex; align-items: center; gap: 4px;
          padding: 6px 8px; flex-shrink: 0;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        }
        .pc-adv-logs__chip {
          padding: 2px 8px; font-size: 11px; color: var(--fg);
          background: transparent;
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          border-radius: 999px; cursor: pointer; text-transform: lowercase;
        }
        .pc-adv-logs__chip[aria-pressed="true"] {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 50%);
        }
        .pc-adv-logs__source {
          margin-left: 6px; flex: 1; min-width: 80px;
          padding: 2px 8px; font-size: 11px; color: var(--fg);
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          border-radius: 6px;
        }
        .pc-adv-logs__source::placeholder { color: var(--fg-mute); }
        .pc-adv-logs__refresh {
          display: inline-flex; align-items: center; padding: 4px;
          color: var(--fg-mute); background: transparent; border: 0;
          border-radius: 4px; cursor: pointer;
        }
        .pc-adv-logs__refresh:hover { color: var(--fg); }
        .pc-adv-logs__body {
          flex: 1; min-height: 0; overflow: auto;
          font-family: ui-monospace, monospace; font-size: 11px;
        }
        .pc-adv-logs__time { color: var(--fg-mute); font-family: ui-monospace, monospace; }
        .pc-adv-logs__level { text-transform: uppercase; font-family: ui-monospace, monospace; }
        .pc-adv-logs__src {
          color: var(--accent-strong, #7dd3fc); font-family: ui-monospace, monospace;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%;
        }
        .pc-adv-logs__msg {
          color: color-mix(in oklab, var(--fg), transparent 12%);
          font-family: ui-monospace, monospace;
          white-space: pre-wrap; word-break: break-word;
        }
        .pc-adv-logs__empty { padding: 16px; font-size: 13px; color: var(--fg-mute); font-family: system-ui; }
        .pc-adv-logs__empty--err { color: var(--bad, #f87171); }
      `}</style>
    </div>
  );
}
