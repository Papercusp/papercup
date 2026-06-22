'use client';

import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { RefreshCw } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSyncQuery } from '@papercusp/sync';
import { RichGrid, usePersistedColumnWidths, type ColumnDef } from '@papercusp/grid-core';
import { useColumnFilters, ColumnFilterBar } from '../../harness/filters';
import { Tooltip } from '../../harness/Tooltip';
import { IssueStatusPill, KindPill, SeverityPill, StatusPill } from '../../harness/primitives';
import { TrustBadge, trustBadgeState } from '../../harness/TrustBadge';
import type { HarnessStatus } from '../../harness/theme';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';

/**
 * WorkItemsPanel — the features/issues view PORTED onto the unified `work_items`
 * surface (blueprint-aware-harness-ui-2026-06-09 P-010 / unify-work-items D-001). One
 * table across BOTH families — feature-family {feature,research-task,chunk} +
 * issue-family {bug,change,task} — for the selected member harness, surfacing the
 * dimensions the old per-kind FeaturesPanel/IssuesPanel couldn't: `kind`/`family`, the
 * claim (`assignee` + `assignedBy`), `severity`, backlog `priority`, per-assignee
 * `rank`, plus the v2 dims (plan-link + spine-position).
 *
 * Reads live via `useSyncQuery({ queryName: 'workItems.byHarness' })` — the resolver
 * reuses the route's `listEnrichedWorkItems` assembly, and the table bridge re-fires
 * the query on harness_features_consolidated / engineer_issues (migration 215) /
 * spawned_agents changes. The Refresh button is a manual `invalidate()` escape hatch.
 */

export interface WorkItemRow {
  id: string;
  kind: string;
  family: string;
  title: string;
  summary: string | null;
  state: string;
  assignee: string | null;
  assignedBy: string | null;
  severity: string | null;
  priority: number | null;
  rank: number | null;
  // P-010 v2 (route-side joins): plan-item linkage + spine position (latest role/stage).
  planSlug: string | null;
  spineRole: string | null;
  spineStatus: string | null;
  updatedAt: string;
  // Provenance for the trust badge (Trust A4) — already in the workItems.byHarness
  // payload (EnrichedWorkItem spreads the full WorkItem); local-origin ⇒ no badge.
  origin: string | null;
  auditVerdict: string | null;
  verifiedAuthorGithubUserId: number | null;
  /**
   * Page metadata stashed on the FIRST row by the `workItems.byHarness` resolver
   * (the flat-row sync contract carries no envelope — same pattern as coord.feed).
   * `total` is the TRUE count in the store for this harness, independent of how
   * many rows the capped read returned.
   */
  _meta?: { total: number };
}

/**
 * Fetch ceiling for the live work-items read. The grid is virtualized
 * (`virtualMode`), so render cost no longer scales with row count — this is a
 * generous bound that loads a harness's full work-item set in practice (local
 * desktop app, all data is local). It exists only to bound the LIVE sync query's
 * per-invalidation re-assembly; when a harness exceeds it the header shows the
 * honest "N of TOTAL" rather than truncating-as-total. Mirrors WORK_ITEMS_MAX_LIMIT.
 */
const WORK_ITEMS_FETCH_LIMIT = 2000;

// Grid-cell truncation (native title= is the approved pattern for dynamic
// per-row truncation tooltips — see design/gotchas).
const CELL_TRUNCATE: CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export default function WorkItemsPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  // The per-column filters (kind/state/severity/priority/…) live in ONE nuqs param
  // (`wif`) owned by useColumnFilters below. The global quick-search is a separate
  // affordance — `wq`, applied as a substring match ON TOP of the column filters.
  const [search, setSearch] = useQueryState('wq', parseAsString.withDefault(''));
  // Row selection drives the global `?sel` the Detail pane reads — F-* resolves
  // to the feature view, WI-* to the work-item view (same contract the retired
  // Features/Issues panels had).
  const [selectedId, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));
  // Dragged column widths survive dockview remounts (panel tab switches
  // remount panels, which used to reset every resize). Render-only
  // preference, not user-meaningful URL state → localStorage, not nuqs.
  const [colWidths, setColWidths] = usePersistedColumnWidths('pc-colw:adv:work-items');

  const query = useSyncQuery<WorkItemRow>({
    queryName: 'workItems.byHarness',
    args: { harnessSlug: slug, limit: WORK_ITEMS_FETCH_LIMIT },
    enabled: Boolean(slug),
  });
  const items = query.loading ? null : query.data;
  const loading = query.fetching;
  const error = query.error ? query.error.message : null;

  // The owner's trust list — to mark a verified remote author as "trusted" on the
  // badge (Trust A4). Fail-soft: no data ⇒ empty set ⇒ verified authors read as
  // "admitted"/"pending", never falsely "trusted".
  const trustQuery = useSyncQuery<{ githubUserId: number }>({ queryName: 'trust.list' });
  const trustedSet = useMemo(
    () => new Set((trustQuery.data ?? []).map((t) => t.githubUserId)),
    [trustQuery.data],
  );
  const isTrusted = (r: WorkItemRow): boolean =>
    r.verifiedAuthorGithubUserId != null && trustedSet.has(r.verifiedAuthorGithubUserId);

  // True total in the store (stashed on the first row's `_meta` by the resolver),
  // falling back to the downloaded length. The title shows "N of TOTAL" only when
  // the read was actually capped, so the count is never a downloaded-length lie.
  const total = items?.[0]?._meta?.total ?? items?.length ?? 0;
  useEffect(() => {
    if (!items) return;
    const n = items.length;
    api.setTitle(`Work items · ${slug} (${total > n ? `${n} of ${total}` : total})`);
  }, [items, total, slug, api]);

  const columns: ColumnDef<WorkItemRow>[] = [
    {
      key: 'id',
      header: 'ID',
      width: 1.4,
      toCopyText: (r) => r.id,
      filter: { type: 'text', accessor: (r) => r.id },
      render: ({ row }) => (
        <code style={CELL_TRUNCATE} title={row.id}>{row.id}</code>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 1.2,
      toCopyText: (r) => r.kind,
      filter: { type: 'enum', accessor: (r) => r.kind },
      // Canonical kind chip (WORK_ITEM_KIND table) — same chip recipe as the
      // Sev column so the table's pill columns read as one visual language.
      render: ({ row }) => <KindPill kind={row.kind} size="xs" />,
    },
    {
      key: 'title',
      header: 'Title',
      width: 4,
      toCopyText: (r) => r.title,
      filter: { type: 'text', accessor: (r) => r.title },
      render: ({ row }) => (
        <span style={CELL_TRUNCATE} title={row.title}>{row.title}</span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      width: 1.2,
      toCopyText: (r) => r.state,
      filter: { type: 'enum', accessor: (r) => r.state },
      // Canonical status pills (app/harness/theme.ts tables — the same coloring
      // FeatureList/IssuesList use). Family picks the table; unknown states fall
      // back to the tables' neutral meta, so plain text never regresses to bare.
      // chip variant = the SeverityPill look, matching the Kind + Sev columns.
      render: ({ row }) =>
        row.family === 'issue' ? (
          <IssueStatusPill status={row.state} size="xs" variant="chip" />
        ) : (
          <StatusPill status={row.state as HarnessStatus} size="xs" variant="chip" />
        ),
    },
    {
      // Trust A4: author trust-state for shared (federated) work — empty for local items.
      key: 'trust',
      header: 'Trust',
      width: 1.3,
      toCopyText: (r) =>
        trustBadgeState({
          origin: r.origin,
          auditVerdict: r.auditVerdict,
          verifiedAuthorGithubUserId: r.verifiedAuthorGithubUserId,
          trusted: isTrusted(r),
        })?.label ?? '',
      render: ({ row }) => (
        <TrustBadge
          origin={row.origin}
          auditVerdict={row.auditVerdict}
          verifiedAuthorGithubUserId={row.verifiedAuthorGithubUserId}
          trusted={isTrusted(row)}
        />
      ),
    },
    {
      key: 'stage',
      header: 'Stage',
      width: 1.7,
      toCopyText: (r) => (r.spineRole ? `${r.spineRole}${r.spineStatus ? ` (${r.spineStatus})` : ''}` : ''),
      filter: { type: 'enum', accessor: (r) => r.spineRole },
      render: ({ row }) =>
        row.spineRole ? (
          <span
            style={CELL_TRUNCATE}
            title={`latest spine role · status (spawned_agents): ${row.spineRole}${row.spineStatus ? ` (${row.spineStatus})` : ''}`}
          >
            {row.spineRole}
            {row.spineStatus ? <span style={{ color: 'var(--fg-mute)' }}> ({row.spineStatus})</span> : null}
          </span>
        ) : (
          <>—</>
        ),
    },
    {
      key: 'assignee',
      header: 'Assignee',
      width: 1.8,
      toCopyText: (r) => r.assignee ?? '',
      filter: { type: 'enum', accessor: (r) => r.assignee },
      render: ({ row }) => (
        <span
          style={CELL_TRUNCATE}
          title={
            row.assignee
              ? `${row.assignee}${row.assignedBy ? ` — delegated by ${row.assignedBy}` : ''}`
              : undefined
          }
        >
          {row.assignee ?? '—'}
          {row.assignedBy ? <span style={{ color: 'var(--fg-mute)' }}> ·by {row.assignedBy}</span> : null}
        </span>
      ),
    },
    {
      key: 'severity',
      header: 'Sev',
      width: 0.9,
      toCopyText: (r) => r.severity ?? '',
      filter: { type: 'enum', accessor: (r) => r.severity },
      render: ({ row }) =>
        row.severity ? <SeverityPill severity={row.severity} size="xs" /> : <>—</>,
    },
    {
      key: 'priority',
      header: 'Prio',
      width: 0.8,
      toCopyText: (r) => (r.priority == null ? '' : String(r.priority)),
      filter: { type: 'number', accessor: (r) => r.priority },
      render: ({ row }) => <>{row.priority ?? '—'}</>,
    },
    {
      key: 'rank',
      header: 'Rank',
      width: 0.8,
      toCopyText: (r) => (r.rank == null ? '' : String(r.rank)),
      filter: { type: 'number', accessor: (r) => r.rank },
      render: ({ row }) => <>{row.rank ?? '—'}</>,
    },
    {
      key: 'plan',
      header: 'Plan',
      width: 1.8,
      toCopyText: (r) => r.planSlug ?? '',
      filter: { type: 'text', accessor: (r) => r.planSlug },
      render: ({ row }) =>
        row.planSlug ? (
          <code style={{ ...CELL_TRUNCATE, fontSize: 11 }} title={row.planSlug}>{row.planSlug}</code>
        ) : (
          <>—</>
        ),
    },
  ];

  // Per-column filters (kind/state/severity/priority/…) → ONE `wif` nuqs param.
  // The hook re-derives enum options from the live rows and AND-s every active
  // filter; `cf.rows` is the input ref when nothing is active (cheap fast-path).
  const cf = useColumnFilters(columns, items ?? [], { ns: 'wi' });

  // Global quick-search (`wq`) is a separate affordance — apply it as a substring
  // match ON TOP of the column-filtered rows (id/title/state/assignee).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cf.rows;
    return cf.rows.filter((i) =>
      `${i.id} ${i.title} ${i.state} ${i.assignee ?? ''}`.toLowerCase().includes(q),
    );
  }, [cf.rows, search]);

  // Virtualized rows — only the visible window mounts as DOM, so the grid scales
  // to the full work-item set without the per-row render cost that the old
  // limit:300 cap was quietly papering over. (Same pattern as AdvAgentsPanel.)
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 12,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [filtered, rowVirtualizer]);

  if (!slug) return <div className="pc-advpanel__empty">Pick a harness to view its work items.</div>;

  return (
    <div className="pc-advpanel">
      <div className="pc-advpanel__bar">
        <input
          type="text"
          className="pc-advpanel__input"
          value={search}
          onChange={(e) => void setSearch(e.target.value)}
          placeholder="Filter work items…"
          aria-label="Filter work items"
        />
        <ColumnFilterBar
          controller={cf.controller}
          activeChips={cf.activeChips}
          hasActive={cf.hasActive}
          clearAll={cf.clearAll}
        />
        <Tooltip label="Refresh work items">
          <button
            type="button"
            className="pc-advpanel__iconbtn"
            onClick={() => query.invalidate()}
            disabled={loading}
            aria-label="Refresh work items"
          >
            <RefreshCw size={13} aria-hidden className={loading ? 'pc-advpanel__spin' : undefined} />
          </button>
        </Tooltip>
      </div>
      {error ? (
        <div className="pc-advpanel__empty pc-advpanel__empty--err">Could not load work items: {error}</div>
      ) : !items ? (
        <div className="pc-advpanel__empty">Loading work items…</div>
      ) : filtered.length === 0 ? (
        <div className="pc-advpanel__empty">
          {items.length === 0 ? 'No work items for this harness.' : 'No work items match the filter.'}
        </div>
      ) : (
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <RichGrid<WorkItemRow>
            inline
            columns={columns}
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: filtered.length,
              rowAt: (i) => filtered[i],
            }}
            resizableColumns
            columnWidths={colWidths}
            onColumnWidthsChange={setColWidths}
            getRowId={(r) => r.id}
            onRowClick={(r) => void setSelectedId(r.id)}
            getRowBg={(r) =>
              r.id === selectedId ? 'color-mix(in oklab, var(--accent), transparent 80%)' : undefined
            }
            rowMinHeight={30}
            headerHeight={30}
          />
        </div>
      )}
    </div>
  );
}
