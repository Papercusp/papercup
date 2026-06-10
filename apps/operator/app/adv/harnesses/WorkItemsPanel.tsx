'use client';

import { useEffect, useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
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

interface WorkItemRow {
  id: string;
  kind: string;
  family: string;
  title: string;
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

export default function WorkItemsPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  // user-meaningful filters → URL (nuqs); `w`-prefixed so they don't collide with
  // the Features (fview/fq) / Issues (iview/iq) panels.
  const [kind, setKind] = useQueryState('wkind', parseAsString.withDefault(''));
  const [search, setSearch] = useQueryState('wq', parseAsString.withDefault(''));

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
    { key: 'id', header: 'ID', width: 1.4, toCopyText: (r) => r.id, render: ({ row }) => <code>{row.id}</code> },
    { key: 'kind', header: 'Kind', width: 1.2, toCopyText: (r) => r.kind, render: ({ row }) => <>{row.kind}</> },
    { key: 'title', header: 'Title', width: 4, toCopyText: (r) => r.title, render: ({ row }) => <>{row.title}</> },
    { key: 'state', header: 'State', width: 1.2, toCopyText: (r) => r.state, render: ({ row }) => <>{row.state}</> },
    {
      key: 'stage',
      header: 'Stage',
      width: 1.7,
      toCopyText: (r) => (r.spineRole ? `${r.spineRole}${r.spineStatus ? ` (${r.spineStatus})` : ''}` : ''),
      render: ({ row }) =>
        row.spineRole ? (
          <span title="latest spine role · status (spawned_agents)">
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
        <span title={row.assignedBy ? `delegated by ${row.assignedBy}` : undefined}>
          {row.assignee ?? '—'}
          {row.assignedBy ? <span style={{ color: 'var(--fg-mute)' }}> ·by {row.assignedBy}</span> : null}
        </span>
      ),
    },
    { key: 'severity', header: 'Sev', width: 0.9, toCopyText: (r) => r.severity ?? '', render: ({ row }) => <>{row.severity ?? '—'}</> },
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
      render: ({ row }) => (row.planSlug ? <code style={{ fontSize: 11 }}>{row.planSlug}</code> : <>—</>),
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
        <select value={kind} onChange={(e) => void setKind(e.target.value)} style={{ fontSize: 12.5, padding: '4px 6px' }}>
          <option value="">all kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => query.invalidate()} disabled={loading} style={{ fontSize: 11.5, padding: '4px 10px' }}>
          {loading ? '…' : 'Refresh'}
        </button>
      </div>
      {error ? (
        <div style={{ padding: 16, color: 'var(--bad, #d97757)', fontSize: 12.5 }}>Could not load work items: {error}</div>
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
            getRowId={(r) => r.id}
            rowMinHeight={30}
            headerHeight={30}
          />
        </div>
      )}
    </div>
  );
}
