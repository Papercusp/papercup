/** Executed by node:test from a measured compiled artifact. No identity,
 * invocation sink, output reader or coverage audit is mocked. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { _resetForTests } from '@papercusp/db-org/connection';
import { lookupByMcpName, registerProjectedTool, type ProjectedTool } from '@papercusp/agent-mcp';
import '../lib/agent-tools/index';
import { PROJECTED_DEPS, flushPendingTelemetry } from '../lib/projected-tool-deps';
import { drainDetached } from '../lib/detached-imports';
import { observeSqlCoverageFixture, initializeRuntimeObservability, runtimeObservabilityHealth,
  shutdownRuntimeObservability } from '../lib/observability/runtime';
import { readCurrentSqlToolCatalog, readLoadedSqlToolCatalog, readSqlCoverageAudits } from '../lib/sql-tool-candidate-production';
import { fingerprintSqlIntent } from '../lib/bash-substitution/sql-intent-fingerprint';
import { miningScopeId } from '../lib/agent-opportunities/privacy';
import { sqlCoverageRows, sqlCoverageToken } from '../lib/bash-substitution/sql-tool-recommendations';
import { writeScratchReference } from '../lib/scratch-reference';
import { safeScratchFilesystemPath } from '../lib/scratch-uri';
import type { TestSqlCoverageObservation } from '@papercusp/test-config/execution-details';
import type { OperatorArtifactIdentity } from '../lib/release/operator-artifact';

export interface SqlCoverageHostResult {
  startedAt: number; finishedAt: number; artifact: OperatorArtifactIdentity;
  outputRefs: string[]; invocationIds: string[];
  catalog: { ref: string; buildRef: string; tools: Array<{ name: string; contractRef: string;
    sourceFingerprint?: string; inputSchema: Record<string, unknown> }> };
  currentSource: { ref: string; buildRef: string; coverage: 'complete' | 'unknown' | 'truncated' };
  unqualifiedSource: { coverage: 'complete' | 'unknown' | 'truncated' };
  observation: Omit<TestSqlCoverageObservation, 'caseKey' | 'occurrence'>;
}

export const SQL_COVERAGE_HOST_CASE = 'compiled SQL handler and typed tool return the same complete rows';

test(SQL_COVERAGE_HOST_CASE, async () => {
  const sql = getOrgPg().sql;
  const workspaceId = 'sql-coverage-host', harness = 'papercusp', ownerId = 'su-sql-coverage-host';
  const scope = { workspaceId, sourceBoundary: 'tool-ledger', epoch: 'fixture-v1', key: new Uint8Array(32).fill(83) };
  const ctx = { workspaceId, harnessSlug: harness, role: 'su', uiClientId: ownerId, transport: 'mcp',
    log: () => {}, signal: new AbortController().signal, emit: () => {}, progress: () => {},
    principal: { kind: 'system', slug: ownerId, workspaceId, authMethod: 'process-internal', trust: 'trusted',
      capabilities: new Set(['*']) } };
  const query = 'SELECT id FROM public.sql_coverage_jobs ORDER BY id LIMIT 5';
  const outputRefs: string[] = [];
  try {
    await sql`CREATE TABLE public.sql_coverage_jobs (id integer PRIMARY KEY)`;
    await sql`INSERT INTO public.sql_coverage_jobs VALUES (1),(2)`;
    await sql`GRANT SELECT ON public.sql_coverage_jobs TO harness_app`;
    const direct = lookupByMcpName('dev:pg_query');
    assert.ok(direct, 'the complete production registry must contain the SQL tool');
    const typed: ProjectedTool = { pluginName: 'fixture', description: 'typed jobs query', capabilities: [],
      expose: { mcp: { name: 'fixture:jobs' } }, inputSchema: { type: 'object', properties: {
        limit: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['limit'], additionalProperties: false },
      fn: async input => ({ content: [{ type: 'text', text: JSON.stringify({ rows:
        await sql`SELECT id FROM public.sql_coverage_jobs ORDER BY id LIMIT ${(input as { limit: number }).limit}`,
      rowCount: 2, truncated: false }) }] }) };
    registerProjectedTool(typed);
    initializeRuntimeObservability();
    const artifact = runtimeObservabilityHealth().artifact;
    assert.equal(artifact?.status, 'measured', 'boot must measure the compiled artifact');
    const startedAt = Date.now();
    const measured = await observeSqlCoverageFixture(scope, harness, async () => {
      const results = [];
      for (const [tool, input] of [[direct, { sql: query }], [typed, { limit: 5 }]] as const) {
        const callId = randomUUID(), toolName = tool.expose.mcp!.name;
        const result = await PROJECTED_DEPS.aroundInvoke!({ tool, toolName, input, ctx, callId,
          invoke: () => tool.fn(input, ctx as never) } as never);
        assert.deepEqual(sqlCoverageRows(result), [{ id: 1 }, { id: 2 }]);
        const outputRef = `papercusp://scratch/${workspaceId}/${toolName}/${randomUUID()}/result.json`;
        writeScratchReference({ filePath: safeScratchFilesystemPath(outputRef), payload: JSON.stringify(result),
          workspaceId, ownerId, mediaType: 'application/json', bodyOffsetInPayload: 0 });
        outputRefs.push(outputRef);
        await PROJECTED_DEPS.recordInvocation!({ pluginName: 'fixture', toolName, ctx, callId,
          windowKey: 'sql-coverage-host', durationMs: 1, status: 'ok', args: input, resultSnapshot: result,
          outputRef } as never);
        results.push(result);
      }
      return results;
    });
    assert.deepEqual(measured.gaps, []);
    assert.equal(measured.executions.length, 2);
    await flushPendingTelemetry(); await drainDetached();
    const shape = fingerprintSqlIntent(query, scope);
    assert.equal(shape.status, 'supported');
    if (shape.status !== 'supported') throw Error('unsupported maintained SQL fixture');
    const [sqlExecution, toolExecution] = measured.executions;
    const catalog = await readLoadedSqlToolCatalog();
    assert.equal(catalog.coverage, 'complete');
    assert.equal(catalog.tools.find(t => t.name === 'fixture:jobs')?.contractRef, toolExecution!.contractRef);
    // Exercise the production Git/blob and boot-artifact readers, without a
    // source-SHA or artifact seam. A directory containing only built outputs
    // cannot stand in for the independently qualified source checkout.
    const currentSource = await readCurrentSqlToolCatalog(catalog);
    assert.equal(currentSource.coverage, 'complete');
    assert.equal(currentSource.ref, catalog.ref);
    assert.equal(currentSource.buildRef, catalog.buildRef);
    const unqualifiedSource = await readCurrentSqlToolCatalog(catalog,
      { root: dirname(process.env.PC_SQL_COVERAGE_RESULT!) });
    assert.equal(unqualifiedSource.coverage, 'unknown');
    const invocations = await sql`SELECT id::text,metadata_json FROM harness_shared.tool_invocations
      WHERE workspace_id=${workspaceId} AND harness_slug=${harness}
        AND metadata_json->'sqlCoverageExecution'->>'callId'=ANY(${measured.executions.map(r => r.callId)}::text[])`;
    assert.equal(invocations.length, 2, 'real writer must persist both host-owned receipts');
    // The parent records the ACTUAL node:test pass and case after process exit
    // and reconciles this measured catalog through the production reader.
    await writeFile(process.env.PC_SQL_COVERAGE_RESULT!, JSON.stringify({ startedAt, finishedAt: Date.now(),
      artifact, outputRefs, invocationIds: invocations.map(r => r.id),
      currentSource: { ref: currentSource.ref, buildRef: currentSource.buildRef, coverage: currentSource.coverage },
      unqualifiedSource: { coverage: unqualifiedSource.coverage },
      catalog: { ref: catalog.ref, buildRef: catalog.buildRef, tools: catalog.tools.filter(t => t.name === 'fixture:jobs')
        .map(t => ({ name: t.name, contractRef: t.contractRef, sourceFingerprint: t.sourceFingerprint,
          inputSchema: typed.inputSchema })) },
      observation: { fixtureRef: 'sql-coverage-host-v1', scopeId: miningScopeId(scope, harness),
        parserVersion: shape.version, fingerprint: shape.fingerprint,
        featuresToken: sqlCoverageToken(scope, harness, 'features', shape.features),
        contractRef: toolExecution!.contractRef, verdict: 'exact', missingFeatures: [], sqlExecution, toolExecution } }));
  } finally { await shutdownRuntimeObservability(); await drainDetached(); await _resetForTests(); }
});

// Keep the production reader in this artifact's measured input closure.
export { readSqlCoverageAudits };
