'use client';

/**
 * ScorecardDetail — the full single-scorecard view (rubrics-tab-scorecard-ui-2026-07-09
 * P-003): every criterion's rating + the evidence behind it, plus the completeness
 * signal (missingKeys). Pure client-side over a `scorecards.list` row — those rows
 * already carry the FULL ratings map, so no extra query is needed. Visual model:
 * the EI-8808 grading artifact (rating chips, evidence-forward layout).
 */
import { Table, type TableColumn } from '../harness/Table';
import { useLexicon } from '@/lib/useLexicon';
import { useState } from 'react';
import { callTool } from '@papercusp/operator-core/lib/call-tool';
import type { ScorecardRow as StoredScorecardRow, ScorecardEvidenceAction } from '@papercusp/operator-core/lib/scorecards';
import type { Rubric } from '@papercusp/operator-core/lib/rubrics';
import type { ObservationLedgerResult } from '@papercusp/operator-core/lib/harness/improvements/observation-types';

export interface RatingEntry {
  rating: string;
  evidence?: string;
  nextEvidenceAction?: string;
  unknownReason?: string;
  ledgerResult?: ObservationLedgerResult;
  lastMeasurement?: ObservationLedgerResult;
}

export interface ScorecardRow extends Pick<StoredScorecardRow,
  'coverage' | 'evidenceActions' | 'omittedActionCount' | 'gradingAudit' | 'acceptance' | 'exclusionReasons'> {
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
  /**
   * WI-3594 (scorecard→improvement flow): outbound work-items this scorecard is
   * linked to (e.g. the improvement it graded), set at file time via
   * improvements:capture's observation.linkTo or after the fact via
   * work_items:link. Empty when nothing is linked.
   */
  linkedItems?: { rel: string; dst: { kind: string; ref: string } }[];
}

function MeasurementDetail({ result, label }: { result: ObservationLedgerResult; label: string }) {
  return <div aria-label={label}>
    {label}: {result.value === null ? 'unavailable' : String(result.value)} {result.unit ?? ''}
    {' · '}{result.status ?? 'Outcome unavailable'}{' · measured '}{result.finishedAt ?? 'time unavailable'}
    {' · age '}{result.ageMs == null ? 'unavailable' : `${result.ageMs} ms`}
    {' · '}{result.freshness ?? 'Freshness unavailable'}
    {result.comparisonTime && <> · compared at {result.comparisonTime}</>}
    {' · source test_runs:'}{result.testRunId}
  </div>;
}

/** Display the server's independent axes; never derive support from rating prose. */
export function ScorecardCoverageSummary({ scorecard }: { scorecard: ScorecardRow }) {
  const coverage = scorecard.coverage;
  if (!coverage) return <span>Coverage unavailable</span>;
  const denominator = coverage.denominator ?? '?';
  return (
    <span aria-label="Assessment coverage">
      {coverage.record.present ?? '?'}/{denominator} rating keys present ·{' '}
      {coverage.evidence.current.length}/{denominator} supported ·{' '}
      {coverage.unresolvedKeys.length} unresolved · Requested scope unknown · Fulfillment unknown
    </span>
  );
}

function EvidenceActionDetail({ action }: { action: ScorecardEvidenceAction }) {
  const [read, setRead] = useState<{ loading?: boolean; text?: string; error?: string }>({});
  const readProcedure = async () => {
    if (!action.definitionRead) return;
    setRead({ loading: true });
    try {
      const response = await callTool(action.definitionRead.tool, action.definitionRead.args);
      const block = response.content.find(item => item.type === 'text' && typeof item.text === 'string');
      if (!block) throw new Error('Pinned procedure unavailable.');
      const result = JSON.parse(block.text as string) as { results?: Array<{ ok?: boolean; rubric?: Rubric }> };
      const rubric = result.results?.find(item => item.ok && item.rubric?.rubricId === action.context.rubricRef)?.rubric;
      if (!rubric || rubric.revision !== action.context.rubricRevision || rubric.criteriaHash !== action.context.criteriaHash) {
        throw new Error('The recorded rubric revision and hash could not be verified.');
      }
      const criterion = rubric.criteria.find(item => item.key === action.criterionKey);
      if (!criterion) throw new Error('The recorded criterion is unavailable.');
      setRead({ text: [criterion.method, criterion.replication].filter(Boolean).join('\n\n') || 'No specific procedure was authored.' });
    } catch (error) {
      setRead({ error: error instanceof Error ? error.message : 'Pinned procedure unavailable.' });
    }
  };
  return (
    <li>
      <strong>{action.criterionKey}</strong>: {action.nextEvidenceAction}
      <p>{action.procedure.excerpt || 'No specific procedure recorded.'}</p>
      <details>
        <summary>Procedure context</summary>
        <p>Reason: {action.reason} · Readiness: {action.readiness}</p>
        <p>Subject: {action.context.subjectRef ?? 'Unknown'}</p>
        <p>Window: {action.context.windowStart ?? 'Unknown'} to {action.context.windowEnd ?? 'Unknown'}</p>
        <p>Rubric: {action.context.rubricRef} · Revision: {action.context.rubricRevision ?? 'Unknown'}</p>
        <p>{action.finishCondition}</p>
        {action.definitionRead && (
          <button type="button" onClick={readProcedure} disabled={read.loading}>
            {read.loading ? 'Reading procedure…' : `Read full procedure for ${action.criterionKey}`}
          </button>
        )}
        {read.error && <p role="status">{read.error}</p>}
        {read.text && <pre style={{ whiteSpace: 'pre-wrap' }}>{read.text}</pre>}
      </details>
    </li>
  );
}

/**
 * Map a rating value to a semantic tone. Scales vary per rubric
 * (pass/partial/fail/unknown, healthy/degraded/broken/unknown, …) so match by
 * meaning, not by one rubric's vocabulary.
 */
export function ratingTone(rating: string): 'good' | 'mid' | 'bad' | 'unknown' {
  const r = rating.toLowerCase();
  if (['exemplary', 'exceptional', 'pass', 'healthy', 'good', 'yes', 'green'].includes(r)) return 'good';
  if (['partial', 'degraded', 'mixed', 'warn'].includes(r)) return 'mid';
  if (['severe', 'fail', 'broken', 'bad', 'no', 'red'].includes(r)) return 'bad';
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
  const t = useLexicon();
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
      render: ([, entry]) => <>
        {entry.evidence ?? ''}
        {entry.ledgerResult && <MeasurementDetail label="Latest attempt" result={entry.ledgerResult} />}
        {entry.lastMeasurement && <MeasurementDetail label="Last measurement" result={entry.lastMeasurement} />}
        {entry.nextEvidenceAction && <p>Next evidence action: {entry.nextEvidenceAction}</p>}
      </>,
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
            <dt style={{ opacity: 0.65 }}>Source {t('pot', { lower: true })}</dt>
            <dd>{scorecard.sourceHive}</dd>
          </>
        )}
        <dt style={{ opacity: 0.65 }}>Score</dt>
        <dd title="Read-time 0–10 projection (scale-aware: 3-level pass=10/partial=5/fail=0; extended exemplary=10/pass=8/partial=5/fail=2/severe=0; unknown excluded) — grading stays categorical">
          {scorecard.score10 !== null ? `${scorecard.score10} / 10` : '— (no mappable ratings)'}
        </dd>
        <dt style={{ opacity: 0.65 }}>Rating keys</dt>
        <dd>
          {complete
            ? `${scorecard.nKeys} present · 0 missing`
            : scorecard.rubricResolved
              ? `incomplete — ${scorecard.missingKeys.length} unrated: ${scorecard.missingKeys.join(', ')}`
              : `rubric unresolved — ${scorecard.nKeys} rated (completeness unverifiable)`}
        </dd>
        <dt style={{ opacity: 0.65 }}>Assessment</dt>
        <dd><ScorecardCoverageSummary scorecard={scorecard} /></dd>
        <dt style={{ opacity: 0.65 }}>Integrity audit</dt>
        <dd>{scorecard.gradingAudit?.state ?? 'Not recorded'}</dd>
        <dt style={{ opacity: 0.65 }}>Eligibility</dt>
        <dd>{scorecard.exclusionReasons?.length ? `Excluded: ${scorecard.exclusionReasons.join(', ')}`
          : scorecard.exclusionReasons ? 'Settled history eligibility passed' : 'Not recorded'}</dd>
        <dt style={{ opacity: 0.65 }}>Author verdict</dt>
        <dd>{scorecard.acceptance?.verdict ?? 'Not recorded'}</dd>
        {scorecard.linkedItems && scorecard.linkedItems.length > 0 && (
          <>
            <dt style={{ opacity: 0.65 }}>Linked items</dt>
            <dd>
              {scorecard.linkedItems.map((l, i) => (
                <span key={`${l.rel}:${l.dst.kind}:${l.dst.ref}`}>
                  {i > 0 && ', '}
                  <span style={{ opacity: 0.65 }}>{l.rel}</span> {l.dst.ref}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>

      {scorecard.evidenceActions && scorecard.evidenceActions.length > 0 && (
        <section aria-label="Next evidence actions">
          <h3>Next evidence actions</h3>
          <ul>{scorecard.evidenceActions.map(action => (
            <EvidenceActionDetail key={`${action.criterionKey}:${action.context.rubricRevision}:${action.context.criteriaHash}`} action={action} />
          ))}</ul>
          {(scorecard.omittedActionCount ?? 0) > 0 && <p>{scorecard.omittedActionCount} more criterion actions in the full evidence read.</p>}
        </section>
      )}

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
