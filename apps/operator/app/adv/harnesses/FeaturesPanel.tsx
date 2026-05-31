'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { MessageSquare, Pencil, RotateCcw } from 'lucide-react';
import { openFeatureChat } from '@restart/papercup-shared';
import { RichGrid, type ColumnDef } from '@restart/grid-core';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { StatusPill } from '../../harness/primitives';
import { Tooltip } from '../../harness/Tooltip';
import { useConfirmDialog } from '../../harness/useConfirmDialog';
import { STATUS, type HarnessStatus } from '../../harness/theme';
import PinMenu, { type PinMenuState } from './PinMenu';
import { useHarnessFeatures, type FeatureStatus, type HarnessFeature } from './useHarnessData';
import { featureReset } from './harness-actions';

// Saved views mirror the legacy FeatureList BUILT_IN_VIEWS. Each view is a
// predicate over a feature; counts are computed client-side. "Running" and
// "Blocked" group multiple statuses, "Stuck" keys off attempts (≥3) — the
// flat one-chip-per-status filter the panel shipped with couldn't express
// those. Deprecated features are hidden from every view except Deprecated.
type ViewId = 'all' | 'running' | 'stuck' | 'blocked' | 'todo' | 'passed' | 'deprecated';

const SAVED_VIEWS: Array<{ id: ViewId; label: string; match: (f: HarnessFeature) => boolean }> = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'running', label: 'Running', match: (f) => f.status === 'in_progress' || f.status === 'validating' },
  { id: 'stuck', label: 'Stuck', match: (f) => (f.attempts ?? 0) >= 3 },
  { id: 'blocked', label: 'Blocked', match: (f) => f.status === 'blocked' || f.status === 'failing' },
  { id: 'todo', label: 'Todo', match: (f) => f.status === 'todo' },
  { id: 'passed', label: 'Passed', match: (f) => f.status === 'passed' },
  { id: 'deprecated', label: 'Deprecated', match: (f) => f.status === 'deprecated' },
];

// Sort order within a view, matching the legacy STATUS_ORDER intent
// (active work first, terminal states last).
const STATUS_ORDER: FeatureStatus[] = [
  'in_progress',
  'validating',
  'blocked',
  'failing',
  'todo',
  'passed',
  'deprecated',
];

// Per-view accent — each saved-view chip carries the canonical STATUS hue of
// the status(es) it filters, so the chips colour-match the row stripes/pills.
// 'all' stays the neutral sky accent.
const VIEW_ACCENT: Record<ViewId, string> = {
  all: 'var(--accent, #38bdf8)',
  running: STATUS.in_progress.solid,
  stuck: STATUS.failing.solid,
  blocked: STATUS.blocked.solid,
  todo: STATUS.todo.solid,
  passed: STATUS.passed.solid,
  deprecated: STATUS.deprecated.solid,
};

export default function FeaturesPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  // Phase 3: live data via Zero (REST bootstrap + Zero overlay), no polling.
  const { features, loading, error, patchFeature } = useHarnessFeatures(slug);
  // Filter selection + search are user-meaningful → URL state (nuqs), not
  // useState, so the view is deep-linkable and agent-driveable. Keys are
  // feature-prefixed (fview/fq) so they don't collide with the Issues panel.
  const [view, setView] = useQueryState('fview', parseAsStringEnum<ViewId>(SAVED_VIEWS.map((v) => v.id)).withDefault('all'));
  const [search, setSearch] = useQueryState('fq', parseAsString.withDefault(''));
  const [selectedId, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));
  // Opening the editor = select the feature + set ?edit=<id> so the Detail
  // pane renders the embedded FeatureEditor (see DetailPanel).
  const [, setEditId] = useQueryState('edit', parseAsString.withDefault(''));
  const [pinMenu, setPinMenu] = useState<PinMenuState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { confirm, element: confirmEl } = useConfirmDialog();

  useEffect(() => {
    if (features) api.setTitle(`Features · ${slug} (${features.length})`);
  }, [features, slug, api]);

  const handleReset = async (f: HarnessFeature) => {
    if (
      !(await confirm({
        title: `Reset ${f.id}?`,
        body: `Reset ${f.id} back to todo and clear its attempts. The worker will pick it up fresh.`,
        destructive: true,
        confirmLabel: 'Reset',
      }))
    )
      return;
    const prevAttempts = f.attempts;
    patchFeature(f.id, { status: 'todo', attempts: 0 }); // optimistic
    setBusyId(f.id);
    try {
      await featureReset(slug, f.id);
      toast.success(`${f.id} reset`);
    } catch (e) {
      patchFeature(f.id, { status: f.status, attempts: prevAttempts }); // rollback
      toast.error('Reset failed', { description: String(e) });
    } finally {
      setBusyId(null);
    }
  };
  const handleChat = async (f: HarnessFeature) => {
    setBusyId(f.id);
    try {
      const res = await openFeatureChat({ slug, role: 'worker', featureId: f.id, title: f.summary || f.title, mode: 'discuss' });
      if (res && typeof res === 'object' && 'error' in res) {
        throw new Error(String((res as { error: unknown }).error));
      }
    } catch (e) {
      toast.error('Open chat failed', { description: String(e) });
    } finally {
      setBusyId(null);
    }
  };

  const activeView = SAVED_VIEWS.find((v) => v.id === view) ?? SAVED_VIEWS[0];

  // Per-view counts (deprecated hidden everywhere except the Deprecated view).
  const viewCounts = useMemo(() => {
    const feats = features ?? [];
    const out: Record<ViewId, number> = {
      all: 0, running: 0, stuck: 0, blocked: 0, todo: 0, passed: 0, deprecated: 0,
    };
    for (const v of SAVED_VIEWS) {
      out[v.id] = feats.filter((f) => {
        if (v.id !== 'deprecated' && f.status === 'deprecated') return false;
        return v.match(f);
      }).length;
    }
    return out;
  }, [features]);

  const filtered = useMemo(() => {
    if (!features) return [];
    const q = search.trim().toLowerCase();
    const out = features.filter((f) => {
      if (activeView.id !== 'deprecated' && f.status === 'deprecated') return false;
      if (!activeView.match(f)) return false;
      if (!q) return true;
      return (
        f.id.toLowerCase().includes(q) ||
        f.title.toLowerCase().includes(q) ||
        (f.summary?.toLowerCase().includes(q) ?? false) ||
        (f.tags?.some((t) => t.toLowerCase().includes(q)) ?? false)
      );
    });
    return out.sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status);
      const bi = STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
  }, [features, activeView, search]);

  // P-020: virtualize via the caller-owned virtualizer fed into RichGrid's
  // `virtualMode`. RichGrid owns the scroll container (captured via
  // scrollContainerRef); only the visible window of rows mounts.
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
  // (sets ?sel), R resets the focused feature, / focuses search. Fires only
  // when the list (or a row in it) holds focus, so it never hijacks typing.
  useEffect(() => {
    setFocusIdx((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);
  useEffect(() => {
    // Virtualized: scroll the focused row into the window (the DOM node may
    // not be mounted, so scrollToIndex is required, not scrollIntoView).
    if (filtered.length > 0) rowVirtualizer.scrollToIndex(focusIdx, { align: 'auto' });
  }, [focusIdx, filtered.length, rowVirtualizer]);
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (filtered.length === 0) return;
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        setFocusIdx((i) => Math.min(filtered.length - 1, i + 1));
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        setFocusIdx((i) => Math.max(0, i - 1));
        break;
      case 'Enter': {
        e.preventDefault();
        const f = filtered[focusIdx];
        if (f) void setSelectedId(f.id);
        break;
      }
      case 'r':
      case 'R': {
        e.preventDefault();
        const f = filtered[focusIdx];
        if (f) void handleReset(f);
        break;
      }
      case '/':
        e.preventDefault();
        searchRef.current?.focus();
        break;
    }
  };

  const columns = useMemo<ColumnDef<HarnessFeature>[]>(() => [
    {
      key: 'id',
      header: 'ID',
      headerText: 'ID',
      width: '78px',
      toCopyText: (f) => f.id,
      // Status-coloured left accent stripe — the same canonical STATUS hue
      // the StatusPill uses, so a feature's status reads as one consistent
      // colour across the row stripe, the pill, and the Detail pane.
      cellStyle: ({ row }) => ({
        boxShadow: `inset 3px 0 0 ${STATUS[row.status as HarnessStatus].solid}`,
      }),
      render: ({ row }) => (
        <Tooltip label={row.id}>
          <span className="pc-adv-features__id">{row.id}</span>
        </Tooltip>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      headerText: 'Status',
      width: '116px',
      toCopyText: (f) => f.status,
      render: ({ row }) => <StatusPill status={row.status as HarnessStatus} size="xs" />,
    },
    {
      key: 'title',
      header: 'Title',
      headerText: 'Title',
      width: 1,
      toCopyText: (f) => f.title,
      render: ({ row }) => (
        <span className="pc-adv-features__title">
          {row.needsReview && (
            <span className="pc-adv-features__review" aria-label="Needs human review" />
          )}
          <span className="pc-adv-features__titletext">{row.title}</span>
        </span>
      ),
    },
    {
      key: 'meta',
      header: '',
      width: '136px',
      align: 'right',
      render: ({ row }) => {
        const attempts = row.attempts ?? 0;
        const claimsCount = row.claims?.length ?? 0;
        return (
          <span className="pc-adv-features__meta">
            {row.sourcePlanSlug && (
              <Tooltip label={`From plan: ${row.sourcePlanSlug}`}>
                <a
                  className="pc-adv-features__plan"
                  href={`/adv/plans?slug=${encodeURIComponent(slug)}&plan=${encodeURIComponent(row.sourcePlanSlug)}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  ↗ plan
                </a>
              </Tooltip>
            )}
            {claimsCount > 0 && (
              <Tooltip label={row.claims?.join(', ') ?? ''}>
                <span className="pc-adv-features__claims">{claimsCount} claim{claimsCount === 1 ? '' : 's'}</span>
              </Tooltip>
            )}
            {attempts > 0 && (
              <span className={`pc-adv-features__attempts${attempts >= 3 ? ' is-warn' : ''}`}>×{attempts}</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      width: '92px',
      align: 'right',
      render: ({ row }) => {
        const show = hoveredId === row.id || busyId === row.id;
        return (
          <span
            className="pc-adv-features__rowactions"
            style={{ opacity: show ? 1 : 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <Tooltip label="Reset to todo">
              <button type="button" disabled={busyId === row.id} onClick={() => void handleReset(row)} aria-label="Reset to todo">
                <RotateCcw size={13} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip label="Edit feature">
              <button
                type="button"
                onClick={() => {
                  void setSelectedId(row.id);
                  void setEditId(row.id);
                }}
                aria-label="Edit feature"
              >
                <Pencil size={13} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip label="Open worker chat">
              <button type="button" disabled={busyId === row.id} onClick={() => void handleChat(row)} aria-label="Open worker chat">
                <MessageSquare size={13} aria-hidden />
              </button>
            </Tooltip>
          </span>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [slug, hoveredId, busyId]);

  const richRowProps = useMemo(
    () => (ctx: { row: HarnessFeature; rowIndex: number }) => {
      const isFocus = ctx.rowIndex === focusIdx;
      const isActive = ctx.row.id === selectedId;
      return {
        className: `pc-adv-features__row${isActive ? ' is-active' : ''}${isFocus ? ' is-focused' : ''}`,
        tabIndex: 0,
        'data-fidx': ctx.rowIndex,
        'aria-label': `${ctx.row.id}: ${ctx.row.title} (${ctx.row.status})`,
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
    () => (row: HarnessFeature) => {
      if (row.id === selectedId) return 'color-mix(in oklab, var(--accent), transparent 80%)';
      if (row.id === hoveredId) return 'var(--bg-3)';
      // undefined → RichGrid's default alternating row stripe (zebra),
      // matching the run-log + agents panels.
      return undefined;
    },
    [selectedId, hoveredId],
  );

  if (!slug) {
    return <PanelMessage>Pick a harness to view its features.</PanelMessage>;
  }
  if (error && !features) {
    return <PanelMessage tone="error">Failed to load features: {error}</PanelMessage>;
  }
  if (!features) {
    return <PanelMessage>{loading ? 'Loading features…' : 'No features.'}</PanelMessage>;
  }

  const total = features.length;

  return (
    <div className="pc-adv-features">
      <div className="pc-adv-features__bar">
        <input
          ref={searchRef}
          className="pc-adv-features__search"
          placeholder="Search features or tags…"
          value={search}
          onChange={(e) => void setSearch(e.target.value || null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <div className="pc-adv-features__views" role="tablist" aria-label="Feature views">
          {SAVED_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={`pc-adv-features__view${view === v.id ? ' is-active' : ''}`}
              style={{ '--chip-accent': VIEW_ACCENT[v.id] } as React.CSSProperties}
              onClick={() => void setView(v.id === 'all' ? null : v.id)}
            >
              {v.label}
              <span>{viewCounts[v.id]}</span>
            </button>
          ))}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="pc-adv-features__list"
        tabIndex={0}
        onKeyDown={onListKeyDown}
      >
        <RichGrid<HarnessFeature>
          inline
          resizableColumns
          virtualMode={{
            virtualizer: rowVirtualizer,
            totalRows: filtered.length,
            rowAt: (i) => filtered[i],
          }}
          columns={columns}
          getRowId={(f) => f.id}
          onRowClick={(f) => {
            void setSelectedId(f.id);
            void setEditId(null); // navigating = view mode, not edit
          }}
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
          empty={
            <PanelMessage>
              {total === 0 ? 'No features yet — planner may still be running.' : 'No features match this view.'}
            </PanelMessage>
          }
        />
      </div>
      <div className="pc-adv-features__footer">
        <span>{filtered.length}/{total} shown</span>
        <span className="pc-adv-features__kbd">J/K move · ↵ open · R reset · / search</span>
      </div>
      {confirmEl}
      <style>{`
        .pc-adv-features {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          background: var(--bg-1, #0b1220);
          color: var(--fg, #e7f7ff);
        }
        .pc-adv-features__bar {
          display: flex;
          gap: 12px;
          align-items: center;
          padding: 8px 12px;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          flex-wrap: wrap;
        }
        .pc-adv-features__search {
          flex: 1;
          min-width: 160px;
          padding: 6px 8px;
          font-size: 12px;
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          color: var(--fg, #e7f7ff);
          border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
          border-radius: 6px;
        }
        .pc-adv-features__search:focus {
          outline: none;
          border-color: var(--accent, #38bdf8);
          box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
        }
        .pc-adv-features__search::placeholder { color: var(--fg-mute, #7f9bb4); }
        .pc-adv-features__views {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }
        .pc-adv-features__view {
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
        .pc-adv-features__view span {
          color: var(--fg-mute, #7f9bb4);
          font-weight: 700;
        }
        .pc-adv-features__view:hover {
          color: var(--fg, #e7f7ff);
          border-color: color-mix(in oklab, var(--_a), transparent 45%);
        }
        .pc-adv-features__view.is-active {
          color: var(--fg, #e7f7ff);
          background: color-mix(in oklab, var(--_a), transparent 80%);
          border-color: color-mix(in oklab, var(--_a), transparent 42%);
        }
        .pc-adv-features__view.is-active span {
          color: var(--fg, #e7f7ff);
        }
        .pc-adv-features__list {
          flex: 1;
          overflow: auto;
          min-height: 0;
        }
        .pc-adv-features__list:focus,
        .pc-adv-features__list:focus-visible {
          outline: none;
        }
        .pc-adv-features__row.is-focused {
          outline: 1px solid color-mix(in oklab, var(--accent, #38bdf8), white 12%);
          outline-offset: -1px;
        }
        .pc-adv-features__id {
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
        .pc-adv-features__title {
          display: inline-flex;
          gap: 7px;
          align-items: center;
          color: var(--fg, #e7f7ff);
          overflow: hidden;
          min-width: 0;
          width: 100%;
        }
        .pc-adv-features__titletext {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pc-adv-features__review {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--warn, #fbbf24);
          flex-shrink: 0;
          box-shadow: 0 0 0 2px color-mix(in oklab, var(--warn, #fbbf24), transparent 80%);
        }
        .pc-adv-features__meta {
          display: inline-flex;
          gap: 8px;
          align-items: center;
          justify-content: flex-end;
        }
        .pc-adv-features__plan {
          font-size: 10px;
          color: var(--accent-strong, #7dd3fc);
          text-decoration: none;
          white-space: nowrap;
        }
        .pc-adv-features__plan:hover { text-decoration: underline; }
        .pc-adv-features__claims {
          font-size: 10px;
          color: var(--fg-dim, #b9d4e8);
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          padding: 1px 6px;
          border-radius: 999px;
          white-space: nowrap;
        }
        .pc-adv-features__attempts {
          font-size: 10px;
          font-weight: 700;
          color: var(--fg-mute, #7f9bb4);
        }
        .pc-adv-features__attempts.is-warn {
          color: var(--bad, #fb7185);
          background: color-mix(in oklab, var(--bad, #fb7185), transparent 84%);
          padding: 1px 6px;
          border-radius: 999px;
        }
        .pc-adv-features__rowactions {
          display: inline-flex;
          gap: 2px;
          align-items: center;
          justify-content: flex-end;
          transition: opacity 0.1s var(--ease-out, ease);
        }
        .pc-adv-features__rowactions button {
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
        .pc-adv-features__rowactions button:hover:not(:disabled) {
          color: var(--fg, #e7f7ff);
          border-color: var(--accent, #38bdf8);
        }
        .pc-adv-features__rowactions button:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .pc-adv-features__footer {
          flex-shrink: 0;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 4px 12px;
          font-size: 10px;
          color: var(--fg-mute, #7f9bb4);
          border-top: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        }
        .pc-adv-features__kbd {
          opacity: 0.85;
          white-space: nowrap;
        }
      `}</style>
      <PinMenu state={pinMenu} onClose={() => setPinMenu(null)} />
    </div>
  );
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
