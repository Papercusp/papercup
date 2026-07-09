'use client';

/**
 * ScorecardDetail — the full single-scorecard view (rubrics-tab-scorecard-ui-2026-07-09
 * P-003): every criterion's rating + the evidence behind it, plus the completeness
 * signal (missingKeys). Pure client-side over a `scorecards.list` row — those rows
 * already carry the FULL ratings map, so no extra query is needed. Visual model:
 * the EI-8808 grading artifact (rating chips, evidence-forward layout).
 */
import { Table, type TableColumn } from '../harness/Table';

export interface RatingEntry {
  rating: string;
  evidence?: string;
}

export interface ScorecardRow {
  issueId: string;
  createdAt: string;
  createdBy: string | null;
  sourceHive?: string;
  rubricRef: string;
  ratings: Record<string, RatingEntry>;
  nKeys: number;
  missingKeys: string[];
  rubricResolved: boolean;
  synthesized?: boolean;
  /** Read-time 0–10 projection (P-004/D-001; null = nothing mappable). */
  score10: number | null;
}

/**
 * Map a rating value to a semantic tone. Scales vary per rubric
 * (pass/partial/fail/unknown, healthy/degraded/broken/unknown, …) so match by
 * meaning, not by one rubric's vocabulary.
 */
export function ratingTone(rating: string): 'good' | 'mid' | 'bad' | 'unknown' {
  const r = rating.toLowerCase();
  if (['pass', 'healthy', 'good', 'yes', 'green'].includes(r)) return 'good';
  if (['partial', 'degraded', 'mixed', 'warn'].includes(r)) return 'mid';
  if (['fail', 'broken', 'bad', 'no', 'red'].includes(r)) return 'bad';
  return 'unknown';
}

const TONE_STYLE: Record<ReturnType<typeof ratingTone>, React.CSSProperties> = {
  good: { background: 'rgba(22, 163, 74, 0.15)', color: '#15803d' },
  mid: { background: 'rgba(217, 119, 6, 0.15)', color: '#b45309' },
  bad: { background: 'rgba(220, 38, 38, 0.15)', color: '#b91c1c' },
  unknown: { background: 'rgba(107, 114, 128, 0.15)', color: '#6b7280' },
};

export function RatingChip({ rating }: { rating: string }) {
  return (
    <span
      style={{
        ...TONE_STYLE[ratingTone(rating)],
        borderRadius: '999px',
        padding: '0.1em 0.7em',
        fontSize: '0.85em',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {rating}
    </span>
  );
}

export default function ScorecardDetail({
  scorecard,
  onBack,
}: {
  scorecard: ScorecardRow;
  onBack?: () => void;
}) {
  const entries = Object.entries(scorecard.ratings);
  const complete = scorecard.rubricResolved && scorecard.missingKeys.length === 0;

  const ratingColumns: TableColumn<[string, RatingEntry]>[] = [
    {
      key: 'criterion',
      header: 'Criterion',
      render: ([key]) => key,
      cellStyle: { whiteSpace: 'nowrap', verticalAlign: 'top' },
    },
    {
      key: 'rating',
      header: 'Rating',
      render: ([, entry]) => <RatingChip rating={entry.rating} />,
      cellStyle: { verticalAlign: 'top' },
    },
    {
      key: 'evidence',
      header: 'Evidence',
      render: ([, entry]) => entry.evidence ?? '',
      cellStyle: { maxWidth: '48rem' },
    },
  ];

  return (
    <div className="pc-scorecard-detail">
      {onBack && (
        <button type="button" onClick={onBack} style={{ marginBottom: '1rem' }}>
          ← Back to grading history
        </button>
      )}
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          gap: '0.25rem 1rem',
          marginBottom: '1.25rem',
        }}
      >
        <dt style={{ opacity: 0.65 }}>Scorecard</dt>
        <dd>{scorecard.issueId}</dd>
        <dt style={{ opacity: 0.65 }}>Rubric</dt>
        <dd>{scorecard.rubricRef}</dd>
        <dt style={{ opacity: 0.65 }}>Graded at</dt>
        <dd>{new Date(scorecard.createdAt).toLocaleString()}</dd>
        <dt style={{ opacity: 0.65 }}>Graded by</dt>
        <dd>{scorecard.createdBy ?? 'unknown'}</dd>
        {scorecard.sourceHive && (
          <>
            <dt style={{ opacity: 0.65 }}>Source hive</dt>
            <dd>{scorecard.sourceHive}</dd>
          </>
        )}
        <dt style={{ opacity: 0.65 }}>Score</dt>
        <dd title="Read-time 0–10 projection (pass=10 / partial=5 / fail=0; unknown excluded) — grading stays categorical">
          {scorecard.score10 !== null ? `${scorecard.score10} / 10` : '— (no mappable ratings)'}
        </dd>
        <dt style={{ opacity: 0.65 }}>Completeness</dt>
        <dd>
          {complete
            ? `complete — all ${scorecard.nKeys} criteria rated`
            : scorecard.rubricResolved
              ? `incomplete — ${scorecard.missingKeys.length} unrated: ${scorecard.missingKeys.join(', ')}`
              : `rubric unresolved — ${scorecard.nKeys} rated (completeness unverifiable)`}
        </dd>
      </dl>

      <div style={{ overflowX: 'auto' }}>
        <Table
          className="pc-scorecard-ratings"
          caption={`${entries.length} criterion rating${entries.length === 1 ? '' : 's'}`}
          columns={ratingColumns}
          rows={entries}
          getRowKey={([key]) => key}
        />
      </div>
    </div>
  );
}
