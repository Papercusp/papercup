'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { ArrowUpRight, Bot, CheckCircle, Circle, Cpu, Eye, FileCode, User, XCircle } from 'lucide-react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import type { Issue, IssueSource, IssueStatus } from '@papercusp/operator-core/lib/harness/issue-types';
import { SeverityPill, ISSUE_STATUS_ICON } from '../../harness/primitives';
import { ISSUE_STATUS, SEVERITY, type IssueStatusKey, type IssueSeverityKey } from '../../harness/theme';
import { Tooltip } from '../../harness/Tooltip';
import PinMenu, { type PinMenuState } from './PinMenu';
import { useHarnessIssues } from './useHarnessData';
import { issueAction, issueActionStatus, type IssueActionKind } from './harness-actions';

type StatusFilter = 'all' | IssueStatus;

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'acknowledged', label: 'Ack' },
  { key: 'fixing', label: 'Fixing' },
  { key: 'closed', label: 'Closed' },
  { key: 'wontfix', label: 'Won’t fix' },
];

// Per-filter accent — each status-filter chip carries the canonical
// ISSUE_STATUS hue it filters, matching the row severity stripes/status dots.
const FILTER_ACCENT: Record<StatusFilter, string> = {
  all: 'var(--accent, #38bdf8)',
  open: ISSUE_STATUS.open.solid,
  acknowledged: ISSUE_STATUS.acknowledged.solid,
  fixing: ISSUE_STATUS.fixing.solid,
  closed: ISSUE_STATUS.closed.solid,
  wontfix: ISSUE_STATUS.wontfix.solid,
};

// Source → icon (validator/worker = Bot, human = User). Source carries no
// color semantics, so it stays a local map; severity + status colors come
// from the canonical theme.ts tables via the primitives.
const SOURCE_ICON: Record<IssueSource, typeof Circle> = {
  validator: Bot,
  worker: Bot,
  human: User,
  system: Cpu,
};

export default function IssuesPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  // Phase 3: live data via Zero (REST bootstrap + Zero overlay), no polling.
  const { issues, pendingCount, loading, error, patchIssue } = useHarnessIssues(slug);
  // URL state (nuqs) so the filter/search are deep-linkable + agent-driveable.
  // Keys are issue-prefixed (ifilter/iq) to avoid colliding with the Features
  // panel's fview/fq.
  const [filter, setFilter] = useQueryState('ifilter', parseAsStringEnum<StatusFilter>(STATUS_FILTERS.map((f) => f.key)).withDefault('open'));
  const [search, setSearch] = useQueryState('iq', parseAsString.withDefault(''));
  const [selectedId, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));
  const [pinMenu, setPinMenu] = useState<PinMenuState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [triaging, setTriaging] = useState(false);

  // P-012: run the curator-style merge of pending validator findings → issues.
  const runTriage = async () => {
    setTriaging(true);
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/triage`, { method: 'POST' });
      const d = (await res.json().catch(() => ({}))) as { merged?: number; deduped?: number; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      toast.success(`Triaged: +${d.merged ?? 0} new, ${d.deduped ?? 0} deduped`);
    } catch (e) {
      toast.error('Triage failed', { description: String(e) });
    } finally {
      setTriaging(false);
    }
  };

  const handleAction = async (i: Issue, action: IssueActionKind) => {
    const target = issueActionStatus(action); // null for promote (server-computed)
    const prevStatus = i.status;
    if (target) patchIssue(i.id, { status: target }); // optimistic
    setBusyId(i.id);
    try {
      await issueAction(slug, i.id, action);
      toast.success(`${i.id} → ${action}`);
    } catch (e) {
      if (target) patchIssue(i.id, { status: prevStatus }); // rollback
      toast.error(`${action} failed`, { description: String(e) });
    } finally {
      setBusyId(null);
    }
  };

  useEffect(() => {
    if (issues) api.setTitle(`Issues · ${slug} (${issues.length})`);
  }, [issues, slug, api]);

  const filtered = useMemo(() => {
    if (!issues) return [];
    const q = search.trim().toLowerCase();
    return issues.filter((i) => {
      if (filter !== 'all' && i.status !== filter) return false;
      if (!q) return true;
      return (
        i.id.toLowerCase().includes(q) ||
        i.title.toLowerCase().includes(q) ||
        (i.evidence?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [issues, filter, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: issues?.length ?? 0 };
    for (const i of issues ?? []) {
      c[i.status] = (c[i.status] ?? 0) + 1;
    }
    return c;
  }, [issues]);

  // P-020: virtualize via the caller-owned virtualizer fed into RichGrid's
  // `virtualMode`. Only the visible window of rows mounts.
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [filtered, rowVirtualizer]);

  // P-019 keyboard nav (panel-scoped): J/K move a focus cursor, ↵ opens
  // (sets ?sel), / focuses search. Fires only when the list holds focus.
  useEffect(() => {
    setFocusIdx((idx) => Math.min(idx, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);
  useEffect(() => {
    if (filtered.length > 0) rowVirtualizer.scrollToIndex(focusIdx, { align: 'auto' });
  }, [focusIdx, filtered.length, rowVirtualizer]);
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (filtered.length === 0) return;
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        setFocusIdx((idx) => Math.min(filtered.length - 1, idx + 1));
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        setFocusIdx((idx) => Math.max(0, idx - 1));
        break;
      case 'Enter': {
        e.preventDefault();
        const it = filtered[focusIdx];
        if (it) void setSelectedId(it.id);
        break;
      }
      case '/':
        e.preventDefault();
        searchRef.current?.focus();
        break;
    }
  };

  const columns = useMemo<ColumnDef<Issue>[]>(() => [
    {
      key: 'id',
      header: 'ID',
      headerText: 'ID',
      width: '60px',
      toCopyText: (i) => i.id,
      // Severity-coloured left accent stripe — same canonical SEVERITY hue as
      // the SeverityPill, so an issue's severity reads as one consistent
      // colour across the stripe, the pill, and the Detail pane.
      cellStyle: ({ row }) => ({
        boxShadow: `inset 3px 0 0 ${SEVERITY[row.severity as IssueSeverityKey].solid}`,
      }),
      render: ({ row }) => (
        <Tooltip label={row.id}>
          <span className="pc-adv-issues__id">{row.id}</span>
        </Tooltip>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      headerText: 'Severity',
      width: '104px',
      toCopyText: (i) => i.severity,
      render: ({ row }) => <SeverityPill severity={row.severity} size="xs" />,
    },
    {
      key: 'title',
      header: 'Title',
      headerText: 'Title',
      width: 1,
      toCopyText: (i) => i.title,
      render: ({ row }) => {
        const StatusIcon = ISSUE_STATUS_ICON[row.status as IssueStatusKey] ?? Circle;
        const SrcIcon = SOURCE_ICON[row.source] ?? Circle;
        const statusColor = ISSUE_STATUS[row.status as IssueStatusKey].solid;
        return (
          <span className="pc-adv-issues__title">
            <Tooltip label={ISSUE_STATUS[row.status as IssueStatusKey].label}>
              <span style={{ display: 'inline-flex', flexShrink: 0 }}>
                <StatusIcon size={12} aria-label={row.status} style={{ color: statusColor }} />
              </span>
            </Tooltip>
            <SrcIcon size={11} aria-label={row.source} style={{ color: 'var(--fg-mute, #7f9bb4)', flexShrink: 0 }} />
            <span className="pc-adv-issues__titletext">{row.title}</span>
          </span>
        );
      },
    },
    {
      key: 'meta',
      header: '',
      width: '150px',
      align: 'right',
      render: ({ row }) => (
        <span className="pc-adv-issues__meta">
          {row.codePointer && (
            <Tooltip label={row.codePointer}>
              <span className="pc-adv-issues__pointer">
                <FileCode size={10} aria-hidden /> {shortPointer(row.codePointer)}
              </span>
            </Tooltip>
          )}
          {row.linkedFeatureId && (
            <Tooltip label={`Linked feature: ${row.linkedFeatureId}`}>
              <span className="pc-adv-issues__link">
                <ArrowUpRight size={10} aria-hidden /> {row.linkedFeatureId}
              </span>
            </Tooltip>
          )}
          {row.foundDuring && (
            <Tooltip label={`Found during: ${row.foundDuring}`}>
              <span className="pc-adv-issues__found">{row.foundDuring}</span>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '116px',
      align: 'right',
      render: ({ row }) => {
        const show = hoveredId === row.id || busyId === row.id;
        const canPromote = !row.linkedFeatureId && row.status !== 'closed' && row.status !== 'wontfix';
        return (
          <span
            className="pc-adv-issues__rowactions"
            style={{ opacity: show ? 1 : 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {canPromote && (
              <Tooltip label="Promote to a fix feature">
                <button type="button" disabled={busyId === row.id} onClick={() => void handleAction(row, 'promote')} aria-label="Promote">
                  <ArrowUpRight size={13} aria-hidden />
                </button>
              </Tooltip>
            )}
            {row.status !== 'acknowledged' && row.status !== 'closed' && (
              <Tooltip label="Acknowledge">
                <button type="button" disabled={busyId === row.id} onClick={() => void handleAction(row, 'acknowledge')} aria-label="Acknowledge">
                  <Eye size={13} aria-hidden />
                </button>
              </Tooltip>
            )}
            {row.status !== 'closed' && (
              <Tooltip label="Close">
                <button type="button" disabled={busyId === row.id} onClick={() => void handleAction(row, 'close')} aria-label="Close">
                  <CheckCircle size={13} aria-hidden />
                </button>
              </Tooltip>
            )}
            {row.status !== 'wontfix' && (
              <Tooltip label="Won't fix">
                <button type="button" disabled={busyId === row.id} onClick={() => void handleAction(row, 'wontfix')} aria-label="Won't fix">
                  <XCircle size={13} aria-hidden />
                </button>
              </Tooltip>
            )}
          </span>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [hoveredId, busyId]);

  const richRowProps = useMemo(
    () => (ctx: { row: Issue; rowIndex: number }) => {
      const isFocus = ctx.rowIndex === focusIdx;
      const isActive = ctx.row.id === selectedId;
      return {
        className: `pc-adv-issues__row${isActive ? ' is-active' : ''}${isFocus ? ' is-focused' : ''}`,
        tabIndex: 0,
        'data-fidx': ctx.rowIndex,
        'aria-label': `${ctx.row.id}: ${ctx.row.title} (${ctx.row.severity}, ${ctx.row.status})`,
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          setPinMenu({
            pos: { x: e.clientX, y: e.clientY },
            itemId: ctx.row.id,
            itemLabel: ctx.row.id,
            harnessSlug: slug,
          });
        },
      };
    },
    [focusIdx, selectedId, slug],
  );

  const richGetRowBg = useMemo(
    () => (row: Issue) => {
      if (row.id === selectedId) return 'color-mix(in oklab, var(--accent), transparent 80%)';
      if (row.id === hoveredId) return 'var(--bg-3)';
      // undefined → RichGrid's default alternating row stripe (zebra),
      // matching the run-log + agents panels.
      return undefined;
    },
    [selectedId, hoveredId],
  );

  if (!slug) {
    return <PanelMessage>Pick a harness to view its issues.</PanelMessage>;
  }
  if (error && !issues) {
    return <PanelMessage tone="error">Failed to load issues: {error}</PanelMessage>;
  }
  if (!issues) {
    return <PanelMessage>{loading ? 'Loading issues…' : 'No issues.'}</PanelMessage>;
  }

  return (
    <div className="pc-adv-issues">
      <div className="pc-adv-issues__bar">
        <input
          ref={searchRef}
          className="pc-adv-issues__search"
          placeholder="Search issues…"
          value={search}
          onChange={(e) => void setSearch(e.target.value || null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <div className="pc-adv-issues__filters">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`pc-adv-issues__filter${filter === f.key ? ' is-active' : ''}`}
              style={{ '--chip-accent': FILTER_ACCENT[f.key] } as React.CSSProperties}
              onClick={() => void setFilter(f.key === 'open' ? null : f.key)}
            >
              {f.label}
              <span>{counts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="pc-adv-issues__triage" role="status">
          <Bot size={13} aria-hidden />
          <span>
            <strong>{pendingCount}</strong> validator finding{pendingCount === 1 ? '' : 's'} pending triage
          </span>
          <Tooltip label="Merge pending validator findings into the issues list">
            <button
              type="button"
              className="pc-adv-issues__triage-btn"
              disabled={triaging}
              onClick={() => void runTriage()}
            >
              {triaging ? 'Triaging…' : `Triage ${pendingCount}`}
            </button>
          </Tooltip>
        </div>
      )}

      <div
        ref={scrollRef}
        className="pc-adv-issues__list"
        tabIndex={0}
        onKeyDown={onListKeyDown}
      >
        <RichGrid<Issue>
          inline
          resizableColumns
          virtualMode={{
            virtualizer: rowVirtualizer,
            totalRows: filtered.length,
            rowAt: (i) => filtered[i],
          }}
          columns={columns}
          getRowId={(i) => i.id}
          onRowClick={(i) => void setSelectedId(i.id)}
          onRowHover={(row) => setHoveredId(row?.id ?? null)}
          rowProps={richRowProps}
          getRowBg={richGetRowBg}
          headerHeight={28}
          rowMinHeight={40}
          headerStyle={{
            background: 'var(--bg-2, rgba(255,255,255,0.045))',
            color: 'var(--fg-mute, #7f9bb4)',
            borderBottom: '1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%))',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
          empty={<PanelMessage>No issues match the current filter.</PanelMessage>}
        />
      </div>
      <div className="pc-adv-issues__footer">
        <span>{filtered.length}/{issues.length} shown</span>
        <span className="pc-adv-issues__kbd">J/K move · ↵ open · / search</span>
      </div>
      <style>{`
        .pc-adv-issues {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          background: var(--bg-1, #0b1220);
          color: var(--fg, #e7f7ff);
        }
        .pc-adv-issues__bar {
          display: flex;
          gap: 12px;
          align-items: center;
          padding: 8px 12px;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          flex-wrap: wrap;
        }
        .pc-adv-issues__search {
          flex: 1;
          min-width: 160px;
          padding: 6px 8px;
          font-size: 12px;
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          color: var(--fg, #e7f7ff);
          border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
          border-radius: 6px;
        }
        .pc-adv-issues__search:focus {
          outline: none;
          border-color: var(--accent, #38bdf8);
          box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
        }
        .pc-adv-issues__search::placeholder { color: var(--fg-mute, #7f9bb4); }
        .pc-adv-issues__filters {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
          align-items: center;
        }
        .pc-adv-issues__filter {
          --_a: var(--chip-accent, var(--accent, #38bdf8));
          display: inline-flex;
          gap: 6px;
          align-items: center;
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 600;
          color: var(--fg-dim, #b9d4e8);
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          border: 1px solid color-mix(in oklab, var(--_a), transparent 68%);
          border-radius: 4px;
          cursor: pointer;
        }
        .pc-adv-issues__filter span {
          color: var(--fg-mute, #7f9bb4);
          font-weight: 700;
        }
        .pc-adv-issues__filter:hover {
          color: var(--fg, #e7f7ff);
          border-color: color-mix(in oklab, var(--_a), transparent 45%);
        }
        .pc-adv-issues__filter.is-active {
          color: var(--fg, #e7f7ff);
          background: color-mix(in oklab, var(--_a), transparent 80%);
          border-color: color-mix(in oklab, var(--_a), transparent 42%);
        }
        .pc-adv-issues__filter.is-active span {
          color: var(--fg, #e7f7ff);
        }
        .pc-adv-issues__triage {
          display: flex;
          gap: 8px;
          align-items: center;
          margin: 8px 12px 0;
          padding: 6px 10px;
          font-size: 11px;
          color: var(--warn, #fbbf24);
          background: var(--warn-bg, rgba(251, 191, 36, 0.1));
          border: 1px solid var(--warn-border, rgba(251, 191, 36, 0.35));
          border-radius: 6px;
        }
        .pc-adv-issues__triage strong {
          color: var(--fg, #e7f7ff);
          font-weight: 800;
        }
        .pc-adv-issues__triage-btn {
          margin-left: auto;
          padding: 3px 10px;
          font-size: 11px;
          font-weight: 700;
          color: var(--accent-ink, #051827);
          background: var(--warn, #fbbf24);
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .pc-adv-issues__triage-btn:hover:not(:disabled) {
          background: color-mix(in oklab, var(--warn, #fbbf24), white 12%);
        }
        .pc-adv-issues__triage-btn:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .pc-adv-issues__list {
          flex: 1;
          overflow: auto;
          min-height: 0;
        }
        .pc-adv-issues__list:focus,
        .pc-adv-issues__list:focus-visible {
          outline: none;
        }
        .pc-adv-issues__row.is-focused {
          outline: 1px solid color-mix(in oklab, var(--accent, #38bdf8), white 12%);
          outline-offset: -1px;
        }
        .pc-adv-issues__id {
          display: block;
          max-width: 100%;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: var(--fg-mute, #7f9bb4);
          font-weight: 600;
          font-size: 11px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pc-adv-issues__title {
          display: inline-flex;
          gap: 7px;
          align-items: center;
          color: var(--fg, #e7f7ff);
          overflow: hidden;
          min-width: 0;
          width: 100%;
        }
        .pc-adv-issues__titletext {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pc-adv-issues__meta {
          display: inline-flex;
          gap: 8px;
          align-items: center;
          justify-content: flex-end;
        }
        .pc-adv-issues__pointer,
        .pc-adv-issues__link {
          display: inline-flex;
          gap: 3px;
          align-items: center;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10px;
          color: var(--accent-strong, #7dd3fc);
          white-space: nowrap;
        }
        .pc-adv-issues__found {
          font-size: 10px;
          color: var(--fg-mute, #7f9bb4);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          white-space: nowrap;
        }
        .pc-adv-issues__rowactions {
          display: inline-flex;
          gap: 2px;
          align-items: center;
          justify-content: flex-end;
          transition: opacity 0.1s var(--ease-out, ease);
        }
        .pc-adv-issues__rowactions button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 3px;
          color: var(--fg-dim, #b9d4e8);
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          border-radius: 4px;
          cursor: pointer;
        }
        .pc-adv-issues__rowactions button:hover:not(:disabled) {
          color: var(--fg, #e7f7ff);
          border-color: var(--accent, #38bdf8);
        }
        .pc-adv-issues__rowactions button:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .pc-adv-issues__footer {
          flex-shrink: 0;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 4px 12px;
          font-size: 10px;
          color: var(--fg-mute, #7f9bb4);
          border-top: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        }
        .pc-adv-issues__kbd {
          opacity: 0.85;
          white-space: nowrap;
        }
      `}</style>
      <PinMenu state={pinMenu} onClose={() => setPinMenu(null)} />
    </div>
  );
}

// Collapse a long code pointer (path:line) to the basename for the chip,
// keeping the full value in the tooltip.
function shortPointer(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.length > 28 ? `…${base.slice(-27)}` : base;
}

function PanelMessage({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'error';
}) {
  return (
    <div
      style={{
        padding: '24px',
        textAlign: 'center',
        color: tone === 'error' ? 'var(--bad, #fb7185)' : 'var(--fg-mute, #7f9bb4)',
        fontSize: 13,
        height: '100%',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {children}
    </div>
  );
}
