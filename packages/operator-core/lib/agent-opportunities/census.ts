/** Five-family pass on the existing SQL census cadence; only minimized diagnostics are persisted. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getOrgPg } from '@papercusp/db-org';
import { getBuildInfo } from '../build-info';
import type { SqlMiningOptions, SqlMiningResult } from '../bash-substitution/sql-tool-candidates';
import type { SqlCorpusCursor, SqlDemandAggregate, SqlDemandObservation } from '../bash-substitution/sql-intent-corpus';
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
/** No examples, actor IDs, paths, request text or transcript locations in 120-day rows.
 * These are internal evidence pointers, not an independent grant to read a source.
 */
interface CandidateEvidence {
  id: string; sourceRefs: string[]; operationRefs: string[];
  metrics: Record<string, number>; reviewEligible: boolean;
}
function identityIndex(rows: readonly { sourceToken: string; operationToken: string | null }[]) {
  const bySource = new Map<string, Set<string>>(), byOperation = new Map<string, Set<string>>();
  for (const row of rows) if (row.operationToken) {
    const operations = bySource.get(row.sourceToken) ?? new Set<string>();
    operations.add(row.operationToken); bySource.set(row.sourceToken, operations);
    const sources = byOperation.get(row.operationToken) ?? new Set<string>();
    sources.add(row.sourceToken); byOperation.set(row.operationToken, sources);
  }
  return (refs: string[]) => {
    const sources = new Set(refs), operations = new Set(refs.flatMap(r => [...bySource.get(r) ?? []]));
    // Include every contributing copy: deduplication cannot discard its authority.
    for (const op of operations) for (const source of byOperation.get(op) ?? []) sources.add(source);
    return { sourceRefs: [...sources].sort(), operationRefs: [...operations].sort() };
  };
}
const runtimeId = `${hostname()}:${process.pid}:${Math.round(Date.now() - process.uptime() * 1000)}`;
const positive = (value: number | undefined, fallback: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value!))) : fallback;

/** Drain one fixed window before grouping: page boundaries are not episode boundaries.
 * Exhausting the ledger window does not establish retention or provider completeness.
 * Check cancellation between pages so a timed-out family cannot keep scanning in the background.
 */
async function drainWindow<T, C extends { scanned: number; denied: number }>(
  fetch: (page: { after?: SqlCorpusCursor; limit: number }) => Promise<{
    observations: T[]; next: SqlCorpusCursor | null; coverage: C;
  }>, pageSize: number, rowCap: number, deadline: number, cancelled: () => boolean,
) {
  const observations: T[] = [], visited = new Set<string>();
  let after: SqlCorpusCursor | undefined, scanned = 0, denied = 0, pages = 0;
  let lastCoverage: C;
  // Native cells carry the conservative strongest observed status across pages;
  // a later empty page must not erase evidence or a truncation from an earlier page.
  const matrix = new Map<string, { provider: string; kind: string; source: string; status: string }>();
  const severity: Record<string, number> = { missing: 0, unsupported: 1, measured: 2, truncated: 3 };
  for (;;) {
    if (cancelled() || Date.now() >= deadline) throw new Error('sql_mining_time_budget');
    const limit = Math.min(pageSize, rowCap - scanned);
    const page = await fetch({ after, limit });
    if (cancelled() || Date.now() >= deadline) throw new Error('sql_mining_time_budget');
    if (!Number.isSafeInteger(page.coverage.scanned) || page.coverage.scanned < 0 || page.coverage.scanned > limit
      || !Number.isSafeInteger(page.coverage.denied) || page.coverage.denied < 0
      || page.coverage.denied > page.coverage.scanned) throw new Error('sql_mining_window_cap');
    observations.push(...page.observations);
    scanned += page.coverage.scanned; denied += page.coverage.denied; pages++; lastCoverage = page.coverage;
    if ('matrix' in page.coverage && Array.isArray(page.coverage.matrix)) {
      for (const cell of page.coverage.matrix) {
        const key = JSON.stringify([cell.provider, cell.kind, cell.source]), prior = matrix.get(key);
        if (!prior || (severity[cell.status] ?? 0) > (severity[prior.status] ?? 0)) matrix.set(key, cell);
      }
    }
    if (page.next) {
      const key = JSON.stringify(page.next);
      if (!page.coverage.scanned || visited.has(key)) throw new Error('sql_mining_window_cap');
      visited.add(key);
    }
    if (!page.next || scanned >= rowCap) return { observations, next: page.next,
      coverage: { ...lastCoverage, ...(matrix.size ? { matrix: [...matrix.values()] } : {}),
        scanned, denied, pages, windowExhausted: !page.next,
        stop: page.next ? 'row-cap' as const : 'window-exhausted' as const } };
    after = page.next;
  }
}
export async function runMonitoredCensus(opts: SqlMiningOptions & { routineId?: string; workflowId?: string },
  sqlStage: () => Promise<SqlMiningResult>, deps: Parameters<typeof productionOpportunityReaders>[1] = {}) {
  const sql = opts.client ?? getOrgPg().sql, scopeId = miningScopeId(opts.scope, opts.harnessSlug);
  if (opts.workspaceId !== opts.scope.workspaceId) throw new Error('invalid_sql_mining_scope');
  const hex = createHash('sha256').update(JSON.stringify([opts.workspaceId, opts.workflowId])).digest('hex');
  const runId = opts.workflowId ? hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5') : randomUUID();
  const started = new Date().toISOString(), now = opts.now ?? Date.now();
  const readers = productionOpportunityReaders({ ...opts, sourceBoundary: opts.scope.sourceBoundary }, deps);
  const common = { ...opts, since: new Date(now - 7 * 86400_000).toISOString(), until: new Date(now).toISOString(),
    authorizeSource: readers.authorizeLedgerSource,
    readOutput: readers.readOutput };
  const candidate = (family: MonitoredFamily, identity: unknown, refs: { sourceRefs: string[]; operationRefs: string[] },
    metrics: Record<string, number>, reviewEligible = false): CandidateEvidence => {
    if (!refs.sourceRefs.length || [...refs.sourceRefs, ...refs.operationRefs].some(t => !/^[a-f0-9]{64}$/.test(t))
      || Object.values(metrics).some(n => !Number.isFinite(n) || n < 0)) throw new Error('sql_mining_source_missing');
    return { id: createHmac('sha256', opts.scope.key)
      .update(JSON.stringify(['monitored-candidate-v1', scopeId, family, identity])).digest('hex'),
    ...refs, metrics, reviewEligible };
  };
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
  const budget = positive(opts.timeBudgetMs, 5000, 30_000);
  const pageSize = positive(opts.rowBudget, 250, 2000), rowCap = positive(opts.windowRowBudget, 20_000, 100_000);
  const measure = async (family: MonitoredFamily, work: (deadline: number, cancelled: () => boolean) => Promise<FamilyMeasurement>): Promise<FamilyMeasurement> => {
    let cancelled = false;
    try { return await boundedStage(() => work(Date.now() + budget, () => cancelled), budget); }
    catch (error) { return { family, coverage: 'UNKNOWN', scanned: 0, qualifying: 0,
      diagnostics: { stage: 'source', reason: miningFailureReason(error), reviewEligible: false, candidates: [] } }; }
    finally { cancelled = true; }
  };
  const families = await Promise.all([
    measure('sql', async () => {
      const result = await sqlStage();
      if (result.status !== 'ok') return { family: 'sql', coverage: 'UNKNOWN', scanned: result.rows, qualifying: 0,
        diagnostics: { stage: result.stage, reason: result.reason ?? 'unknown', reviewEligible: false, candidates: [] } };
      const [row] = await sql<{ summary: SqlDemandAggregate; source_tokens: string[]; revision_token: string }[]>`
        SELECT summary,source_tokens,revision_token FROM harness_shared.sql_intent_history
        WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId} AND ran_on=${new Date(now).toISOString().slice(0,10)}::date`;
      const coverage = result.more ? 'truncated' : row?.summary.coverage.status === 'complete' ? 'measured' : 'UNKNOWN';
      const sources = row ? await sql<{ observation: SqlDemandObservation }[]>`SELECT observation
        FROM harness_shared.sql_intent_operations WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId}
        AND source_token=ANY(${row.source_tokens}::text[])` : [];
      if (row) {
        const [current] = await sql`SELECT 1 FROM harness_shared.sql_intent_history
          WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId}
          AND ran_on=${new Date(now).toISOString().slice(0,10)}::date AND revision_token=${row.revision_token}`;
        if (!current || sources.length !== row.source_tokens.length) throw new Error('sql_mining_source_missing');
      }
      const observationsByCandidate = new Map<string, SqlDemandObservation[]>();
      for (const { observation: o } of sources) if (o.intent.status === 'supported') {
        const key = JSON.stringify([o.workspaceToken, o.harnessToken, o.boundaryToken, o.intent.version, o.intent.fingerprint]);
        const rows = observationsByCandidate.get(key) ?? []; rows.push(o); observationsByCandidate.set(key, rows);
      }
      const identities = identityIndex(sources.map(s => s.observation));
      const ranked = row ? rankSqlToolCandidates(row.summary).candidates : [];
      const candidates = ranked.map(c => {
        const observations = observationsByCandidate.get(c.id) ?? [];
        return candidate('sql', c.id, identities(observations.map(o => o.sourceToken)),
          { successful: c.counts.ok, error: c.counts.error, refused: c.counts.refused, unknown: c.counts.unknown,
            verifiedAgents: c.verifiedAgents, activeDays: c.activeDays.length }, c.eligible && coverage === 'measured');
      });
      return { family: 'sql', coverage, scanned: result.rows,
        qualifying: ranked.filter(c => c.eligible).length,
        diagnostics: { stage: result.stage, logicalCalls: result.logicalCalls ?? null, reviewEligible: coverage === 'measured',
          candidates, sourceRevision: row?.revision_token ?? null } };
    }),
    measure('search-reformulation', async (deadline, cancelled) => {
      const page = await drainWindow(p => fetchSearchReformulations({ ...common, ...p }), pageSize, rowCap, deadline, cancelled);
      const grouped = groupSearchReformulations(page.observations);
      const identities = identityIndex(page.observations);
      const chains = grouped.chains.filter(c => c.reformulations > 0 || c.fallbacks > 0);
      return { family: 'search-reformulation', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: chains.length,
        diagnostics: { sourceCoverage: page.coverage, collisions: grouped.collisions, reviewEligible: false,
          candidates: chains.map(c => candidate('search-reformulation', [c.scopeToken, c.id],
            identities(c.operations.map(o => o.sourceToken)),
            { logicalDemand: c.operations.length, reformulations: c.reformulations, fallbacks: c.fallbacks })) } };
    }),
    measure('result-recovery', async (deadline, cancelled) => {
      const page = await drainWindow(p => fetchResultRecovery({ ...common, ...p }), pageSize, rowCap, deadline, cancelled);
      const grouped = rankResultRecovery(page.observations);
      const identities = identityIndex(page.observations);
      const exposureSources = new Map<string, string[]>();
      for (const o of grouped.operations) {
        const key = JSON.stringify([o.scopeToken, o.tool]), sources = exposureSources.get(key) ?? [];
        sources.push(o.sourceToken); exposureSources.set(key, sources);
      }
      return { family: 'result-recovery', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: grouped.rankings.length, diagnostics: { sourceCoverage: page.coverage,
          collisions: grouped.collisions, evidenceGaps: grouped.evidenceGaps, reviewEligible: false,
          candidates: grouped.rankings.map(c => candidate('result-recovery', [c.scopeToken, c.tool],
            identities([...(exposureSources.get(JSON.stringify([c.scopeToken, c.tool])) ?? []),
              ...c.episodes.flatMap(e => e.sourceRefs)]),
            { exposure: c.exposure, recoveryEpisodes: c.recoveryEpisodes, extraCalls: c.extraCalls, successful: c.successEpisodes })) } };
    }),
    measure('workaround-funnel', async (deadline, cancelled) => {
      const page = await drainWindow(p => fetchWorkaroundFunnels({ ...common, ...p }), pageSize, rowCap, deadline, cancelled);
      const grouped = rankWorkarounds(page.observations);
      const identities = identityIndex(page.observations);
      return { family: 'workaround-funnel', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: grouped.rankings.length, diagnostics: { sourceCoverage: page.coverage,
          collisions: grouped.collisions, evidenceGaps: grouped.evidenceGaps, reviewEligible: false,
          candidates: grouped.rankings.map(c => candidate('workaround-funnel', [c.scopeToken, c.tool, c.repair],
            identities(c.episodes.flatMap(e => e.operations.map(o => o.sourceToken))),
            { successfulEpisodes: c.successfulEpisodes, extraCalls: c.extraCalls, elapsedMs: c.elapsedMs })) } };
    }),
    measure('native-operation', async (deadline, cancelled) => {
      const page = await drainWindow(p => fetchNativeOperations({ ...common, ...p, authorizeSource: readers.authorizeActivitySource,
        readTranscript: readers.readTranscript }), pageSize, rowCap, deadline, cancelled);
      const grouped = groupNativeOperations(page.observations);
      return { family: 'native-operation', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: grouped.chains.length, diagnostics: { sourceCoverage: page.coverage,
          collisions: grouped.collisions, evidenceGaps: grouped.evidenceGaps, reviewEligible: false,
          candidates: grouped.chains.map(c => candidate('native-operation', [c.scopeToken, c.kind, c.id],
            { sourceRefs: c.sourceRefs, operationRefs: [...new Set(c.operationRefs)].sort() },
            { logicalDemand: c.logicalDemand, successful: c.successCount, unknown: c.unknownCount })) } };
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
