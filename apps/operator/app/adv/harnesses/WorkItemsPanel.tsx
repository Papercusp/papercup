'use client';

import { useEffect, useMemo, type CSSProperties } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { RichGrid, usePersistedColumnWidths, type ColumnDef } from '@papercusp/grid-core';
import { Select } from '../../harness/Select';
import { IssueStatusPill, SeverityPill, StatusPill } from '../../harness/primitives';
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
}

// Grid-cell truncation (native title= is the approved pattern for dynamic
// per-row truncation tooltips — see design/gotchas).
const CELL_TRUNCATE: CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// Small kind chip — same recipe as the member-rail/workspace-card kind chips.
const KIND_CHIP: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.02em',
  padding: '1px 5px',
  borderRadius: 4,
  background: 'var(--bg-3, rgba(255, 255, 255, 0.075))',
  color: 'var(--fg-mute, #7f9bb4)',
  whiteSpace: 'nowrap',
};

// Radix Select reserves '' for "no selection" — translate at the boundary
// (the documented sentinel pattern from design/gotchas).
const ALL_KINDS = '_all';

export default function WorkItemsPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  // user-meaningful filters → URL (nuqs); `w`-prefixed so they don't collide with
  // the Features (fview/fq) / Issues (iview/iq) panels.
  const [kind, setKind] = useQueryState('wkind', parseAsString.withDefault(''));
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
    args: { harnessSlug: slug, limit: 300 },
    enabled: Boolean(slug),
  });
  const items = query.loading ? null : query.data;
  const loading = query.fetching;
  const error = query.error ? query.error.message : null;

  useEffect(() => {
    if (items) api.setTitle(`Work items · ${slug} (${items.length})`);
  }, [items, slug, api]);

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const i of items ?? []) set.add(i.kind);
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items ?? []).filter((i) => {
      if (kind && i.kind !== kind) return false;
      if (q && !(`${i.id} ${i.title} ${i.state} ${i.assignee ?? ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, kind, search]);

  const columns: ColumnDef<WorkItemRow>[] = [
    {
      key: 'id',
      header: 'ID',
      width: 1.4,
      toCopyText: (r) => r.id,
      render: ({ row }) => (
        <code style={CELL_TRUNCATE} title={row.id}>{row.id}</code>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 1.2,
      toCopyText: (r) => r.kind,
      render: ({ row }) => <span style={KIND_CHIP}>{row.kind}</span>,
    },
    {
      key: 'title',
      header: 'Title',
      width: 4,
      toCopyText: (r) => r.title,
      render: ({ row }) => (
        <span style={CELL_TRUNCATE} title={row.title}>{row.title}</span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      width: 1.2,
      toCopyText: (r) => r.state,
      // Canonical status pills (app/harness/theme.ts tables — the same coloring
      // FeatureList/IssuesList use). Family picks the table; unknown states fall
      // back to the tables' neutral meta, so plain text never regresses to bare.
      render: ({ row }) =>
        row.family === 'issue' ? (
          <IssueStatusPill status={row.state} size="xs" />
        ) : (
          <StatusPill status={row.state as HarnessStatus} size="xs" />
        ),
    },
    {
      key: 'stage',
      header: 'Stage',
      width: 1.7,
      toCopyText: (r) => (r.spineRole ? `${r.spineRole}${r.spineStatus ? ` (${r.spineStatus})` : ''}` : ''),
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
      render: ({ row }) =>
        row.severity ? <SeverityPill severity={row.severity} size="xs" /> : <>—</>,
    },
    {
      key: 'priority',
      header: 'Prio',
      width: 0.8,
      toCopyText: (r) => (r.priority == null ? '' : String(r.priority)),
      render: ({ row }) => <>{row.priority ?? '—'}</>,
    },
    {
      key: 'rank',
      header: 'Rank',
      width: 0.8,
      toCopyText: (r) => (r.rank == null ? '' : String(r.rank)),
      render: ({ row }) => <>{row.rank ?? '—'}</>,
    },
    {
      key: 'plan',
      header: 'Plan',
      width: 1.8,
      toCopyText: (r) => r.planSlug ?? '',
      render: ({ row }) =>
        row.planSlug ? (
          <code style={{ ...CELL_TRUNCATE, fontSize: 11 }} title={row.planSlug}>{row.planSlug}</code>
        ) : (
          <>—</>
        ),
    },
  ];

  if (!slug) return <div style={{ padding: 16, color: 'var(--fg-mute)' }}>Pick a harness to view its work items.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => void setSearch(e.target.value)}
          placeholder="Filter work items…"
          style={{ flex: 1, fontSize: 12.5, padding: '4px 8px' }}
        />
        <Select
          value={kind || ALL_KINDS}
          onChange={(v) => void setKind(v === ALL_KINDS ? '' : v)}
          ariaLabel="Filter by kind"
          options={[
            { value: ALL_KINDS, label: 'all kinds' },
            ...kinds.map((k) => ({ value: k, label: k })),
          ]}
        />
        <button type="button" onClick={() => query.invalidate()} disabled={loading} style={{ fontSize: 11.5, padding: '4px 10px' }}>
          {loading ? '…' : 'Refresh'}
        </button>
      </div>
      {error ? (
        <div style={{ padding: 16, color: 'var(--bad, #f87171)', fontSize: 12.5 }}>Could not load work items: {error}</div>
      ) : !items ? (
        <div style={{ padding: 16, color: 'var(--fg-mute)', fontSize: 12.5 }}>Loading work items…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--fg-mute)', fontSize: 12.5 }}>
          {items.length === 0 ? 'No work items for this harness.' : 'No work items match the filter.'}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <RichGrid<WorkItemRow>
            columns={columns}
            rows={filtered}
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
