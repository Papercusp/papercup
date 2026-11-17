/** isolatedWorkerFailureDetail must never let a harness-deadline kill masquerade
 * as the worker's own failure (WI-6554700010042656: a 180s execute deadline killed
 * the process group mid-import, tsx's esbuild service died with it, and the phase
 * detail reported only "TransformError: The service is no longer running"). */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { readBaselinePacket, retainBaselinePacket } from './task-artifacts-baseline-repair';
import { assertIsolatedFileRunBudget, assertIsolatedIntegrationWorkerEnvironment, assertIsolatedPreflightRejection, cleanupCurrentSuNativeEgress, CURRENT_SU_NATIVE_EGRESS_RUN_ID_MANIFEST, currentSuNativeRetainedArtifacts, codexManagedToolsNativeIntegrationSourcePaths, codexManagedToolsNativeProofOptions, isolatedIntegrationProofSourcePaths, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof, withNativeProofLedger, nativeProofRecorder } from './isolated-integration-proof';
import type { ProcExec } from '../lib/external-bench/grader/swe-bench-pro';
import { nativeProofFingerprint, readNativeProofRun, type NativeProofInput } from '../lib/testing-run-store';
import { privateOperatorApiBuildBudget } from './private-http-workspace-preflight';
import { RESTRICTED_HOLD_PREFLIGHT_TIMEOUT_MS } from '../../../scripts/lib/restricted-hold-preflight.mjs';

const methodAuthority = vi.hoisted(() => vi.fn());
vi.mock('./native-method-authority', () => ({ verifyNativeMethodAuthority: methodAuthority }));

describe('isolated producer archive retention', () => {
  it('retains complete large originals through the actual failed-prepare teardown and a fresh reader', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'isolated-produced-retention-'));
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', join(directory, 'canonical'));
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(directory, 'mutex'));
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(directory, 'pins'));
    const original = Buffer.alloc(16 * 1024 * 1024 + 1, 97);
    original[original.length - 1] = 122;
    const fingerprint = createHash('sha256').update('retention-only edition').digest('hex');
    const execute = vi.fn();
    const archive = vi.fn(async (runDir: string) => {
      const seal = retainBaselinePacket(runDir, join(runDir, '../retained', runDir.split('/').at(-1)!, 'objects'),
        fingerprint, ['phases/prepare/original.json']);
      await writeFile(join(runDir, 'phases/teardown/packet.json'), seal, { flag: 'wx' });
      return ['phases/teardown/packet.json'];
    });
    try {
      await expect(recordIsolatedIntegrationProof({ root: resolve(import.meta.dirname, '../../..'),
        filePath: 'packages/operator-core/test/isolated-integration-proof.test.ts', sourcePaths: [],
        // The real pre-observer path runs prepare before allocating the org DB.
        // The intentional preparation failure owns no worker or private PG.
        requiredPreparation: {} as never,
        prepare: async evidenceDir => {
          await writeFile(join(evidenceDir, 'original.json'), original);
          throw new Error('original-producer-refused-after-writing');
        }, retainProducedArtifacts: archive, execute,
      })).rejects.toThrow('original-producer-refused-after-writing');
      expect(archive).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
      const runDir = await realpath(join(directory, 'canonical/isolated-integration/latest'));
      const retained = join(runDir, '../retained', runDir.split('/').at(-1)!);
      const seal = await readFile(join(retained, 'phases/teardown/packet.json'));
      await rm(runDir, { recursive: true });
      const recovered = readBaselinePacket(seal, createHash('sha256').update(seal).digest('hex'), fingerprint);
      expect(recovered.read('phases/prepare/original.json').equals(original)).toBe(true);
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('native egress parent recovery', () => {
  const runId = 'PRIVATE-CURRENT-SU-12345678-1234-4123-8123-123456789abc';
  const dockerHost = 'unix:///run/docker-bench.sock';
  const reaped = { exitCode: null, signalCode: 'SIGKILL' as const };
  const withEvidence = async (run: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), 'native-egress-parent-'));
    try { await run(dir); }
    finally { await rm(dir, { recursive: true, force: true }); }
  };
  const receipt = async (dir: string) => JSON.parse(await readFile(join(dir, 'current-su-native-egress-cleanup.json'), 'utf8'));

  it('recovers only the recorded run after a real worker is killed before its finally', async () => withEvidence(async dir => {
    const child = spawn(process.execPath, ['-e',
      "require('node:fs').writeFileSync(process.argv[1], process.argv[2]); process.kill(process.pid, 'SIGKILL')",
      join(dir, CURRENT_SU_NATIVE_EGRESS_RUN_ID_MANIFEST), runId + '\n'], { stdio: 'ignore' });
    await once(child, 'close');
    expect(child.signalCode).toBe('SIGKILL');
    const calls: string[][] = [];
    const exec: ProcExec = async (command, args) => {
      expect(command).toBe('docker'); calls.push([...args]);
      const op = args.slice(2, 4).join(' ');
      return { code: 0, stderr: '', stdout: op === 'ps -aq' ? 'owned-container\n'
        : op === 'network ls' ? 'owned-network\n' : '' };
    };
    await expect(cleanupCurrentSuNativeEgress(dir, { worker: child, dockerHost, exec }))
      .resolves.toMatchObject({ runId, workerReaped: true, status: 'cleaned', errors: [] });
    expect(calls).toEqual([
      ['--host', dockerHost, 'ps', '-aq', '--filter', 'label=papercusp.bench-egress=' + runId.toLowerCase()],
      ['--host', dockerHost, 'rm', '-f', 'owned-container'],
      ['--host', dockerHost, 'network', 'ls', '-q', '--filter', 'label=papercusp.bench-egress=' + runId.toLowerCase()],
      ['--host', dockerHost, 'network', 'rm', 'owned-network'],
    ]);
    expect(await receipt(dir)).toMatchObject({ runId, dockerHost, status: 'cleaned', workerReaped: true });
    expect(child.signalCode).toBe('SIGKILL');
    expect(currentSuNativeRetainedArtifacts(true)).toEqual(expect.arrayContaining([
      'phases/execute/' + CURRENT_SU_NATIVE_EGRESS_RUN_ID_MANIFEST,
      'phases/execute/current-su-native-egress-cleanup.json',
    ]));
  }));

  it('records no allocation without querying Docker when the worker never wrote a manifest', async () => withEvidence(async dir => {
    const exec = vi.fn<ProcExec>();
    await expect(cleanupCurrentSuNativeEgress(dir, { worker: reaped, dockerHost, exec }))
      .resolves.toMatchObject({ runId: null, status: 'not-started' });
    expect(exec).not.toHaveBeenCalled();
    expect(await receipt(dir)).toMatchObject({ status: 'not-started' });
  }));

  it.each(['peer-run', runId + '\npeer-run', ''])('refuses an invalid cleanup key (%j) before any Docker call', async value => withEvidence(async dir => {
    await writeFile(join(dir, CURRENT_SU_NATIVE_EGRESS_RUN_ID_MANIFEST), value);
    const exec = vi.fn<ProcExec>();
    await expect(cleanupCurrentSuNativeEgress(dir, { worker: reaped, dockerHost, exec }))
      .rejects.toThrow('exact private fixture runId');
    expect(exec).not.toHaveBeenCalled();
    expect(await receipt(dir)).toMatchObject({ status: 'failed' });
  }));

  it('refuses a manifest symlink before reading a cleanup key', async () => withEvidence(async dir => {
    await writeFile(join(dir, 'peer-key'), runId);
    await symlink(join(dir, 'peer-key'), join(dir, CURRENT_SU_NATIVE_EGRESS_RUN_ID_MANIFEST));
    const exec = vi.fn<ProcExec>();
    await expect(cleanupCurrentSuNativeEgress(dir, { worker: reaped, dockerHost, exec }))
      .rejects.toThrow('bounded regular file');
    expect(exec).not.toHaveBeenCalled();
  }));

  it.each(['live-worker', 'missing-daemon'])('refuses unsafe cleanup (%s)', async boundary => withEvidence(async dir => {
    await writeFile(join(dir, CURRENT_SU_NATIVE_EGRESS_RUN_ID_MANIFEST), runId);
    const exec = vi.fn<ProcExec>();
    await expect(cleanupCurrentSuNativeEgress(dir, {
      worker: boundary === 'live-worker' ? { exitCode: null, signalCode: null } : reaped,
      dockerHost: boundary === 'missing-daemon' ? '' : dockerHost, exec,
    })).rejects.toThrow(boundary === 'live-worker' ? 'reaped worker' : 'explicit Docker host');
    expect(exec).not.toHaveBeenCalled();
    expect(await receipt(dir)).toMatchObject({ status: 'failed' });
  }));

  it('retains failed cleanup and fails acceptance when Docker refuses a scoped sweep', async () => withEvidence(async dir => {
    await writeFile(join(dir, CURRENT_SU_NATIVE_EGRESS_RUN_ID_MANIFEST), runId);
    const exec: ProcExec = async () => ({ code: 1, stdout: '', stderr: 'engine refused' });
    await expect(cleanupCurrentSuNativeEgress(dir, { worker: reaped, dockerHost, exec }))
      .rejects.toThrow('recovery cleanup must complete');
    expect(await receipt(dir)).toMatchObject({ runId, status: 'failed', errors: expect.arrayContaining([
      expect.stringContaining('engine refused'),
    ]) });
  }));
});

describe('isolated negative preflight evidence', () => {
  const expected = 'MCP tool call requires approval, but approval policy is never';
  const withEvidence = async (run: (path: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), 'isolated-negative-preflight-'));
    try { await run(join(dir, 'failure.json')); }
    finally { await rm(dir, { recursive: true, force: true }); }
  };

  it.each([9999, 10000, 10001, 30000])('retains %i stderr characters and the original subprocess error instead of a matcher diff', length => withEvidence(async path => {
    const stderr = 'x'.repeat(length) + ' decisive-tail';
    let original: unknown;
    await expect(assertIsolatedPreflightRejection(async () => {
      try {
        execFileSync(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(7)`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { original = error; throw error; }
    }, expected, path)).rejects.toBe(original);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.outcome).toBe('rejected');
    expect(saved.failure).toContain(stderr);
    expect(saved.failure).toContain('status: 7');
    expect(saved.failure).not.toContain('more characters');
  }));

  it('preserves catalog timeout fields and the complete path', () => withEvidence(async path => {
    const executable = '/installed/' + 'long-directory/'.repeat(40) + 'codex';
    const failure = Object.assign(new Error(`spawnSync ${executable} ETIMEDOUT`), {
      code: 'ETIMEDOUT', errno: -110, signal: 'SIGTERM', status: null,
      path: executable, spawnargs: ['debug', 'models'], stdout: '', stderr: '',
    });
    await expect(assertIsolatedPreflightRejection(async () => { throw failure; }, expected, path))
      .rejects.toBe(failure);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    for (const value of [executable, 'ETIMEDOUT', 'SIGTERM', 'errno: -110', 'debug', 'models']) {
      expect(saved.failure).toContain(value);
    }
  }));

  it('accepts the expected refusal with its retained evidence', () => withEvidence(async path => {
    await assertIsolatedPreflightRejection(async () => { throw new Error(expected); }, expected, path);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved).toMatchObject({ outcome: 'rejected', expectedMessage: expected });
    expect(saved.failure).toContain(expected);
  }));

  it('fails a missing refusal and records that the control succeeded unexpectedly', () => withEvidence(async path => {
    await expect(assertIsolatedPreflightRejection(async () => {}, expected, path))
      .rejects.toThrow('Preflight unexpectedly succeeded');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ outcome: 'resolved', failure: null });
  }));

  it('keeps the original failure if retaining the evidence also fails', async () => {
    const failure = new Error('catalog executable failed');
    const dir = await mkdtemp(join(tmpdir(), 'isolated-negative-preflight-'));
    try {
      await expect(assertIsolatedPreflightRejection(async () => { throw failure; }, expected, dir))
        .rejects.toMatchObject({ errors: [failure, expect.objectContaining({ code: 'EISDIR' })] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('P010 native proof allocation admission', () => {
  it('reads fresh original custody events from the durable ledger and refuses a missing or substituted intent', async () => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const input: NativeProofInput = { schemaVersion: 1,
      scope: { workspaceId: 'synthetic-custody', harnessSlug: 'native', planSlug: 'native-custody' },
      original: { sourceSha: 'a'.repeat(40), fixtureSha256: digest('fixture'), captureSha256: digest('capture'),
        sourceDigests: { original: digest('original') }, dependenciesReconstructed: false },
      prerequisiteSources: { child: digest('child') },
      method: { sha256: digest('method'), configurationSha256: digest('config'), clientMatrix: ['native'] },
      selectedInputs: { 'package.json': digest('manifest') },
      plannedRepair: { lockSha256: digest('lock'), packageDeltaSha256: digest('delta'), candidateGraphSha256: digest('graph') },
      toolchain: { npmSha256: digest('npm'), npmVersion: '11', nodeVersion: '25', nativeAbi: '141' } };
    const fingerprint = nativeProofFingerprint(input).fingerprint, runId = 'native-proof-' + fingerprint;
    const envelope = { schemaVersion: 1, fingerprint, input, admission: { reviewedFingerprint: fingerprint,
      reviewRef: 'thread-post:123', preflightRefs: { numericFold: 'fold', physicalInstall: 'install', priorFailureAudit: 'audit' } } };
    const events = [{ kind: 'reserved', fingerprint }, { kind: 'started', fingerprint }];
    let rows = [{ run_id: runId, native_proof_input: envelope,
      native_proof_events: events, native_proof_child_launch: null }];
    const sql = vi.fn(async () => rows);
    const intent = await readNativeProofRun(sql, runId);
    expect(intent).toBeTruthy();
    const recorder = nativeProofRecorder(sql, intent!);
    const installed = { kind: 'installed', fingerprint, receiptRef: '/original/installed.json', receiptSha256: digest('installed') };
    rows[0].native_proof_events = [...events, installed];
    expect((await recorder.readIntent()).events.at(-1)).toEqual(installed);
    expect(intent!.events).toHaveLength(2);
    rows = [];
    await expect(recorder.readIntent()).rejects.toThrow('Native proof original intent changed');
    const other = nativeProofFingerprint({ ...input, method: { ...input.method, sha256: digest('other method') } });
    rows = [{ run_id: 'native-proof-' + other.fingerprint,
      native_proof_input: { ...envelope, input: other.input, fingerprint: other.fingerprint,
        admission: { ...envelope.admission, reviewedFingerprint: other.fingerprint } },
      native_proof_events: events.map(event => ({ ...event, fingerprint: other.fingerprint })), native_proof_child_launch: null }];
    await expect(recorder.readIntent()).rejects.toThrow('Native proof original intent changed');
    expect(sql).toHaveBeenLastCalledWith(expect.anything(), runId);
  });
  it.each([false, true])('validates canonical method authority before ledger start or prepare (approved=%s)', async approved => {
    const root = resolve(import.meta.dirname, '../../..');
    const filePath = 'packages/operator-core/lib/task-artifacts-client-baseline.integration.test.ts';
    const entry = 'packages/operator-core/test/task-artifacts-baseline-http-fixture.ts';
    const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const input: NativeProofInput = { schemaVersion: 1,
      scope: { workspaceId: 'ws-method', harnessSlug: 'native', planSlug: 'plan-native' },
      original: { sourceSha: 'a'.repeat(40), fixtureSha256: digest('fixture'), captureSha256: digest('capture'),
        sourceDigests: { original: digest('original') }, dependenciesReconstructed: false },
      prerequisiteSources: Object.fromEntries(isolatedIntegrationProofSourcePaths(filePath, [entry])
        .map(path => [path, digest(readFileSync(join(root, path)))])),
      method: { sha256: digest('method'), configurationSha256: digest('config'), clientMatrix: ['mcp', 'ptool'] },
      selectedInputs: { 'package.json': digest('manifest') },
      plannedRepair: { lockSha256: digest('lock'), packageDeltaSha256: digest('delta'), candidateGraphSha256: digest('graph') },
      toolchain: { npmSha256: digest('npm'), npmVersion: '11', nodeVersion: '25', nativeAbi: '141' },
    };
    const fingerprint = nativeProofFingerprint(input).fingerprint;
    const admission = { reviewedFingerprint: fingerprint, reviewRef: 'thread-post:123',
      preflightRefs: { numericFold: 'fold-proof', physicalInstall: 'install-proof', priorFailureAudit: 'audit-proof' } };
    const beginCalls = vi.fn();
    const begin: Sql['begin'] = async () => { beginCalls(); throw new Error('ledger-start-sentinel'); };
    const sql = Object.assign(vi.fn(async () => []), { begin });
    const prepare = vi.fn(); const execute = vi.fn();
    methodAuthority.mockReset();
    if (approved) methodAuthority.mockResolvedValue({ fingerprint });
    else methodAuthority.mockRejectedValue(new Error('canonical-method-refused'));
    await expect(recordIsolatedIntegrationProof({ root, filePath, sourcePaths: [entry], nativeChildEntryPoint: entry,
      nativeProof: { sql, input, admission }, prepare, execute }))
      .rejects.toThrow(approved ? 'ledger-start-sentinel' : 'canonical-method-refused');
    expect(methodAuthority).toHaveBeenCalledWith(root, expect.objectContaining({
      workspaceId: input.scope.workspaceId, harnessSlug: input.scope.harnessSlug,
      subjectPlan: input.scope.planSlug, fingerprint, reviewRef: admission.reviewRef }), { signal: undefined });
    expect(beginCalls).toHaveBeenCalledTimes(approved ? 1 : 0);
    expect(sql).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('refuses implicit product-database fallback without entering the effect', async () => {
    const execute = vi.fn();
    await expect(withNativeProofLedger({ HARNESS_ADMIN_DATABASE_URL: 'postgresql://product-only/fixture' }, execute))
      .rejects.toThrow('explicit durable test-run ledger URL');
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses a baseline successor with no durable intent before inspecting a root or entering prepare', async () => {
    const prepare = vi.fn();
    const execute = vi.fn();
    await expect(recordIsolatedIntegrationProof({ root: '/must-not-allocate-native-baseline',
      filePath: 'packages/operator-core/lib/task-artifacts-client-baseline.integration.test.ts',
      sourcePaths: [], prepare, execute,
    })).rejects.toThrow('durable prelaunch admission before allocation/prepare');
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

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
