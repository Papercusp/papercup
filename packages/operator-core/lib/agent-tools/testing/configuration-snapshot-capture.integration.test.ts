/**
 * P-011 (plan verification-system-improvements-2026-10-10): every test run recorded in the
 * ledger carries the configuration its MEASURED process ran under, in
 * test_runs.configuration_snapshot (migration 1448). A bar that declares a production
 * configuration is judged against that snapshot, so a recorded run without one can never
 * prove such a bar.
 *
 * Integration, not unit, on purpose: the snapshot is captured inside the Vitest reporter of
 * the CHILD process the router spawns, then written over a real Postgres connection. Unit
 * tests pin each half (the reporter's insert shape, the store's INSERT params); only a real
 * run establishes that the child's environment is what reaches the stored row. Each case
 * plants a one-off PAPERCUSP_FLAG_* value in the environment the child inherits and checks
 * that exact value comes back out of the stored, fingerprint-verified snapshot.
 *
 *   SPEC-P-011-RUNNER-CAPTURE   — testing:run records a fingerprint on every row it records.
 *   SPEC-P-011-MUTATION-CAPTURE — a mutation-probe row (source='mutation-probe', written by the
 *                                 same router + reporter the probe drives) carries one too.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { _resetForTests, getOrgPg } from '@papercusp/db-org';
import { FLAGS, FLAG_DEFAULTS, flagEnvVarName } from '@papercusp/flags';
import { captureConfigurationSnapshot, proofContextImpact, readConfigurationSnapshot, readProofContextIdentity } from '@papercusp/test-config/configuration-snapshot';
import { reconcileTimedOutTestRunReceipts, retainSharedPg,
  type TestRunReceipt } from '@papercusp/test-config/admin-test-runs-reporter';
import { parseRecordedNativePopulation, parseTestRunExecutionDetails, captureRecordedProofContext,
  parseRecordedWorkerRuntime, parseRecordedSourceSubmodules, stableRecordedWorkerExecution,
  parseRecordedWorkerDatabaseReset, parseRecordedSourceBytes } from '@papercusp/test-config/execution-details';
import { readPartialNativeCompletion } from '../../../../../scripts/lib/partial-task-resume.mjs';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { _resetHarnessAdminUrlCacheForTests } from '../../embedded-pg-discovery';
import { REPO_ROOT } from '../docs/_repo-paths';
import runTool from './run';
import runsTool from './runs';
import { evaluateCriterionTestChecks, runCriterionCheckFiles, type CriterionCheckRunner } from '../../rubrics-criterion-checks';

const execFileAsync = promisify(execFile);

/** Nested runs own their artifacts; inheriting the outer packet directory
 * makes its independent identity/population verifier reject the foreign router. */
function nestedRouterEnv(directory: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PC_HEAVY_'))),
    PAPERCUSP_TEST_ARTIFACT_DIR: join(directory, 'artifacts'),
  };
}

async function expectIsolatedRouterCustody(directory: string, group: string, suites: string[]): Promise<void> {
  const artifactRoot = join(directory, 'artifacts');
  const routers = (await readdir(artifactRoot)).filter(name => name.startsWith('native-router-'));
  expect(routers).toHaveLength(1);
  const router = join(artifactRoot, routers[0]!);
  const declaration = JSON.parse(await readFile(join(router, 'expected.json'), 'utf8')) as {
    identity: { runId: string }; expected: Array<{ attempt: string; selected: string[] }>;
  };
  const locator = JSON.parse(await readFile(join(router, 'locator.json'), 'utf8')) as { identity: unknown };
  expect(declaration.identity.runId).toBe(group);
  expect(locator.identity).toEqual(declaration.identity);
  expect(declaration.expected.filter(row => row.attempt === 'primary').flatMap(row => row.selected).sort())
    .toEqual(suites.map(suite => join(REPO_ROOT, suite)).sort());
}

/** A small, stable, DB-free suite with a tiny import closure. */
const SUITE = 'packages/operator-core/lib/testing-flakiness.test.ts';
/** Recorded raw by captureConfigurationSnapshot (CONFIGURATION_SNAPSHOT_RAW_ENV_KEY). */
const MARKER = 'PAPERCUSP_FLAG_P011_CAPTURE_PROBE';

const ENV_KEYS = [
  'HARNESS_DATABASE_URL', 'HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL',
  'PAPERCUSP_PGBOUNCER', 'PAPERCUSP_SKIP_PG_DISCOVERY', MARKER,
] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let org: OrgTestDb | undefined;

function callTestingRun(args: Record<string, unknown>, ctx: Record<string, unknown>) {
  return (runTool as unknown as { handler: (a: unknown, c: unknown) => Promise<unknown> }).handler(args, ctx);
}

type RunResult = { ok: boolean; runId?: string; testRunIds?: number[] };

/** testing:run returns its result as `data` or as an MCP-style text envelope. */
function unwrap(raw: unknown): RunResult {
  const envelope = raw as { data?: unknown; content?: Array<{ text?: string }> } | null;
  if (envelope?.data !== undefined) return envelope.data as RunResult;
  const text = envelope?.content?.[0]?.text;
  if (typeof text === 'string') return JSON.parse(text) as RunResult;
  throw new Error(`unrecognised testing:run result shape: ${JSON.stringify(raw)?.slice(0, 200)}`);
}

type LedgerRow = { id: string; source: string; phase: string | null; configuration_snapshot: unknown };

beforeAll(async () => {
  // Every nested router and its reporter write to this suite's disposable migrated database.
  org = await createOrgTestDb();
  process.env.HARNESS_DATABASE_URL = org.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = org.adminDsn;
  process.env.DATABASE_URL = org.adminDsn;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  _resetHarnessAdminUrlCacheForTests();
  await _resetForTests();
}, 120_000);

afterEach(() => {
  delete process.env[MARKER];
});

afterAll(async () => {
  try {
    await _resetForTests();
    await org?.cleanup();
  } finally {
    for (const key of ENV_KEYS) {
      const saved = savedEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    _resetHarnessAdminUrlCacheForTests();
  }
});

/** Every row must hold a snapshot whose fingerprint recomputes and that saw `nonce`. */
function expectCapturedBy(rows: readonly LedgerRow[], nonce: string): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const snapshot = readConfigurationSnapshot(row.configuration_snapshot);
    expect(snapshot, `test_runs ${row.id} has no verifiable configuration_snapshot`).not.toBeNull();
    expect(snapshot!.fingerprint).toMatch(/^sha256-config-snapshot-v1:[0-9a-f]{64}$/);
    expect(snapshot!.flagEnv[MARKER], `test_runs ${row.id} snapshot is not from this run's child`).toBe(nonce);
  }
}

describe('configuration snapshot capture on recorded test runs (P-011)', () => {
  it('P017 carries a criterion declaration into the real child and refuses a changed canonical snapshot', async () => {
    const group = `criterion-config-${randomUUID()}`;
    const nonce = randomUUID();
    const flag = FLAGS.VIDEO_CHANNELS;
    const required = !FLAG_DEFAULTS[flag];
    const declaration = { flags: { [flag]: required }, env: {
      [MARKER]: nonce, PAPERCUSP_TEST_RUNS_DB_URL: org!.adminDsn,
    } };
    let measured: Awaited<ReturnType<typeof runCriterionCheckFiles>> | undefined;
    const runner: CriterionCheckRunner = async opts => measured ??= await runCriterionCheckFiles({
      ...opts, actorId: process.env.PAPERCUSP_SID,
    });
    const evaluate = () => evaluateCriterionTestChecks({
      criteria: [{ key: 'configured', productionConfiguration: declaration,
        check: { kind: 'tests', files: [SUITE] } }], ratings: { configured: { rating: 'healthy' } },
      root: REPO_ROOT, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp',
      runId: group, timeoutMs: 120_000, runner,
    });
    const baseline = await evaluate();
    expect(baseline, JSON.stringify(baseline)).toMatchObject({ ok: true });
    expect(measured?.testRunIds).toHaveLength(1);
    const [original] = await getOrgPg().sql<Array<{ id: string; configuration_snapshot: unknown }>>`
      SELECT id::text AS id, configuration_snapshot FROM harness_shared.test_runs
      WHERE id = ANY(${measured!.testRunIds!}::bigint[]) AND run_group_id = ${group}
        AND workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
    `;
    expect(original).toBeDefined();
    const snapshot = readConfigurationSnapshot(original!.configuration_snapshot);
    expect(snapshot?.flagEnv).toMatchObject({ [MARKER]: nonce,
      [flagEnvVarName(flag)]: required ? '1' : '0' });
    const changed = captureConfigurationSnapshot({ ...declaration.env,
      [flagEnvVarName(flag)]: required ? '0' : '1' });
    try {
      await getOrgPg().sql`UPDATE harness_shared.test_runs SET configuration_snapshot =
        ${JSON.stringify(changed)}::text::jsonb WHERE id::text = ${original!.id}`;
      const falsifier = await evaluate();
      expect(falsifier).toMatchObject({ ok: false, error: 'check_run_failed' });
      if (!falsifier.ok) expect(falsifier.detail).toContain('configuration differs');
    } finally {
      await getOrgPg().sql`UPDATE harness_shared.test_runs SET configuration_snapshot =
        ${JSON.stringify(original!.configuration_snapshot)}::text::jsonb WHERE id::text = ${original!.id}`;
    }
    expect(await evaluate()).toMatchObject({ ok: true });
  }, 180_000);

  it('P021: retains actual owned schema observations through native completion and the original PostgreSQL row', async () => {
    const suite = 'libs/test-config/src/pg-migrate.integration.test.ts';
    const group = `schema-custody-${randomUUID()}`;
    const attempt = `schema-native-${randomUUID()}`;
    const receiptDir = await mkdtemp(join(tmpdir(), 'schema-original-custody-'));
    const receiptFile = join(receiptDir, 'receipts.jsonl');
    const nativeFile = join(receiptDir, 'native.json');
    let verified = false;
    try {
      await execFileAsync(process.execPath, ['scripts/test-files.mjs', suite,
        '--testNamePattern=^P021 original schema custody target$'], {
        cwd: REPO_ROOT,
        env: { ...nestedRouterEnv(receiptDir), PAPERCUSP_TEST_RUNS_DB_URL: org!.adminDsn,
          PAPERCUSP_TEST_RUN_GROUP: group, PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receiptFile,
          PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID: attempt,
          PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/test-config',
          PC_EXECUTED_SOURCE_MAP_OUT: nativeFile, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1' },
        timeout: 150_000, maxBuffer: 16 * 1024 * 1024,
      }).catch((error: unknown) => {
        const child = error as { killed?: boolean; signal?: string; code?: string | number;
          stdout?: string; stderr?: string };
        throw new Error(`P021 schema child termination ${JSON.stringify({ killed: child.killed,
          signal: child.signal, code: child.code })}\n${child.stderr?.slice(-3000) ?? ''}\n${child.stdout?.slice(-1000) ?? ''}`,
        { cause: error });
      });
      await expectIsolatedRouterCustody(receiptDir, group, [suite]);
      const receipts = (await readFile(receiptFile, 'utf8')).trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as TestRunReceipt);
      const ids = receipts.filter(receipt => receipt.outcome === 'inserted').map(receipt => String(receipt.id));
      expect(ids, JSON.stringify(receipts)).toHaveLength(1);
      const [row] = await getOrgPg().sql<Array<{ id: string; execution_details: unknown }>>`
        SELECT id::text AS id, execution_details FROM harness_shared.test_runs
          WHERE id::text = ANY(${ids}) AND run_group_id = ${group} AND file_path = ${suite}
      `;
      expect(row).toBeDefined();
      const details = parseTestRunExecutionDetails(row!.execution_details);
      expect(details, 'original PostgreSQL schema row').toBeDefined();
      const native = JSON.parse(await readFile(nativeFile, 'utf8'));
      expect(native.completionCheckpoint).toMatchObject({ runGroupId: group, qualificationAttemptId: attempt });
      expect(native.nativeRun).toMatchObject({ terminalHook: 'onTestRunEnd', reason: 'passed',
        selectedPopulationMatched: true, unhandledErrorCount: 0 });
      expect(native.nativeRun.files).toHaveLength(1);
      const completion = native.nativeRun.files[0];
      const reset = parseRecordedWorkerDatabaseReset(completion.proof?.inputs?.workerDatabaseReset);
      expect(reset).toBeDefined();
      expect(reset).toMatchObject({ runGroupId: group, testFile: join(REPO_ROOT, suite),
        captureId: completion.proof.inputs.workerExecution.captureId });
      expect(reset!.databases).toHaveLength(1);
      expect(reset!.databases[0]).toMatchObject({ readyAt: expect.any(String), cleanup: { outcome: 'dropped' } });
      const schema = reset!.databases[0]!.schemaInputs!;
      expect(schema.before).toMatchObject({ schemaVersion: 'owned-database-schema-v2', populationStatus: 'unknown',
        missing: ['unowned-connections-unobserved'], extensionDefinitionsSha256: expect.any(String),
        serverRoleStateSha256: expect.any(String) });
      expect(schema.after).toMatchObject({ schemaVersion: 'owned-database-schema-v2', populationStatus: 'unknown' });
      expect(schema.after!.schemaSha256).not.toBe(schema.before!.schemaSha256);
      expect(schema.after!.appliedMigrationsSha256).not.toBe(schema.before!.appliedMigrationsSha256);
      expect(schema.after!.extensionsSha256).toBe(schema.before!.extensionsSha256);
      expect(schema.after!.dumpExecutableSha256).toBe(schema.before!.dumpExecutableSha256);
      expect(details!.workerDatabaseReset).toEqual(reset);
      expect(details!.proofContext!.components.schema).toBeNull();
      const readOriginal = async () => (await runsTool.handler({ testRunIds: ids.map(Number) } as never,
        {} as never) as { data: { runs: Array<{ executionDetails: typeof details }>;
          originalResultSetReference: unknown } }).data;
      const original = await readOriginal();
      expect(original.runs[0]!.executionDetails?.workerDatabaseReset).toEqual(reset);
      expect(original.originalResultSetReference).not.toBeNull();

      // Corrupt the actual stored observation, not a detached fixture. The
      // reader must withhold both parsed evidence and the original-set binding.
      try {
        const corrupt = structuredClone(details!);
        corrupt.workerDatabaseReset!.databases[0]!.schemaInputs!.before!.fingerprint = 'e'.repeat(64);
        const foreign = { ...details!, workerDatabaseReset: { ...reset!, captureId: randomUUID() } };
        for (const changed of [corrupt, foreign]) {
          expect(parseTestRunExecutionDetails(changed)).toBeUndefined();
          await getOrgPg().sql`UPDATE harness_shared.test_runs SET execution_details =
            ${JSON.stringify(changed)}::text::jsonb WHERE id::text = ${row!.id}`;
          const refused = await readOriginal();
          expect(refused.runs[0]!.executionDetails).toBeNull();
          expect(refused.originalResultSetReference).toBeNull();
        }
      } finally {
        await getOrgPg().sql`UPDATE harness_shared.test_runs SET execution_details =
          ${JSON.stringify(row!.execution_details)}::text::jsonb WHERE id::text = ${row!.id}`;
      }
      expect((await readOriginal()).originalResultSetReference).toEqual(original.originalResultSetReference);

      // Natural qualification may remain refused at its existing dependency
      // prerequisite. When ready, the consumer must retain the exact original.
      const consumed = readPartialNativeCompletion(nativeFile, { attemptId: attempt,
        root: REPO_ROOT, workspaceName: '@papercusp/test-config',
        manifest: { schemaVersion: 1, units: [{ id: `test:${suite}`, kind: 'test', path: suite }] },
        selectedSpecifications: native.nativeRun.selectedManifest.specifications });
      if (typeof native.completionCheckpoint.runnerIdentity === 'string') {
        expect(consumed, JSON.stringify(consumed)).toMatchObject({ status: 'ready' });
        expect(consumed.receipts[0]?.proof.workerDatabaseReset).toEqual(reset);
      } else expect(consumed).toMatchObject({ status: 'refused', reason: 'snapshot-identity-mismatch', receipts: [] });
      verified = true;
    } finally {
      if (verified) await rm(receiptDir, { recursive: true, force: true });
      else process.stderr.write(`P021 original schema custody failure evidence retained: ${receiptDir}\n`);
    }
  }, 240_000);

  it('P021: preserves complete native case identities and measured source bytes through the actual reporter and PostgreSQL consumer', async () => {
    const suite = 'libs/test-config/src/execution-details.test.ts';
    const group = `population-v1-${randomUUID()}`;
    const receiptDir = await mkdtemp(join(tmpdir(), 'population-v1-capture-'));
    const receiptFile = join(receiptDir, 'receipts.jsonl');
    const nativeFile = join(receiptDir, 'native.json');
    const attempt = `population-native-${randomUUID()}`;
    try {
      await execFileAsync(process.execPath, ['scripts/test-files.mjs', suite], {
        cwd: REPO_ROOT,
        env: { ...nestedRouterEnv(receiptDir), PAPERCUSP_TEST_RUNS_DB_URL: org!.adminDsn,
          PAPERCUSP_TEST_RUN_GROUP: group, PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receiptFile,
          PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID: attempt,
          PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/test-config',
          PC_EXECUTED_SOURCE_MAP_OUT: nativeFile, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1' },
        timeout: 150_000, maxBuffer: 16 * 1024 * 1024,
      }).catch((error: unknown) => {
        const child = error as { killed?: boolean; signal?: string; code?: string | number;
          stdout?: string; stderr?: string };
        // Put termination and the LAST phase first: the standard error begins
        // at startup and reporter summaries bound its message length.
        throw new Error(`P021 child termination ${JSON.stringify({ killed: child.killed,
          signal: child.signal, code: child.code })}\n${child.stderr?.slice(-3000) ?? ''}\n${child.stdout?.slice(-1000) ?? ''}`,
        { cause: error });
      });
      await expectIsolatedRouterCustody(receiptDir, group, [suite]);
      const receipts = (await readFile(receiptFile, 'utf8')).trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as TestRunReceipt);
      const ids = receipts.filter(receipt => receipt.outcome === 'inserted').map(receipt => String(receipt.id));
      expect(ids.length, JSON.stringify(receipts)).toBeGreaterThan(0);
      const rows = await getOrgPg().sql<Array<{ id: string; file_path: string;
        run_group_id: string; execution_details: unknown; commit_sha: string | null;
        worktree_dirty: boolean; workspace_id: string | null; harness_slug: string | null }>>`
        SELECT id::text AS id, file_path, run_group_id, execution_details,
               commit_sha, worktree_dirty, workspace_id, harness_slug
          FROM harness_shared.test_runs WHERE id::text = ANY(${ids})
      `;
      expect(rows).toHaveLength(ids.length);
      const native = JSON.parse(await readFile(nativeFile, 'utf8'));
      expect(native.completionCheckpoint).toMatchObject({ runGroupId: group, qualificationAttemptId: attempt });
      expect(native.nativeRun).toMatchObject({ selectedPopulationMatched: true,
        terminalHook: 'onTestRunEnd', reason: 'passed', unhandledErrorCount: 0 });
      expect(native.nativeRun.selectedManifest.specifications).toHaveLength(rows.length);
      expect(native.nativeRun.files).toHaveLength(rows.length);
      const consumed = readPartialNativeCompletion(nativeFile, { attemptId: attempt,
        root: REPO_ROOT, workspaceName: '@papercusp/test-config',
        manifest: { schemaVersion: 1, units: [{ id: `test:${suite}`, kind: 'test', path: suite }] },
        selectedSpecifications: native.nativeRun.selectedManifest.specifications });
      // Missing qualified dependency-generation identity keeps the production
      // refusal. Original population integrity is independently checkable.
      const runtimeKnown = typeof native.completionCheckpoint.runnerIdentity === 'string';
      if (runtimeKnown) {
        expect(consumed, JSON.stringify(consumed))
          .toMatchObject({ status: 'ready', origin: { terminal: 'passed', runGroupId: group } });
        expect(consumed.receipts).toHaveLength(rows.length);
      } else expect(consumed).toMatchObject({ status: 'refused', reason: 'snapshot-identity-mismatch',
        receipts: [], currentEvidence: [] });
      for (const row of rows) {
        const details = parseTestRunExecutionDetails(row.execution_details);
        expect(details, `original PostgreSQL row ${row.id}`).toBeDefined();
        expect(row.run_group_id).toBe(group);
        expect(row.file_path).toBe(suite);
        expect(details).toMatchObject({ runGroupId: group, filePath: suite,
          populationCaptureStatus: 'captured', failed: 0, collectionFailed: false });
        const population = details!.population!;
        const context = readProofContextIdentity(details!.proofContext);
        expect(context, `original PostgreSQL row ${row.id} lost its reporter context`).not.toBeNull();
        expect(context!.components.population).toMatch(/^[a-f0-9]{64}$/);
        expect(context!.components.runtimeCapabilities).toBeNull();
        expect(proofContextImpact({ before: context, after: context })).toMatchObject({
          status: 'unknown', reason: 'proof-context-incomplete' });
        expect(population.cases).toHaveLength(details!.passed + details!.failed + details!.skipped);
        expect(population.cases.every(test => test.identity[1] === suite)).toBe(true);
        // This maintained suite has long parameterized titles which neither
        // passedCaseTitles nor the bounded case table can retain completely.
        expect(population.cases.some(test => test.identity[2].length > 2_048)).toBe(true);
        expect(population.executionOrder).toHaveLength(details!.passed);
        const completion = native.nativeRun.files.find((file: { testFile: string; projectName: string }) =>
          file.testFile === suite && file.projectName === population.cases[0]!.identity[0]);
        expect(completion).toMatchObject({ completionId: expect.any(String), populationCaptureStatus: 'captured',
          population });
        const workerRuntime = parseRecordedWorkerRuntime(completion.proof?.inputs?.runtime);
        expect(workerRuntime, 'actual worker observation missing from native handoff').toBeDefined();
        expect(details!.workerRuntime).toEqual(workerRuntime);
        const workerTestConfiguration = completion.proof?.inputs?.testConfiguration;
        expect(workerTestConfiguration).toMatchObject({ schemaVersion: 'vitest-worker-configuration-v1',
          before: expect.stringMatching(/^[a-f0-9]{64}$/), after: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(workerTestConfiguration.after).toBe(workerTestConfiguration.before);
        expect(details!.workerTestConfiguration).toEqual(workerTestConfiguration);
        const workerExecution = stableRecordedWorkerExecution(completion.proof?.inputs?.workerExecution);
        expect(workerExecution, 'actual worker incarnation missing from native handoff').toBeDefined();
        expect(workerExecution!.before!.pid).not.toBe(native.nativeRun.pid);
        expect(workerExecution!.testFile).toBe(join(REPO_ROOT, suite));
        expect(details!.workerExecution).toEqual(workerExecution);
        const compilerInputs = completion.proof?.inputs?.compilerInputs;
        expect(compilerInputs).toMatchObject({ schemaVersion: 'worker-compiler-inputs-v1',
          captureId: workerExecution!.captureId, testFile: workerExecution!.testFile,
          scope: 'vitest-inlined-vm-calls', populationStatus: 'unknown',
          inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(compilerInputs.vmCallCount).toBeGreaterThan(0);
        expect(compilerInputs.missing).toContain('transform-pipeline-unobserved');
        expect(details!.workerCompilerInputs).toEqual(compilerInputs);
        expect(context!.components.compilerConfiguration).toBeNull();
        if (runtimeKnown) expect(consumed.receipts.find(receipt => receipt.completionId === completion.completionId)
          ?.proof.workerExecution).toEqual(workerExecution);
        if (runtimeKnown) expect(consumed.receipts.find(receipt => receipt.completionId === completion.completionId)
          ?.proof.workerCompilerInputs).toEqual(compilerInputs);
        expect(context!.components.testConfiguration).toMatch(/^[a-f0-9]{64}$/);
        const sourceSubmodules = parseRecordedSourceSubmodules(completion.sourceSubmodules);
        expect(sourceSubmodules, 'actual reporter source-submodule observation missing').toBeDefined();
        expect(details!.sourceSubmodules?.schemaVersion).toBe('submodule-checkouts-v1');
        const sourceBytes = parseRecordedSourceBytes(completion.sourceBytes);
        expect(sourceBytes, 'actual native reporter must retain its source-byte observation, including unknown pins')
          .toBeDefined();
        expect(details!.sourceBytes, 'the original PostgreSQL row must retain the same observation').toEqual(sourceBytes);
        expect(Object.keys(sourceBytes!).sort()).toEqual(['after', 'before', 'schemaVersion']);
        if (details!.worktreeDirty) {
          expect(context!.components.source).toBeNull();
        } else if (sourceBytes!.before && sourceBytes!.after
          && sourceBytes!.before.sha256 === sourceBytes!.after.sha256
          && sourceBytes!.before.fileCount === sourceBytes!.after.fileCount) {
          expect(context!.components.source).toBe(sourceBytes!.before.sha256);
        } else expect(context!.components.source).toBeNull();
        if (runtimeKnown) expect(consumed.receipts.find(receipt => receipt.completionId === completion.completionId)
          ?.proof.sourceBytes).toEqual(sourceBytes);
        const measured = captureRecordedProofContext({ commitSha: details!.commitSha,
          worktreeDirty: details!.worktreeDirty, population, workerRuntime, workerTestConfiguration,
          sourceSubmodules: details!.sourceSubmodules, sourceBytes });
        expect(context!.components.source).toBe(measured.components.source);
        expect(context!.components.dependencies).toBe(measured.components.dependencies);
        expect(context!.components.testConfiguration).toBe(measured.components.testConfiguration);
        expect(context!.components.submodules).toBe(measured.components.submodules);
        if (!runtimeKnown) expect(context!.components.dependencies).toBeNull();
        expect(readProofContextIdentity(completion.proofContext)?.components.population)
          .toBe(context!.components.population);
        if (runtimeKnown) expect(consumed.receipts.find(receipt => receipt.completionId === completion.completionId)
          ?.proof.proofContext).toEqual(completion.proofContext);
        expect(native.nativeRun.pid).toBeGreaterThan(0);
        const specification = native.nativeRun.selectedManifest.specifications.find(
          (spec: { testFile: string; projectName: string }) => spec.testFile === suite
            && spec.projectName === population.cases[0]!.identity[0]);
        expect(specification).toBeDefined();
        expect(parseRecordedNativePopulation(completion, specification)).toEqual(population);
        expect(parseRecordedNativePopulation({ ...completion,
          execution: { ...completion.execution, passed: completion.execution.passed + 1 } }, specification))
          .toBeUndefined();
        if (runtimeKnown) expect(consumed.receipts.find(receipt => receipt.completionId === completion.completionId))
          .toMatchObject({ unitId: `test:${suite}`, observedCount: details!.passed,
            proof: { population, producingRun: { qualificationAttemptId: attempt, runGroupId: group,
              completionId: completion.completionId,
              selectedManifestHash: native.nativeRun.selectedManifest.sha256 } } });

        const readOriginal = async () => {
          const result = await runsTool.handler({ testRunIds: [Number(row.id)], limit: 1 } as never,
            {} as never) as { data: { runs: Array<{ id: number; executionDetails: unknown;
              root: string | null; originalResultReference: { sha256: string; testRunId: string } | null;
              executionDetailsUnavailableReason?: string }>;
              originalResultSetReference: { sha256: string; testRunIds: string[] } | null } };
          expect(result.data.runs).toHaveLength(1);
          expect(result.data.runs[0]!.id).toBe(Number(row.id));
          return { ...result.data.runs[0]!, setReference: result.data.originalResultSetReference };
        };
        const originalResult = await readOriginal();
        expect(originalResult.executionDetails).toEqual(details);
        const originalReference = originalResult.originalResultReference;
        expect(originalReference).toMatchObject({ testRunId: row.id, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        const setReference = originalResult.setReference;
        expect(setReference).toMatchObject({ testRunIds: [row.id], sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        const missing = await runsTool.handler({ testRunIds: [Number(row.id), Number.MAX_SAFE_INTEGER] } as never,
          {} as never) as { data: { originalResultSetReference: unknown } };
        expect(missing.data.originalResultSetReference).toBeNull();
        // Keep the original id, outcome and nested population/context stable;
        // only the actual worker capture changes in this disposable PG row.
        try {
          const invalidSourceBytes = { ...sourceBytes!, before: { ...sourceBytes!.before, sha256: 'foreign-source-bytes' } };
          await getOrgPg().sql`UPDATE harness_shared.test_runs SET execution_details =
            ${JSON.stringify({ ...details!, sourceBytes: invalidSourceBytes })}::text::jsonb
            WHERE id::text = ${row.id}`;
          expect(await readOriginal(), 'a malformed source observation must invalidate the original result')
            .toMatchObject({ executionDetails: null, originalResultReference: null, setReference: null });
          const changedCaptureId = randomUUID();
          const changedDetails = { ...details!, workerExecution: { ...workerExecution!, captureId: changedCaptureId },
            workerCompilerInputs: { ...compilerInputs, captureId: changedCaptureId },
            ...(details!.workerDatabaseReset ? { workerDatabaseReset: {
              ...details!.workerDatabaseReset, captureId: changedCaptureId } } : {}) };
          // Validate the complete incarnation before mutating PG. Every bound
          // receipt must move together, while foreign custody stays rejected.
          expect(parseTestRunExecutionDetails(changedDetails), 'changed capture preflight').toBeDefined();
          await getOrgPg().sql`UPDATE harness_shared.test_runs SET execution_details =
            ${JSON.stringify({ ...changedDetails, workerCompilerInputs: compilerInputs })}::text::jsonb
            WHERE id::text = ${row.id}`;
          const foreignCompiler = await readOriginal();
          expect(foreignCompiler.executionDetails).toBeNull();
          expect(foreignCompiler.originalResultReference).toBeNull();
          expect(foreignCompiler.setReference).toBeNull();
          if (details!.workerDatabaseReset) {
            await getOrgPg().sql`UPDATE harness_shared.test_runs SET execution_details =
              ${JSON.stringify({ ...changedDetails, workerDatabaseReset: details!.workerDatabaseReset })}::text::jsonb
              WHERE id::text = ${row.id}`;
            const foreignReset = await readOriginal();
            expect(foreignReset.executionDetails).toBeNull();
            expect(foreignReset.originalResultReference).toBeNull();
            expect(foreignReset.setReference).toBeNull();
          }
          await getOrgPg().sql`UPDATE harness_shared.test_runs SET execution_details =
            ${JSON.stringify(changedDetails)}::text::jsonb
            WHERE id::text = ${row.id}`;
          const changed = await readOriginal();
          expect(changed.executionDetails, changed.executionDetailsUnavailableReason).not.toBeNull();
          expect(changed.originalResultReference).not.toBeNull();
          expect(changed.originalResultReference?.sha256).not.toBe(originalReference!.sha256);
          expect(changed.setReference).not.toBeNull();
          expect(changed.setReference?.sha256).not.toBe(setReference!.sha256);
        } finally {
          await getOrgPg().sql`UPDATE harness_shared.test_runs SET execution_details =
            ${JSON.stringify(row.execution_details)}::text::jsonb WHERE id::text = ${row.id}`;
        }
        expect((await readOriginal()).originalResultReference).toEqual(originalReference);
        expect((await readOriginal()).setReference).toEqual(setReference);
        // Change only independently stored row identities. The nested context
        // remains valid, but belongs to a different original result. Restore
        // this private row after each control so every mismatch is isolated.
        for (const changed of [
          { commit_sha: row.commit_sha === 'f'.repeat(40) ? 'e'.repeat(40) : 'f'.repeat(40) },
          { worktree_dirty: !row.worktree_dirty },
          { workspace_id: `foreign-workspace-${randomUUID()}` },
          { harness_slug: `foreign-harness-${randomUUID()}` },
        ]) {
          try {
            await getOrgPg().sql`UPDATE harness_shared.test_runs SET ${getOrgPg().sql(changed)}
              WHERE id::text = ${row.id}`;
            expect(await readOriginal()).toMatchObject({ executionDetails: null, root: null, originalResultReference: null, setReference: null,
              executionDetailsUnavailableReason: 'row-mismatch' });
          } finally {
            await getOrgPg().sql`UPDATE harness_shared.test_runs SET ${getOrgPg().sql({
              commit_sha: row.commit_sha, worktree_dirty: row.worktree_dirty,
              workspace_id: row.workspace_id, harness_slug: row.harness_slug })}
              WHERE id::text = ${row.id}`;
          }
          expect((await readOriginal()).executionDetails).toEqual(details);
        }

        // Recover the ORIGINAL worker receipt through the real readback query.
        // Labels alone cannot join a result whose full proof/counts changed.
        const inserted = receipts.find(receipt => receipt.outcome === 'inserted' && receipt.id === row.id);
        expect(inserted?.outcome).toBe('inserted');
        const timedOut = { ...inserted!, outcome: 'timeout', reason: 'lost acknowledgement', replayable: false };
        const priorLedger = process.env.PAPERCUSP_TEST_RUNS_DB_URL;
        process.env.PAPERCUSP_TEST_RUNS_DB_URL = org!.adminDsn;
        const releaseLedger = retainSharedPg();
        const recoverOriginal = () => reconcileTimedOutTestRunReceipts(JSON.stringify(timedOut), {
          expectedPaths: [suite], expectedRoot: REPO_ROOT, runGroupId: group, env: {}, timeoutMs: 5_000,
        });
        try {
          expect(await recoverOriginal()).toMatchObject([{ id: row.id, outcome: 'inserted' }]);
          for (const changed of [
            { ...details!, passed: details!.passed + 1 },
            { ...details!, proofContext: { ...context!, fingerprint: 'foreign-proof' } },
            { ...details!, sourceBytes: { ...sourceBytes!, after: { ...sourceBytes!.after, sha256: 'foreign-source-bytes' } } },
            { ...details!, workerTestConfiguration: { ...workerTestConfiguration, before: 'f'.repeat(64) } },
            { ...details!, workerExecution: { ...workerExecution, captureId: randomUUID() } },
          ]) {
            try {
              await getOrgPg().sql`UPDATE harness_shared.test_runs
                SET execution_details = ${JSON.stringify(changed)}::text::jsonb WHERE id::text = ${row.id}`;
              expect(await recoverOriginal(), 'changed original metadata must retain its timeout').toEqual([]);
            } finally {
              await getOrgPg().sql`UPDATE harness_shared.test_runs
                SET execution_details = ${JSON.stringify(row.execution_details)}::text::jsonb WHERE id::text = ${row.id}`;
            }
            expect(await recoverOriginal()).toMatchObject([{ id: row.id, outcome: 'inserted' }]);
          }
        } finally {
          await releaseLedger();
          if (priorLedger === undefined) delete process.env.PAPERCUSP_TEST_RUNS_DB_URL;
          else process.env.PAPERCUSP_TEST_RUNS_DB_URL = priorLedger;
        }

        // Corrupt only this disposable database's original result, then read
        // it through the same consumer. A stored digest is not trusted proof.
        const tampered = await getOrgPg().sql<Array<{ execution_details: unknown }>>`
          UPDATE harness_shared.test_runs
             SET execution_details = jsonb_set(execution_details, '{population,cases,0,outcome}', '"failed"'::jsonb)
           WHERE id::text = ${row.id} RETURNING execution_details
        `;
        expect(tampered).toHaveLength(1);
        expect(parseTestRunExecutionDetails(tampered[0].execution_details)).toBeUndefined();
      }
    } finally {
      await rm(receiptDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('SPEC-P-011-RUNNER-CAPTURE: testing:run records the measured child configuration on every row it records', async () => {
    const nonce = randomUUID();
    process.env[MARKER] = nonce;
    const out = unwrap(await callTestingRun(
      { files: [SUITE], harness: 'papercusp' },
      { projectDir: REPO_ROOT, harnessSlug: '*', workspaceId: 'papercusp-workspace' },
    ));
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(typeof out.runId).toBe('string');

    const rows = await getOrgPg().sql<LedgerRow[]>`
      SELECT id::text AS id, source, execution_details->>'mutationPhase' AS phase, configuration_snapshot
        FROM harness_shared.test_runs
       WHERE run_group_id = ${out.runId!}
    `;
    // Calibration: the run really recorded the suite, so an empty row set cannot pass vacuously.
    expect(rows.length).toBeGreaterThan(0);
    expect(out.testRunIds).toEqual(expect.arrayContaining(rows.map((row) => Number(row.id))));
    expectCapturedBy(rows, nonce);
  }, 180_000);

  it('SPEC-P-011-MUTATION-CAPTURE: a mutation-probe run recorded in the ledger carries the configuration fingerprint', async () => {
    const nonce = randomUUID();
    const group = `mutation-capture-${nonce}`;
    const receiptDir = await mkdtemp(join(tmpdir(), 'p011-mutation-capture-'));
    const receiptFile = join(receiptDir, 'receipts.jsonl');
    try {
      // Exactly the child environment scripts/mutation-probe.sh run_guard exports around a
      // guard command, driving the same router a probe's --test command runs.
      // Two small real suites make the exact-set/limit controls non-vacuous.
      // This ordinary reporter path proves ledger identity only; the separate
      // native control above still owns manifest, worker and context custody.
      await execFileAsync(process.execPath, ['scripts/test-files.mjs', SUITE,
        'packages/operator-core/lib/testing-case-filter.test.ts'], {
        cwd: REPO_ROOT,
        env: {
          ...nestedRouterEnv(receiptDir),
          [MARKER]: nonce,
          PAPERCUSP_TEST_RUN_GROUP: group,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_TEST_RUNS_DB_URL: org!.adminDsn,
          PAPERCUSP_MUTATION_PROBE: '1',
          PAPERCUSP_MUTATION_PHASE: 'baseline',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receiptFile,
        },
        timeout: 150_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      await expectIsolatedRouterCustody(receiptDir, group,
        [SUITE, 'packages/operator-core/lib/testing-case-filter.test.ts']);
      const receipts = (await readFile(receiptFile, 'utf8')).trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { outcome: string; id?: string });
      const ids = receipts.filter((receipt) => receipt.outcome === 'inserted').map((receipt) => String(receipt.id));
      expect(ids.length, JSON.stringify(receipts)).toBeGreaterThan(0);

      const rows = await getOrgPg().sql<Array<LedgerRow & { branch: string | null }>>`
        SELECT id::text AS id, source, execution_details->>'mutationPhase' AS phase, configuration_snapshot, branch
          FROM harness_shared.test_runs
         WHERE id::text = ANY(${ids})
      `;
      expect(rows).toHaveLength(ids.length);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(row.source).toBe('mutation-probe');
        expect(row.phase).toBe('baseline');
      }
      expectCapturedBy(rows, nonce);

      const readSet = async (requested: number[], limit = 100) => {
        const result = await runsTool.handler({ testRunIds: requested, limit } as never, {} as never) as {
          data: { runs: Array<{ id: number; executionDetails: unknown }>;
            originalResultSetReference: { sha256: string; testRunIds: string[] } | null };
        };
        return result.data;
      };
      const requested = ids.map(Number);
      const original = await readSet(requested);
      expect(original.runs).toHaveLength(ids.length);
      expect(original.runs.every(row => row.executionDetails !== null)).toBe(true);
      expect(original.originalResultSetReference).toMatchObject({
        schemaVersion: 'original-test-run-set-reference-v2', scope: 'exact-requested-original-test-runs',
        testRunIds: [...ids].sort((a, b) => Number(a) - Number(b)),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect((await readSet([...requested].reverse())).originalResultSetReference)
        .toEqual(original.originalResultSetReference);
      expect((await readSet(requested, 1)).originalResultSetReference).toBeNull();
      expect((await readSet([...requested, Number.MAX_SAFE_INTEGER])).originalResultSetReference).toBeNull();
      // Change one independently stored original identity, keeping id, outcome
      // and execution metadata intact. Restore the actual row after the control.
      const changedRow = rows[0]!;
      try {
        await getOrgPg().sql`UPDATE harness_shared.test_runs SET branch = ${`set-control-${randomUUID()}`}
          WHERE id::text = ${changedRow.id}`;
        const changed = await readSet(requested);
        expect(changed.originalResultSetReference).not.toBeNull();
        expect(changed.originalResultSetReference?.sha256).not.toBe(original.originalResultSetReference!.sha256);
      } finally {
        await getOrgPg().sql`UPDATE harness_shared.test_runs SET branch = ${changedRow.branch}
          WHERE id::text = ${changedRow.id}`;
      }
      expect((await readSet(requested)).originalResultSetReference).toEqual(original.originalResultSetReference);
      // The configuration is an independent ledger column, outside execution_details.
      // Its verified content must participate even when every outcome/identity stays fixed.
      const changedConfiguration = captureConfigurationSnapshot({ [MARKER]: `${nonce}-changed` });
      try {
        for (const stored of [changedConfiguration, null, { ...changedConfiguration, fingerprint: 'forged' }]) {
          await getOrgPg().sql`UPDATE harness_shared.test_runs SET configuration_snapshot =
            ${JSON.stringify(stored)}::text::jsonb WHERE id::text = ${changedRow.id}`;
          const changed = await readSet(requested);
          if (stored === changedConfiguration) {
            expect(changed.originalResultSetReference).not.toBeNull();
            expect(changed.originalResultSetReference?.sha256).not.toBe(original.originalResultSetReference!.sha256);
          } else expect(changed.originalResultSetReference).toBeNull();
        }
      } finally {
        await getOrgPg().sql`UPDATE harness_shared.test_runs SET configuration_snapshot =
          ${JSON.stringify(changedRow.configuration_snapshot)}::text::jsonb WHERE id::text = ${changedRow.id}`;
      }
      expect((await readSet(requested)).originalResultSetReference).toEqual(original.originalResultSetReference);
    } finally {
      await rm(receiptDir, { recursive: true, force: true });
    }
  }, 180_000);
});
