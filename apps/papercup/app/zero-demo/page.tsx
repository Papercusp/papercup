'use client';

/**
 * Zero + RichGrid demo for the harness DB.
 *
 *   PG `papercusp.harness_shared.projects`
 *     → publication `zero_harness`
 *     → zero-cache-harness on :4849
 *     → @rocicorp/zero/react WebSocket
 *     → useQuery
 *     → <RichGrid columns={...} />
 *     → live re-render on every PG change
 *
 * NOTE on table naming: zero-cache replicates publication tables into its
 * SQLite replica with their full schema-qualified PG name (e.g. literal
 * 'harness_shared.projects'). Our Zero schema in @restart/zero-harness uses
 * that same name as the table key so the view-syncer can match it without
 * needing a name-mapping refactor in Zero. We access via `zql['harness_shared.projects']`.
 */
import { useMemo } from 'react';
import { useQuery } from '@rocicorp/zero/react';
import { queries, type ProjectRow } from '@restart/zero-harness';
import { RichGrid, type ColumnDef } from '@restart/grid-core';

function fmtMoney(cents: number | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'in_progress' ? '#34d399' :
    status === 'launched'    ? '#7aa2f7' :
    status === 'paused'      ? '#fbbf24' :
    status === 'cancelled'   ? '#f87171' :
                                '#8a96ad';
  return (
    <span style={{
      fontSize: 11, fontFamily: 'ui-monospace, monospace',
      padding: '2px 8px', borderRadius: 999,
      border: `1px solid ${tone}55`,
      background: `color-mix(in oklab, ${tone}, transparent 88%)`,
      color: tone,
    }}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export default function ZeroDemoPage() {
  const [rows, info] = useQuery(queries.projects.all());

  const columns: ColumnDef<ProjectRow>[] = useMemo(() => [
    {
      key: 'id',
      header: 'ID',
      width: 2,
      align: 'left',
      sortKey: 'id',
      render: ({ row }) => (
        <span style={{ fontFamily: 'ui-monospace, monospace', color: '#7aa2f7', fontSize: 12 }}>{row.id}</span>
      ),
    },
    {
      key: 'name',
      header: 'Name',
      width: 5,
      align: 'left',
      sortKey: 'name',
      render: ({ row }) => <span>{row.name}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: 1.5,
      align: 'center',
      sortKey: 'status',
      render: ({ row }) => <StatusPill status={row.status} />,
    },
    {
      key: 'owningDept',
      header: 'Owner',
      width: 1.5,
      align: 'left',
      render: ({ row }) => (
        <span style={{ color: '#8a96ad', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
          {row.owningDept ?? '—'}
        </span>
      ),
    },
    {
      key: 'budget',
      header: 'Budget',
      width: 1.2,
      align: 'right',
      sortKey: 'budgetCents',
      render: ({ row }) => (
        <span style={{ fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums' }}>
          {fmtMoney(row.budgetCents)}
        </span>
      ),
    },
    {
      key: 'spent',
      header: 'Spent',
      width: 1.2,
      align: 'right',
      sortKey: 'spentCents',
      render: ({ row }) => (
        <span style={{ fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums', color: row.spentCents > 0 ? '#fbbf24' : '#8a96ad' }}>
          {fmtMoney(row.spentCents)}
        </span>
      ),
    },
  ], []);

  const isLive = info?.type === 'complete';

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: '#e7ecf3', height: 'calc(100vh - 100px)', display: 'flex', flexDirection: 'column' }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Harness Zero + RichGrid demo</h1>
      <p style={{ fontSize: 12, color: '#8a96ad', marginBottom: 16 }}>
        <code>harness_shared.projects</code> via zero-cache-harness :4849 → useQuery → RichGrid. No polling.
        Status: <strong style={{ color: isLive ? '#34d399' : '#fbbf24' }}>{isLive ? 'live' : 'loading…'}</strong> ({rows.length} rows)
      </p>

      <div style={{ flex: 1, minHeight: 200, border: '1px solid #1f2738', borderRadius: 6 }}>
        <RichGrid<ProjectRow>
          columns={columns}
          rows={rows as ProjectRow[]}
          getRowId={(r) => r.id}
          empty={
            isLive
              ? 'No projects yet. Insert one via psql and watch this row appear without reload.'
              : 'Connecting to harness Zero…'
          }
        />
      </div>
    </div>
  );
}
