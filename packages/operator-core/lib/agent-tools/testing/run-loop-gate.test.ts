import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
}));
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
import runTool, { buildDetachedTestRunBootstrapScript, testingRunAbortCompletionReceipt } from './run';
import { testRunDeadline, type TestRunDeadline } from './run-artifacts';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const directories = phases.detach.mock.calls.flatMap(([request]) =>
    (request.detachedReportArtifacts ?? []).map((artifact: { reportPath: string }) => join(artifact.reportPath, '..')));
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  Object.values(phases).forEach((mock) => mock.mockReset());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function invoke(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'testing-run-loop-gate-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
  await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'feature.test.ts'), "import { it } from 'vitest';\nit('noop', () => {});\n");
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
