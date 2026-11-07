import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { compileLibraryFixture } from '../../test/compiled-library-fixture';
import { operatorArtifactSource, writeOperatorArtifactManifest } from '../release/operator-artifact';
import { collectSqlCoverageObservations, insertTestRunRowsWithSql } from '@papercusp/test-config/admin-test-runs-reporter';
import { parseTestRunExecutionDetails, TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION } from '@papercusp/test-config/execution-details';
import { readSqlCoverageAudits } from '../sql-tool-candidate-production';
import { fingerprintSqlIntent } from '../bash-substitution/sql-intent-fingerprint';
import type { SqlCandidateWorklistOptions } from '../sql-tool-candidate-worklist';
import type { SqlCoverageHostResult } from '../../test/sql-coverage-host-fixture';
import { compileJsonSchema } from '../json-schema-validation';
import { writeScratchReference } from '../scratch-reference';
import { safeScratchFilesystemPath } from '../scratch-uri';

const root = resolve(import.meta.dirname, '../../../..');
const caseKey = 'compiled SQL handler and typed tool return the same complete rows';
let db: OrgTestDb, temporary: string;
beforeAll(async () => { db = await createOrgTestDb(); temporary = await mkdtemp(join(tmpdir(), 'sql-coverage-host-')); }, 120_000);
afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); await db?.cleanup(); });

it('reconciles a measured compiled producer with actual canonical writes and refuses revocation/output drift', async () => {
  const entry = join(temporary, 'host.mjs'), resultPath = join(temporary, 'result.json');
  const sourceSha = await operatorArtifactSource(root);
  await compileLibraryFixture(root, join(root, 'packages/operator-core/test/sql-coverage-host-fixture.ts'), entry, { sourceSha });
  const artifact = await writeOperatorArtifactManifest({ root, entry, sourceSha, artifactRoot: temporary });
  expect(artifact.status).toBe('measured');
  await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  const child = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', entry], { cwd: root, timeout: 120_000, maxBuffer: 2_000_000,
    env: { ...process.env, NODE_OPTIONS: '', HARNESS_ADMIN_DATABASE_URL: db.adminDsn,
      HARNESS_DATABASE_URL: db.appDsn, DATABASE_URL: db.adminDsn, PC_SQL_COVERAGE_RESULT: resultPath,
      PAPERCUSP_CANONICAL_TREE: root,
      PAPERCUSP_INTERNAL_BUILD: 'false', PAPERCUSP_POSTHOG_KEY: '', PAPERCUSP_POSTHOG_HOST: '' } });
  expect(child.stdout).toMatch(/^# pass 1$/m); expect(child.stdout).toMatch(/^# fail 0$/m);
  const result: SqlCoverageHostResult = JSON.parse(await readFile(resultPath, 'utf8'));
  expect(result.artifact).toEqual(artifact);
  expect(result.currentSource).toEqual({ ref: result.catalog.ref, buildRef: result.catalog.buildRef,
    coverage: 'complete' });
  expect(result.unqualifiedSource).toEqual({ coverage: 'unknown' });
  const observations = collectSqlCoverageObservations({ children: { allTests: () => [{ fullName: caseKey,
    result: () => ({ state: 'passed' }), meta: () => ({ papercuspSqlCoverageObservations: [result.observation] }) }] } } as never);
  expect(observations).toHaveLength(1);
  const workspaceId = 'sql-coverage-host', harnessSlug = 'papercusp';
  const details = parseTestRunExecutionDetails({ schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION, root,
    filePath: 'packages/operator-core/test/sql-coverage-host-fixture.ts', runGroupId: 'compiled-sql-host', workspaceId,
    harnessSlug, testLayer: 'integration', testNamePattern: null, passed: 1, failed: 0, skipped: 0,
    collectionFailed: false, mutationPhase: null, commitSha: sourceSha, worktreeDirty: false,
    runStartedAt: new Date(result.startedAt).toISOString(), sqlCoverageObservations: observations });
  expect(details).toBeDefined();
  const [receipt] = await insertTestRunRowsWithSql(db.adminSql as never, [{ filePath: details!.filePath,
    framework: 'node', status: 'pass', startedAt: new Date(result.startedAt), finishedAt: new Date(result.finishedAt),
    durationMs: result.finishedAt - result.startedAt, outputTail: child.stdout, isScratchConfig: false,
    worktreeDirty: false, commitSha: sourceSha, executionDetails: details!, cases: [{ caseIndex: 0, caseKey,
      occurrence: 1, status: 'pass', durationMs: result.finishedAt - result.startedAt, errorTail: null }] }],
  { branch: 'staging', inferredCommit: sourceSha, declaredSource: 'local', runGroupId: 'compiled-sql-host',
    workspaceId, harnessSlug, loopLagP95Ms: null, rssMb: null });
  expect(receipt?.outcome).toBe('inserted');
  if (receipt?.outcome !== 'inserted') throw Error('canonical fixture run was not inserted');
  const scope = { workspaceId, sourceBoundary: 'tool-ledger', epoch: 'fixture-v1', key: new Uint8Array(32).fill(83) };
  let allowed = true;
  const opts: SqlCandidateWorklistOptions = { workspaceId, harnessSlug, client: db.adminSql, scope,
    authorize: async () => allowed, authorizeSource: async () => allowed, now: Date.now() };
  const shape = fingerprintSqlIntent('SELECT id FROM public.sql_coverage_jobs ORDER BY id LIMIT 5', scope);
  if (shape.status !== 'supported') throw Error('unsupported maintained SQL fixture');
  // A catalog entry is bound to the actually loaded function measured in the
  // child; no fixture verdict/audit is injected into the production reader.
  const catalog = { ...result.catalog, coverage: 'complete' as const, tools: result.catalog.tools.map(tool => {
    const validate = compileJsonSchema(tool.inputSchema);
    return { ...tool, args: { safeParse: (args: unknown) => ({ success: validate(args) === true }) } };
  }) };
  const read = () => readSqlCoverageAudits(opts, shape, [catalog]);
  expect(await read()).toMatchObject([{ verdict: 'exact', toolName: 'fixture:jobs', args: { limit: 5 } }]);
  await db.adminSql`UPDATE harness_shared.test_runs SET status='fail' WHERE id=${receipt.id}`;
  expect(await read()).toEqual([]);
  await db.adminSql`UPDATE harness_shared.test_runs SET status='pass' WHERE id=${receipt.id}`;
  await db.adminSql`UPDATE harness_shared.test_case_runs SET status='fail' WHERE test_run_id=${receipt.id}`;
  expect(await read()).toEqual([]);
  await db.adminSql`UPDATE harness_shared.test_case_runs SET status='pass' WHERE test_run_id=${receipt.id}`;
  allowed = false; expect(await read()).toEqual([]); allowed = true;
  expect(await read()).toHaveLength(1);
  const originalArgs = await db.adminSql`SELECT id,args_json FROM harness_shared.tool_invocations
    WHERE id=ANY(${result.invocationIds}::bigint[]) ORDER BY id`;
  await db.adminSql`UPDATE harness_shared.tool_invocations SET args_json='{"limit":4}'::jsonb
    WHERE id=${originalArgs[0]!.id}`;
  expect(await read()).toEqual([]);
  await db.adminSql`UPDATE harness_shared.tool_invocations SET args_json=${db.adminSql.json(originalArgs[0]!.args_json)}
    WHERE id=${originalArgs[0]!.id}`;
  expect(await read()).toHaveLength(1);
  writeScratchReference({ filePath: safeScratchFilesystemPath(result.outputRefs[1]!),
    payload: JSON.stringify({ rows: [{ id: 999 }], truncated: false }), workspaceId,
    ownerId: 'su-sql-coverage-host', mediaType: 'application/json', bodyOffsetInPayload: 0 });
  expect(await read()).toEqual([]);
}, 300_000);
