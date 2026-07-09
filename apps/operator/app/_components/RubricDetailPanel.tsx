'use client';

/**
 * RubricDetailPanel — a single rubric's grading history + per-criterion trend
 * (rubrics-tab-scorecard-ui-2026-07-09 P-002). Reads the already-live
 * `scorecards.list` + `rubrics.trend` sync queries (the SAME store reads
 * scorecards:list / rubrics:trend serve agents). Clicking a scorecard row
 * opens the full ScorecardDetail (P-003) — no extra fetch, the list rows
 * already carry the complete ratings map.
 */
import { useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { Table, type TableColumn } from '../harness/Table';
import ScorecardDetail, { RatingChip, type ScorecardRow } from './ScorecardDetail';

interface CriterionTrend {
  criterion: string;
  count: number;
  distribution: Record<string, number>;
  idleCount: number;
  first: { rating: string; at: string };
  latest: { rating: string; at: string };
  direction: string;
  mean10: number | null;
}

interface RubricTrend {
  rubricRef: string;
  scorecardCount: number;
  window: { since?: string; from?: string; to?: string };
  criteria: CriterionTrend[];
}

function directionGlyph(direction: string): string {
  const d = direction.toLowerCase();
  if (d.includes('improv') || d.includes('up')) return '↑';
  if (d.includes('worsen') || d.includes('declin') || d.includes('regress') || d.includes('down')) return '↓';
  return '→';
}

function formatDistribution(distribution: Record<string, number>): string {
  return Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .map(([rating, n]) => `${n}× ${rating}`)
    .join(', ');
}

export default function RubricDetailPanel({
  rubricId,
  onBack,
}: {
  rubricId: string;
  onBack?: () => void;
}) {
  const [selected, setSelected] = useState<ScorecardRow | null>(null);

  const scorecards = useSyncQuery<ScorecardRow>({
    queryName: 'scorecards.list',
    args: { rubricRef: rubricId },
  });
  const trend = useSyncQuery<RubricTrend>({
    queryName: 'rubrics.trend',
    args: { rubricRef: rubricId },
  });

  if (selected) {
    return <ScorecardDetail scorecard={selected} onBack={() => setSelected(null)} />;
  }

  const rows = scorecards.data ?? [];
  const trendRow = trend.data?.[0];

  const trendColumns: TableColumn<CriterionTrend>[] = trendRow
    ? [
        { key: 'criterion', header: 'Criterion', render: (c) => c.criterion, cellStyle: { whiteSpace: 'nowrap' } },
        { key: 'latest', header: 'Latest', render: (c) => <RatingChip rating={c.latest.rating} /> },
        {
          key: 'trend',
          header: 'Trend',
          render: (c) => `${directionGlyph(c.direction)} ${c.direction}`,
          cellTitle: (c) => c.direction,
        },
        {
          key: 'mean',
          header: 'Mean /10',
          render: (c) => c.mean10 ?? '—',
          cellStyle: { fontVariantNumeric: 'tabular-nums' },
        },
        { key: 'distribution', header: 'Distribution', render: (c) => formatDistribution(c.distribution) },
        {
          key: 'rated',
          header: 'Rated',
          render: (c) => c.count,
          cellStyle: { fontVariantNumeric: 'tabular-nums' },
        },
      ]
    : [];

  const historyColumns: TableColumn<ScorecardRow>[] = [
    { key: 'scorecard', header: 'Scorecard', render: (row) => row.issueId },
    {
      key: 'gradedAt',
      header: 'Graded at',
      render: (row) => new Date(row.createdAt).toLocaleString(),
      cellStyle: { whiteSpace: 'nowrap' },
    },
    { key: 'gradedBy', header: 'Graded by', render: (row) => row.createdBy ?? 'unknown' },
    {
      key: 'score',
      header: 'Score /10',
      render: (row) => row.score10 ?? '—',
      cellStyle: { fontVariantNumeric: 'tabular-nums' },
    },
    {
      key: 'criteriaRated',
      header: 'Criteria rated',
      render: (row) => row.nKeys,
      cellStyle: { fontVariantNumeric: 'tabular-nums' },
    },
    {
      key: 'completeness',
      header: 'Completeness',
      render: (row) =>
        row.rubricResolved
          ? row.missingKeys.length === 0
            ? 'complete'
            : `${row.missingKeys.length} missing`
          : 'rubric unresolved',
    },
  ];

  return (
    <div className="pc-rubric-detail">
      {onBack && (
        <button type="button" onClick={onBack} style={{ marginBottom: '1rem' }}>
          ← All rubrics
        </button>
      )}
      <h2 style={{ marginBottom: '0.25rem' }}>{rubricId}</h2>

      <h3 style={{ margin: '1.25rem 0 0.5rem' }}>Per-criterion trend</h3>
      {trend.loading ? (
        <div role="status">Loading trend…</div>
      ) : trend.error ? (
        <div role="status">Trend unavailable — {String(trend.error)}</div>
      ) : !trendRow || trendRow.criteria.length === 0 ? (
        <div role="status">No graded criteria yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table
            className="pc-rubric-trend"
            caption={
              <>
                {trendRow.scorecardCount} scorecard{trendRow.scorecardCount === 1 ? '' : 's'} in window{' '}
                {trendRow.window.from ? `${new Date(trendRow.window.from).toLocaleDateString()} – ` : ''}
                {trendRow.window.to ? new Date(trendRow.window.to).toLocaleDateString() : ''}
              </>
            }
            columns={trendColumns}
            rows={trendRow.criteria}
            getRowKey={(c) => c.criterion}
          />
        </div>
      )}

      <h3 style={{ margin: '1.5rem 0 0.5rem' }}>Grading history</h3>
      {scorecards.loading ? (
        <div role="status">Loading scorecards…</div>
      ) : scorecards.error ? (
        <div role="status">Scorecards unavailable — {String(scorecards.error)}</div>
      ) : rows.length === 0 ? (
        <div role="status">No scorecards filed against this rubric yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table
            className="pc-rubric-history"
            caption={
              <>
                {rows.length} scorecard{rows.length === 1 ? '' : 's'} (newest first) — click a row for
                full ratings + evidence
              </>
            }
            columns={historyColumns}
            rows={rows}
            getRowKey={(row) => row.issueId}
            onRowClick={(row) => setSelected(row)}
          />
        </div>
      )}
    </div>
  );
}
