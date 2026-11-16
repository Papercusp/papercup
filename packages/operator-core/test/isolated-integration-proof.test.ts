/** isolatedWorkerFailureDetail must never let a harness-deadline kill masquerade
 * as the worker's own failure (WI-6554700010042656: a 180s execute deadline killed
 * the process group mid-import, tsx's esbuild service died with it, and the phase
 * detail reported only "TransformError: The service is no longer running"). */
import { describe, expect, it, vi } from 'vitest';
import { assertIsolatedFileRunBudget, assertIsolatedIntegrationWorkerEnvironment, codexManagedToolsNativeIntegrationSourcePaths, codexManagedToolsNativeProofOptions, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from './isolated-integration-proof';
import { privateOperatorApiBuildBudget } from './private-http-workspace-preflight';
import { RESTRICTED_HOLD_PREFLIGHT_TIMEOUT_MS } from '../../../scripts/lib/restricted-hold-preflight.mjs';

describe('isolated integration worker environment', () => {
  const owned = { PAPERCUSP_WORKSPACE: 'test-runtime-private',
    PAPERCUSP_WORKSPACE_ID: 'test-runtime-private', PAPERCUSP_SKIP_PG_DISCOVERY: '1',
    PC_ISOLATED_RUNTIME_PROOF: '1' };

  it('accepts the owned workspace after actual Vitest setup scrubs its process pin', async () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, owned);
      vi.resetModules();
      await import('../../../libs/test-config/src/setup-hermetic-env');
      expect(process.env.PAPERCUSP_WORKSPACE_ID).toBeUndefined();
      expect(process.env.PAPERCUSP_WORKSPACE).toBe(owned.PAPERCUSP_WORKSPACE);
      expect(process.env.PAPERCUSP_SKIP_PG_DISCOVERY).toBe('1');
      // Reproduces the former guard's failure after the launcher's correct handoff.
      expect(/^test-runtime-/.test(process.env.PAPERCUSP_WORKSPACE_ID ?? '')).toBe(false);
      expect(assertIsolatedIntegrationWorkerEnvironment()).toBe(owned.PAPERCUSP_WORKSPACE);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  it('accepts matching launcher pins before worker setup', () => {
    expect(assertIsolatedIntegrationWorkerEnvironment(owned)).toBe(owned.PAPERCUSP_WORKSPACE);
  });

  it.each([
    { PAPERCUSP_WORKSPACE: 'papercusp-workspace', PAPERCUSP_WORKSPACE_ID: undefined },
    { PAPERCUSP_WORKSPACE: undefined },
    { PAPERCUSP_WORKSPACE_ID: 'test-runtime-another' },
    { PAPERCUSP_SKIP_PG_DISCOVERY: undefined },
    { PAPERCUSP_SKIP_PG_DISCOVERY: '0' },
    { PC_ISOLATED_RUNTIME_PROOF: undefined },
  ])('refuses an unowned or inconsistent runtime: %j', override => {
    expect(() => assertIsolatedIntegrationWorkerEnvironment({ ...owned, ...override }))
      .toThrow('Proof worker requires the owned isolated runtime');
  });
});

it('pins the private registry writer and PG state store in the Codex proof source manifest', () => {
  expect(codexManagedToolsNativeIntegrationSourcePaths).toEqual(expect.arrayContaining([
    'packages/operator-core/lib/harness-registry.ts',
    'packages/operator-core/lib/operator-state-pg.ts',
  ]));
});

const killedMidImport = [
  'NATIVE_INCIDENT_API_STAGE=handler-loaded',
  'NATIVE_INCIDENT_API_STAGE=import-start:fixture-stores',
  'Error [TransformError]: The service is no longer running',
  '    at sendRequest (node_modules/esbuild/lib/main.js:599:36)',
].join('\n');

describe('isolatedWorkerFailureDetail', () => {
  it('leads with the deadline, its phase and the last fixture stage when the harness ended the worker', () => {
    const detail = isolatedWorkerFailureDetail(killedMidImport,
      { timedOut: true, timeoutPhase: 'bootstrap', signal: 'SIGTERM' });
    const [first] = detail.split('\n');
    expect(first).toContain('ISOLATED_WORKER_DEADLINE phase=bootstrap signal=SIGTERM');
    expect(first).toContain('lastStage=NATIVE_INCIDENT_API_STAGE=import-start:fixture-stores');
    // The consequent error is kept, but only after the deadline that caused it.
    expect(detail.indexOf('TransformError')).toBeGreaterThan(detail.indexOf('ISOLATED_WORKER_DEADLINE'));
  });

  it('keeps structured *_FAILURE lines after the deadline header', () => {
    const detail = isolatedWorkerFailureDetail('NATIVE_REUSE_FAILURE {"reason":"x"}\nnoise',
      { timedOut: true, timeoutPhase: 'execute', signal: 'SIGTERM' });
    expect(detail.split('\n')).toEqual([
      expect.stringContaining('ISOLATED_WORKER_DEADLINE phase=execute signal=SIGTERM lastStage=none'),
      'NATIVE_REUSE_FAILURE {"reason":"x"}',
    ]);
  });

  it('is unchanged for a worker that failed on its own', () => {
    for (const capture of [undefined, { timedOut: false, timeoutPhase: null, signal: null }]) {
      const detail = isolatedWorkerFailureDetail(killedMidImport, capture);
      expect(detail).not.toContain('ISOLATED_WORKER_DEADLINE');
      expect(detail.startsWith('Error [TransformError]')).toBe(true);
    }
  });
});

describe('isolatedWorkerOptions', () => {
  it('gives bootstrap its own budget so PG boot never consumes the execute allowance', () => {
    const options = isolatedWorkerOptions(180_000, {});
    expect(options.phaseTimeouts.executeMs).toBe(180_000);
    expect(options.phaseTimeouts.bootstrapMs).toBeGreaterThan(0);
    expect(options.testTimeoutMs).toBeGreaterThan(options.phaseTimeouts.bootstrapMaxMs! + 180_000);
  });
});

describe('isolated proof enclosing file deadline', () => {
  it('contains compilation and the final source census before reserving the original HTTP assertion lifetime', async () => {
    const builder = privateOperatorApiBuildBudget();
    const withoutPreparation = isolatedWorkerOptions(480_000, {});
    const prepared = isolatedWorkerOptions(480_000, {}, 480_000, {}, builder.maxMs);
    expect(builder.maxMs - 420_000).toBe(RESTRICTED_HOLD_PREFLIGHT_TIMEOUT_MS);
    expect(prepared.phaseTimeouts).toEqual(withoutPreparation.phaseTimeouts);
    expect(prepared.testTimeoutMs - withoutPreparation.testTimeoutMs).toBe(builder.maxMs);
    expect(() => assertIsolatedFileRunBudget(prepared.testTimeoutMs,
      { PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(prepared.testTimeoutMs) })).not.toThrow();
    const prepare = vi.fn();
    const execute = vi.fn();
    vi.stubEnv('PAPERCUSP_TEST_FILE_TIMEOUT_MS', String(prepared.testTimeoutMs - 1));
    try {
      await expect(recordIsolatedIntegrationProof({ root: '/must-not-allocate-consult-http-proof',
        filePath: 'consult-cascade-http.integration.test.ts', sourcePaths: [],
        minimumFileRunTimeoutMs: prepared.testTimeoutMs, prepare, execute,
      })).rejects.toThrow('enclosing router has');
      expect(prepare).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it('contains both Codex worker lifetimes without inheriting the encompassing file timeout', () => {
    const original = codexManagedToolsNativeProofOptions();
    vi.stubEnv('PAPERCUSP_TEST_FILE_TIMEOUT_MS', '7200000');
    vi.stubEnv('PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS', '600000');
    try {
      expect(codexManagedToolsNativeProofOptions()).toEqual(original);
      expect(original.routerEnv.PAPERCUSP_TEST_FILE_TIMEOUT_MS).toBe('600000');
      // Existing assertion deadlines total 335s. Collection and lifecycle
      // cleanup have their own maxima and cannot spend that assertion budget.
      expect(Number(original.routerEnv.PAPERCUSP_TEST_FILE_TIMEOUT_MS)).toBeGreaterThan(335_000);
      expect(original.runtimeWorker.phaseTimeouts.executeMs)
        .toBeGreaterThan(original.censusWorker.testTimeoutMs);
      for (const worker of [original.censusWorker, original.runtimeWorker]) {
        expect(worker.phaseTimeouts.bootstrapMaxMs).toBe(600_000);
        expect(worker.phaseTimeouts.finalizeMaxMs).toBe(600_000);
        expect(worker.phaseTimeouts.teardownMaxMs).toBe(600_000);
      }
      expect(() => assertIsolatedFileRunBudget(original.runtimeWorker.testTimeoutMs,
        { PAPERCUSP_TEST_FILE_TIMEOUT_MS: '7200000' })).not.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });

  it('refuses an undersized Codex parent before preparing its API or observing source', async () => {
    const { runtimeWorker } = codexManagedToolsNativeProofOptions();
    const prepare = vi.fn();
    const execute = vi.fn();
    vi.stubEnv('PAPERCUSP_TEST_FILE_TIMEOUT_MS', String(runtimeWorker.testTimeoutMs - 1));
    try {
      await expect(recordIsolatedIntegrationProof({ root: '/must-not-allocate-codex-proof',
        filePath: 'codex-managed-tools.native.integration.test.ts', sourcePaths: [],
        minimumFileRunTimeoutMs: runtimeWorker.testTimeoutMs, prepare, execute,
      })).rejects.toThrow('enclosing router has');
      expect(prepare).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([undefined, '600000'])('refuses an undersized file budget (%s) before source or worker allocation', async budget => {
    const options = isolatedWorkerOptions(480_000, {});
    const execute = vi.fn();
    vi.stubEnv('PAPERCUSP_TEST_FILE_TIMEOUT_MS', budget);
    try {
      await expect(recordIsolatedIntegrationProof({
        // This root must never be inspected: deadline admission precedes source
        // observation, telemetry database setup and execute.
        root: '/not-an-allocated-proof-root', filePath: 'consult-http-budget.test.ts',
        sourcePaths: [], minimumFileRunTimeoutMs: options.testTimeoutMs, execute,
      })).rejects.toThrow(`Isolated proof requires PAPERCUSP_TEST_FILE_TIMEOUT_MS >= ${options.testTimeoutMs}`);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([480_000, 600_000])('admits the composed %ims worker budget exactly and refuses one millisecond less', executeMs => {
    const { testTimeoutMs } = isolatedWorkerOptions(executeMs, {});
    expect(() => assertIsolatedFileRunBudget(testTimeoutMs,
      { PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(testTimeoutMs) })).not.toThrow();
    expect(() => assertIsolatedFileRunBudget(testTimeoutMs,
      { PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(testTimeoutMs + 1) })).not.toThrow();
    expect(() => assertIsolatedFileRunBudget(testTimeoutMs,
      { PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(testTimeoutMs - 1) })).toThrow('enclosing router has');
  });

  it('refuses an undersized working-tree API parent before allocating a private runtime', async () => {
    const worker = isolatedWorkerOptions(600_000, {});
    const execute = vi.fn();
    vi.stubEnv('PAPERCUSP_TEST_FILE_TIMEOUT_MS', String(worker.testTimeoutMs - 1));
    try {
      await expect(recordIsolatedIntegrationProof({ root: '/must-not-allocate-working-tree-api-proof',
        filePath: 'working-tree-operator-api.integration.test.ts', sourcePaths: [],
        minimumFileRunTimeoutMs: worker.testTimeoutMs, execute,
      })).rejects.toThrow(`Isolated proof requires PAPERCUSP_TEST_FILE_TIMEOUT_MS >= ${worker.testTimeoutMs}`);
      expect(execute).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
