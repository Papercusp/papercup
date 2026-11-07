import type { ScorecardRow } from '../../app/_components/ScorecardDetail';

const comparisonTime = '2026-11-01T12:01:00.001Z';
const measured = { testRunId: 1, value: 840, unit: 'ms', status: 'pass' as const,
  finishedAt: '2026-11-01T12:00:00Z', ageMs: 60_001, freshness: 'stale' as const, comparisonTime };
const base: ScorecardRow = { issueId: 'older-accepted', rubricRef: 'grading-history-browser',
  createdAt: '2026-10-01T12:00:00Z', createdBy: 'fixture-author', nKeys: 2,
  missingKeys: [], rubricResolved: true, score10: 10, exclusionReasons: [],
  ratings: { latency: { rating: 'healthy', evidence: 'Retained historical measurement.' },
    manual: { rating: 'unknown', evidence: 'Manual method has not been applied.', nextEvidenceAction: 'Read the declared manual source.' } },
  gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: '2026-10-01T12:00:00Z' } };
const pending: ScorecardRow = { ...base, issueId: 'newer-pending', createdAt: '2026-11-01T12:00:31Z', score10: null,
  exclusionReasons: ['grading-audit-pending'],
  gradingAudit: { ...base.gradingAudit!, state: 'pending' },
  ratings: { ...base.ratings, latency: { rating: 'unknown', evidence: 'Latest collection failed.',
    nextEvidenceAction: 'Repair the collection check.', lastMeasurement: measured,
    ledgerResult: { ...measured, testRunId: 2, value: null, status: 'error',
      finishedAt: '2026-11-01T12:00:30Z', ageMs: 30_001, freshness: 'failed' } } } };
const failed = { ...pending, issueId: 'newer-review-failed',
  gradingAudit: { ...pending.gradingAudit!, state: 'failed' as const }, exclusionReasons: ['grading-audit-failed'] };
const first = [pending, failed].map(card => ({ ...card, _meta: { nextCursor: 'older-page', hasMore: true } }));
const older = [
  { ...pending, issueId: 'stale-history', exclusionReasons: ['grading-audit-stale'] },
  { ...pending, issueId: 'unreviewed-history', gradingAudit: undefined, exclusionReasons: ['grading-audit-missing'] },
  { ...pending, issueId: 'diagnostic-history', exclusionReasons: ['diagnostic'] }, base,
].map(card => ({ ...card, _meta: { nextCursor: null, hasMore: false } }));
const accepted = [base];
const summary = [{ total: 6, matched: 6, facets: [], selection: [] }];
const trend = [{ rubricRef: base.rubricRef, scorecardCount: 1, sample: { inputCount: 1, limit: 500 },
  window: {}, criteria: [], status: 'active' }];
export const requests: Array<{ queryName: string; args: Record<string, unknown> }> = [];
Object.assign(window, { __gradingHistoryRequests: requests });

export function useSyncQuery({ queryName, args }: { queryName: string; args: Record<string, unknown> }) {
  requests.push({ queryName, args });
  const data = queryName === 'rubrics.trend' ? trend : queryName === 'scorecards.summary' ? summary
    : args.mode === 'accepted' ? accepted : args.cursor ? older : first;
  return { data, loading: false, fetching: false, error: null };
}
export const useLexicon = () => (term: string) => term;
export async function callTool() { throw new Error('This browser fixture does not collect or publish evidence.'); }
