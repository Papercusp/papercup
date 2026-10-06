import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_PRECHECK_SETUP_BUDGET_MS,
  ADMISSION_PRECHECK_SETUP_IDLE_MS,
  admissionPrecheckSetupEnv,
  classifyTestFileRun,
  createCheckpointTreeFixPrecheckRunner,
  defaultExec,
  dependencyGenerationInfraCode,
  evaluateFixPrecheck,
  isTestFilePath,
  precheckPopulation,
  resolveCanonicalIntegrationRoot,
  ROUTER_EXIT_NOT_MEASURED,
  ROUTER_EXIT_TEMPFAIL,
  type ExecOptions,
  type ExecResult,
  type FixPrecheckRunResult,
  type FixPrecheckProgress,
} from './admission-fix-precheck';
import {
  TEST_FILE_EXIT_FAILED,
  TEST_FILE_EXIT_NOT_MEASURED,
  TEST_FILE_EXIT_PASSED,
  TEST_FILE_EXIT_TEMPFAIL,
  testFileRunWasMeasured,
  // The .mjs contract module has no declaration file; the diagnostic lands on
  // the `from` line, so the suppression must be the LAST comment line directly
  // above it.
  // @ts-expect-error
} from '../../../../scripts/lib/test-file-exit-codes.mjs';

const C = 'e'.repeat(40);
const sig = (id: string, kind: 'test-file' | 'lint-leg' | 'workspace-task' | 'post-suite-leg' | 'seed' = 'test-file') => ({ kind, id });
const ran = (results: Array<[string, 'pass' | 'fail' | 'unmeasured']>): FixPrecheckRunResult => ({
  ran: true,
  commit: C,
  results: results.map(([path, status]) => ({ path, status })),
});

describe('precheckPopulation (P-006 / R6)', () => {
  it('splits signature test files from admitted-outside-signature test files and ignores non-test paths', () => {
    const pop = precheckPopulation({
      signature: [sig('lib/red.test.ts'), sig('lib/red.test.ts'), sig('lib/other.test.ts')],
      admittedPaths: ['lib/red.test.ts', './lib/fix.ts', 'lib/new.test.ts', 'lib/new.test.ts', 'lib/x.integration.test.ts'],
    });
    expect(pop.signatureTestFiles).toEqual(['lib/red.test.ts', 'lib/other.test.ts']);
    expect(pop.admittedTestFiles).toEqual(['lib/new.test.ts', 'lib/x.integration.test.ts']);
    expect(pop.nonTestKinds).toEqual([]);
    expect(pop.canProveDoesNotFix).toBe(true);
    expect(pop.files).toEqual(['lib/red.test.ts', 'lib/other.test.ts', 'lib/new.test.ts', 'lib/x.integration.test.ts']);
  });

  it('cannot prove does-not-fix when the signature carries a non-test kind, or is empty', () => {
    const mixed = precheckPopulation({ signature: [sig('lib/red.test.ts'), sig('lint:tsc', 'lint-leg')], admittedPaths: [] });
    expect(mixed.canProveDoesNotFix).toBe(false);
    expect(mixed.nonTestKinds).toEqual(['lint-leg']);
    expect(mixed.signatureTestFiles).toEqual(['lib/red.test.ts']);
    const empty = precheckPopulation({ signature: [], admittedPaths: ['lib/fix.ts'] });
    expect(empty.canProveDoesNotFix).toBe(false);
    expect(empty.files).toEqual([]);
  });

  it('recognises the test-file spellings the router runs', () => {
    for (const p of ['a.test.ts', 'a.spec.tsx', 'a.integration.test.ts', 'a.test.mjs', 'a.spec.cjs', 'a.test.js']) {
      expect(isTestFilePath(p), p).toBe(true);
    }
    for (const p of ['a.ts', 'test.ts', 'a.tests.ts', 'a.test.ts.snap', 'a.test.md']) {
      expect(isTestFilePath(p), p).toBe(false);
    }
  });
});

describe('evaluateFixPrecheck (P-006 / R6)', () => {
  const pop = precheckPopulation({ signature: [sig('lib/red.test.ts'), sig('lib/red2.test.ts')], admittedPaths: ['lib/new.test.ts', 'lib/fix.ts'] });

  it('nothing-to-run when the population is empty (never invokes the runner)', () => {
    const empty = precheckPopulation({ signature: [sig('lint:tsc', 'lint-leg')], admittedPaths: ['lib/fix.ts'] });
    const v = evaluateFixPrecheck(empty, ran([]));
    expect(v).toMatchObject({ ok: true, ran: false, reason: 'nothing-to-run' });
  });

  it('passes when at least one signature test file passes and nothing admitted is red', () => {
    const v = evaluateFixPrecheck(pop, ran([['lib/red.test.ts', 'pass'], ['lib/red2.test.ts', 'fail'], ['lib/new.test.ts', 'pass']]));
    expect(v.ok).toBe(true);
    if (!v.ok || !v.ran) throw new Error('expected a ran verdict');
    expect(v.fixes).toEqual(['lib/red.test.ts']);
    expect(v.failing).toEqual(['lib/red2.test.ts']);
    expect(v.commit).toBe(C);
  });

  it('refuses admission-does-not-fix when no signature test file passes — an unmeasured file never counts as passing', () => {
    const v = evaluateFixPrecheck(pop, ran([['lib/red.test.ts', 'fail'], ['lib/new.test.ts', 'pass']]));
    expect(v).toMatchObject({ ok: false, code: 'admission-does-not-fix', alsoImportsRed: false, importedRed: [] });
    if (v.ok || !v.ran) throw new Error('expected a measured refusal');
    expect(v.unmeasured).toEqual(['lib/red2.test.ts']);
    expect(v.detail).toContain('unmeasured');
    expect(v.detail).toContain(C.slice(0, 12));
  });

  it('refuses admission-imports-red when an admitted test file outside the signature fails', () => {
    const v = evaluateFixPrecheck(pop, ran([['lib/red.test.ts', 'pass'], ['lib/red2.test.ts', 'pass'], ['lib/new.test.ts', 'fail']]));
    expect(v).toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['lib/new.test.ts'], alsoImportsRed: false });
    if (v.ok) throw new Error('expected refusal');
    expect(v.detail).toContain('lib/new.test.ts');
  });

  it('names does-not-fix as primary and flags alsoImportsRed when both hold', () => {
    const v = evaluateFixPrecheck(pop, ran([['lib/red.test.ts', 'fail'], ['lib/red2.test.ts', 'fail'], ['lib/new.test.ts', 'fail']]));
    expect(v).toMatchObject({ ok: false, code: 'admission-does-not-fix', alsoImportsRed: true, importedRed: ['lib/new.test.ts'] });
  });

  it('a signature with non-test kinds can only be refused for imports-red, never does-not-fix', () => {
    const mixed = precheckPopulation({ signature: [sig('lib/red.test.ts'), sig('lint:tsc', 'lint-leg')], admittedPaths: ['lib/new.test.ts'] });
    const allRedButNoImport = evaluateFixPrecheck(mixed, ran([['lib/red.test.ts', 'fail'], ['lib/new.test.ts', 'pass']]));
    expect(allRedButNoImport.ok).toBe(true);
    const imports = evaluateFixPrecheck(mixed, ran([['lib/red.test.ts', 'fail'], ['lib/new.test.ts', 'fail']]));
    expect(imports).toMatchObject({ ok: false, code: 'admission-imports-red' });
  });

  it('a signature red admitted as a path is still a signature file, not an import', () => {
    const p = precheckPopulation({ signature: [sig('lib/red.test.ts')], admittedPaths: ['lib/red.test.ts'] });
    expect(p.admittedTestFiles).toEqual([]);
    expect(evaluateFixPrecheck(p, ran([['lib/red.test.ts', 'fail']]))).toMatchObject({ ok: false, code: 'admission-does-not-fix' });
  });

  it('accepts only the busy-tree exception; a runner failure refuses as unmeasured', () => {
    const busy: FixPrecheckRunResult = { ran: false, reason: 'checkpoint-tree-busy', detail: 'gate run holds it', holder: { pid: 7, elapsedSec: 30 } };
    expect(evaluateFixPrecheck(pop, busy)).toMatchObject({ ok: true, ran: false, reason: 'checkpoint-tree-busy', holder: { pid: 7 } });
    const failed: FixPrecheckRunResult = { ran: false, reason: 'runner-failed', detail: 'setup exited 1' };
    expect(evaluateFixPrecheck(pop, failed)).toMatchObject({
      ok: false,
      ran: false,
      code: 'admission-precheck-unavailable',
      reason: 'runner-failed',
      detail: expect.stringContaining('setup exited 1'),
    });
  });
});

describe('classifyTestFileRun', () => {
  const r = (over: Partial<ExecResult>): ExecResult => ({ exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1, ...over });
  it('exit 0 is pass; nonzero is fail; route errors, matched=0, timeouts and signals are unmeasured', () => {
    expect(classifyTestFileRun(r({})).status).toBe('pass');
    expect(classifyTestFileRun(r({ exitCode: 1 })).status).toBe('fail');
    expect(classifyTestFileRun(r({ exitCode: 0, output: 'TEST_FILE_ROUTE_ERROR path=x' })).status).toBe('unmeasured');
    expect(classifyTestFileRun(r({ exitCode: 0, output: 'router matched=0 files' })).status).toBe('unmeasured');
    expect(classifyTestFileRun(r({ exitCode: 1, timedOut: true })).status).toBe('unmeasured');
    expect(classifyTestFileRun(r({ exitCode: null, signal: 'SIGKILL' })).status).toBe('unmeasured');
  });

  it('pins the local not-measured literals to the router exit-code contract', () => {
    expect(ROUTER_EXIT_NOT_MEASURED).toBe(TEST_FILE_EXIT_NOT_MEASURED);
    expect(ROUTER_EXIT_TEMPFAIL).toBe(TEST_FILE_EXIT_TEMPFAIL);
  });

  it('classifies every contract exit code by whether the router MEASURED it (WI-10003617)', () => {
    // Only a measured run may be pass or fail; everything else is unmeasured — never a red.
    for (const code of [TEST_FILE_EXIT_PASSED, TEST_FILE_EXIT_FAILED, TEST_FILE_EXIT_NOT_MEASURED, TEST_FILE_EXIT_TEMPFAIL] as number[]) {
      const status = classifyTestFileRun(r({ exitCode: code })).status;
      if (testFileRunWasMeasured(code)) expect(status, `exit ${code}`).not.toBe('unmeasured');
      else expect(status, `exit ${code}`).toBe('unmeasured');
    }
  });

  it('an all-skipped file (router exit 2) is unmeasured, so it cannot refuse an admission as imports-red', () => {
    const allSkipped = r({
      exitCode: TEST_FILE_EXIT_NOT_MEASURED,
      output:
        'TEST_FILE_ALL_SKIPPED requested=1 executed=1 matched=1 testsExecuted=0 status=not-measured reason=every-collected-test-was-skipped',
    });
    const c = classifyTestFileRun(allSkipped);
    expect(c.status).toBe('unmeasured');
    expect(c.detail).toContain('reason=every-collected-test-was-skipped');

    const pop = precheckPopulation({ signature: [sig('lint', 'lint-leg')], admittedPaths: ['pkg/skipped.test.ts'] });
    const v = evaluateFixPrecheck(pop, ran([['pkg/skipped.test.ts', c.status]]));
    expect(v.ok).toBe(true);
    expect(v.ran && v.unmeasured).toEqual(['pkg/skipped.test.ts']);
  });
});

describe('createCheckpointTreeFixPrecheckRunner', () => {
  it('advances the heartbeat on setup output before setup finishes or any file is measured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'precheck-setup-progress-'));
    const releaseFile = join(dir, 'release');
    const snapshots: FixPrecheckProgress[] = [];
    let setupFinished = false;
    let filesMeasured = 0;
    const exec = async (argv: readonly string[], opts: ExecOptions): Promise<ExecResult> => {
      if (argv[0] !== 'bash') {
        filesMeasured += 1;
        return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 };
      }
      const result = await defaultExec([
        process.execPath, '-e',
        "const fs = require('node:fs'); console.log('materializing dependencies'); " +
          "console.error('setup stderr progress'); " +
          "const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); } }, 10);",
        releaseFile,
      ], { ...opts, cwd: process.cwd(), timeoutMs: 5_000 });
      setupFinished = true;
      return result;
    };
    const runner = createCheckpointTreeFixPrecheckRunner({
      integrationRoot: process.cwd(), checkpointRoot: join(dir, 'checkpoint'),
      exec, logDir: dir, runLockHeld: () => ({ held: false, elapsedSec: null }),
    });
    const startedAt = Date.now();
    const pending = runner({ commit: C, files: ['lib/red.test.ts'], onProgress: (p) => { snapshots.push(p); } });
    try {
      await vi.waitFor(() => {
        expect(snapshots.some((p) => p.heartbeatAtMs > startedAt)).toBe(true);
      }, { timeout: 2_000 });
      expect(setupFinished).toBe(false);
      expect(filesMeasured).toBe(0);
      expect(snapshots.at(-1)).toMatchObject({ currentFile: 'lib/red.test.ts', completedCount: 0, totalCount: 1 });
    } finally {
      writeFileSync(releaseFile, 'release setup');
      const result = await pending;
      rmSync(dir, { recursive: true, force: true });
      expect(result).toMatchObject({ ran: true, results: [{ status: 'pass' }] });
    }
  });

  const base = { integrationRoot: '/repo', checkpointRoot: '/ckpt' };

  it('reports checkpoint-tree-busy without touching the tree when a gate run holds the run-lock', async () => {
    const exec = vi.fn();
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: true, pid: 42, elapsedSec: 120 }) });
    const out = await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect(out).toMatchObject({ ran: false, reason: 'checkpoint-tree-busy', holder: { pid: 42, elapsedSec: 120 } });
    expect(exec).not.toHaveBeenCalled();
  });

  it('materializes the commit with setup-release-checkout then runs each file in a dedicated admission checkout', async () => {
    const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
    const events: string[] = [];
    const progress: Array<{
      currentFile: string;
      completedCount: number;
      totalCount: number;
      heartbeatAtMs: number;
    }> = [];
    const exec = vi.fn(async (argv: readonly string[], opts: { cwd: string }) => {
      calls.push({ argv, cwd: opts.cwd });
      if (argv[0] === 'bash') {
        events.push('setup');
        return { exitCode: 0, signal: null, timedOut: false, output: 'ok', durationMs: 5 } as ExecResult;
      }
      const file = argv[2];
      events.push(`test:${file}`);
      return { exitCode: file === 'lib/red.test.ts' ? 0 : 1, signal: null, timedOut: false, output: '', durationMs: 3 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const out = await runner({
      commit: C,
      files: ['lib/red.test.ts', 'lib/new.test.ts'],
      onProgress: (snapshot) => {
        progress.push(snapshot);
        events.push(`progress:${snapshot.currentFile}`);
      },
    });
    expect(out).toMatchObject({ ran: true, commit: C, results: [{ path: 'lib/red.test.ts', status: 'pass' }, { path: 'lib/new.test.ts', status: 'fail' }] });
    expect(progress).toEqual([
      { currentFile: 'lib/red.test.ts', completedCount: 0, totalCount: 2, heartbeatAtMs: expect.any(Number) },
      { currentFile: 'lib/new.test.ts', completedCount: 1, totalCount: 2, heartbeatAtMs: expect.any(Number) },
    ]);
    expect(events).toEqual([
      'setup',
      'progress:lib/red.test.ts',
      'test:lib/red.test.ts',
      'progress:lib/new.test.ts',
      'test:lib/new.test.ts',
    ]);
    expect(calls[0].argv.slice(0, 2)).toEqual(['bash', '/repo/apps/operator/bin/release/setup-release-checkout.sh']);
    expect(calls[0].argv).toEqual(expect.arrayContaining(['--ref', C, '--integration', '/repo', '--release', '/ckpt-admission-precheck']));
    expect(calls[0].cwd).toBe('/repo');
    expect(calls[1]).toEqual({ argv: ['node', 'scripts/test-files.mjs', 'lib/red.test.ts'], cwd: '/ckpt-admission-precheck' });
    expect(calls[2].argv[2]).toBe('lib/new.test.ts');
  });

  it('materializes the pre-check node_modules by hardlink from the immutable generation (WI-10004928)', async () => {
    const setupEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const testEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const exec = vi.fn(async (argv: readonly string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      (argv[0] === 'bash' ? setupEnvs : testEnvs).push(opts.env);
      return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect(admissionPrecheckSetupEnv()).toEqual({ DEPENDENCY_GENERATION_ALLOW_HARDLINK: '1' });
    expect(setupEnvs).toEqual([{ DEPENDENCY_GENERATION_ALLOW_HARDLINK: '1' }]);
    // The opt-in is for materialization only. The test processes never see it.
    expect(testEnvs[0]?.DEPENDENCY_GENERATION_ALLOW_HARDLINK).toBeUndefined();
  });

  it('cannot measure a gate-repinned checkout as an admission failure', async () => {
    let gateCheckoutHead = 'old-gate-head';
    const measuredRoots: string[] = [];
    const exec = vi.fn(async (argv: readonly string[], opts: { cwd: string }) => {
      if (argv[0] === 'bash') {
        expect(argv).toEqual(expect.arrayContaining(['--release', '/ckpt-admission-precheck']));
      } else {
        const racedOntoOldGateTree = gateCheckoutHead === 'new-gate-head' && opts.cwd === base.checkpointRoot;
        measuredRoots.push(opts.cwd);
        if (measuredRoots.length === 1) gateCheckoutHead = 'new-gate-head';
        return {
          exitCode: racedOntoOldGateTree ? 1 : 0,
          signal: null,
          timedOut: false,
          output: racedOntoOldGateTree ? 'No getDatatype export is defined on the old mock' : '',
          durationMs: 5,
        } as ExecResult;
      }
      return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 5 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const out = await runner({ commit: C, files: ['lib/first.test.ts', 'lib/second.test.ts'] });
    expect(gateCheckoutHead).toBe('new-gate-head');
    expect(measuredRoots).toEqual(['/ckpt-admission-precheck', '/ckpt-admission-precheck']);
    expect(out).toMatchObject({ ran: true, results: [{ status: 'pass' }, { status: 'pass' }] });
  });

  it('refuses to reset an existing directory that is not its own admission worktree', async () => {
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'admission-checkout-'));
    const unrelated = `${checkpointRoot}-admission-precheck`;
    mkdirSync(unrelated);
    try {
      const exec = vi.fn();
      const runner = createCheckpointTreeFixPrecheckRunner({
        integrationRoot: '/repo', checkpointRoot, exec,
        runLockHeld: () => ({ held: false, elapsedSec: null }),
      });
      const out = await runner({ commit: C, files: ['lib/red.test.ts'] });
      expect(out).toMatchObject({ ran: false, reason: 'runner-failed' });
      expect(exec).not.toHaveBeenCalled();
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
      rmSync(checkpointRoot, { recursive: true, force: true });
    }
  });

  it('isolates progress persistence failures from the measured file verdict', async () => {
    const logs: string[] = [];
    const exec = vi.fn(async (argv: readonly string[]) =>
      ({ exitCode: 0, signal: null, timedOut: false, output: argv[0] === 'bash' ? 'ok' : '', durationMs: 5 }) as ExecResult,
    );
    const runner = createCheckpointTreeFixPrecheckRunner({
      ...base,
      exec,
      log: (line) => logs.push(line),
      runLockHeld: () => ({ held: false, elapsedSec: null }),
    });
    const out = await runner({
      commit: C,
      files: ['lib/red.test.ts'],
      onProgress: () => {
        throw new Error('queue unavailable');
      },
    });
    expect(out).toMatchObject({ ran: true, results: [{ path: 'lib/red.test.ts', status: 'pass' }] });
    expect(logs).toContain('[admission-precheck] progress callback failed for lib/red.test.ts: queue unavailable');
  });

  it('a failed setup is runner-failed (never a verdict on the files)', async () => {
    const exec = vi.fn(async () => ({ exitCode: 1, signal: null, timedOut: false, output: 'boom', durationMs: 5 }) as ExecResult);
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const out = await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect(out).toMatchObject({ ran: false, reason: 'runner-failed' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  // WI-10006014: the setup died on a 20-min WALL-CLOCK budget while still progressing, and the
  // failure left nothing on disk to attribute it with.
  it('gives setup an idle watchdog + the shared ceiling, logs durably, and names a stall and the log in the detail', async () => {
    const seen: ExecOptions[] = [];
    const exec = vi.fn(async (_argv: readonly string[], opts: ExecOptions) => {
      seen.push(opts);
      return { exitCode: null, signal: 'SIGTERM', timedOut: true, idleTimedOut: true, output: 'last-setup-line', durationMs: 5 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({
      ...base,
      exec,
      logDir: '/var/log/precheck',
      runLockHeld: () => ({ held: false, elapsedSec: null }),
    });
    const out = await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect(seen[0]).toMatchObject({
      timeoutMs: ADMISSION_PRECHECK_SETUP_BUDGET_MS,
      idleTimeoutMs: ADMISSION_PRECHECK_SETUP_IDLE_MS,
    });
    expect(seen[0].logFile).toMatch(new RegExp(`^/var/log/precheck/admission-precheck-${C.slice(0, 12)}-.*\\.log$`));
    expect(ADMISSION_PRECHECK_SETUP_IDLE_MS).toBeLessThan(ADMISSION_PRECHECK_SETUP_BUDGET_MS);
    expect(out).toMatchObject({ ran: false, reason: 'runner-failed' });
    const detail = (out as { detail: string }).detail;
    expect(detail).toContain('(stalled: no output for 15 min)');
    expect(detail).toContain(`log=${seen[0].logFile}`);
    expect(detail).toContain('last-setup-line');
  });

  it('a wall-clock ceiling hit is reported as such, distinct from a stall', async () => {
    const exec = vi.fn(async () => ({ exitCode: null, signal: 'SIGTERM', timedOut: true, output: 'x', durationMs: 2_400_000 }) as ExecResult);
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, logDir: '/tmp/l', runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const out = await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect((out as { detail: string }).detail).toMatch(/\(timed out at the 40-min ceiling after 2400s\)/);
  });

  it('every per-file run appends to the same durable log as setup', async () => {
    const logFiles: Array<string | undefined> = [];
    const exec = vi.fn(async (_argv: readonly string[], opts: ExecOptions) => {
      logFiles.push(opts.logFile);
      return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, logDir: '/tmp/l', runLockHeld: () => ({ held: false, elapsedSec: null }) });
    await runner({ commit: C, files: ['lib/a.test.ts', 'lib/b.test.ts'] });
    expect(logFiles).toHaveLength(3);
    expect(new Set(logFiles).size).toBe(1);
    expect(logFiles[0]).toMatch(/^\/tmp\/l\/admission-precheck-/);
  });
});

describe('resolveCanonicalIntegrationRoot (P-006 / R6)', () => {
  it('a main worktree (its common dir is its own .git) resolves to itself', () => {
    expect(resolveCanonicalIntegrationRoot('/w/papercusp', () => '/w/papercusp/.git')).toBe('/w/papercusp');
  });

  it('a LINKED worktree (papercusp-staging on :3170) resolves to the main worktree that owns the object store', () => {
    // Measured 2026-09-11: the door handed the runner the linked worktree, setup-release-checkout
    // refused it (`-d .git` is false for a gitdir FILE), and the admission published unmeasured.
    expect(resolveCanonicalIntegrationRoot('/w/papercusp-staging', () => '/w/papercusp/.git')).toBe('/w/papercusp');
  });

  it('a relative common dir is resolved against the root', () => {
    expect(resolveCanonicalIntegrationRoot('/w/papercusp', () => '.git')).toBe('/w/papercusp');
  });

  it('a root git cannot classify is returned unchanged — the runner then fails loudly instead of guessing', () => {
    expect(resolveCanonicalIntegrationRoot('/not-a-repo', () => null)).toBe('/not-a-repo');
    expect(resolveCanonicalIntegrationRoot('/bare.git', () => '/bare.git')).toBe('/bare.git');
  });
});

describe('dependencyGenerationInfraCode (WI-10004849)', () => {
  it('maps the typed copy refusals by exit code', () => {
    expect(dependencyGenerationInfraCode(76, '')).toBe('DEPENDENCY_GENERATION_LOCK_TIMEOUT');
    expect(dependencyGenerationInfraCode(77, '')).toBe('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
  });

  it('recognizes the logged marker when a wrapper re-mapped the exit', () => {
    expect(
      dependencyGenerationInfraCode(
        1,
        '[dependency-generation] DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT need=0 avail=1',
      ),
    ).toBe('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
  });

  it('is null for an ordinary setup failure', () => {
    expect(dependencyGenerationInfraCode(1, 'npm ERR! missing script')).toBeNull();
    expect(dependencyGenerationInfraCode(null, '')).toBeNull();
  });
});
