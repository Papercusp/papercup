'use client';

import { useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';

/**
 * WorkItemsPanel — the features/issues view PORTED onto the unified `work_items`
 * surface (blueprint-aware-harness-ui-2026-06-09 P-010 / unify-work-items D-001). One
 * table across BOTH families — feature-family {feature,research-task,chunk} +
 * issue-family {bug,change,task} — for the selected member harness, surfacing the
 * dimensions the old per-kind FeaturesPanel/IssuesPanel couldn't: `kind`/`family`, the
 * claim (`assignee` + `assignedBy`), `severity`, backlog `priority`, and per-assignee
 * `rank`.
 *
 * v1 reads `GET /api/harness/:slug/work-items` via fetch + manual refresh. The proper
 * live-updating path is a `@papercusp/sync` resolver (`workItems.byHarness`) — a
 * deliberate follow-up (surfaced, not silently bypassed): this is an additive,
 * opt-in panel, so a fetch is acceptable for the first cut. Spine-position (role/stage)
 * + plan-item linkage are also follow-ups (they need a spawned_agents / coord_links join).
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
  updatedAt: string;
}

export default function WorkItemsPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  const [items, setItems] = useState<WorkItemRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // user-meaningful filters → URL (nuqs); `w`-prefixed so they don't collide with
  // the Features (fview/fq) / Issues (iview/iq) panels.
  const [kind, setKind] = useQueryState('wkind', parseAsString.withDefault(''));
  const [search, setSearch] = useQueryState('wq', parseAsString.withDefault(''));

  const load = useMemo(
    () => async () => {
      if (!slug) return;
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/work-items?limit=300`, { cache: 'no-store' });
        const d = (await r.json()) as { workItems?: WorkItemRow[]; error?: string };
        if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
        setItems(d.workItems ?? []);
      } catch (e) {
        setError((e as Error).message);
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [slug],
  );

  useEffect(() => {
    void load();
  }, [load]);

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
        <button type="button" onClick={() => void load()} disabled={loading} style={{ fontSize: 11.5, padding: '4px 10px' }}>
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
