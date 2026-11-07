/** Production composition for the existing passive worklist. Source SQL is only
 * hydrated behind its current ACL; it is never executed, persisted or returned. */
import { isDeepStrictEqual } from 'node:util';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { listAllProjectedTools, projectedToolRegistryRevision } from '@papercusp/agent-mcp';
import { readServingGeneration } from './serving-generation';
import { compileJsonSchema } from './json-schema-validation';
import { miningScopeId } from './agent-opportunities/privacy';
import { fingerprintSqlIntent, type SqlIntentResult } from './bash-substitution/sql-intent-fingerprint';
import { SQL_CORPUS_TOOL } from './bash-substitution/sql-corpus';
import { DEFAULT_DISPATCHER_TOOLS } from './tool-sequence-patterns';
import { sqlCoverageRows, sqlCoverageToken, sqlToolContractIdentity, type SqlCoverageAudit,
  type SqlToolCatalog } from './bash-substitution/sql-tool-recommendations';
import { loadedHandlerFingerprint, runtimeObservabilityHealth } from './observability/runtime';
import { operatorArtifactSource, type OperatorArtifactIdentity } from './release/operator-artifact';
import type { SqlCandidateWorklistOptions } from './sql-tool-candidate-worklist';
import { parseTestRunExecutionDetails, parseSqlCoverageExecutionReceipt } from '@papercusp/test-config/execution-details';
import { productionOpportunityReaders } from './agent-opportunities/source-readers';
import { isOperatorToolCatalogueLoaded } from './agent-tools/operator-tool-catalogue';

const unknownCatalog = (ref: string): SqlToolCatalog => ({ ref, buildRef: '', coverage: 'unknown', tools: [] });

/** A loaded catalog also describes current source only when its complete build
 * input closure still names the canonical checkout. A dirty tree, new untracked
 * tool, moved submodule or different commit cannot borrow the serving identity.
 * This deliberately remains UNKNOWN for unqualified development processes. */
export async function readCurrentSqlToolCatalog(loaded: SqlToolCatalog, deps: {
  root?: string;
  artifact?: () => OperatorArtifactIdentity | null;
  source?: (root: string) => Promise<string>;
} = {}): Promise<SqlToolCatalog> {
  try {
    const root = deps.root ?? process.env.PAPERCUSP_CANONICAL_TREE;
    const artifact = (deps.artifact ?? (() => runtimeObservabilityHealth().artifact))();
    if (!root || !isAbsolute(root) || await realpath(root) !== resolve(root)
      || loaded.coverage !== 'complete' || artifact?.status !== 'measured'
      || !Object.keys(artifact.sourceBlobs).length) return unknownCatalog('current-source-unmeasured');
    const source = deps.source ?? (async (path: string) => {
      const { stdout } = await promisify(execFile)('git', ['-C', path, 'status', '--porcelain=v1',
        '--untracked-files=all', '--ignore-submodules=none'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      if (stdout) throw Error('current-source-dirty');
      return operatorArtifactSource(path);
    });
    const before = await source(root);
    if (before !== artifact.sourceSha) return unknownCatalog('current-source-build-mismatch');
    for (const [path, expected] of Object.entries(artifact.sourceBlobs)) {
      const file = resolve(root, path), rel = relative(root, file);
      if (!rel || rel.startsWith('../') || isAbsolute(rel) || path.includes('\\')
        || await realpath(file) !== file || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected))
        return unknownCatalog('current-source-input-unmeasured');
      const bytes = await readFile(file);
      const actual = createHash(expected.length === 64 ? 'sha256' : 'sha1')
        .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (actual !== expected) return unknownCatalog('current-source-input-changed');
    }
    const after = await source(root);
    const currentArtifact = (deps.artifact ?? (() => runtimeObservabilityHealth().artifact))();
    const current = await readLoadedSqlToolCatalog();
    if (after !== before || !isDeepStrictEqual(currentArtifact, artifact)
      || current.coverage !== 'complete' || current.ref !== loaded.ref || current.buildRef !== loaded.buildRef)
      return unknownCatalog('current-source-changed');
    return { ...loaded, tools: [...loaded.tools] };
  } catch { return unknownCatalog('current-source-unmeasured'); }
}

/** A catalog is of the LOADED process, not checkout HEAD. Registry, baked code,
 * applied schema and output declarations all contribute to contract identity.
 * A mutation during either async identity read invalidates the entire snapshot. */
export async function readLoadedSqlToolCatalog(deps: {
  list?: typeof listAllProjectedTools;
  generation?: typeof readServingGeneration;
} = {}): Promise<SqlToolCatalog> {
  try {
    if (!isOperatorToolCatalogueLoaded()) return unknownCatalog('loaded-catalog-registration-incomplete');
    const list = deps.list ?? listAllProjectedTools;
    const generation = deps.generation ?? readServingGeneration;
    const tools = [...list()], revision = projectedToolRegistryRevision(tools);
    const before = await generation({ toolRegistryRevision: revision });
    if (before.state !== 'known') return unknownCatalog('loaded-catalog-unmeasured');
    const contracts = tools.flatMap(tool => {
      const name = tool.expose.mcp?.name;
      if (!name) return [];
      // The code SHA identifies builtins. An installed plugin's version alone
      // cannot attest its loaded implementation bytes, so it stays unauditable.
      if (tool.pluginInstallation) return [];
      const validate = compileJsonSchema(tool.discoveryInputSchema ?? tool.inputSchema);
      const contractRef = sqlToolContractIdentity(before.revision, projectedToolRegistryRevision([tool]));
      const sourceFingerprint = loadedHandlerFingerprint(tool.fn as (...args: never[]) => unknown) ?? undefined;
      return [{ name, contractRef, sourceFingerprint,
        args: { safeParse: (value: unknown) => ({ success: validate(value) === true }) } }];
    });
    const afterTools = [...list()], afterRevision = projectedToolRegistryRevision(afterTools);
    const after = await generation({ toolRegistryRevision: afterRevision });
    if (!isOperatorToolCatalogueLoaded() || after.state !== 'known'
      || before.revision !== after.revision || revision !== afterRevision)
      return unknownCatalog('loaded-catalog-changed');
    return { ref: revision, buildRef: before.revision,
      coverage: tools.some(t => t.expose.mcp?.name && t.pluginInstallation) ? 'unknown' : 'complete', tools: contracts };
  } catch { return unknownCatalog('loaded-catalog-unmeasured'); }
}

/** Reconcile bounded fixture hints with the canonical passing run, exact passing
 * case, independently written invocation custody and authorized retained bytes.
 * Missing, stale, contradictory or incomplete evidence supplies no audit. */
export async function readSqlCoverageAudits(opts: SqlCandidateWorklistOptions,
  shape: Extract<SqlIntentResult, { status: 'supported' }>, catalogs: readonly SqlToolCatalog[], deps: {
    readOutput?: ReturnType<typeof productionOpportunityReaders>['readOutput'];
  } = {}): Promise<SqlCoverageAudit[]> {
  const allowed = () => opts.authorize({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
    sourceBoundary: opts.scope.sourceBoundary });
  try {
    if (!await allowed()) return [];
    const sql = opts.client ?? getOrgPg().sql, now = opts.now ?? Date.now();
    if (!Number.isFinite(now)) return [];
    const scopeId = miningScopeId(opts.scope, opts.harnessSlug);
    const featuresToken = sqlCoverageToken(opts.scope, opts.harnessSlug, 'features', shape.features);
    const readOutput = deps.readOutput ?? productionOpportunityReaders({ workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug, sourceBoundary: opts.scope.sourceBoundary,
      client: opts.client, authorize: opts.authorize }).readOutput;
    const runs = await sql`SELECT id, status, source, commit_sha, started_at, finished_at, execution_details
      FROM harness_shared.test_runs WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}
        AND status='pass' AND finished_at>=${new Date(now - 30 * 86400_000)} AND finished_at<=${new Date(now)}
        AND execution_details->'sqlCoverageObservations' @> ${sql.json([{ fingerprint: shape.fingerprint, scopeId }])}::jsonb
      ORDER BY finished_at DESC,id DESC LIMIT 33`;
    if (runs.length > 32) return [];
    const audits: SqlCoverageAudit[] = [];
    for (const run of runs) {
      const details = parseTestRunExecutionDetails(run.execution_details);
      if (run.status !== 'pass' || run.source === 'mutation-probe' || !details || details.failed !== 0
        || details.collectionFailed || details.worktreeDirty || details.passed < 1
        || !['integration', 'e2e'].includes(details.testLayer ?? '')
        || details.workspaceId !== opts.workspaceId || details.harnessSlug !== opts.harnessSlug
        || !details.commitSha || details.commitSha !== run.commit_sha) continue;
      const start = Date.parse(details.runStartedAt ?? String(run.started_at)), end = new Date(run.finished_at).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now) continue;
      for (const hint of details.sqlCoverageObservations ?? []) {
        if (hint.scopeId !== scopeId || hint.fingerprint !== shape.fingerprint || hint.parserVersion !== shape.version
          || hint.featuresToken !== featuresToken) continue;
        const contract = catalogs.filter(c => c.coverage === 'complete').flatMap(c => c.tools)
          .find(t => t.name === hint.toolExecution.toolName && t.contractRef === hint.contractRef);
        if (!contract?.sourceFingerprint || contract.sourceFingerprint !== hint.toolExecution.sourceFingerprint) continue;
        const loadCases = () => sql`SELECT case_key,occurrence,status FROM harness_shared.test_case_runs
          WHERE test_run_id=${run.id} AND case_key=${hint.caseKey} AND occurrence=${hint.occurrence} LIMIT 2`;
        const cases = await loadCases();
        if (cases.length !== 1 || cases[0]!.status !== 'pass') continue;
        const receipts = [hint.sqlExecution, hint.toolExecution];
        if (receipts.some(r => r.workspaceId !== opts.workspaceId || r.harness !== opts.harnessSlug
          || r.startedAt < start || r.endedAt > end || !String(run.commit_sha).startsWith(r.buildSha))) continue;
        const load = () => sql`SELECT id::text,tool_name,status,args_json,output_ref,metadata_json,serving_build_sha
          FROM harness_shared.tool_invocations WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}
            AND invoked_at>=${new Date(start)} AND invoked_at<=${new Date(end)}
            AND metadata_json->'sqlCoverageExecution'->>'callId'=ANY(${receipts.map(r => r.callId)}::text[])
          ORDER BY id LIMIT 3`;
        const invocations = await load();
        if (invocations.length !== 2) continue;
        let args: unknown, valid = true;
        for (const receipt of receipts) {
          const matches = invocations.filter(row => row.metadata_json?.sqlCoverageExecution?.callId === receipt.callId);
          const invocation = matches.length === 1 ? matches[0] : undefined;
          const own = parseSqlCoverageExecutionReceipt(invocation?.metadata_json?.sqlCoverageExecution);
          if (!invocation || !own || !isDeepStrictEqual(own, receipt) || invocation.status !== 'ok'
            || invocation.tool_name !== receipt.toolName || invocation.serving_build_sha !== receipt.buildSha
            || !await opts.authorizeSource(invocation.id)
            || sqlCoverageToken(opts.scope, opts.harnessSlug, 'args', invocation.args_json) !== receipt.argsToken) {
            valid = false; break;
          }
          if (receipt === hint.sqlExecution) {
            const parsed = fingerprintSqlIntent(invocation.args_json?.sql, opts.scope);
            if (parsed.status !== 'supported' || parsed.secretValuesDropped || parsed.fingerprint !== shape.fingerprint
              || parsed.version !== shape.version || !isDeepStrictEqual(parsed.features, shape.features)) { valid = false; break; }
          } else {
            args = invocation.args_json;
            if (!contract.args.safeParse(args).success) { valid = false; break; }
          }
          const output = await readOutput({ id: invocation.id, outputRef: invocation.output_ref,
            tool: invocation.tool_name, metadata: invocation.metadata_json });
          const rows = output?.complete ? sqlCoverageRows(output.body) : null;
          if (!rows || sqlCoverageToken(opts.scope, opts.harnessSlug, 'rows', rows) !== receipt.resultToken) {
            valid = false; break;
          }
        }
        if (!valid || !await allowed()) continue;
        for (const invocation of invocations) if (!await opts.authorizeSource(invocation.id)) valid = false;
        if (!valid || !isDeepStrictEqual(invocations, await load())) continue;
        // Output IO must not retain a pass which the canonical ledger has
        // revoked, replaced or corrected in the meantime.
        const currentRuns = await sql`SELECT id,status,source,commit_sha,started_at,finished_at,execution_details
          FROM harness_shared.test_runs WHERE id=${run.id} AND workspace_id=${opts.workspaceId}
            AND harness_slug=${opts.harnessSlug} LIMIT 2`;
        if (currentRuns.length !== 1 || !isDeepStrictEqual(currentRuns[0], run)
          || !isDeepStrictEqual(await loadCases(), cases) || !await allowed()) continue;
        audits.push({ toolName: hint.toolExecution.toolName, contractRef: hint.contractRef, parserVersion: shape.version,
          fingerprint: shape.fingerprint, requiredFeatures: shape.features, fixtureRef: hint.fixtureRef,
          resultRef: `test-run:${run.id}:case:${hint.occurrence}:${hint.sqlExecution.callId}:${hint.toolExecution.callId}`,
          verdict: hint.verdict, missingFeatures: [...hint.missingFeatures], args });
      }
    }
    return await allowed() ? audits : [];
  } catch { return []; }
}

/** Reuses the corpus' authoritative source rows and retained example lifetime.
 * The bound is explicit: failure to find an example is UNKNOWN, never noncoverage.
 * No historical regex/table-pair verdict is promoted to an executed shape audit. */
export const productionSqlRecommendationInput: NonNullable<SqlCandidateWorklistOptions['recommendationInput']> =
  async (candidate, opts, snapshot) => {
    const allowed = () => opts.authorize({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
      sourceBoundary: opts.scope.sourceBoundary });
    try {
      if (!await allowed() || opts.workspaceId !== opts.scope.workspaceId || !snapshot.sourceIds.length) return null;
      const sql = opts.client ?? getOrgPg().sql, now = opts.now ?? Date.now();
      // Source ACL is checked before reading args, including custom per-source grants.
      for (const id of snapshot.sourceIds) if (!await opts.authorizeSource(id)) return null;
      const rows = await sql<{ id: string; query: string | null; example: unknown; expires_at: Date }[]>`
        SELECT i.id::text,
          CASE WHEN i.tool_name=${SQL_CORPUS_TOOL} THEN i.args_json->>'sql'
            ELSE i.args_json->'args'->>'sql' END AS query,e.example,e.expires_at
        FROM harness_shared.sql_intent_operations o
        JOIN harness_shared.sql_intent_examples e USING (workspace_id,scope_id,source_token)
        JOIN harness_shared.tool_invocations i ON i.id=o.source_id AND i.workspace_id=o.workspace_id
          AND i.harness_slug=${opts.harnessSlug}
        WHERE o.workspace_id=${opts.workspaceId} AND o.scope_id=${miningScopeId(opts.scope, opts.harnessSlug)}
          AND o.source_id=ANY(${snapshot.sourceIds}::bigint[])
          AND o.observation->'intent'->>'fingerprint'=${candidate.fingerprint}
          AND e.expires_at>${new Date(now).toISOString()}::timestamptz
          AND COALESCE(i.args_json->>'_truncated','false')='false'
          AND (i.tool_name=${SQL_CORPUS_TOOL} OR (i.tool_name=ANY(${[...DEFAULT_DISPATCHER_TOOLS]}::text[])
            AND i.args_json->>'name'=${SQL_CORPUS_TOOL}))
        ORDER BY o.source_token LIMIT 101`;
      if (rows.length > 100) return null;
      for (const row of rows) {
        if (!row.query || !Number.isFinite(new Date(row.expires_at).getTime())
          || new Date(row.expires_at).getTime() <= now) continue;
        const shape = fingerprintSqlIntent(row.query, opts.scope);
        const example = row.example as { canonical?: unknown; features?: unknown } | null;
        if (shape.status !== 'supported' || shape.secretValuesDropped || shape.fingerprint !== candidate.fingerprint
          || shape.version !== candidate.parserVersion || !example || shape.canonical !== example.canonical
          || !isDeepStrictEqual(shape.features, example.features)
          || !snapshot.examples.some(saved => isDeepStrictEqual(saved, row.example))) continue;
        const served = await readLoadedSqlToolCatalog();
        const current = await readCurrentSqlToolCatalog(served);
        if (!await allowed()) return null;
        for (const id of snapshot.sourceIds) if (!await opts.authorizeSource(id)) return null;
        const audits = await readSqlCoverageAudits(opts, shape, [served]);
        const renewedServed = await readLoadedSqlToolCatalog();
        if (renewedServed.ref !== served.ref || renewedServed.buildRef !== served.buildRef
          || renewedServed.coverage !== served.coverage) return null;
        if (current.coverage === 'complete') {
          const renewedCurrent = await readCurrentSqlToolCatalog(renewedServed);
          if (renewedCurrent.coverage !== 'complete' || renewedCurrent.ref !== current.ref
            || renewedCurrent.buildRef !== current.buildRef) return null;
        }
        if (!await allowed()) return null;
        for (const id of snapshot.sourceIds) if (!await opts.authorizeSource(id)) return null;
        return { sql: row.query, scope: opts.scope, sourceAuthorized: true,
          sourceCoverage: snapshot.summary.coverage.status === 'complete'
            && snapshot.summary.coverage.retention === 'complete' ? 'complete' : 'unknown',
          now, exampleExpiresAt: new Date(row.expires_at).getTime(), served,
          current,
          audits, candidateCoverage: 'unknown' };
      }
      return null;
    } catch { return null; }
  };
