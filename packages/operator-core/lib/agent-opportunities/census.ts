/** Five-family pass on the existing SQL census cadence; only minimized diagnostics are persisted. */
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getOrgPg } from '@papercusp/db-org';
import { getBuildInfo } from '../build-info';
import type { SqlMiningOptions, SqlMiningResult } from '../bash-substitution/sql-tool-candidates';
import type { SqlDemandAggregate } from '../bash-substitution/sql-intent-corpus';
import { rankSqlToolCandidates } from '../sql-tool-candidate-score';
import { AGGREGATE_LIFETIME_DAYS, miningScopeId } from './privacy';
import { boundedStage, miningFailureReason, MONITORED_FAMILIES, type MonitoredFamily } from './pipeline';
import { productionOpportunityReaders } from './source-readers';
import { fetchSearchReformulations, groupSearchReformulations } from './search-reformulation';
import { fetchResultRecovery, rankResultRecovery } from './result-recovery';
import { fetchWorkaroundFunnels, rankWorkarounds } from './workaround-funnel';
import { fetchNativeOperations, groupNativeOperations } from './native-operation';

export interface FamilyMeasurement {
  family: MonitoredFamily; coverage: 'measured' | 'missing' | 'unsupported' | 'truncated' | 'UNKNOWN';
  scanned: number; qualifying: number; diagnostics: Record<string, unknown>;
}
const runtimeId = `${hostname()}:${process.pid}:${Math.round(Date.now() - process.uptime() * 1000)}`;
export async function runMonitoredCensus(opts: SqlMiningOptions & { routineId?: string; workflowId?: string },
  sqlStage: () => Promise<SqlMiningResult>, deps: Parameters<typeof productionOpportunityReaders>[1] = {}) {
  const sql = opts.client ?? getOrgPg().sql, scopeId = miningScopeId(opts.scope, opts.harnessSlug);
  if (opts.workspaceId !== opts.scope.workspaceId) throw new Error('invalid_sql_mining_scope');
  const hex = createHash('sha256').update(JSON.stringify([opts.workspaceId, opts.workflowId])).digest('hex');
  const runId = opts.workflowId ? hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5') : randomUUID();
  const started = new Date().toISOString(), now = opts.now ?? Date.now();
  const readers = productionOpportunityReaders({ ...opts, sourceBoundary: opts.scope.sourceBoundary }, deps);
  const common = { ...opts, since: new Date(now - 7 * 86400_000).toISOString(), until: new Date(now).toISOString(),
    limit: Math.min(2000, Math.max(1, opts.rowBudget ?? 250)), authorizeSource: readers.authorizeLedgerSource,
    readOutput: readers.readOutput };
  await sql`INSERT INTO harness_shared.sql_intent_runs
    (workspace_id,run_id,scope_id,harness_slug,routine_id,workflow_id,source_sha,runtime_id,started_at)
    VALUES (${opts.workspaceId},${runId}::uuid,${scopeId},${opts.harnessSlug},${opts.routineId ?? null},
      ${opts.workflowId ?? null},${getBuildInfo().sha},${runtimeId},${started}::timestamptz)
    ON CONFLICT (workspace_id,run_id) DO NOTHING`;
  const [identity] = await sql`SELECT source_sha,runtime_id,scope_id,harness_slug,finished_at
    FROM harness_shared.sql_intent_runs WHERE workspace_id=${opts.workspaceId} AND run_id=${runId}::uuid`;
  if (!identity || identity.runtime_id !== runtimeId || identity.source_sha !== getBuildInfo().sha
    || identity.scope_id !== scopeId || identity.harness_slug !== opts.harnessSlug || identity.finished_at)
    throw new Error('sql_mining_run_identity_or_replay');
  const measure = async (family: MonitoredFamily, work: () => Promise<FamilyMeasurement>): Promise<FamilyMeasurement> => {
    try { return await boundedStage(work, Math.min(30_000, Math.max(1, opts.timeBudgetMs ?? 5000))); }
    catch (error) { return { family, coverage: 'UNKNOWN', scanned: 0, qualifying: 0,
      diagnostics: { stage: 'source', reason: miningFailureReason(error), reviewEligible: false } }; }
  };
  const families = await Promise.all([
    measure('sql', async () => {
      const result = await sqlStage();
      if (result.status !== 'ok') return { family: 'sql', coverage: 'UNKNOWN', scanned: result.rows, qualifying: 0,
        diagnostics: { stage: result.stage, reason: result.reason ?? 'unknown', reviewEligible: false } };
      const [row] = await sql<{ summary: SqlDemandAggregate }[]>`SELECT summary FROM harness_shared.sql_intent_history
        WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId} AND ran_on=${new Date(now).toISOString().slice(0,10)}::date`;
      const coverage = result.more ? 'truncated' : row?.summary.coverage.status === 'complete' ? 'measured' : 'UNKNOWN';
      return { family: 'sql', coverage, scanned: result.rows,
        qualifying: row ? rankSqlToolCandidates(row.summary).candidates.filter(c => c.eligible).length : 0,
        diagnostics: { stage: result.stage, logicalCalls: result.logicalCalls ?? null, reviewEligible: coverage === 'measured' } };
    }),
    measure('search-reformulation', async () => {
      const page = await fetchSearchReformulations(common), grouped = groupSearchReformulations(page.observations);
      return { family: 'search-reformulation', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: grouped.chains.filter(c => c.reformulations > 0 || c.fallbacks > 0).length,
        diagnostics: { sourceCoverage: page.coverage, collisions: grouped.collisions, reviewEligible: false } };
    }),
    measure('result-recovery', async () => {
      const page = await fetchResultRecovery(common), grouped = rankResultRecovery(page.observations);
      return { family: 'result-recovery', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: grouped.rankings.length, diagnostics: { sourceCoverage: page.coverage,
          collisions: grouped.collisions, evidenceGaps: grouped.evidenceGaps, reviewEligible: false } };
    }),
    measure('workaround-funnel', async () => {
      const page = await fetchWorkaroundFunnels(common), grouped = rankWorkarounds(page.observations);
      return { family: 'workaround-funnel', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: grouped.rankings.length, diagnostics: { sourceCoverage: page.coverage,
          collisions: grouped.collisions, evidenceGaps: grouped.evidenceGaps, reviewEligible: false } };
    }),
    measure('native-operation', async () => {
      const page = await fetchNativeOperations({ ...common, authorizeSource: readers.authorizeActivitySource,
        readTranscript: readers.readTranscript }), grouped = groupNativeOperations(page.observations);
      return { family: 'native-operation', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: grouped.chains.length, diagnostics: { sourceCoverage: page.coverage,
          collisions: grouped.collisions, evidenceGaps: grouped.evidenceGaps, reviewEligible: false } };
    }),
  ]);
  await sql.begin(async tx => {
    for (const row of families) await tx`INSERT INTO harness_shared.sql_intent_family_runs
      (workspace_id,run_id,family,coverage,scanned,qualifying,diagnostics)
      VALUES (${opts.workspaceId},${runId}::uuid,${row.family},${row.coverage},${row.scanned},${row.qualifying},
        ${JSON.stringify(row.diagnostics)}::jsonb)
      ON CONFLICT (workspace_id,run_id,family) DO UPDATE SET coverage=EXCLUDED.coverage,
        scanned=EXCLUDED.scanned,qualifying=EXCLUDED.qualifying,diagnostics=EXCLUDED.diagnostics`;
    await tx`UPDATE harness_shared.sql_intent_runs SET finished_at=now()
      WHERE workspace_id=${opts.workspaceId} AND run_id=${runId}::uuid`;
    await tx`DELETE FROM harness_shared.sql_intent_runs WHERE workspace_id=${opts.workspaceId}
      AND started_at < now() - ${AGGREGATE_LIFETIME_DAYS} * interval '1 day'`;
  });
  return { runId, families, coverage: { population: [...MONITORED_FAMILIES],
    checked: families.filter(f => f.coverage === 'measured').map(f => f.family),
    notChecked: families.filter(f => f.coverage !== 'measured').map(f => f.family),
    notApplicable: [], residue: families.filter(f => f.coverage !== 'measured').map(f => `${f.family}:${f.coverage}`) } };
}
