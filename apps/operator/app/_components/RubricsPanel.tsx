'use client';

/**
 * RubricsPanel — every rubric in the store with its grading rollup
 * (rubrics-tab-scorecard-ui-2026-07-09 P-001). Reads via `@papercusp/sync`
 * (rubrics.list) — the resolver reuses the SAME store reads rubrics:list /
 * scorecards:list serve agents, so this panel never diverges from what
 * graders see. Row click drills into grading history + scorecard detail
 * (P-002/P-003 — the scorecards.list / rubrics.trend queries are already
 * live server-side).
 */
import { useSyncQuery } from '@papercusp/sync';
import { Table, type TableColumn } from '../harness/Table';

interface RubricRow {
  rubricId: string;
  characteristic: string;
  title: string;
  status: string;
  criteriaCount: number;
  ratingScale: string[];
  methodRef: string | null;
  updatedAt: string;
  scorecardCount: number;
  latestScorecardAt: string | null;
  latestScore10: number | null;
  avgScore10: number | null;
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString();
  const min = ms / 60_000;
  if (min < 60) return `${Math.max(1, Math.round(min))}m ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / (60 * 24))}d ago`;
}

export default function RubricsPanel({ onSelect }: { onSelect?: (rubricId: string) => void }) {
  const { data, error, loading } = useSyncQuery<RubricRow>({
    queryName: 'rubrics.list',
    args: {},
  });

  if (loading) {
    return (
      <div className="pc-rubrics" role="status">
        Loading rubrics…
      </div>
    );
  }
  if (error) {
    return (
      <div className="pc-rubrics pc-rubrics--error" role="status">
        Rubrics unavailable — {String(error)}
      </div>
    );
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div className="pc-rubrics" role="status">
        No rubrics in the store yet.
      </div>
    );
  }

  const columns: TableColumn<RubricRow>[] = [
    {
      key: 'rubric',
      header: 'Rubric',
      render: (row) => (
        <>
          <div>{row.title}</div>
          <div style={{ opacity: 0.65, fontSize: '0.85em' }}>{row.rubricId}</div>
        </>
      ),
    },
    { key: 'domain', header: 'Domain', render: (row) => row.characteristic },
    { key: 'status', header: 'Status', render: (row) => row.status },
    { key: 'criteria', header: 'Criteria', render: (row) => row.criteriaCount },
    { key: 'scale', header: 'Scale', render: (row) => row.ratingScale.join(' / ') },
    { key: 'scorecards', header: 'Scorecards', render: (row) => row.scorecardCount },
    {
      key: 'avgScore',
      header: 'Avg /10',
      render: (row) => row.avgScore10 ?? '—',
      cellStyle: { fontVariantNumeric: 'tabular-nums' },
      cellTitle: () => 'Read-time 0–10 projection (pass=10 / partial=5 / fail=0; unknown excluded)',
    },
    { key: 'lastGraded', header: 'Last graded', render: (row) => formatWhen(row.latestScorecardAt) },
  ];

  return (
    <Table
      className="pc-rubrics"
      caption={`${rows.length} rubric${rows.length === 1 ? '' : 's'}`}
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.rubricId}
      onRowClick={onSelect ? (row) => onSelect(row.rubricId) : undefined}
    />
  );
}
