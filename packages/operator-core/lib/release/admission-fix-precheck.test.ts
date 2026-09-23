import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyTestFileRun,
  createCheckpointTreeFixPrecheckRunner,
  evaluateFixPrecheck,
  isTestFilePath,
  precheckPopulation,
  resolveCanonicalIntegrationRoot,
  type ExecResult,
  type FixPrecheckRunResult,
} from './admission-fix-precheck';

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
});

describe('createCheckpointTreeFixPrecheckRunner', () => {
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
