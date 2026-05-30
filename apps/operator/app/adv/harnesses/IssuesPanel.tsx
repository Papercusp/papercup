'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle,
  Circle,
  Eye,
  FileCode,
  Hammer,
  Info,
  User,
  Bot,
  XCircle,
} from 'lucide-react';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import type { Issue, IssueSeverity, IssueSource, IssueStatus } from '../../harness/issues/types';
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

const SEVERITY_TONE: Record<IssueSeverity, { bg: string; fg: string }> = {
  critical: { bg: 'rgba(239, 68, 68, 0.18)', fg: '#fca5a5' },
  major: { bg: 'rgba(249, 115, 22, 0.16)', fg: '#fdba74' },
  minor: { bg: 'rgba(250, 204, 21, 0.14)', fg: '#fde68a' },
  nit: { bg: 'rgba(148, 163, 184, 0.14)', fg: '#cbd5e1' },
};

// Icon maps mirror the legacy IssuesList. Every lookup falls back to Circle
// (`?? Circle`) — a missing/typo'd key returning undefined would otherwise
// render `<undefined />` and crash the whole panel subtree.
const SEVERITY_ICON: Record<IssueSeverity, typeof Circle> = {
  critical: AlertOctagon,
  major: AlertTriangle,
  minor: Info,
  nit: Circle,
};
const SOURCE_ICON: Record<IssueSource, typeof Circle> = {
  validator: Bot,
  worker: Bot,
  human: User,
};
const STATUS_ICON: Record<IssueStatus, typeof Circle> = {
  open: Circle,
  acknowledged: Eye,
  fixing: Hammer,
  closed: CheckCircle,
  wontfix: XCircle,
};
const STATUS_COLOR: Record<IssueStatus, string> = {
  open: '#fca5a5',
  acknowledged: '#fde68a',
  fixing: '#c4b5fd',
  closed: '#86efac',
  wontfix: '#71717a',
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
  const [focusIdx, setFocusIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
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

  // P-020: virtualize the row list (only the visible window mounts).
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 44,
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
          <button
            type="button"
            className="pc-adv-issues__triage-btn"
            disabled={triaging}
            onClick={() => void runTriage()}
            title="Merge pending validator findings into the issues list"
          >
            {triaging ? 'Triaging…' : `Triage ${pendingCount}`}
          </button>
        </div>
      )}

      <div ref={listRef} className="pc-adv-issues__list" tabIndex={0} onKeyDown={onListKeyDown}>
        {filtered.length === 0 ? (
          <PanelMessage>No issues match the current filter.</PanelMessage>
        ) : (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {rowVirtualizer.getVirtualItems().map((vi) => {
            const i = filtered[vi.index];
            const idx = vi.index;
            const sevTone = SEVERITY_TONE[i.severity] ?? SEVERITY_TONE.minor;
            const SevIcon = SEVERITY_ICON[i.severity] ?? Circle;
            const SrcIcon = SOURCE_ICON[i.source] ?? Circle;
            const StatusIcon = STATUS_ICON[i.status] ?? Circle;
            const isActive = i.id === selectedId;
            return (
              <div
                key={i.id}
                data-index={idx}
                data-fidx={idx}
                ref={rowVirtualizer.measureElement}
                className={`pc-adv-issues__row${isActive ? ' is-active' : ''}${idx === focusIdx ? ' is-focused' : ''}`}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                onClick={() => void setSelectedId(i.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setPinMenu({
                    pos: { x: e.clientX, y: e.clientY },
                    itemId: i.id,
                    itemLabel: i.id,
                    harnessSlug: slug,
                  });
                }}
                role="button"
                tabIndex={0}
              >
                <span className="pc-adv-issues__id">{i.id}</span>
                <span
                  className="pc-adv-issues__severity"
                  style={{ background: sevTone.bg, color: sevTone.fg }}
                >
                  <SevIcon size={11} aria-hidden />
                  {i.severity}
                </span>
                <span className="pc-adv-issues__title">
                  <StatusIcon
                    size={12}
                    aria-label={i.status}
                    style={{ color: STATUS_COLOR[i.status] ?? '#888', flexShrink: 0 }}
                  />
                  <SrcIcon size={11} aria-label={i.source} style={{ color: 'rgba(199, 188, 252, 0.6)', flexShrink: 0 }} />
                  <span className="pc-adv-issues__titletext">{i.title}</span>
                </span>
                <span className="pc-adv-issues__meta">
                  {i.codePointer && (
                    <span className="pc-adv-issues__pointer" title={i.codePointer}>
                      <FileCode size={10} aria-hidden /> {shortPointer(i.codePointer)}
                    </span>
                  )}
                  {i.linkedFeatureId && (
                    <span className="pc-adv-issues__link" title={`Linked feature: ${i.linkedFeatureId}`}>
                      <ArrowUpRight size={10} aria-hidden /> {i.linkedFeatureId}
                    </span>
                  )}
                  {i.foundDuring && (
                    <span className="pc-adv-issues__found" title={`Found during: ${i.foundDuring}`}>
                      {i.foundDuring}
                    </span>
                  )}
                </span>
                <span className="pc-adv-issues__rowactions" onClick={(e) => e.stopPropagation()}>
                  {!i.linkedFeatureId && i.status !== 'closed' && i.status !== 'wontfix' && (
                    <button type="button" disabled={busyId === i.id} onClick={() => void handleAction(i, 'promote')} title="Promote to a fix feature">
                      Promote
                    </button>
                  )}
                  {i.status !== 'acknowledged' && i.status !== 'closed' && (
                    <button type="button" disabled={busyId === i.id} onClick={() => void handleAction(i, 'acknowledge')} title="Acknowledge">
                      Ack
                    </button>
                  )}
                  {i.status !== 'closed' && (
                    <button type="button" disabled={busyId === i.id} onClick={() => void handleAction(i, 'close')} title="Close">
                      Close
                    </button>
                  )}
                  {i.status !== 'wontfix' && (
                    <button type="button" disabled={busyId === i.id} onClick={() => void handleAction(i, 'wontfix')} title="Won't fix">
                      Won&apos;t fix
                    </button>
                  )}
                </span>
              </div>
            );
            })}
          </div>
        )}
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
          background: rgba(8, 10, 22, 0.6);
        }
        .pc-adv-issues__bar {
          display: flex;
          gap: 12px;
          align-items: center;
          padding: 8px 12px;
          border-bottom: 1px solid rgba(167, 139, 250, 0.12);
          flex-wrap: wrap;
        }
        .pc-adv-issues__search {
          flex: 1;
          min-width: 160px;
          padding: 6px 8px;
          font-size: 12px;
          background: rgba(20, 18, 38, 0.96);
          color: #f7f5ff;
          border: 1px solid rgba(167, 139, 250, 0.2);
          border-radius: 6px;
        }
        .pc-adv-issues__filters {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
          align-items: center;
        }
        .pc-adv-issues__filter {
          display: inline-flex;
          gap: 6px;
          align-items: center;
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 600;
          color: rgba(220, 214, 248, 0.66);
          background: rgba(20, 18, 38, 0.6);
          border: 1px solid rgba(167, 139, 250, 0.14);
          border-radius: 4px;
          cursor: pointer;
        }
        .pc-adv-issues__filter span {
          color: rgba(220, 214, 248, 0.5);
          font-weight: 700;
        }
        .pc-adv-issues__filter.is-active {
          color: #f7f5ff;
          background: rgba(31, 23, 56, 0.96);
          border-color: rgba(167, 139, 250, 0.4);
        }
        .pc-adv-issues__filter.is-active span {
          color: #c4b5fd;
        }
        .pc-adv-issues__triage {
          display: flex;
          gap: 8px;
          align-items: center;
          margin: 8px 12px 0;
          padding: 6px 10px;
          font-size: 11px;
          color: #fde68a;
          background: rgba(250, 204, 21, 0.1);
          border: 1px solid rgba(250, 204, 21, 0.28);
          border-radius: 6px;
        }
        .pc-adv-issues__triage strong {
          color: #fef3c7;
          font-weight: 800;
        }
        .pc-adv-issues__triage-btn {
          margin-left: auto;
          padding: 3px 10px;
          font-size: 11px;
          font-weight: 700;
          color: #1a160a;
          background: #fde68a;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .pc-adv-issues__triage-btn:hover:not(:disabled) {
          background: #fef3c7;
        }
        .pc-adv-issues__triage-btn:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .pc-adv-issues__list {
          flex: 1;
          overflow: auto;
          padding: 4px 0;
        }
        .pc-adv-issues__row {
          position: relative;
          display: grid;
          grid-template-columns: 70px 92px 1fr auto;
          gap: 10px;
          align-items: center;
          padding: 6px 12px;
          font-size: 12px;
          color: rgba(220, 214, 248, 0.86);
          border-bottom: 1px solid rgba(167, 139, 250, 0.06);
          cursor: pointer;
          user-select: none;
        }
        .pc-adv-issues__rowactions {
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
          display: inline-flex;
          gap: 4px;
          opacity: 0;
          transition: opacity 0.08s;
          padding-left: 28px;
          background: linear-gradient(90deg, transparent, rgba(13, 11, 26, 0.97) 26%);
        }
        .pc-adv-issues__row:hover .pc-adv-issues__rowactions {
          opacity: 1;
        }
        .pc-adv-issues__rowactions button {
          padding: 2px 8px;
          font-size: 10px;
          font-weight: 600;
          color: rgba(220, 214, 248, 0.85);
          background: rgba(31, 23, 56, 0.96);
          border: 1px solid rgba(167, 139, 250, 0.3);
          border-radius: 4px;
          cursor: pointer;
          white-space: nowrap;
        }
        .pc-adv-issues__rowactions button:hover:not(:disabled) {
          color: #f7f5ff;
          border-color: rgba(167, 139, 250, 0.6);
        }
        .pc-adv-issues__rowactions button:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .pc-adv-issues__row:hover {
          background: rgba(31, 23, 56, 0.45);
        }
        .pc-adv-issues__row.is-active {
          background: rgba(167, 139, 250, 0.18);
          border-left: 2px solid rgba(167, 139, 250, 0.78);
          padding-left: 10px;
        }
        .pc-adv-issues__row.is-focused {
          outline: 1px solid rgba(196, 181, 253, 0.55);
          outline-offset: -1px;
        }
        .pc-adv-issues__list:focus,
        .pc-adv-issues__list:focus-visible {
          outline: none;
        }
        .pc-adv-issues__id {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: rgba(199, 188, 252, 0.78);
          font-weight: 600;
        }
        .pc-adv-issues__severity {
          display: inline-flex;
          gap: 4px;
          align-items: center;
          padding: 1px 8px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          border-radius: 999px;
        }
        .pc-adv-issues__title {
          display: inline-flex;
          gap: 7px;
          align-items: center;
          color: #f7f5ff;
          overflow: hidden;
          min-width: 0;
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
          flex-shrink: 0;
        }
        .pc-adv-issues__pointer,
        .pc-adv-issues__link {
          display: inline-flex;
          gap: 3px;
          align-items: center;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10px;
          color: rgba(199, 188, 252, 0.7);
        }
        .pc-adv-issues__found {
          font-size: 10px;
          color: rgba(220, 214, 248, 0.45);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .pc-adv-issues__footer {
          flex-shrink: 0;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 4px 12px;
          font-size: 10px;
          color: rgba(220, 214, 248, 0.5);
          border-top: 1px solid rgba(167, 139, 250, 0.08);
        }
        .pc-adv-issues__kbd {
          opacity: 0.75;
          white-space: nowrap;
        }
      `}</style>
      <PinMenu state={pinMenu} onClose={() => setPinMenu(null)} />
    </div>
  );
}

// Collapse a long code pointer (path:line) to the basename for the chip,
// keeping the full value in the title attribute.
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
        color: tone === 'error' ? '#fca5a5' : 'rgba(220, 214, 248, 0.6)',
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
