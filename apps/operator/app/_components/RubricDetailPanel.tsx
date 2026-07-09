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
import ScorecardDetail, { RatingChip, type ScorecardRow } from './ScorecardDetail';

interface CriterionTrend {
  criterion: string;
  count: number;
  distribution: Record<string, number>;
  idleCount: number;
  first: { rating: string; at: string };
  latest: { rating: string; at: string };
  direction: string;
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
          <table className="pc-rubric-trend">
            <caption>
              {trendRow.scorecardCount} scorecard{trendRow.scorecardCount === 1 ? '' : 's'} in window{' '}
              {trendRow.window.from ? `${new Date(trendRow.window.from).toLocaleDateString()} – ` : ''}
              {trendRow.window.to ? new Date(trendRow.window.to).toLocaleDateString() : ''}
            </caption>
            <thead>
              <tr>
                <th scope="col">Criterion</th>
                <th scope="col">Latest</th>
                <th scope="col">Trend</th>
                <th scope="col">Distribution</th>
                <th scope="col">Rated</th>
              </tr>
            </thead>
            <tbody>
              {trendRow.criteria.map((c) => (
                <tr key={c.criterion}>
                  <td style={{ whiteSpace: 'nowrap' }}>{c.criterion}</td>
                  <td>
                    <RatingChip rating={c.latest.rating} />
                  </td>
                  <td title={c.direction}>
                    {directionGlyph(c.direction)} {c.direction}
                  </td>
                  <td>{formatDistribution(c.distribution)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{c.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
          <table className="pc-rubric-history">
            <caption>
              {rows.length} scorecard{rows.length === 1 ? '' : 's'} (newest first) — click a row for
              full ratings + evidence
            </caption>
            <thead>
              <tr>
                <th scope="col">Scorecard</th>
                <th scope="col">Graded at</th>
                <th scope="col">Graded by</th>
                <th scope="col">Criteria rated</th>
                <th scope="col">Completeness</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.issueId} onClick={() => setSelected(row)} style={{ cursor: 'pointer' }}>
                  <td>{row.issueId}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{row.createdBy ?? 'unknown'}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.nKeys}</td>
                  <td>
                    {row.rubricResolved
                      ? row.missingKeys.length === 0
                        ? 'complete'
                        : `${row.missingKeys.length} missing`
                      : 'rubric unresolved'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
