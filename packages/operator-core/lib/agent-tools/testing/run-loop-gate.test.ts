import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// WI-10004175 / expensive-verification-loops P-002: testing:run launches detached runs that
// the attempt ledger counts per work-item, but it never consulted the loop gate, so a grinding
// item could keep launching slow test runs that capability:bash and release:cut would refuse.
const phases = vi.hoisted(() => ({
  gate: vi.fn(),
  fence: vi.fn(),
  prepare: vi.fn(),
  finish: vi.fn(),
  retract: vi.fn(),
  provenance: vi.fn(),
  detach: vi.fn(),
  recoveryPrepared: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, mkdtemp: async (prefix: string) => {
    const directory = await fs.mkdtemp(prefix);
    phases.recoveryPrepared(directory);
    return directory;
  } };
});
vi.mock('../../testing-run-store', async (original) => ({
  ...(await original<typeof import('../../testing-run-store')>()), startRunDurable: phases.detach,
}));
vi.mock('../../verification-attempts/loop-gate', () => ({ loopLaunchRefusal: phases.gate }));
vi.mock('./mutation-probe-fence', () => ({ mutationProbeRefusal: phases.fence }));
// The restricted-write fence (WI-10005634) reads the fence module's closure exports, which the
// factory above omits; it has its own suite (restricted-hold-fence.test.ts).
vi.mock('./restricted-hold-fence', () => ({ restrictedHoldRefusal: vi.fn(async () => null) }));
vi.mock('../capability/bash-task-provenance', () => ({
  BashProvenanceRefusal: class extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
  resolveBashTaskProvenance: phases.provenance,
}));
vi.mock('./evidence', async (original) => ({
  ...(await original<typeof import('./evidence')>()),
  prepareTestEvidence: phases.prepare,
  finishTestEvidence: phases.finish,
  retractRefusedTestEvidence: phases.retract,
}));

import { BashProvenanceRefusal } from '../capability/bash-task-provenance';
import { REPO_ROOT } from '../docs/_repo-paths';
import runTool, { buildDetachedTestRunBootstrapScript, buildDetachedTestRunRequest,
  compiledTestingCoreNodeOptions, runTestFilesCore, TestingCoreRefusal, testingRunAbortCompletionReceipt } from './run';
import { RunLaunchCutoffError } from '../../testing-run-store';
import { testRunDeadline, type TestRunDeadline } from './run-artifacts';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const directories = phases.detach.mock.calls.flatMap(([request]) =>
    (request.detachedReportArtifacts ?? []).map((artifact: { reportPath: string }) => join(artifact.reportPath, '..')));
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  Object.values(phases).forEach((mock) => mock.mockReset());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function invoke(extra: Record<string, unknown> = {}, options: { autoPrivatePg?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'testing-run-loop-gate-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
  await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
  if (options.autoPrivatePg) vi.stubEnv('PAPERCUSP_TEST_PG_ADMIN_URL', '');
  await writeFile(join(root, 'feature.test.ts'), options.autoPrivatePg
    ? "import { recordIsolatedIntegrationProof } from './isolated-integration-proof';\nrecordIsolatedIntegrationProof();\n"
    : "import { it } from 'vitest';\nit('noop', () => {});\n");
  const evidence = { workItemId: 'WI-grinding', planSlug: 'gate-plan', bindings: [{
    specId: 'SPEC-001', specRevision: 1, testPath: 'feature.test.ts', sourcePaths: ['feature.ts'], testLayer: 'unit' as const,
  }] };
  const metadata = vi.fn();
  const ctx = { projectDir: root, workspaceId: 'gate-workspace', uiClientId: 'su-gate-test', isSuperuser: true, metadata } as const;
  const args = runTool.args.parse({ files: ['feature.test.ts'], harness: 'gate-harness', evidence, ...extra });
  const result = (await runTool.handler(args, ctx as never)) as { data: Record<string, unknown> };
  return { root, result: result.data, metadata };
}

const refusal = {
  ok: false as const,
  reason: 'loop_audit_required' as const,
  work_item_id: 'WI-grinding',
  triggers: ['distinct-failures'],
  fingerprints: ['exit:aaa', 'log:bbb'],
  message: 'loop_audit_required — WI-grinding is grinding',
};

const sourceSha256 = 'a'.repeat(64);
const coreSource = (marker: string, source = sourceSha256) => `
  import { origin } from './origin.mjs';
  export const testingCoreSourceSha256 = ${JSON.stringify(source)};
  export async function runTestFilesCore(options, deps) {
    return { ok: true, marker: ${JSON.stringify(marker)}, origin, options, reports: deps.reportDirectories };
  }
`;

async function stagedCore(source = coreSource('A')) {
  const root = await mkdtemp(join(tmpdir(), 'testing-compiled-core-'));
  roots.push(root);
  const core = join(root, 'core.mjs');
  await writeFile(core, source);
  await writeFile(join(root, 'origin.mjs'), 'export const origin = "original-file-origin";');
  const expected = { schemaVersion: 1, sourceSha256,
    artifactSha256: createHash('sha256').update(source).digest('hex') };
  const options = { root, files: ['feature.test.ts'], deadline: testRunDeadline(120_000),
    workspaceId: 'compiled-workspace', harnessSlug: 'compiled-harness', workItemId: 'WI-compiled',
    privatePg: true, reporterStageTrace: true, maxFailures: 7, timeoutMs: 120_000,
    testNamePattern: 'preserved pattern', allowSiblingCheckoutFallback: false,
    compiledCore: { moduleUrl: pathToFileURL(core).href, expected } };
  const request = async () => {
    const result = await buildDetachedTestRunRequest(options);
    roots.push(...(result.detachedReportArtifacts ?? []).map(artifact => join(artifact.reportPath, '..')));
    return result;
  };
  return { root, core, source, options, expected, request };
}

function runCompiled(request: Awaited<ReturnType<typeof buildDetachedTestRunRequest>>, extraPreload?: string) {
  const result = spawnSync(request.command, request.args, {
    cwd: request.cwd, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, ...request.env, PAPERCUSP_TEST_RUN_GROUP: 'compiled-run',
      ...(extraPreload ? { NODE_OPTIONS: request.env!.NODE_OPTIONS + ' --import=' + JSON.stringify(pathToFileURL(extraPreload).href) } : {}) },
  });
  expect(result.error, result.stderr).toBeUndefined();
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout.trim().split('\n').at(-1)!) : null;
  return { ...result, parsed };
}

it('runs an independently staged compiled core with plain Node and exact replay/report identity', async () => {
  const f = await stagedCore();
  const request = await f.request();
  expect(request.args).not.toContain('tsx');
  const result = runCompiled(request);
  expect(result.status, result.stderr).toBe(0);
  expect(result.parsed).toMatchObject({ ok: true, marker: 'A', origin: 'original-file-origin', options: {
    root: f.root, files: f.options.files, deadline: f.options.deadline, runId: 'compiled-run',
    timeoutMs: 120_000, taskDeadlineAtMs: f.options.deadline.taskDeadlineAtMs,
    cleanupReserveMs: f.options.deadline.cleanupReserveMs, allowDetachedRecovery: false,
    workspaceId: 'compiled-workspace', harnessSlug: 'compiled-harness', workItemId: 'WI-compiled',
    privatePg: true, reporterStageTrace: true, maxFailures: 7, testNamePattern: 'preserved pattern',
    allowSiblingCheckoutFallback: false,
  }, reports: { [f.root]: join(request.detachedReportArtifacts![0]!.reportPath, '..') } });
  const verified = result.stderr.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).find(row => row?.phase === 'core-witness-verified');
  expect(verified).toMatchObject({ schemaVersion: 'testing-run-bootstrap-v1', coreMode: 'compiled', witnessSchemaVersion: 1 });
  expect(verified.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(verified.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
});

it.each(['unchanged', 'swap', 'restore'] as const)(
  'loads retained A through an outer native observer despite candidate %s', async mode => {
    const f = await stagedCore();
    const request = await f.request();
    const observer = join(f.root, 'observer.mjs'), receipt = join(f.root, 'observed.json');
    const replacement = coreSource('B'); // Deliberately exports the SAME source witness.
    await writeFile(observer, `
      import { registerHooks } from 'node:module';
      import { readFileSync, writeFileSync } from 'node:fs';
      registerHooks({ load(url, context, nextLoad) {
        if (!url.includes('papercusp-testing-core=')) return nextLoad(url, context);
        if (${JSON.stringify(mode)} !== 'unchanged') writeFileSync(${JSON.stringify(f.core)}, ${JSON.stringify(replacement)});
        const substituted = readFileSync(${JSON.stringify(f.core)}, 'utf8');
        if (${JSON.stringify(mode)} === 'restore') writeFileSync(${JSON.stringify(f.core)}, ${JSON.stringify(f.source)});
        const loaded = nextLoad(url, context);
        writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ substituted,
          endpoint: readFileSync(${JSON.stringify(f.core)}, 'utf8'), source: Buffer.from(loaded.source).toString() }));
        return loaded;
      } });
    `);
    const result = runCompiled(request, observer);
    expect(result.status, result.stderr).toBe(0);
    expect(result.parsed).toMatchObject({ marker: 'A', origin: 'original-file-origin' });
    const observed = JSON.parse(await readFile(receipt, 'utf8'));
    expect(observed.source).toBe(f.source);
    expect(observed.substituted).toBe(mode === 'unchanged' ? f.source : replacement);
    expect(observed.endpoint).toBe(mode === 'swap' ? replacement : f.source);
  }, 15_000,
);

it('distinguishes a source witness mismatch from an artifact mismatch or missing/invalid expectation', async () => {
  const f = await stagedCore(coreSource('A', 'b'.repeat(64)));
  const mismatch = runCompiled(await f.request());
  expect(mismatch.status).toBe(1);
  expect(mismatch.parsed).toMatchObject({ error: 'testing_core_source_mismatch', failedPhase: 'core-witness' });
  await writeFile(f.core, coreSource('B'));
  await expect(f.request()).rejects.toThrowError(expect.objectContaining({ code: 'testing_core_artifact_mismatch' }));
  await expect(buildDetachedTestRunRequest({ ...f.options, compiledCore: {
    moduleUrl: pathToFileURL(f.core).href, expected: undefined,
  } })).rejects.toThrowError(expect.objectContaining({ code: 'testing_core_missing_witness' }));
  await expect(buildDetachedTestRunRequest({ ...f.options, compiledCore: {
    moduleUrl: pathToFileURL(f.core).href, expected: { schemaVersion: 1 },
  } })).rejects.toThrowError(expect.objectContaining({ code: 'testing_core_invalid_witness' }));
  await rm(f.core);
  await expect(f.request()).rejects.toThrowError(expect.objectContaining({ code: 'testing_core_missing_artifact' }));
});

it.each([
  ['matching', `export const testingCoreSourceSha256 = ${JSON.stringify(sourceSha256)};`, true],
  ['missing', '', false],
  ['invalid', 'export const testingCoreSourceSha256 = "not-a-sha256";', false],
] as const)('checks a %s loaded source export before core execution', async (_kind, declaration, accepted) => {
  const f = await stagedCore([
    'import { appendFileSync } from "node:fs";', declaration,
    'export async function runTestFilesCore() {',
    '  appendFileSync(new URL("./core-executed", import.meta.url), "once\\n");',
    '  return { ok: true };',
    '}',
  ].join('\n'));
  // stagedCore independently hashes each loadable artifact, so refusal must
  // come from its loaded source export rather than the artifact/import guard.
  const result = runCompiled(await f.request());
  const phases = result.stderr.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(row => row?.schemaVersion === 'testing-run-bootstrap-v1');
  expect(phases.filter(row => row.phase === 'core-import-complete')).toHaveLength(1);
  const execution = phases.filter(row => row.phase.startsWith('core-execution-')).map(row => row.phase);
  const marker = readFile(join(f.root, 'core-executed'), 'utf8');
  if (accepted) {
    expect(result.status, result.stderr).toBe(0);
    expect(result.parsed).toEqual({ ok: true });
    expect(execution).toEqual(['core-execution-start', 'core-execution-complete']);
    await expect(marker).resolves.toBe('once\n');
  } else {
    expect(result.status).toBe(1);
    expect(result.parsed).toMatchObject({ error: 'testing_core_source_mismatch', failedPhase: 'core-witness' });
    expect(phases.filter(row => row.phase === 'bootstrap-error')).toEqual([
      expect.objectContaining({ failedPhase: 'core-witness' }),
    ]);
    expect(phases.some(row => row.phase === 'core-witness-verified')).toBe(false);
    expect(execution).toEqual([]);
    await expect(marker).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('removes source interpreters while retaining native tracing and Node options', () => {
  expect(compiledTestingCoreNodeOptions('--max-old-space-size=2048 --import tsx --import="file:///trace.mjs" --require ts-node/register'))
    .toBe('--max-old-space-size=2048 --import="file:///trace.mjs"');
  expect(() => compiledTestingCoreNodeOptions('--loader ./custom-loader.mjs')).toThrow(TestingCoreRefusal);
});

it('keeps the one-shot transfer preload out of test descendants', async () => {
  const f = await stagedCore(`
    import { execFileSync } from 'node:child_process';
    export const testingCoreSourceSha256 = ${JSON.stringify(sourceSha256)};
    export async function runTestFilesCore() {
      const child = execFileSync(process.execPath, ['-e', 'process.stdout.write("child-ok")'], { encoding: 'utf8' });
      return { ok: true, child };
    }
  `);
  const result = runCompiled(await f.request());
  expect(result.status, result.stderr).toBe(0);
  expect(result.parsed).toEqual({ ok: true, child: 'child-ok' });
});

async function invokeBootstrap(source: string, deadline = testRunDeadline(120_000)) {
  const root = await mkdtemp(join(tmpdir(), 'testing-run-bootstrap-'));
  roots.push(root);
  const corePath = join(root, 'core.mjs');
  await writeFile(corePath, source);
  const script = buildDetachedTestRunBootstrapScript({
    coreModuleUrl: pathToFileURL(corePath).href,
    replay: { root, files: ['feature.test.ts'], deadline },
    reportDirectories: { [root]: join(root, 'reports') },
  });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PAPERCUSP_TEST_RUN_GROUP: 'bootstrap-run' },
  });
  expect(result.error, JSON.stringify({ status: result.status, signal: result.signal,
    stdoutBytes: Buffer.byteLength(result.stdout), stderr: result.stderr })).toBeUndefined();
  const events = result.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  return { ...result, events, root };
}

it('retains worker startup, import and execution phases without changing the replay deadline', async () => {
  const deadline = testRunDeadline(120_000, { now: Date.now() - 5_000, cleanupReserveMs: 30_000 });
  const result = await invokeBootstrap(`export async function runTestFilesCore(opts, deps) {
    return { ok: true, deadline: opts.deadline, runId: opts.runId, reports: deps.reportDirectories };
  }`, deadline);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, deadline, runId: 'bootstrap-run',
    reports: { [result.root]: join(result.root, 'reports') } });
  expect(result.events.map(event => event.phase)).toEqual(['bootstrap-start', 'core-import-start',
    'core-import-complete', 'core-execution-start', 'core-execution-complete']);
  for (const event of result.events) {
    expect(event).toMatchObject({ schemaVersion: 'testing-run-bootstrap-v1', runId: 'bootstrap-run',
      taskDeadlineAtMs: deadline.taskDeadlineAtMs, childCutoffAtMs: deadline.childCutoffAtMs,
      cleanupReserveMs: 30_000 });
    expect(event.sinceRequestMs).toBeGreaterThanOrEqual(5_000);
    expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
  }
  expect(result.events.at(-1)).toMatchObject({ ok: true, error: null });
});

it.each([{ ok: true, code: 0 }, { ok: false, code: 1 }])(
  'terminates a completed $ok worker after draining its report despite retained runtime handles', async ({ ok, code }) => {
    const result = await invokeBootstrap(`
      setInterval(() => {}, 1000);
      export async function runTestFilesCore() {
        return { ok: ${JSON.stringify(ok)}, payload: 'x'.repeat(256 * 1024) };
      }
    `);

    expect(result.status).toBe(code);
    expect(JSON.parse(result.stdout)).toEqual({ ok, payload: 'x'.repeat(256 * 1024) });
    expect(result.events.at(-1)).toMatchObject({ phase: 'core-execution-complete', ok });
  },
  15_000,
);

it('retains an import failure before a core or artifact packet can start', async () => {
  const result = await invokeBootstrap('throw new TypeError("fixture import failure");');
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.events.map(event => event.phase)).toEqual(['bootstrap-start', 'core-import-start', 'bootstrap-error']);
  expect(result.events.at(-1)).toMatchObject({ failedPhase: 'core-import', errorName: 'TypeError' });
});

it('distinguishes a core failure from an import failure', async () => {
  const result = await invokeBootstrap('export async function runTestFilesCore() { throw new Error("fixture core failure"); }');
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.events.map(event => event.phase)).toEqual(['bootstrap-start', 'core-import-start',
    'core-import-complete', 'core-execution-start', 'bootstrap-error']);
  expect(result.events.at(-1)).toMatchObject({ failedPhase: 'core-execution', errorName: 'Error' });
});

it('reports an exhausted child budget without renewing it or changing the refused result', async () => {
  const deadline: TestRunDeadline = { startedAtMs: Date.now() - 120_000,
    taskDeadlineAtMs: Date.now() + 10_000, childCutoffAtMs: Date.now() - 20_000, cleanupReserveMs: 30_000 };
  const result = await invokeBootstrap(`export async function runTestFilesCore(opts) {
    return { ok: false, error: 'deadline_exhausted', deadline: opts.deadline };
  }`, deadline);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: 'deadline_exhausted', deadline });
  expect(result.events.every(event => event.remainingChildMs === 0)).toBe(true);
  expect(result.events.at(-1)).toMatchObject({ ok: false, error: 'deadline_exhausted' });
});

async function timeoutRecoveryFixture(count: number) {
  const parent = await mkdtemp(join(tmpdir(), 'testing-run-recovery-cutoff-'));
  roots.push(parent);
  const checkouts = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const root = join(parent, String(index));
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
    await writeFile(join(root, 'scripts/test-files.mjs'), 'export {};\n');
    await writeFile(join(root, 'feature.test.ts'), 'export {};\n');
    return root;
  }));
  return { root: checkouts[0]!, files: checkouts.map(root => join(root, 'feature.test.ts')),
    artifactBaseDir: join(parent, 'artifacts') };
}

const recoveryCutoffCases = [1, 2].flatMap(count => ['derived', 'caller'].flatMap(kind =>
  [-1, 0, 1].map(offset => ({ count, kind, offset }))));

it.each(recoveryCutoffCases)(
  'admits $kind recovery only before the original cutoff ($offset ms, $count checkout(s))',
  async ({ count, kind, offset }) => {
    const fixture = await timeoutRecoveryFixture(count);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const deadline = testRunDeadline(120_000, { now });
    phases.fence.mockResolvedValue(null);
    phases.detach.mockResolvedValue({ snapshot: { runId: 'cutoff-recovery' }, durable: true });
    const runRouterFn = vi.fn(async () => {
      now = deadline.childCutoffAtMs + offset;
      return { code: null, signal: 'SIGTERM' as const, timedOut: true, aborted: false,
        output: 'controlled foreground timeout' };
    });
    const result = await runTestFilesCore({ root: fixture.root, files: fixture.files,
      timeoutMs: 25_000, recoveryTimeoutMs: 120_000, harnessSlug: 'cutoff-harness',
      ...(kind === 'caller' ? { deadline } : {}) }, { runRouterFn, artifactBaseDir: fixture.artifactBaseDir });

    expect(result).toMatchObject({ ok: false, error: 'timeout', cleanup: { complete: true } });
    if (result.error !== 'timeout') throw new Error('expected controlled foreground timeout');
    expect(runRouterFn).toHaveBeenCalledTimes(offset < 0 ? count : 1);
    const manifest = JSON.parse(await readFile(result.artifacts!.manifest, 'utf8'));
    expect(manifest.deadline).toEqual(deadline);
    if (offset < 0) {
      expect(phases.detach).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ detachedRunId: 'cutoff-recovery', detachedDurable: true });
      expect(phases.detach.mock.calls[0]![0]).toMatchObject({ launchCutoffAtMs: deadline.childCutoffAtMs, env: {
        PAPERCUSP_TEST_TASK_DEADLINE_AT_MS: String(deadline.taskDeadlineAtMs),
        PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS: String(deadline.childCutoffAtMs),
        PAPERCUSP_TEST_CLEANUP_RESERVE_MS: String(deadline.cleanupReserveMs),
      }, detachedReportArtifacts: fixture.files.map(file => expect.objectContaining({ requestedFiles: [file] })) });
    } else {
      expect(phases.detach).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('detachedRunId');
      expect(result.hint).toContain('Original child cutoff exhausted');
      expect(phases.recoveryPrepared.mock.calls.flatMap(([directory]) =>
        directory.includes('testing-run-replay-') ? [directory] : [])).toEqual([]);
    }
  },
);

it.each([1, 2].flatMap(count => ['preparation', 'store-admission'].map(stage => ({ count, stage }))))(
  'rechecks the original cutoff after $stage for $count checkout(s)', async ({ count, stage }) => {
  const fixture = await timeoutRecoveryFixture(count);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const deadline = testRunDeadline(120_000, { now });
  phases.fence.mockResolvedValue(null);
  phases.detach.mockResolvedValue({ snapshot: { runId: 'must-not-start' }, durable: true });
  phases.recoveryPrepared.mockImplementation(directory => {
    if (stage === 'preparation' && directory.includes('testing-run-replay-')) now = deadline.childCutoffAtMs;
  });
  if (stage === 'store-admission') phases.detach.mockImplementation(async () => {
    now = deadline.childCutoffAtMs;
    throw new RunLaunchCutoffError(deadline.childCutoffAtMs);
  });
  const runRouterFn = vi.fn(async () => {
    now = deadline.childCutoffAtMs - 1;
    return { code: null, signal: 'SIGTERM' as const, timedOut: true, aborted: false,
      output: 'controlled foreground timeout before delayed recovery preparation' };
  });
  const result = await runTestFilesCore({ root: fixture.root, files: fixture.files,
    timeoutMs: 25_000, recoveryTimeoutMs: 120_000, harnessSlug: 'cutoff-harness' },
  { runRouterFn, artifactBaseDir: fixture.artifactBaseDir });

  expect(result).toMatchObject({ ok: false, error: 'timeout', cleanup: { complete: true } });
  if (result.error !== 'timeout') throw new Error('expected controlled foreground timeout');
  expect(result).not.toHaveProperty('detachedRunId');
  expect(result.hint).toContain('Original child cutoff exhausted');
  expect(phases.detach).toHaveBeenCalledTimes(stage === 'store-admission' ? 1 : 0);
  const prepared = phases.recoveryPrepared.mock.calls.flatMap(([directory]) =>
    directory.includes('testing-run-replay-') ? [directory] : []);
  expect(prepared).toHaveLength(count);
  for (const directory of prepared) await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(result.artifacts!.manifest, 'utf8')).deadline).toEqual(deadline);
});

it('retires background evidence when store admission exhausts its original cutoff', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  phases.gate.mockResolvedValue(null);
  phases.fence.mockResolvedValue(null);
  phases.prepare.mockResolvedValue([{}]);
  phases.retract.mockResolvedValue({ status: 'retired' });
  phases.detach.mockImplementation(async request => {
    now = request.launchCutoffAtMs;
    throw new RunLaunchCutoffError(now);
  });
  const { result } = await invoke({ background: true, timeoutMs: 120_000 });
  expect(result).toMatchObject({ ok: false, error: 'deadline_exhausted' });
  expect(result).not.toHaveProperty('detachedRunId');
  expect(phases.detach).toHaveBeenCalledOnce();
  expect(phases.retract).toHaveBeenCalledOnce();
  expect(phases.finish).not.toHaveBeenCalled();
  for (const artifact of phases.detach.mock.calls[0]![0].detachedReportArtifacts) {
    await expect(access(join(artifact.reportPath, '..'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('starts one caller-bound background core, retaining pending evidence and the full budget', async () => {
  phases.gate.mockResolvedValue(null);
  phases.fence.mockResolvedValue(null);
  phases.prepare.mockResolvedValue([{}]);
  phases.detach.mockResolvedValue({ snapshot: { runId: 'direct-background', taskId: 'task-direct' }, durable: true });
  const before = Date.now();
  const { root, result } = await invoke({ background: true, timeoutMs: 120_000,
    privatePg: false, maxFailures: 7, reporterStageTrace: true, testNamePattern: 'focused case' });
  expect(phases.gate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ background: true, timeoutMs: 120_000 }));
  expect(phases.detach).toHaveBeenCalledTimes(1);
  const request = phases.detach.mock.calls[0]![0];
  expect(request).toMatchObject({ command: process.execPath, cwd: REPO_ROOT, originRunId: result.runId,
    env: { PAPERCUSP_TEST_RUN_HARNESS: 'gate-harness', PAPERCUSP_WORKSPACE_ID: 'gate-workspace' } });
  const script = request.args.at(-1) as string;
  // Platform helpers run from the host checkout; only the explicit corpus and
  // reporter roots belong to the external fixture checkout.
  expect(script).toContain('"root":' + JSON.stringify(root));
  expect(request.detachedReportArtifacts).toEqual([expect.objectContaining({ root })]);
  expect(script).toContain('runTestFilesCore');
  expect(script).toContain('"allowDetachedRecovery":false');
  expect(script).toContain('"privatePg":false');
  expect(script).toContain('"maxFailures":7');
  expect(script).toContain('"testNamePattern":"focused case"');
  expect(result).toMatchObject({ ok: true, mode: 'background', status: 'pending',
    detachedRunId: 'direct-background', detachedDurable: true, taskId: 'task-direct',
    evidenceBundle: { status: 'incomplete', verificationFingerprint: null, rows: [{ phase: 'pending', outcome: 'unknown' }],
      recovery: { args: { recoverEvidence: { originRunId: result.runId, runId: 'direct-background' } } } } });
  expect((result.deadline as { taskDeadlineAtMs: number }).taskDeadlineAtMs).toBeGreaterThanOrEqual(before + 120_000);
  expect(phases.prepare).toHaveBeenCalledOnce();
  expect(phases.finish).not.toHaveBeenCalled();
  expect(result).not.toHaveProperty('passed');
  expect(testingRunAbortCompletionReceipt({}, { data: result } as never, {} as never)).toMatchObject({
    status: 'recorded', diagnostics: { outcome: 'pending' },
  });
  expect(testingRunAbortCompletionReceipt({}, { data: { ...result, detachedDurable: false } } as never, {} as never))
    .toMatchObject({ status: 'recovery-incomplete' });
});

it.each(['changedPaths', 'recoverEvidence', 'remeasureEvidence', 'nativeConsult', 'securityQualification'])(
  'refuses background mixed with %s before any preparation or launch', async selector => {
    const { data: result } = await runTool.handler({ background: true, [selector]: {} } as never, {} as never) as
      { data: Record<string, unknown> };
    expect(result).toMatchObject({ ok: false, error: 'mutually_exclusive_selectors' });
    expect(phases.prepare).not.toHaveBeenCalled();
    expect(phases.detach).not.toHaveBeenCalled();
  });

it('records delayed background preparation and handoff without renewing the deadline', async () => {
  const startedAt = Date.now();
  let elapsed = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => startedAt + elapsed);
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  phases.gate.mockImplementation(async () => { elapsed += 17; return null; });
  phases.fence.mockResolvedValue(null);
  phases.prepare.mockImplementation(async () => { elapsed += 3_000; return [{}]; });
  phases.detach.mockImplementation(async () => {
    elapsed += 2_000;
    return { snapshot: { runId: 'delayed-background', taskId: 'task-delayed' }, durable: true };
  });

  const { result, metadata } = await invoke({ background: true, timeoutMs: 120_000 });

  expect(result).toMatchObject({ status: 'pending', phaseTimingsMs: {
    admissionGateMs: 17, preparationMs: 3_017, handoffMs: 2_000,
    totalHandlerMs: 5_017, routerExecutionMs: null,
  } });
  expect(result.deadline).toMatchObject({ startedAtMs: startedAt, taskDeadlineAtMs: startedAt + 120_000 });
  expect(metadata).toHaveBeenCalledExactlyOnceWith({ testingRun: {
    schemaVersion: 'testing-run-phase-telemetry-v1', runId: result.runId, outcome: 'pending',
    detachedRunId: 'delayed-background', taskId: 'task-delayed', phaseTimingsMs: result.phaseTimingsMs,
  } });
  expect(phases.detach).toHaveBeenCalledOnce();
});

it('defaults auto-detected private-PG files to durable background dispatch', async () => {
  phases.gate.mockResolvedValue(null);
  phases.fence.mockResolvedValue(null);
  phases.prepare.mockResolvedValue([{}]);
  phases.detach.mockResolvedValue({ snapshot: { runId: 'auto-private-pg' }, durable: true });

  const { result } = await invoke({}, { autoPrivatePg: true });

  expect(result).toMatchObject({ mode: 'background', status: 'pending',
    detachedRunId: 'auto-private-pg', detachedDurable: true });
  expect(phases.gate).toHaveBeenCalledWith(expect.objectContaining({ background: true }));
  expect(phases.detach).toHaveBeenCalledOnce();
  expect((phases.detach.mock.calls[0]![0] as { args: string[] }).args.join(' ')).toContain('"privatePg":true');
});

it('preserves an explicit foreground choice for auto-detected private-PG files', async () => {
  phases.gate.mockResolvedValue(refusal);

  const { result } = await invoke({ background: false }, { autoPrivatePg: true });

  expect(result).toMatchObject({ reason: 'loop_audit_required' });
  expect(phases.gate).toHaveBeenCalledWith(expect.objectContaining({ background: false }));
  expect(phases.detach).not.toHaveBeenCalled();
});

it('retires prepared evidence and starts no child when preparation exhausts the deadline', async () => {
  const startedAt = Date.now();
  let elapsed = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => startedAt + elapsed);
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  phases.gate.mockResolvedValue(null);
  phases.fence.mockResolvedValue(null);
  phases.prepare.mockImplementation(async () => { elapsed = 120_000; return [{}]; });
  phases.retract.mockResolvedValue({ status: 'retired' });

  const { result, metadata } = await invoke({ background: true, timeoutMs: 120_000 });

  expect(result).toMatchObject({ ok: false, error: 'deadline_exhausted',
    deadline: { startedAtMs: startedAt, taskDeadlineAtMs: startedAt + 120_000 },
    evidenceBundle: { status: 'retired' },
    phaseTimingsMs: { preparationMs: 120_000, handoffMs: null } });
  expect(phases.detach).not.toHaveBeenCalled();
  expect(phases.retract).toHaveBeenCalledExactlyOnceWith([{}], result.runId,
    expect.objectContaining({ harnessSlug: 'gate-harness', workspaceId: 'gate-workspace' }), 'deadline_exhausted');
  expect(metadata).toHaveBeenCalledExactlyOnceWith({ testingRun: expect.objectContaining({
    runId: result.runId, outcome: 'deadline_exhausted', phaseTimingsMs: result.phaseTimingsMs,
  }) });
});

it('records background admission refusal without preparing evidence or handing off', async () => {
  phases.gate.mockResolvedValue(refusal);
  const { result, metadata } = await invoke({ background: true });
  expect(result).toMatchObject({ ok: false, reason: 'loop_audit_required' });
  expect(metadata).toHaveBeenCalledExactlyOnceWith({ testingRun: expect.objectContaining({
    runId: result.runId, outcome: 'loop_audit_required', phaseTimingsMs: result.phaseTimingsMs,
  }) });
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.detach).not.toHaveBeenCalled();
});

it('refuses a grinding item before any evidence is registered or any test process starts', async () => {
  phases.gate.mockResolvedValue(refusal);

  const { root, result } = await invoke();

  expect(result).toMatchObject({ ok: false, reason: 'loop_audit_required', work_item_id: 'WI-grinding', root });
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.fence).not.toHaveBeenCalled();
  expect(phases.finish).not.toHaveBeenCalled();
});

it('asks the gate about the named work item with the REQUESTED budget, not the foreground clamp', async () => {
  // Default budget: the detached run may outlive the clamp, so it is a slow attempt.
  phases.gate.mockResolvedValue(refusal);
  await invoke();
  expect(phases.gate).toHaveBeenCalledExactlyOnceWith({
    workspaceId: 'gate-workspace',
    workItemId: 'WI-grinding',
    background: false,
    timeoutMs: 300_000,
  });

  // An explicit short budget is passed through, so the gate can let an audit's quick check run.
  phases.gate.mockReset();
  phases.gate.mockResolvedValue(refusal);
  await invoke({ timeoutMs: 60_000 });
  expect(phases.gate).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
});

it('attributes the slow-run gate to the explicitly named item instead of a stale WI goal stamp', async () => {
  phases.provenance.mockImplementation(async (_ctx, _harness, _deps, options) => ({
    launchedBy: 'su-gate-test',
    sessionId: 'su-gate-test',
    harnessSlug: 'gate-harness',
    workItemId: options?.explicitWorkItemId ?? 'WI-10004353',
    planSlug: null,
    goalRef: 'WI-10004353',
  }));
  const namedRefusal = {
    ...refusal,
    work_item_id: 'WI-10004437',
    message: 'loop_audit_required — WI-10004437 is grinding',
  };
  phases.gate.mockResolvedValue(namedRefusal);

  const { result } = await invoke({ evidence: undefined, work_item_id: 'WI-10004437' });

  expect(result).toMatchObject({ ok: false, reason: 'loop_audit_required', work_item_id: 'WI-10004437' });
  expect(phases.provenance).toHaveBeenCalledWith(
    expect.objectContaining({ uiClientId: 'su-gate-test' }),
    'gate-harness',
    undefined,
    { explicitWorkItemId: 'WI-10004437' },
  );
  expect(phases.gate).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'WI-10004437' }));
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.finish).not.toHaveBeenCalled();
});

it('returns a held-claim refusal before the loop gate when the named item is not held', async () => {
  phases.provenance.mockRejectedValue(
    new BashProvenanceRefusal('work_item_not_held', "work_item_id 'WI-not-held' is not one of your held work-items."),
  );

  const { result } = await invoke({ evidence: undefined, work_item_id: 'WI-not-held' });

  expect(result).toMatchObject({ ok: false, error: 'work_item_not_held' });
  expect(phases.gate).not.toHaveBeenCalled();
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.fence).not.toHaveBeenCalled();
});

it('rejects an explicit work item that conflicts with the evidence attribution', async () => {
  const { result } = await invoke({ work_item_id: 'WI-explicit' });

  expect(result).toMatchObject({ ok: false, error: 'work_item_id_conflicts_with_evidence' });
  expect(phases.provenance).not.toHaveBeenCalled();
  expect(phases.gate).not.toHaveBeenCalled();
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.finish).not.toHaveBeenCalled();
});
