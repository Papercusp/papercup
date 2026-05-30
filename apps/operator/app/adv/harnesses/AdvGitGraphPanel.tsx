'use client';

/**
 * AdvGitGraphPanel — the /adv Git dock's commit-graph panel.
 *
 * Replaces the @restart/git-graph library's custom row list with the app's
 * RichGrid (per the user request "make the grid use richgrid"), while keeping
 * the branch-lane graph as the first column. We REUSE the lib's data + layout
 * + detail pieces (fetchGitLog / getCachedGitLog / assignLanes / laneColor /
 * CommitDetail) so this is a presentation swap, not a reimplementation:
 *
 *   commits → assignLanes() → RichGrid rows
 *   columns: [lane graph] [sha] [message + refs] [author] [time]
 *   row click → CommitDetail (inline drawer) below the grid.
 *
 * The lib's rail is a *per-row* set of vertical lane bars + a dot on the
 * commit's lane (no cross-row beziers), so it renders cleanly inside one cell.
 *
 * Toolbar carries search / limit / refresh. Bookmarks, the worktree selector,
 * and the top-authors rail from the old GitGraphPanel are intentionally not
 * carried over here.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { RefreshCw } from 'lucide-react';
import { RichGrid, type ColumnDef } from '@restart/grid-core';
import {
  CommitDetail,
  assignLanes,
  laneColor,
  fetchGitLog,
  getCachedGitLog,
  type Commit,
  type LaidOutCommit,
} from '@restart/git-graph';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { crossOriginUrl } from '@/lib/cross-origin-url';

const LIMITS = [100, 300, 500, 1000] as const;

function formatAge(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function refClass(ref: string): string {
  if (ref === 'HEAD' || ref.startsWith('HEAD ->')) return 'head';
  if (ref.startsWith('tag: ')) return 'tag';
  return 'branch';
}

function refLabel(ref: string): string {
  return ref.replace(/^tag: /, '').replace(/^HEAD -> /, 'HEAD → ');
}

function matchesCommit(commit: LaidOutCommit, needle: string): boolean {
  if (!needle) return true;
  const haystack = [commit.sha, commit.subject, commit.author, ...commit.refs].join(' ').toLowerCase();
  return haystack.includes(needle);
}

export default function AdvGitGraphPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const scope = `harness:${slug}`;

  const [limit, setLimit] = useState<number>(300);
  const [query, setQuery] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [hoveredSha, setHoveredSha] = useState<string | null>(null);
  const [commits, setCommits] = useState<Commit[] | null>(() =>
    slug ? getCachedGitLog(scope, limit, null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const logUrl = `/api/harness/${slug}/git/log?limit=${limit}`;

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setCommits(getCachedGitLog(scope, limit, null));
    setError(null);
    fetchGitLog(scope, limit, logUrl)
      .then((c) => { if (!cancelled) setCommits(c); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [scope, slug, limit, reloadTick, logUrl]);

  const laidOut = useMemo(() => (commits ? assignLanes(commits) : []), [commits]);
  const laneCount = useMemo(
    () => Math.max(1, laidOut.reduce((max, c) => Math.max(max, c.lane + 1), 1)),
    [laidOut],
  );
  const railWidth = Math.max(18, laneCount * 10);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => laidOut.filter((c) => matchesCommit(c, needle)),
    [laidOut, needle],
  );

  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 14,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [visible, rowVirtualizer]);

  // Row backgrounds match the Features/Issues grids: selected → accent tint,
  // hovered → bg-3, otherwise undefined (RichGrid's default zebra stripe).
  const richGetRowBg = useMemo(
    () => (row: LaidOutCommit) => {
      if (row.sha === selectedSha) return 'color-mix(in oklab, var(--accent), transparent 80%)';
      if (row.sha === hoveredSha) return 'var(--bg-3)';
      return undefined;
    },
    [selectedSha, hoveredSha],
  );

  const columns = useMemo<ColumnDef<LaidOutCommit>[]>(() => [
    {
      key: 'graph',
      header: '',
      headerText: '',
      width: `${railWidth}px`,
      cellStyle: { position: 'relative', overflow: 'visible' },
      render: ({ row }) => (
        <span className="pc-adv-gitgrid__rail" style={{ width: railWidth }} aria-hidden>
          {Array.from({ length: laneCount }).map((_, lane) => (
            <span
              key={lane}
              className={`pc-adv-gitgrid__lane${lane === row.lane ? ' is-active' : ''}`}
              style={{ left: lane * 10 + 7, background: laneColor(lane) }}
            />
          ))}
          <span
            className="pc-adv-gitgrid__dot"
            style={{ left: row.lane * 10 + 3, background: laneColor(row.lane) }}
          />
        </span>
      ),
    },
    {
      key: 'sha',
      header: 'SHA',
      headerText: 'SHA',
      width: '74px',
      toCopyText: (r) => r.sha,
      render: ({ row }) => <span className="pc-adv-gitgrid__sha">{row.sha.slice(0, 8)}</span>,
    },
    {
      key: 'message',
      header: 'Message',
      headerText: 'Message',
      width: 1,
      toCopyText: (r) => r.subject,
      render: ({ row }) => (
        <span className="pc-adv-gitgrid__msg">
          <span className="pc-adv-gitgrid__subject" title={row.subject}>{row.subject}</span>
          {row.parents.length > 1 ? <span className="pc-adv-gitgrid__merge">merge</span> : null}
          {row.refs.slice(0, 4).map((ref) => (
            <span key={ref} className={`pc-adv-gitgrid__ref is-${refClass(ref)}`}>{refLabel(ref)}</span>
          ))}
          {row.refs.length > 4 ? (
            <span className="pc-adv-gitgrid__ref-more">+{row.refs.length - 4}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'author',
      header: 'Author',
      headerText: 'Author',
      width: '120px',
      toCopyText: (r) => r.author,
      render: ({ row }) => <span className="pc-adv-gitgrid__author" title={row.author}>{row.author}</span>,
    },
    {
      key: 'time',
      header: 'When',
      headerText: 'When',
      width: '84px',
      align: 'right',
      render: ({ row }) => (
        <span className="pc-adv-gitgrid__time" title={new Date(row.ts).toLocaleString()}>
          {formatAge(row.ts)}
        </span>
      ),
    },
  ], [laneCount, railWidth]);

  if (!slug) {
    return <div className="pc-adv-gitgrid__empty">No harness slug in params.</div>;
  }

  return (
    <div className="pc-adv-gitgrid">
      <div className="pc-adv-gitgrid__bar">
        <input
          type="search"
          className="pc-adv-gitgrid__search"
          placeholder="Search commits…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="pc-adv-gitgrid__limit"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          aria-label="Commit limit"
        >
          {LIMITS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="pc-adv-gitgrid__count">{visible.length}</span>
        <button
          type="button"
          className="pc-adv-gitgrid__refresh"
          onClick={() => setReloadTick((n) => n + 1)}
          aria-label="Refresh git log"
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>

      <div ref={scrollRef} className="pc-adv-gitgrid__list">
        {error ? (
          <div className="pc-adv-gitgrid__empty pc-adv-gitgrid__empty--err">Failed: {error}</div>
        ) : !commits ? (
          <div className="pc-adv-gitgrid__empty">Loading {slug}…</div>
        ) : (
          <RichGrid<LaidOutCommit>
            inline
            resizableColumns
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: visible.length,
              rowAt: (i) => visible[i],
            }}
            columns={columns}
            getRowId={(r) => r.sha}
            onRowClick={(r) => setSelectedSha(r.sha)}
            onRowHover={(r) => setHoveredSha(r?.sha ?? null)}
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
            empty={<div className="pc-adv-gitgrid__empty">No commits match this view.</div>}
          />
        )}
      </div>

      {selectedSha ? (
        <div className="pc-adv-gitgrid__detail">
          <CommitDetail
            sha={selectedSha}
            showCommitUrl={(sha: string) => crossOriginUrl(`/api/harness/${slug}/git/show/${sha}`)}
            onClose={() => setSelectedSha(null)}
            inline
          />
        </div>
      ) : null}

      <style>{`
        .pc-adv-gitgrid { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-1, #0b1220); }
        .pc-adv-gitgrid__bar {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 8px; flex-shrink: 0;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        }
        .pc-adv-gitgrid__search {
          flex: 1; min-width: 0; min-height: 26px;
          padding: 0 9px; font: inherit; font-size: 12px;
          color: var(--fg); background: color-mix(in oklab, var(--bg-2), white 2%);
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%)); border-radius: 8px;
          outline: none;
        }
        .pc-adv-gitgrid__search:focus { border-color: var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%)); }
        .pc-adv-gitgrid__limit {
          min-height: 26px; font: inherit; font-size: 12px; color: var(--fg);
          background: color-mix(in oklab, var(--bg-2), white 2%);
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%)); border-radius: 8px;
          padding: 0 6px; cursor: pointer;
        }
        .pc-adv-gitgrid__count { font-size: 10px; color: var(--fg-mute); font-variant-numeric: tabular-nums; }
        .pc-adv-gitgrid__refresh {
          display: inline-flex; align-items: center; padding: 4px;
          color: var(--fg-mute); background: transparent; border: 0; border-radius: 4px; cursor: pointer;
        }
        .pc-adv-gitgrid__refresh:hover { color: var(--fg); }
        .pc-adv-gitgrid__list { flex: 1; min-height: 0; overflow: auto; }
        .pc-adv-gitgrid__rail { position: relative; display: block; height: 100%; min-height: 40px; flex-shrink: 0; }
        .pc-adv-gitgrid__lane {
          position: absolute; top: 0; bottom: 0; width: 2px; opacity: 0.4;
        }
        .pc-adv-gitgrid__lane.is-active { opacity: 0.85; }
        .pc-adv-gitgrid__dot {
          position: absolute; top: 50%; transform: translateY(-50%);
          width: 8px; height: 8px; border-radius: 50%;
          box-shadow: 0 0 0 2px var(--bg-1, #0b1220);
        }
        .pc-adv-gitgrid__sha {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10.5px; color: var(--fg-mute);
        }
        .pc-adv-gitgrid__msg { display: inline-flex; align-items: center; gap: 6px; min-width: 0; width: 100%; }
        .pc-adv-gitgrid__subject {
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-size: 12px; color: var(--fg);
        }
        .pc-adv-gitgrid__merge {
          flex-shrink: 0; padding: 1px 6px; border-radius: 999px; font-size: 9px; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.04em;
          color: var(--accent, #38bdf8);
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
        }
        .pc-adv-gitgrid__ref {
          flex-shrink: 0; padding: 1px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 650;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap;
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          color: var(--fg-dim);
        }
        .pc-adv-gitgrid__ref.is-head {
          color: var(--good, #34d399);
          border-color: color-mix(in oklab, var(--good, #34d399), transparent 55%);
          background: color-mix(in oklab, var(--good, #34d399), transparent 88%);
        }
        .pc-adv-gitgrid__ref.is-tag {
          color: var(--warn, #fbbf24);
          border-color: color-mix(in oklab, var(--warn, #fbbf24), transparent 55%);
          background: color-mix(in oklab, var(--warn, #fbbf24), transparent 88%);
        }
        .pc-adv-gitgrid__ref.is-branch {
          color: var(--accent-strong, #7dd3fc);
          border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 90%);
        }
        .pc-adv-gitgrid__ref-more { flex-shrink: 0; font-size: 9.5px; color: var(--fg-mute); }
        .pc-adv-gitgrid__author {
          font-size: 11px; color: var(--fg-mute);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pc-adv-gitgrid__time { font-size: 10px; color: var(--fg-mute); font-variant-numeric: tabular-nums; }
        .pc-adv-gitgrid__detail {
          flex-shrink: 0; max-height: 46%; min-height: 0; overflow: auto;
          border-top: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          background: color-mix(in oklab, var(--bg-2), white 1%);
        }
        .pc-adv-gitgrid__empty { padding: 16px; font-size: 13px; color: var(--fg-mute); }
        .pc-adv-gitgrid__empty--err { color: var(--bad, #f87171); }
      `}</style>
    </div>
  );
}
