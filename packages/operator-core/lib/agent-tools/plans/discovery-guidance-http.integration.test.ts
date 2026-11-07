import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, type TestContext } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { assertDiscoveryShippedIdentity, pinDiscoveryShippedTarget, readDiscoveryShippedTarget,
  validateDiscoveryGuidanceRequests, type DiscoveryShippedTarget } from '../../../test/discovery-guidance-http-scenario';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);
const shippedCase = 'repeats discovery guidance against the exact shipped artifact without rebuilding';
const journeyFile = 'packages/operator-core/lib/agent-tools/plans/discovery-guidance-http.integration.test.ts';

function requestedShippedJourney(context = process.env.PAPERCUSP_CRITERION_TEST_CASES): boolean {
  if (!context) return false;
  const selectors: unknown = JSON.parse(context);
  if (!Array.isArray(selectors) || selectors.some(selector => !selector ||
    typeof selector.file !== 'string' || typeof selector.testName !== 'string')) {
    throw new Error('invalid criterion case context');
  }
  return selectors.some(selector => selector.testName === shippedCase &&
    resolve(root, selector.file) === resolve(root, journeyFile));
}

// Explicit final-artifact selection keeps the ordinary pre-deploy gate on its
// current-build route. The final selector is absent (never a passing/skip result)
// unless the caller selects the exact release target for that independent run.
it('delivers provisional, refusal, recovery and finalized discovery guidance to the same served session',
  context => runJourney(context, false), options.testTimeoutMs);
if (process.env.PC_DISCOVERY_ARTIFACT_TARGET === 'release-operator' || requestedShippedJourney()) {
  it('repeats discovery guidance against the exact shipped artifact without rebuilding',
    context => runJourney(context, true), options.testTimeoutMs);
}

it('refuses incomplete or altered shipped-target selection before starting a private host', async () => {
  expect(requestedShippedJourney('[]')).toBe(false);
  expect(requestedShippedJourney(JSON.stringify([{ file: journeyFile, testName: shippedCase }]))).toBe(true);
  expect(requestedShippedJourney(JSON.stringify([{ file: 'other.test.ts', testName: shippedCase }]))).toBe(false);
  expect(() => requestedShippedJourney('{}')).toThrow('invalid criterion case context');
  const target = { runtime: 'release-operator', processStartedAtMs: 1,
    source: { entry: '/release/hono-host.mjs', sha256: 'a'.repeat(64) },
    artifact: { status: 'measured', sourceSha: 'b'.repeat(40), bundleSha256: 'a'.repeat(64) },
    health: { sha: 'b'.repeat(10), service: 'papercusp-operator' } } as DiscoveryShippedTarget;
  expect(() => assertDiscoveryShippedIdentity(target)).not.toThrow();
  expect(() => assertDiscoveryShippedIdentity({ ...target, health: { ...target.health, sha: 'c'.repeat(10) } }))
    .toThrow('health and release candidate differ');
  expect(() => assertDiscoveryShippedIdentity({ ...target,
    artifact: { ...target.artifact, bundleSha256: 'c'.repeat(64) } })).toThrow('loaded bundle differs');
  expect(() => assertDiscoveryShippedIdentity({ ...target, processStartedAtMs: 0 })).toThrow('process start');
  expect(await readDiscoveryShippedTarget([])).toBeNull();
  await expect(readDiscoveryShippedTarget(['--discovery-shipped-target=/missing'])).rejects.toThrow();
  await expect(readDiscoveryShippedTarget(['--discovery-shipped-target-sha=' + 'a'.repeat(64)])).rejects.toThrow();
  const dir = await mkdtemp(join(tmpdir(), 'discovery-artifact-control-'));
  try {
    const path = join(dir, 'target.json');
    const bytes = JSON.stringify({ runtime: 'staging-operator' });
    await writeFile(path, bytes, { flag: 'wx' });
    const args = ['--discovery-shipped-target=' + path];
    await expect(readDiscoveryShippedTarget([...args,
      '--discovery-shipped-target-sha=' + 'a'.repeat(64)])).rejects.toThrow('shipped target receipt changed');
    await expect(readDiscoveryShippedTarget([...args,
      '--discovery-shipped-target-sha=' + createHash('sha256').update(bytes).digest('hex')]))
      .rejects.toThrow('release-operator');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function runJourney(context: TestContext, shipped: boolean) {
  await validateDiscoveryGuidanceRequests();
  let target: { path: string; sha256: string } | undefined;
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/plans/discovery-guidance-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/discovery-guidance-http-scenario.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/agent-tools/plans/product-shaping.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-declarations.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-declaration-resolvers.ts',
      'packages/operator-core/lib/plan-audits.ts', 'packages/operator-core/lib/agent-tools/plans/audit.ts',
      'packages/operator-core/lib/agent-tools/plans/new.ts', 'packages/operator-core/lib/agent-tools/plans/get.ts',
      'packages/operator-core/lib/agent-tools/plans/set-content.ts',
      'packages/operator-core/lib/serving-runtimes.ts', 'packages/operator-core/lib/runtime-vintage.ts',
      'packages/operator-core/lib/agent-tools/dev/systemd-service-probe.ts',
      'packages/operator-core/lib/release/operator-artifact.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    prepare: shipped ? async evidenceDir => {
      const selected = await pinDiscoveryShippedTarget();
      const bytes = JSON.stringify(selected);
      target = { path: join(evidenceDir, 'discovery-shipped-target.json'),
        sha256: createHash('sha256').update(bytes).digest('hex') };
      await writeFile(target.path, bytes, { flag: 'wx', mode: 0o600 });
    } : undefined,
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'discovery-guidance', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        ...(target ? ['--discovery-shipped-target=' + target.path, '--discovery-shipped-target-sha=' + target.sha256] : [])],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n'))
          if (line.startsWith('STAGING_FIRST_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output, result)).toMatchObject({ code: 0,
        signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('DISCOVERY_GUIDANCE_HTTP_RECEIPT '));
      expect(line, result.output.slice(-4_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('DISCOVERY_GUIDANCE_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        actorPreserved: true, refusal: 'discovery_not_ready', recoveryTool: 'plans:set-content',
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' },
        stages: ['discovery', 'implementation-review', 'implementation-review'],
        initialGuidance: { stage: 'implementation' }, adoptedGuidance: { stage: 'implementation-review' },
        evidenceRefs: ['source:existing-discovery-guidance.ts'] });
      expect(new Set(receipt.transcript.map((row: any) => row.callerSid))).toEqual(new Set([receipt.callerSid]));
      if (shipped) {
        expect(receipt).toMatchObject({ rebuilt: false, artifactTarget: { runtime: 'release-operator',
          artifact: { status: 'measured', bundleSha256: receipt.bundleSha256 },
          source: { sha256: receipt.bundleSha256 }, health: { sha: receipt.health.sha } } });
      } else expect(receipt.artifactTarget).toBeUndefined();
      console.info('DISCOVERY_GUIDANCE_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('DISCOVERY_GUIDANCE_HTTP_PROOF_RUN ' + runId);
}
