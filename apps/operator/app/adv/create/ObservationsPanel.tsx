'use client';

/**
 * create:observations — the Observations browse pane (turn-end-reflection-
 * observations-2026-06-14 P-043 / D-005).
 *
 * PRE-IDEA sensor readings agents record at the END of a turn (the reflection
 * step), filed in the SEPARATE observation lane. This pane is BROWSE-ONLY:
 * observations never enter the work/triage queue (that is the whole point), so
 * there is deliberately NO triage / dispatch / claim affordance here. Data is
 * the `learning.observations` sync resolver (newest first); the only path from
 * an observation to actual work is Scout clustering a RECURRING one and
 * promoting it to a real idea — never from this surface.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { RefreshCw } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { VirtualGrid, type ColumnDef } from '@papercusp/grid-core';
import { readListTotal } from '@papercusp/operator-core/lib/sync-resolver/list-meta';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import { useItemPlanFilter } from './use-create-data';

interface ObservationRow {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  scope: string | null;
  confidence: string | null;
  refs: string[];
  sourceRole: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = {
  friction: 'Friction',
  workaround: 'Workaround',
  gap: 'Gap',
  surprise: 'Surprise',
  reinforce: 'Reinforce',
};

// Same growing server window used by Working → Work Queue. VirtualGrid keeps DOM
// work bounded while the explicit limit makes each next page part of the same
// sync-query stream. The resolver carries the true count on row[0]._meta.
export const OBSERVATIONS_PAGE = 200;

const CELL_TRUNCATE: CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export default function ObservationsPanel(_props?: Partial<PanelComponentProps>) {
  const [itemPlans] = useItemPlanFilter();
  const [limit, setLimit] = useState(OBSERVATIONS_PAGE);
  const itemPlanKey = itemPlans.join('\u0000');
  useEffect(() => setLimit(OBSERVATIONS_PAGE), [itemPlanKey]);

  const query = useSyncQuery<ObservationRow>({
    queryName: 'learning.observations',
    args: { limit },
    staleTime: 30_000,
  });
  // Keep cached rows painted while a larger window or push invalidation refetches.
  const allRows = query.data ?? [];
  const rows = useMemo(
    () => itemPlans.length
      ? allRows.filter((row) => observationMatchesPlan(row, itemPlans))
      : allRows,
    [allRows, itemPlans],
  );
  const total = readListTotal(query.data);
  const hasMore = allRows.length < total;
  const loadMore = useCallback(() => setLimit((current) => current + OBSERVATIONS_PAGE), []);

  const columns = useMemo<ColumnDef<ObservationRow>[]>(() => [
    {
      key: 'kind',
      header: 'Signal',
      width: 1,
      toCopyText: (row) => row.kind ? (KIND_LABEL[row.kind] ?? row.kind) : '',
      render: ({ row }) => row.kind ? (
        <span style={{ fontSize: 11, fontWeight: 650, color: 'var(--accent)' }}>
          {KIND_LABEL[row.kind] ?? row.kind}
        </span>
      ) : null,
    },
    {
      key: 'observation',
      header: 'Observation',
      width: 5,
      toCopyText: (row) => [row.title, row.body].filter(Boolean).join('\n'),
      render: ({ row }) => (
        <span style={{ display: 'grid', gap: 2, minWidth: 0 }} title={row.body ?? row.title}>
          <strong style={{ ...CELL_TRUNCATE, fontSize: 12, fontWeight: 620 }}>{row.title}</strong>
          {row.body ? <span style={{ ...CELL_TRUNCATE, color: 'var(--fg-mute)', fontSize: 11 }}>{row.body}</span> : null}
        </span>
      ),
    },
    {
      key: 'context',
      header: 'Context',
      width: 2.6,
      toCopyText: (row) => [row.sourceRole, row.scope, row.confidence, ...row.refs].filter(Boolean).join(' · '),
      render: ({ row }) => (
        <span style={{ ...CELL_TRUNCATE, color: 'var(--fg-mute)', fontSize: 11 }} title={[row.sourceRole, row.scope, row.confidence, ...row.refs].filter(Boolean).join(' · ')}>
          {[row.sourceRole, row.scope, row.confidence, ...row.refs].filter(Boolean).join(' · ')}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Observed',
      width: 1.5,
      toCopyText: (row) => row.createdAt,
      render: ({ row }) => (
        <span style={{ ...CELL_TRUNCATE, color: 'var(--fg-mute)', fontSize: 11 }} title={new Date(row.createdAt).toLocaleString()}>
          {new Date(row.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      ),
    },
  ], []);

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ minHeight: 30, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        {total > 0 ? (
          <span data-testid="observations-count" style={{ color: 'var(--fg-mute)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            {itemPlans.length ? `${rows.length} / ${total}` : total}
          </span>
        ) : null}
        <button
          type="button"
          className="pc-advpanel__iconbtn"
          aria-label="Refresh observations"
          disabled={query.fetching}
          onClick={() => query.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>
      {query.loading && rows.length === 0 ? (
        <div style={{ color: 'var(--fg-mute)', padding: 12 }}>Loading observations…</div>
      ) : query.error ? (
        <div style={{ color: 'var(--bad)', padding: 12 }}>Could not load observations.</div>
      ) : rows.length === 0 ? (
        <div style={{ color: 'var(--fg-mute)', padding: 12 }}>
          {itemPlans.length
            ? 'No observations match the selected plan.'
            : 'No observations yet — they appear as agents reflect at the end of their turns.'}
        </div>
      ) : (
        <VirtualGrid<ObservationRow>
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
          rowMinHeight={48}
          headerHeight={30}
          onEndReached={hasMore ? loadMore : undefined}
        />
      )}
    </div>
  );
}

function observationMatchesPlan(row: ObservationRow, planSlugs: readonly string[]): boolean {
  if (planSlugs.length === 0) return true;
  const refs = row.refs.map((r) => r.toLowerCase());
  return planSlugs.some((slug) => {
    const s = slug.toLowerCase();
    const token = new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(s)}($|[^a-z0-9_-])`);
    return refs.some((ref) => ref === s || ref === `plan:${s}` || token.test(ref));
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
