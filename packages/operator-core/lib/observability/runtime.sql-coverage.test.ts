/** These controls exercise the actual producer/settlement path. Mocked build
 * identities are unit controls, never evidence that an operator is deployed. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectedTool } from '@papercusp/agent-mcp';
import { sqlCoverageToken } from '../bash-substitution/sql-tool-recommendations';

const host = vi.hoisted(() => ({ generation: vi.fn() }));
vi.mock('../serving-generation', () => ({ readServingGeneration: host.generation }));
vi.mock('../telemetry-flush', () => ({ resolveTelemetryConfig: async () => ({
  optedIn: false, internalBuild: false, host: '', projectKey: '', distinctId: 'fixture', consentSince: 0,
}) }));
vi.mock('../release/operator-artifact', async original => ({ ...await original<object>(),
  measureBootOperatorArtifact: () => ({ status: 'measured', sourceSha: 'a'.repeat(40),
    bundleSha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64), sourceBlobs: {}, evidenceRef: 'fixture:artifact' }) }));
import { beginToolTrace, finishSqlCoverageExecution, finishToolTrace, initializeRuntimeObservability,
  observeSqlCoverageFixture, runToolTrace, shutdownRuntimeObservability } from './runtime';

const scope = { workspaceId: 'coverage-unit', sourceBoundary: 'fixture-ledger', epoch: '2026-11',
  key: new Uint8Array(32).fill(81) };
const ctx = { workspaceId: scope.workspaceId, harnessSlug: 'papercusp', role: 'su' };
const args = { limit: 5 };
const output = () => ({ content: [{ type: 'text' as const,
  text: JSON.stringify({ rows: [{ id: 1 }], rowCount: 1, truncated: false }) }] });
function request(callId = 'unit-sql-coverage', fn: () => Promise<ReturnType<typeof output>> = async () => output()) {
  const tool = { pluginName: 'fixture', expose: { mcp: { name: 'fixture:jobs' } }, description: 'fixture',
    inputSchema: { type: 'object' }, capabilities: [], fn } as unknown as ProjectedTool;
  return { tool, toolName: 'fixture:jobs', input: args, ctx, callId, invoke: fn } as unknown as Parameters<typeof runToolTrace>[0];
}
const settlement = (req: ReturnType<typeof request>, result: unknown) => ({ callId: req.callId,
  toolName: req.toolName, ctx: req.ctx, args: req.input, resultSnapshot: result, status: 'ok' }) as Parameters<typeof finishSqlCoverageExecution>[0];

beforeEach(() => {
  host.generation.mockReset().mockResolvedValue({ state: 'known', revision: 'fixture-generation',
    buildSha: 'a'.repeat(40), appliedMigrationDigest: 'fixture-schema', toolRegistryRevision: 'fixture-registry' });
  initializeRuntimeObservability();
});
afterEach(async () => { await shutdownRuntimeObservability(); });

it('captures actual loaded handler, scoped args/results and a one-use canonical settlement', async () => {
  const req = request(); beginToolTrace({ ...req, pluginName: 'fixture' } as never);
  const measured = await observeSqlCoverageFixture(scope, 'papercusp', () => runToolTrace(req, req.invoke));
  expect(measured.gaps).toEqual([]);
  expect(measured.executions).toHaveLength(1);
  const own = finishSqlCoverageExecution(settlement(req, measured.result));
  expect(own).toEqual(measured.executions[0]);
  expect(own).toMatchObject({ toolName: 'fixture:jobs', buildSha: 'a'.repeat(40),
    artifactFingerprint: 'b'.repeat(64), argsToken: sqlCoverageToken(scope, 'papercusp', 'args', args),
    resultToken: sqlCoverageToken(scope, 'papercusp', 'rows', [{ id: 1 }]) });
  expect(own!.contractRef).toMatch(/^sql-tool-contract-v1:/);
  expect(finishSqlCoverageExecution(settlement(req, measured.result))).toBeUndefined();
  finishToolTrace(settlement(req, measured.result));
});

it('does not mint custody outside the internal fixture scope, and never retries a failed handler', async () => {
  const plain = request('plain'); const value = await runToolTrace(plain, plain.invoke);
  expect(finishSqlCoverageExecution(settlement(plain, value))).toBeUndefined();
  const failure = new Error('synthetic handler failure');
  const fn = vi.fn(async () => { throw failure; }); const failed = request('failed', fn);
  await expect(observeSqlCoverageFixture(scope, 'papercusp', () => runToolTrace(failed, failed.invoke))).rejects.toBe(failure);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(finishSqlCoverageExecution(settlement(failed, output()))).toBeUndefined();
});

it('keeps runtime drift, wrong scope, clipped results and changed settlement arguments unproved', async () => {
  const drift = request('drift');
  host.generation.mockResolvedValueOnce({ state: 'known', revision: 'old', buildSha: 'a'.repeat(40) })
    .mockResolvedValueOnce({ state: 'known', revision: 'new', buildSha: 'a'.repeat(40) });
  expect((await observeSqlCoverageFixture(scope, 'papercusp', () => runToolTrace(drift, drift.invoke))).executions).toEqual([]);
  const wrong = request('wrong'); wrong.ctx = { ...wrong.ctx, workspaceId: 'foreign' };
  expect((await observeSqlCoverageFixture(scope, 'papercusp', () => runToolTrace(wrong, wrong.invoke))).executions).toEqual([]);
  const clipped = request('clipped', async () => ({ content: [{ type: 'text',
    text: JSON.stringify({ rows: [{ id: 1 }], truncated: true }) }] }));
  expect((await observeSqlCoverageFixture(scope, 'papercusp', () => runToolTrace(clipped, clipped.invoke))).executions).toEqual([]);
  const changed = request('changed');
  const measured = await observeSqlCoverageFixture(scope, 'papercusp', () => runToolTrace(changed, changed.invoke));
  expect(measured.executions).toHaveLength(1);
  expect(finishSqlCoverageExecution({ ...settlement(changed, measured.result), args: { limit: 99 } } as never)).toBeUndefined();
});
