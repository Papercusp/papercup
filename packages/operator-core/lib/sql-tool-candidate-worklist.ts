/** P008: passive pull worklist. Nothing from this read is persisted or executed. */
import { getOrgPg } from '@papercusp/db-org';
import { isDeepStrictEqual } from 'node:util';
import { readSqlCandidates, type SqlCandidateReadOptions } from './bash-substitution/sql-tool-candidates';
import { fingerprintSqlIntent } from './bash-substitution/sql-intent-fingerprint';
import { recommendSqlTool, type SqlRecommendationInput, type SqlToolRecommendation } from './bash-substitution/sql-tool-recommendations';
import { miningScopeId } from './agent-opportunities/privacy';
import { rankSqlToolCandidates, type SqlToolCandidateScore } from './sql-tool-candidate-score';
import { sqlCandidateReviewIdentity, submitSqlCandidateReview, type SqlCandidateReviewDeps,
  type SqlCandidateReviewInput } from './sql-tool-candidate-review';

export interface SqlCandidateDecisionRef {
  editionId: string;
  workItemId: string;
  suppressed: boolean;
  createdAt: string;
}
export interface SqlCandidateWorklistEntry {
  candidate: SqlToolCandidateScore;
  sourceRef: { scopeId: string; ranOn: string };
  evidenceRefs: Array<{ kind: 'tool-invocation'; id: string }>;
  evidenceRefsOmitted: number;
  decisionHistory: SqlCandidateDecisionRef[];
  decisionHistoryTruncated: boolean;
  /** Ephemeral result of existing exact/partial contract audits; never a recipe
   * execution certificate. Private SQL, arguments and audit inputs stay local. */
  recommendation?: SqlToolRecommendation;
}
export interface SqlCandidateWorklist {
  status: 'ok' | 'UNKNOWN';
  candidates: SqlCandidateWorklistEntry[];
  population: { candidates: number; returned: number; omitted: number; snapshotCap: 120 };
  snapshots: Array<{ ranOn: string; coverage: ReturnType<typeof rankSqlToolCandidates>['coverage'];
    residue: ReturnType<typeof rankSqlToolCandidates>['residue'] }>;
}
export type SqlCandidateWorklistOptions = SqlCandidateReadOptions & {
  limit?: number;
  /** Internal exact candidate selection; authority still covers the contributing snapshot. */
  candidateId?: string;
  /** Trusted host composition, never accepted from tool arguments. The host
   * supplies current/served contracts and maintained audits from their sources. */
  recommendationInput?: (candidate: SqlToolCandidateScore,
    opts: SqlCandidateReadOptions) => Promise<SqlRecommendationInput | null>;
};
export interface SqlCandidateWorklistDeps {
  read?: typeof readSqlCandidates;
  /** Receives the caller's read options too, so an injected history can stay scope-aware like the default. */
  history?: (candidate: SqlToolCandidateScore, opts: SqlCandidateWorklistOptions) => Promise<SqlCandidateDecisionRef[]>;
}
const empty = (): SqlCandidateWorklist => ({ status: 'UNKNOWN', candidates: [], snapshots: [],
  population: { candidates: 0, returned: 0, omitted: 0, snapshotCap: 120 } });

/** Scope/ACL misses and dependency failures share one content-free answer. No denied counts. */
export async function readSqlToolCandidateWorklist(opts: SqlCandidateWorklistOptions,
  deps: SqlCandidateWorklistDeps = {}): Promise<SqlCandidateWorklist> {
  const limit = opts.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_sql_worklist_limit');
  try {
    const snapshots = await (deps.read ?? readSqlCandidates)(opts);
    if (!snapshots.length) return empty();
    const entries = new Map<string, SqlCandidateWorklistEntry>();
    const coverage: SqlCandidateWorklist['snapshots'] = [];
    for (const snapshot of snapshots) {
      const ranked = rankSqlToolCandidates(snapshot.summary);
      coverage.push({ ranOn: snapshot.ranOn, coverage: ranked.coverage, residue: ranked.residue });
      for (const candidate of ranked.candidates) {
        // Newest authorized snapshot wins; overlapping rolling windows never add demand.
        if (entries.has(candidate.id)) continue;
        entries.set(candidate.id, { candidate,
          sourceRef: { scopeId: miningScopeId(opts.scope, opts.harnessSlug), ranOn: snapshot.ranOn },
          evidenceRefs: snapshot.sourceIds.slice(0, 100).map(id => ({ kind: 'tool-invocation' as const, id })),
          evidenceRefsOmitted: Math.max(0, snapshot.sourceIds.length - 100),
          decisionHistory: [], decisionHistoryTruncated: false });
      }
    }
    const selected = [...entries.values()].filter(entry => !opts.candidateId || entry.candidate.id === opts.candidateId)
      .sort((a, b) => b.candidate.score - a.candidate.score
      || a.candidate.id.localeCompare(b.candidate.id)).slice(0, limit);
    const recommendationInputs = new Map<string, SqlRecommendationInput | null>();
    for (const entry of selected) {
      const history = deps.history ? await deps.history(entry.candidate, opts) : await readHistory(opts, entry.candidate);
      entry.decisionHistory = history.slice(0, 20);
      entry.decisionHistoryTruncated = history.length > 20;
      if (opts.recommendationInput) recommendationInputs.set(entry.candidate.id,
        await opts.recommendationInput(entry.candidate, opts));
    }
    // Derivation/history reads may take time. Resolve the contributing sources again
    // before releasing counts, membership, decisions or refs to the caller.
    const current = await (deps.read ?? readSqlCandidates)(opts);
    if (snapshots.some(snapshot => !current.some(row => row.ranOn === snapshot.ranOn
      && JSON.stringify(row.sourceIds) === JSON.stringify(snapshot.sourceIds)
      && JSON.stringify(row.summary) === JSON.stringify(snapshot.summary)))) return empty();
    for (const entry of selected) {
      if (!recommendationInputs.has(entry.candidate.id)) continue;
      const unavailable = (): SqlToolRecommendation => ({ kind: 'insufficient-evidence',
        reason: 'source-unavailable', toolName: null, immediatelyCallable: false,
        fingerprint: null, requiredFeatures: null, evidenceRefs: [], missingFeatures: [] });
      const input = recommendationInputs.get(entry.candidate.id);
      const snapshot = current.find(row => row.ranOn === entry.sourceRef.ranOn);
      if (!input || !snapshot || miningScopeId(input.scope, opts.harnessSlug) !== entry.sourceRef.scopeId) {
        entry.recommendation = unavailable(); continue;
      }
      const shape = fingerprintSqlIntent(input.sql, opts.scope, input.sourceCoverage);
      // A neighboring shape, foreign key/epoch or expired private example cannot
      // borrow this candidate's demand/history or a different shape's audit.
      if (shape.status !== 'supported' || shape.fingerprint !== entry.candidate.fingerprint
        || shape.version !== entry.candidate.parserVersion || !snapshot.examples.some(example => {
          if (!example || typeof example !== 'object') return false;
          const saved = example as { canonical?: unknown; features?: unknown };
          return saved.canonical === shape.canonical && isDeepStrictEqual(saved.features, shape.features);
        })) { entry.recommendation = unavailable(); continue; }
      entry.recommendation = recommendSqlTool({ ...input, scope: opts.scope, now: opts.now ?? Date.now(),
        sourceCoverage: snapshot.summary.coverage.status === 'complete'
          && snapshot.summary.coverage.retention === 'complete' ? input.sourceCoverage : 'unknown' });
    }
    return { status: 'ok', candidates: selected, snapshots: coverage,
      population: { candidates: entries.size, returned: selected.length,
        omitted: entries.size - selected.length, snapshotCap: 120 } };
  } catch { return empty(); }
}

/** Rehydrate the candidate and recommendation at every intake boundary. Counts
 * and run receipts do not change the edition; contract/decision changes do. */
export async function submitSqlWorklistCandidateReview(opts: SqlCandidateWorklistOptions,
  input: SqlCandidateReviewInput, deps: SqlCandidateReviewDeps & { submit?: typeof submitSqlCandidateReview } = {}) {
  const read = async () => (await readSqlToolCandidateWorklist({ ...opts,
    candidateId: input.candidate.id, limit: 1 })).candidates[0];
  const entry = await read();
  if (!entry) return { ...sqlCandidateReviewIdentity(input), status: 'UNKNOWN' as const,
    workItemId: null, owner: null, queue: null };
  const current = { ...input, candidate: entry.candidate, sourceRef: entry.sourceRef,
    recommendation: entry.recommendation,
    contractRef: entry.recommendation?.contractRef ?? input.contractRef };
  return (deps.submit ?? submitSqlCandidateReview)(current, { ...deps, authorize: async () => {
    if (deps.authorize && !await deps.authorize()) return false;
    const renewed = await read();
    return !!renewed && renewed.sourceRef.scopeId === entry.sourceRef.scopeId
      && renewed.sourceRef.ranOn === entry.sourceRef.ranOn
      && isDeepStrictEqual(renewed.evidenceRefs, entry.evidenceRefs)
      && renewed.evidenceRefsOmitted === entry.evidenceRefsOmitted
      && isDeepStrictEqual(renewed.candidate, entry.candidate)
      && isDeepStrictEqual(renewed.recommendation, entry.recommendation);
  } });
}

async function readHistory(opts: SqlCandidateReadOptions, candidate: SqlToolCandidateScore): Promise<SqlCandidateDecisionRef[]> {
  const { lifecycleId } = sqlCandidateReviewIdentity({ workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug, submittedBy: 'worklist-read', candidate, contractRef: 'identity-only' });
  const sql = opts.client ?? getOrgPg().sql;
  const rows = await sql<{ edition_id: string; artifact_id: string; suppressed: boolean; created_at: Date }[]>`
    SELECT edition_id,artifact_id,suppressed,created_at FROM harness_shared.sql_candidate_reviews
    WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug} AND lifecycle_id=${lifecycleId}
    ORDER BY created_at DESC,edition_id LIMIT 21`;
  return rows.map(row => ({ editionId: row.edition_id, workItemId: row.artifact_id,
    suppressed: row.suppressed, createdAt: new Date(row.created_at).toISOString() }));
}

/** Evidence is hydrated from current source authority, never from a saved worklist packet. */
export async function readSqlToolCandidateEvidence(opts: SqlCandidateReadOptions, candidateId: string) {
  try {
    const snapshots = await readSqlCandidates(opts);
    const snapshot = snapshots.find(row => rankSqlToolCandidates(row.summary).candidates.some(c => c.id === candidateId));
    return snapshot ? { status: 'ok' as const, examples: snapshot.examples,
      evidenceRefs: snapshot.sourceIds.slice(0, 100).map(id => ({ kind: 'tool-invocation' as const, id })),
      evidenceRefsOmitted: Math.max(0, snapshot.sourceIds.length - 100) }
      : { status: 'UNKNOWN' as const, examples: [], evidenceRefs: [], evidenceRefsOmitted: 0 };
  } catch { return { status: 'UNKNOWN' as const, examples: [], evidenceRefs: [], evidenceRefsOmitted: 0 }; }
}
