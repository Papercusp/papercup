/** Real current-su launcher, private current-build operator and task container.
 * Local refusal/scripted protocol listeners have no provider forwarding code. */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { expect, it, type TestContext, vi } from 'vitest';
import { defaultEvidenceRoot, runHarness } from '@papercusp/verification-harness';
import type {} from '../../test/current-su-native-http-scenario';
import type {} from '../../test/staging-first-http-fixture';
import { captureIsolatedWorker, cleanupCurrentSuNativeEgress, currentSuNativeRetainedArtifacts, CURRENT_SU_RECOVERY_ALLOCATION_ARTIFACTS,
  isolatedWorkerFailureDetail, isolatedWorkerOptions,
  preflightCurrentSuNativeEgress, recordIsolatedIntegrationProof, withNativeProofLedger,
  nativeProofRecorder } from '../../test/isolated-integration-proof';
import { assertBaselineInstalledTree, assertBaselineToolchain, captureBaselineInstalledTree,
  readBaselinePacket, retainBaselinePacket } from '../../test/task-artifacts-baseline-repair';
import { readNativeProofRun } from '../testing-run-store';
import { preparePrivateOperatorApiBundle, privateMcpSourceSha, privateNativeDockerHost } from '../../test/private-http-workspace-preflight';
import { CC_HOOK_FILES } from '../desktop-install/papercusp-files';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000);
const recoveryProofBudgetMs = 1_200_000;
const hookSources = 'apps/operator/scripts/hooks';
const hookInputs = [...CC_HOOK_FILES.map(name => `${hookSources}/cc/${name}`),
  ...['inject', 'inject/adapters'].flatMap(dir => readdirSync(join(root, hookSources, dir))
    .filter(name => name.endsWith('.mjs')).map(name => `${hookSources}/${dir}/${name}`))];

async function nativeScenario(scenario: 'current-su-native' | 'current-su-native-carry'
  | 'current-su-native-frozen-carry-on' | 'current-su-native-frozen-carry-off'
  | 'current-su-native-recovery-baseline', context: TestContext) {
  const dockerHost = privateNativeDockerHost(['--native-docker-host=' + (process.env.DOCKER_HOST ?? '')]);
  let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>> | undefined;
  let preparedSourceSha: string | undefined;
  type NativeAdmission = NonNullable<Parameters<typeof recordIsolatedIntegrationProof>[0]['nativeProof']>;
  const recovery = scenario === 'current-su-native-recovery-baseline';
  const runProof = (nativeProof?: NativeAdmission) => recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/external-bench/current-su-native.integration.test.ts',
    ...(nativeProof ? { nativeProof, nativeChildEntryPoint: 'packages/operator-core/test/staging-first-http-fixture.ts',
      minimumFileRunTimeoutMs: recoveryProofBudgetMs } : {}),
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/current-su-native-http-scenario.ts',
      'packages/operator-core/test/current-su-native-http-protocol.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/external-bench/current-su.ts',
      'packages/operator-core/lib/external-bench/frontier-swe-launch-adapter.ts',
      'packages/operator-core/lib/external-bench/frontier-swe-seam.ts',
      'packages/operator-core/lib/external-bench/container-exec-target.ts',
      'packages/operator-core/lib/external-bench/codex-hook-bridge.ts',
      'packages/operator-core/lib/external-bench/bench-egress.ts',
      'packages/operator-core/lib/external-bench/grader/index.ts',
      'packages/operator-core/lib/external-bench/grader/swe-bench-pro.ts',
      'packages/operator-core/lib/agent-tools/session/request-compaction.ts',
      'packages/operator-core/lib/capability-envelope/session-confinement.ts',
      'packages/operator-core/lib/carry-respawn.ts', 'packages/operator-core/lib/carry-doc.ts',
      'packages/operator-core/lib/agent-tools/capability/launch-agent.ts',
      'packages/operator-core/lib/console-spawn.ts', 'apps/operator/scripts/psu-launcher.mjs',
      'apps/operator/scripts/psu-pty-host.mjs',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'packages/operator-core/lib/desktop-install/papercusp-files.ts',
      'packages/operator-core/lib/role-codex-home.ts', ...hookInputs,
      ...(recovery ? ['packages/operator-core/test/task-artifacts-baseline-repair.ts',
        'packages/operator-core/lib/task-artifacts-baseline-custody.ts',
        'scripts/npm-install-safe.mjs', 'apps/operator/bin/release/dependency-generation.sh',
        'apps/operator/bin/release/dependency-lock-tree-audit.mjs',
        'packages/operator-core/lib/testing-run-store.ts', 'packages/operator-core/test/native-method-authority.ts',
        'packages/operator-core/test/native-method-authority-fixture.ts',
        'packages/operator-core/lib/consult/get-feedback-prod.ts', 'packages/operator-core/lib/consult/review-findings.ts',
        'packages/operator-core/lib/consult/selection-policies.ts', 'packages/operator-core/lib/rubrics.ts',
        'packages/operator-core/lib/acceptance-author-identity.ts'] : [])],
    retainedArtifacts: [...currentSuNativeRetainedArtifacts(scenario !== 'current-su-native'),
      ...(scenario !== 'current-su-native' ? ['phases/execute/native-carry-packet.json',
        'phases/execute/native-carry-input.json'] : []),
      ...(scenario === 'current-su-native-recovery-baseline' ? ['phases/execute/native-recovery-fixture.json',
        'phases/execute/native-recovery-continuation.json', 'phases/execute/native-recovery-readback.json',
        'phases/execute/native-recovery-runtime.json', 'phases/prepare/native-recovery-installed.json',
        'phases/prepare/native-recovery-built.json', 'phases/prepare/native-recovery-installed-tree.json',
        'phases/execute/native-recovery-runtime-custody-before.json',
        'phases/execute/native-recovery-runtime-custody-after.json',
        'phases/execute/native-recovery-runtime-custody-trace.json'] : []),
      ...(scenario.includes('-frozen-carry-') ? ['phases/execute/native-frozen-carry-delivery.json'] : [])],
    ...(nativeProof ? { retainProducedArtifacts: async (runDir: string) => {
      const fingerprint = JSON.parse(readFileSync(join(runDir, 'phases/prepare/native-proof-intent.json'), 'utf8')).fingerprint;
      const paths = ['prepare', 'execute'].flatMap(phase => {
        const directory = join(runDir, 'phases', phase);
        return existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(file => file.isFile())
          .map(file => 'phases/' + phase + '/' + file.name) : [];
      });
      const seal = retainBaselinePacket(runDir, join(runDir, '../retained', basename(runDir), 'native-objects'), fingerprint, paths);
      const sealPath = join(runDir, 'phases/teardown/native-recovery-packet-seal.json');
      await (await import('node:fs/promises')).writeFile(sealPath, seal, { flag: 'wx' });
      const current = await readNativeProofRun(nativeProof.sql, 'native-proof-' + fingerprint);
      if (current?.events.length === 6) {
        const recorder = nativeProofRecorder(nativeProof.sql, current);
        await recorder.observe('sealed', sealPath);
        readBaselinePacket(readFileSync(sealPath), createHash('sha256').update(seal).digest('hex'), fingerprint);
        await recorder.observe('readback', sealPath);
      }
      return ['phases/teardown/native-recovery-packet-seal.json'];
    } } : {}),
    prepare: async (evidenceDir, native) => {
      // The native MCP handshake requires a known serving generation. Reject
      // unqualified working source before the expensive build or allocation.
      const sourceSha = privateMcpSourceSha(root);
      preparedSourceSha = sourceSha;
      await preflightCurrentSuNativeEgress(evidenceDir);
      let installed: Awaited<ReturnType<typeof captureBaselineInstalledTree>> | undefined;
      if (native) {
        assertBaselineToolchain(native.input.toolchain);
        expect(native.input.original.sourceSha.startsWith(sourceSha)).toBe(true);
        installed = await captureBaselineInstalledTree(root);
        const manifest = JSON.stringify(installed);
        await (await import('node:fs/promises')).writeFile(join(evidenceDir, 'native-recovery-installed-tree.json'), manifest, { flag: 'wx' });
        const receiptPath = join(evidenceDir, 'native-recovery-installed.json');
        await (await import('node:fs/promises')).writeFile(receiptPath, JSON.stringify({ sourceSha,
          installedTreeSha256: installed.sha256, manifestSha256: createHash('sha256').update(manifest).digest('hex'),
          toolchain: native.input.toolchain }), { flag: 'wx' });
        await native.observe('installed', receiptPath);
      }
      // Compilation and every guard must finish before the disposable native
      // runtime/database exists. The worker consumes only these pinned bytes.
      // Completed build steps may renew the stall checkpoint up to the shared
      // absolute ceiling. A stalled build still fails before runtime allocation.
      // The restricted-hold gate is a production fail-closed check. This
      // private Vitest fixture has no restricted holdings, so route only this
      // builder child through its documented VITEST-only census seam rather
      // than letting preparation probe the protected live org-admin database.
      const censusPath = join(evidenceDir, 'restricted-hold-census.json');
      await (await import('node:fs/promises')).writeFile(censusPath, '[]\n', { mode: 0o600 });
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
        sourceSha,
        builder: { timeoutMs: 240_000, maxMs: 420_000,
          env: { ...process.env, VITEST: 'true', PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: censusPath } },
      });
      if (native) {
        await assertBaselineInstalledTree(root, installed!);
        const receiptPath = join(evidenceDir, 'native-recovery-built.json');
        await (await import('node:fs/promises')).writeFile(receiptPath, JSON.stringify({ sourceSha,
          bundleSha256: prepared.sha256, preparationReceiptSha256: prepared.receiptSha256,
          installedTreeSha256: installed!.sha256 }), { flag: 'wx' });
        await native.observe('built', receiptPath);
      }
    },
    execute: async (observe, evidenceDir, nativeChild) => {
      expect(prepared, 'Private API preparation must precede runtime allocation').toBeDefined();
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--managed-tasks', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        '--prepared-api-sha=' + prepared!.sha256, '--prepared-receipt-sha=' + prepared!.receiptSha256,
        '--native-docker-host=' + dockerHost, '--private-http-scenario=' + scenario,
        ...(nativeChild ? ['--native-proof-child=' + join(evidenceDir, 'native-proof-child.json')] : [])],
      { cwd: root, detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
          TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') } });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n'))
          if (/^(CURRENT_SU_NATIVE_PHASE|STAGING_FIRST_HTTP_PHASE) /.test(line)) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>> | undefined;
      const failures: unknown[] = [];
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      catch (error) { failures.push(error); }
      try {
        const cleanup = await cleanupCurrentSuNativeEgress(evidenceDir, { worker: child, dockerHost });
        if (result?.code === 0) expect(cleanup.status).toBe('cleaned');
      }
      catch (error) { failures.push(error); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      if (failures.length) throw new AggregateError(failures, 'Native worker capture or egress cleanup failed');
      expect(result).toBeDefined();
      if (!result) throw new Error('Native worker capture returned no result');
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      expect(result.output).toContain('PRIVATE_HTTP_SCENARIO_SELECTED ' + scenario);
      const line = result.output.split('\n').find(row => row.startsWith('CURRENT_SU_NATIVE_RECEIPT '));
      expect(line, result.output.slice(-4000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('CURRENT_SU_NATIVE_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        hostStopped: true, providerForwarding: false, modelRequests: expect.any(Number),
        nativeSessionId: expect.stringMatching(/^[a-f0-9-]{36}$/), autoRegistered: true,
        hooksBridged: true, containerWorkdir: '/app', mcpConfined: true, dockerHost });
      expect(receipt.modelRequests).toBeGreaterThan(0);
      if (scenario !== 'current-su-native') {
        expect(receipt.managedCarry).toMatchObject({ requested: true, distinctNativeSession: true,
          sameOwner: true, sameTask: true, preservedHead: true, preservedDiff: true, confinementPreserved: true });
        expect(receipt.managedCarry.successorId).not.toBe(receipt.managedCarry.predecessorId);
        const delivery = JSON.parse(readFileSync(join(evidenceDir, 'native-carry-input.json'), 'utf8'));
        expect(delivery).toMatchObject({ schemaVersion: 1, client: 'codex', workspace: receipt.workspace,
          nativeTaskId: receipt.nativeTaskId, nativeSessionId: receipt.managedCarry.successorId,
          predecessorId: receipt.managedCarry.predecessorId,
          observedAt: expect.any(String), packet: expect.any(String) });
        expect(createHash('sha256').update(delivery.packet).digest('hex')).toBe(delivery.packetSha256);
        expect(delivery.packetChars).toBe(delivery.packet.length);
        expect(delivery.packetBytes).toBe(Buffer.byteLength(delivery.packet, 'utf8'));
        const originalPacket = readFileSync(join(evidenceDir, 'native-carry-packet.json'));
        expect(delivery.packetArtifact).toEqual({ path: 'native-carry-packet.json',
          sha256: createHash('sha256').update(originalPacket).digest('hex') });
        expect(JSON.parse(originalPacket.toString('utf8'))).toMatchObject({ packet: delivery.packet,
          packetSha256: delivery.packetSha256, predecessorId: delivery.predecessorId });
        expect(delivery.notExercised).toContain('paired-outcome-ledger');
      }
      if (scenario === 'current-su-native-recovery-baseline') {
        expect(receipt.recoveryBaseline).toMatchObject({ fixtureId: 'F01',
          nativeSessionId: receipt.managedCarry.successorId, nativeTaskId: receipt.nativeTaskId });
        const fixture = JSON.parse(readFileSync(join(evidenceDir, 'native-recovery-fixture.json'), 'utf8'));
        const continuation = JSON.parse(readFileSync(join(evidenceDir, 'native-recovery-continuation.json'), 'utf8'));
        const readback = JSON.parse(readFileSync(join(evidenceDir, 'native-recovery-readback.json'), 'utf8'));
        expect(fixture.aliases.CURRENT_REF).toMatch(/^WI-\d+$/);
        expect(fixture.aliases.PEER_REF).toMatch(/^WI-\d+$/);
        expect(fixture.rowGenerations).toHaveLength(21);
        expect(fixture.action.content).toBe('fact-recovery-fixture:complete\\n');
        expect(continuation).toMatchObject({ state: 'done', correctReadbackObserved: true });
        expect(continuation.calls.map((call: { name: string }) => call.name)).toEqual([
          'work_items:get', 'facts:list', 'artifacts:save', 'artifacts:load']);
        expect(readback).toEqual(receipt.recoveryBaseline);
        expect(readback.independentStoreReadback).toBe(fixture.action.content);
        expect(createHash('sha256').update(readFileSync(join(evidenceDir, 'native-recovery-fixture.json'))).digest('hex'))
          .toBe(readback.fixtureSha256);
        expect(readback.notExercised).toContain('paired-outcome-ledger');
        const before = readFileSync(join(evidenceDir, 'native-recovery-runtime-custody-before.json'));
        const after = readFileSync(join(evidenceDir, 'native-recovery-runtime-custody-after.json'));
        expect(after).toEqual(before);
        const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
        const beforeSha256 = digest(before), afterSha256 = digest(after);
        const runtime = JSON.parse(readFileSync(join(evidenceDir, 'native-recovery-runtime.json'), 'utf8'));
        expect(runtime.custodyBeforeSha256).toBe(beforeSha256);
        expect(receipt.runtimeCustody).toEqual({ ...JSON.parse(after.toString()),
          custodyBeforeSha256: beforeSha256, custodyAfterSha256: afterSha256 });
        const trace = JSON.parse(readFileSync(join(evidenceDir, 'native-recovery-runtime-custody-trace.json'), 'utf8'));
        expect(trace).toEqual({ schemaVersion: 1, fingerprint: nativeChild!.fingerprint,
          continuation: { path: 'native-recovery-continuation.json',
            sha256: digest(readFileSync(join(evidenceDir, 'native-recovery-continuation.json'))) },
          custodyBefore: { path: 'native-recovery-runtime-custody-before.json', sha256: beforeSha256 },
          custodyAfter: { path: 'native-recovery-runtime-custody-after.json', sha256: afterSha256 } });
      }
      if (scenario.includes('-frozen-carry-')) expect(receipt.frozenCarry).toMatchObject({
        mode: scenario.endsWith('-on') ? 'on' : 'off', inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        policySeed: 'private-observer', gatewayAccounting: 'not-measured', controlledArmAdmission: 'not-exercised',
        trigger: { kind: 'matched-threshold', limitTokens: 20_000, usageSource: 'codex-last-token-usage' },
      });
      console.info('CURRENT_SU_NATIVE_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  const runId = recovery ? await withNativeProofLedger(process.env, async sql => {
    const group = process.env.PAPERCUSP_TEST_RUN_GROUP;
    expect(group, 'Native F01 baseline requires its original durable prelaunch intent').toMatch(/^native-proof-[a-f0-9]{64}$/);
    const intent = await readNativeProofRun(sql, group!);
    expect(intent, 'Original native F01 method/inputs must be reserved before preparation').toBeTruthy();
    expect(intent!.input.scope).toEqual({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp',
      planSlug: 'agent-paperwork-and-restart-tax-reduction-2026-10-15' });
    return runProof({ sql, input: intent!.input, admission: intent!.admission });
  }) : await runProof();
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('CURRENT_SU_NATIVE_PROOF_RUN ' + runId);
}

async function privateMcpPreflightOnlyScenario(context: TestContext) {
  let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>> | undefined;
  let preparedSourceSha: string | undefined;
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/external-bench/current-su-native.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'packages/operator-core/lib/serving-generation.ts', 'packages/operator-core/lib/superuser-token.ts'],
    retainedArtifacts: currentSuNativeRetainedArtifacts(false, { nativeEgress: false }),
    prepare: async evidenceDir => {
      // testing:run doesn't inherit shell-local test harness selectors. Pass
      // this test's exact harness to both source qualification and the builder.
      const buildEnv = { ...process.env, PAPERCUSP_TEST_RUN_HARNESS: 'papercusp' };
      const sourceSha = privateMcpSourceSha(root, buildEnv);
      preparedSourceSha = sourceSha;
      const censusPath = join(evidenceDir, 'restricted-hold-census.json');
      await (await import('node:fs/promises')).writeFile(censusPath, '[]\n', { mode: 0o600 });
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
        sourceSha,
        builder: { timeoutMs: 240_000, maxMs: 420_000,
          env: { ...buildEnv, VITEST: 'true', PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: censusPath } },
      });
    },
    execute: async (observe, evidenceDir) => {
      expect(prepared, 'Private API preparation must precede isolated runtime allocation').toBeDefined();
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--managed-tasks', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        '--prepared-api-sha=' + prepared!.sha256, '--prepared-receipt-sha=' + prepared!.receiptSha256,
        '--private-http-scenario=private-mcp-preflight-only'],
      { cwd: root, detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',

          STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
          TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') } });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      expect(result.output).toContain('PRIVATE_HTTP_SCENARIO_SELECTED private-mcp-preflight-only');
      const line = result.output.split('\n').find(row => row.startsWith('PRIVATE_MCP_PREFLIGHT_ONLY_RECEIPT '));
      expect(line, result.output.slice(-4000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('PRIVATE_MCP_PREFLIGHT_ONLY_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        sourceSha: preparedSourceSha, healthSha: preparedSourceSha, hostStopped: true, nativeLaunches: 0,
        servingGeneration: expect.stringMatching(/^serving-generation-v1:[a-f0-9]{64}$/),
        toolCount: expect.any(Number) });
      expect(receipt.toolCount).toBeGreaterThan(0);
      expect(result.output).not.toContain('CURRENT_SU_NATIVE_RECEIPT');
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('PRIVATE_MCP_PREFLIGHT_ONLY_PROOF_RUN ' + runId);
}

it('checks native egress startup without private API compilation or model requests', async context => {
  const benchDockerHost = privateNativeDockerHost(['--native-docker-host=unix:///run/docker-bench.sock']);
  vi.stubEnv('DOCKER_HOST', benchDockerHost);
  try {
    const result = await runHarness({
      contract: { name: 'native-egress-prerequisite', phases: [{ id: 'prepare' }] },
      evidenceRoot: defaultEvidenceRoot('native-egress-prerequisite'),
      retainedArtifacts: ['phases/prepare/native-egress-preflight.json'],
      runPhase: async phase => {
        await preflightCurrentSuNativeEgress(phase.evidenceDir);
        const receipt = JSON.parse(readFileSync(join(phase.evidenceDir, 'native-egress-preflight.json'), 'utf8')) as {
          status: string;
          dockerHost: string | null;
          relayConnections: number | null;
          cleanupErrors: string[];
          commands: Array<{ args: string[]; elapsedMs: number }>;
        };
        expect(receipt).toMatchObject({ status: 'ready', dockerHost: benchDockerHost,
          relayConnections: 0, cleanupErrors: [] });
        expect(receipt.commands.length).toBeGreaterThan(0);
        expect(receipt.commands.every(command => Number.isFinite(command.elapsedMs) && command.elapsedMs >= 0)).toBe(true);
        return { ok: true };
      },
    });
    Object.assign(context.task.meta, { papercuspNativeEgressRunId: result.runId });
    console.info('CURRENT_SU_NATIVE_EGRESS_PROOF_RUN ' + result.runId);
    expect(result.verdict, JSON.stringify({ runId: result.runId, phases: result.phases })).toBe('pass');
  } finally {
    vi.unstubAllEnvs();
  }
}, 120_000);

it('allocates numeric recovery inputs and retains their PostgreSQL-clock manifest before native launch', async context => {
  const allocationOptions = isolatedWorkerOptions(180_000);
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/external-bench/current-su-native.integration.test.ts',
    sourcePaths: ['packages/operator-core/test/current-su-native-http-scenario.ts',
      'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/lib/agent-facts/store.ts', 'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/text-artifacts.ts',
      'packages/agent-mcp/src/tools/artifacts/load.ts',
      'libs/papercusp/libs/db/src/workspace-context.ts'],
    retainedArtifacts: CURRENT_SU_RECOVERY_ALLOCATION_ARTIFACTS,
    execute: async (observe, evidenceDir) => {
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        '--current-su-recovery-allocation'],
      { cwd: root, detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir } });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, allocationOptions);
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const receipt = JSON.parse(readFileSync(join(evidenceDir, 'recovery-fact-allocation.json'), 'utf8'));
      const manifest = readFileSync(join(evidenceDir, 'recovery-fact-manifest.json'), 'utf8');
      expect(result.output).toContain('CURRENT_SU_RECOVERY_ALLOCATION_SELECTED');
      expect(result.output).toContain('CURRENT_SU_RECOVERY_ALLOCATION_RECEIPT ');
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), nativeLaunches: 0,
        allocation: { currentRef: expect.stringMatching(/^WI-\d+$/), peerRef: expect.stringMatching(/^WI-\d+$/),
          canonicalReadback: true, invalidAlphaRefsRejected: true },
        clock: { source: expect.stringContaining('PostgreSQL'), sharedByAllRows: true },
        selectedBodies: ['Continue the assigned task.', 'Resume the bound harness.'], initiallyAbsent: true,
        manifest: { roundTrip: true, wrongHarnessRejected: true, ordinaryOverwriteRejected: true,
          corruptReadRejected: true } });
      expect(receipt.allocation.currentRef).not.toBe(receipt.allocation.peerRef);
      expect(createHash('sha256').update(manifest).digest('hex')).toBe(receipt.manifest.sha256);
      const frozen = JSON.parse(manifest);
      expect(frozen.aliases.CURRENT_REF).toBe(receipt.allocation.currentRef);
      expect(frozen.rowGenerations.find((row: { scope: string }) => row.scope === 'work_item').scopeRef)
        .toBe(receipt.allocation.currentRef);
      expect(frozen.notExercised).toContain('native-epoch');
      const artifactProofBytes = readFileSync(join(evidenceDir, 'recovery-fact-artifact-proof.json'), 'utf8');
      expect(createHash('sha256').update(artifactProofBytes).digest('hex')).toBe(receipt.artifactProof.sha256);
      const proof = JSON.parse(artifactProofBytes);
      expect(proof).toMatchObject({ workspace: receipt.workspace, nativeLaunches: 0,
        allocationManifestSha256: receipt.manifest.sha256,
        artifactTool: { name: 'artifacts:load', workspaceWrapper: 'withWorkspace', maxChars: 4000,
          reconstructedSha256: receipt.manifest.sha256, chars: manifest.length,
          bytes: Buffer.byteLength(manifest), foreignWorkspaceRejected: true,
          wrongHarnessRejected: true, reachableAfterControls: true },
        factAudience: { nonmemberBodies: ['Continue the assigned task.', 'Resume the bound harness.'],
          memberBodies: ['Continue the assigned task.', 'Excluded nonmember audience.', 'Resume the bound harness.'],
          candidateManifestReceiver: 'not-exercised' },
        ttlControl: { taskContext: { workItemRefs: [receipt.allocation.currentRef] },
          selectionControls: { currencyReadContainsGuard: false, taskReadContainsGuard: true },
          rowUnchangedAcrossExpiry: true, liveBeforeExpiry: true,
          absentAfterExpiry: true, originalInputRestored: true } });
      let offset = 0;
      for (const page of proof.artifactTool.pages) {
        expect(page.offset).toBe(offset);
        const originalPage = manifest.slice(offset, offset + 4000);
        expect(page.chars).toBe(originalPage.length);
        expect(page.bytes).toBe(Buffer.byteLength(originalPage));
        expect(page.sha256).toBe(createHash('sha256').update(originalPage).digest('hex'));
        offset += page.chars;
        expect(page.truncated).toBe(offset < manifest.length);
      }
      expect(proof.artifactTool.pages.length).toBeGreaterThan(1);
      expect(offset).toBe(manifest.length);
      expect(Date.parse(proof.ttlControl.buildObservedAt)).toBeLessThan(Date.parse(proof.ttlControl.expiresAt));
      expect(Date.parse(proof.ttlControl.deliveredAt)).toBeGreaterThanOrEqual(Date.parse(proof.ttlControl.expiresAt));
      expect(proof.ttlControl.beforeExpiry).toEqual(proof.ttlControl.afterExpiry);
      expect(proof.notExercised).toContain('candidate-manifest-receiver');
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('CURRENT_SU_RECOVERY_ALLOCATION_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

it('verifies the digest-pinned private MCP generation before any native launch', async context => {
  await privateMcpPreflightOnlyScenario(context);
}, options.testTimeoutMs);

it('launches autonomous current-su through the native container adapter without provider forwarding',
  context => nativeScenario('current-su-native', context), options.testTimeoutMs);
it('resumes current-su through its maintained host after managed native container compaction',
  context => nativeScenario('current-su-native-carry', context), options.testTimeoutMs);
it('binds a normal-fact native F01 baseline to current custody and the exact permitted artifact readback',
  context => nativeScenario('current-su-native-recovery-baseline', context), recoveryProofBudgetMs);
it.for(['on', 'off'] as const)('delivers frozen carry %s through a fresh native session at the same measured threshold',
  { timeout: options.testTimeoutMs },
  (mode, context) => nativeScenario(`current-su-native-frozen-carry-${mode}`, context));
