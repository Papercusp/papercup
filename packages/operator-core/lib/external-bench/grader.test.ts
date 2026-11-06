/**
 * Port 3 (grader) unit tests — fake exec/fs, no Docker, no image pulls.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  getOfficialGrader,
  makeFakeGrader,
  makeHarnessBenchGrader,
  makeSweBenchProGrader,
  makeSweBenchVerifiedGrader,
  parseSweBenchProReport,
  parseSweBenchVerifiedReport,
} from './grader';
import type { GraderFs, HarnessBenchReceipt, SweBenchVerifiedGraderConfig } from './grader';
import type { ArmSubmission, BenchTask as Task } from './types';

function task(id: string): Task {
  return { benchmark: 'swe-bench-pro', instanceId: id, problemStatement: 'x', repo: 'a/b', baseCommit: 'abc1234', graderMeta: {} };
}
function diffSub(id: string, patch = 'diff', prefix = 'seed-0'): ArmSubmission {
  return { modality: 'diff', instanceId: id, patch, prefix };
}

describe('makeFakeGrader', () => {
  it('resolves from a verdict map and is pure w.r.t. the arm', async () => {
    const g = makeFakeGrader({ verdicts: { a: true, b: false } });
    const res = await g.grade([diffSub('a'), diffSub('b')], [task('a'), task('b')]);
    expect(res.map((r) => r.resolved)).toEqual([true, false]);
    expect(res[0].failToPass?.[0]).toEqual({ test: 'fake::test_resolved', passed: true });
  });
  it('treats a missing verdict as graderError (not a silent false)', async () => {
    const g = makeFakeGrader({ verdicts: { a: true } });
    const [, b] = await g.grade([diffSub('a'), diffSub('b')], [task('a'), task('b')]);
    expect(b.graderError).toMatch(/no verdict/);
    expect(b.resolved).toBe(false);
  });
  it('honors a forced per-instance graderError', async () => {
    const g = makeFakeGrader({ verdicts: { a: true }, graderErrors: { a: 'image pull failed' } });
    const [a] = await g.grade([diffSub('a')], [task('a')]);
    expect(a.graderError).toBe('image pull failed');
  });
});

describe('parseSweBenchProReport', () => {
  const subs = [diffSub('a'), diffSub('b')];

  it('maps the eval_results.json bool verdict per instance', () => {
    const res = parseSweBenchProReport({ a: true, b: false }, subs, 'v1');
    expect(res[0].resolved).toBe(true);
    expect(res[1].resolved).toBe(false);
    expect(res[0].graderFamily).toBe('swe-bench-pro');
    expect(res[0].graderVersion).toBe('v1');
  });

  it('a missing instance is graderError, not a silent fail', () => {
    const [a] = parseSweBenchProReport({ b: true }, subs, 'v1');
    expect(a.graderError).toMatch(/no eval_results.json entry/);
    expect(a.resolved).toBe(false);
  });
});

describe('makeSweBenchProGrader', () => {
  function fakeFs(report: unknown, opts: { failRead?: boolean } = {}): { fs: GraderFs; writes: Record<string, string> } {
    const writes: Record<string, string> = {};
    const fs: GraderFs = {
      mkdtemp: async (p) => `${p}tmp`,
      writeFile: async (p, d) => {
        writes[p] = d;
      },
      readFile: async () => {
        if (opts.failRead) throw new Error('no report');
        return JSON.stringify(report);
      },
      rm: async () => {},
    };
    return { fs, writes };
  }

  it('writes predictions JSON, invokes the eval, and maps the report', async () => {
    const { fs, writes } = fakeFs({ a: true }); // eval_results.json = { instance_id: bool }
    const exec = vi.fn(async (_cmd: string, _args: string[], _opts?: { cwd?: string }) => ({ stdout: '', stderr: '', code: 0 }));
    const grader = makeSweBenchProGrader({ evalRepoDir: '/eval', rawSamplePath: '/csv.csv', version: 'imgset@2026-05' }, { exec, fs });

    const res = await grader.grade([diffSub('a', 'PATCH', 'seed-1')], [task('a')]);
    expect(res[0].resolved).toBe(true);
    expect(res[0].graderVersion).toBe('imgset@2026-05');

    // predictions written in the {instance_id, patch, prefix} shape
    const preds = JSON.parse(Object.values(writes)[0]);
    expect(preds[0]).toMatchObject({ instance_id: 'a', patch: 'PATCH', prefix: 'seed-1' });

    // eval invoked with the documented argv (shell-free, cwd=evalRepoDir), local Docker by default
    const [cmd, argv, opts] = exec.mock.calls[0];
    expect(cmd).toBe('python3');
    expect(argv[0]).toBe('swe_bench_pro_eval.py');
    expect(argv).toContain('--raw_sample_path=/csv.csv');
    expect(argv.some((a: string) => a.startsWith('--patch_path='))).toBe(true);
    expect(argv).toContain('--dockerhub_username=jefzda');
    expect(argv).toContain('--use_local_docker');
    expect(opts?.cwd).toBe('/eval');
  });

  it('turns a missing report into a batch-wide graderError', async () => {
    const { fs } = fakeFs(null, { failRead: true });
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'died', code: 1 }));
    const grader = makeSweBenchProGrader({ evalRepoDir: '/eval', rawSamplePath: '/csv.csv', version: 'v' }, { exec, fs });
    const res = await grader.grade([diffSub('a'), diffSub('b')], [task('a'), task('b')]);
    expect(res.every((r) => r.graderError)).toBe(true);
    expect(res[0].resolved).toBe(false);
  });

  it('ignores non-diff (in-container) submissions', async () => {
    const { fs } = fakeFs({});
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const grader = makeSweBenchProGrader({ evalRepoDir: '/e', rawSamplePath: '/c', version: 'v' }, { exec, fs });
    const res = await grader.grade([{ modality: 'in-container', instanceId: 'a', envRef: 'env://x', prefix: 'seed-0' }], [task('a')]);
    expect(res).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('parseSweBenchVerifiedReport', () => {
  const subs = [diffSub('a'), diffSub('b'), diffSub('c')];

  it('maps resolved_ids → resolved, unresolved → false, error_ids → graderError', () => {
    const res = parseSweBenchVerifiedReport({ resolved_ids: ['a'], unresolved_ids: ['b'], error_ids: ['c'] }, subs, 'v1');
    expect(res[0].resolved).toBe(true);
    expect(res[1].resolved).toBe(false);
    expect(res[1].graderError).toBeUndefined();
    expect(res[2].resolved).toBe(false);
    expect(res[2].graderError).toMatch(/error_ids/);
    expect(res[0].graderFamily).toBe('swe-bench-verified');
  });

  it('an instance in no list is graderError, not a silent fail', () => {
    const [a] = parseSweBenchVerifiedReport({ resolved_ids: ['b'] }, [diffSub('a')], 'v1');
    expect(a.resolved).toBe(false);
    expect(a.graderError).toMatch(/no verdict/);
  });
});

describe('makeSweBenchVerifiedGrader', () => {
  function fakeFs(): { fs: GraderFs; writes: Record<string, string> } {
    const writes: Record<string, string> = {};
    const fs: GraderFs = {
      mkdtemp: async (p) => `${p}tmp`,
      writeFile: async (p, d) => {
        writes[p] = d;
      },
      readFile: async () => '{}',
      rm: async () => {},
    };
    return { fs, writes };
  }

  function cfg(over: Partial<SweBenchVerifiedGraderConfig> = {}): SweBenchVerifiedGraderConfig {
    return {
      swebenchDir: '/swebench',
      version: 'swebench@sha / images-2026-06',
      buildEvalCommand: ({ predsPath, runId, datasetName, maxWorkers }) => ({
        cmd: 'python3',
        args: [
          '-m',
          'swebench.harness.run_evaluation',
          `--dataset_name=${datasetName}`,
          `--predictions_path=${predsPath}`,
          `--run_id=${runId}`,
          `--max_workers=${maxWorkers}`,
        ],
      }),
      readReport: async () => ({ resolved_ids: ['a'], unresolved_ids: [] }),
      ...over,
    };
  }

  it('writes model_patch predictions, invokes the swebench harness, maps resolved_ids', async () => {
    const { fs, writes } = fakeFs();
    const exec = vi.fn(async (_cmd: string, _args: string[], _opts?: { cwd?: string }) => ({ stdout: '', stderr: '', code: 0 }));
    const grader = makeSweBenchVerifiedGrader(cfg(), { exec, fs });
    const res = await grader.grade([diffSub('a', 'PATCH', 'seed-1')], [task('a')]);

    expect(res[0].resolved).toBe(true);
    expect(res[0].graderVersion).toBe('swebench@sha / images-2026-06');
    // predictions use the swebench {instance_id, model_name_or_path, model_patch} shape (NOT Pro's patch)
    const preds = JSON.parse(Object.values(writes)[0]);
    expect(preds[0]).toMatchObject({ instance_id: 'a', model_name_or_path: 'papercusp', model_patch: 'PATCH' });
    // harness invoked via the injected command (shell-free argv, cwd=swebenchDir), the swebench module path
    const [cmd, argv, opts] = exec.mock.calls[0];
    expect(cmd).toBe('python3');
    expect(argv).toContain('-m');
    expect(argv).toContain('swebench.harness.run_evaluation');
    expect(argv.some((a: string) => a.startsWith('--dataset_name=princeton-nlp/SWE-bench_Verified'))).toBe(true);
    expect(opts?.cwd).toBe('/swebench');
  });

  it('turns a failed report-read into a batch-wide graderError', async () => {
    const { fs } = fakeFs();
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'harness died', code: 1 }));
    const grader = makeSweBenchVerifiedGrader(
      cfg({ readReport: async () => { throw new Error('no report file'); } }),
      { exec, fs },
    );
    const res = await grader.grade([diffSub('a'), diffSub('b')], [task('a'), task('b')]);
    expect(res.every((r) => r.graderError)).toBe(true);
    expect(res[0].resolved).toBe(false);
  });
});

describe('getOfficialGrader', () => {
  it('builds the swe-bench-pro grader from config', () => {
    const g = getOfficialGrader('swe-bench-pro', { sweBenchPro: { evalRepoDir: '/e', rawSamplePath: '/c', version: 'v' } }, { exec: async () => ({ stdout: '', stderr: '', code: 0 }), fs: {} as never });
    expect(g.family).toBe('swe-bench-pro');
    expect(g.modality).toBe('diff');
  });
  it('builds the swe-bench-verified grader from config', () => {
    const g = getOfficialGrader(
      'swe-bench-verified',
      {
        sweBenchVerified: {
          swebenchDir: '/swebench',
          version: 'v',
          buildEvalCommand: () => ({ cmd: 'python3', args: [] }),
          readReport: async () => ({}),
        },
      },
      { exec: async () => ({ stdout: '', stderr: '', code: 0 }), fs: {} as never },
    );
    expect(g.family).toBe('swe-bench-verified');
    expect(g.modality).toBe('diff');
  });
  it('throws when the verified config is absent', () => {
    expect(() => getOfficialGrader('swe-bench-verified', {})).toThrow(/requires a SweBenchVerifiedGraderConfig/);
  });
  it('throws for the unbuilt terminal backend and unconfigured replay backend', () => {
    expect(() => getOfficialGrader('terminal-bench', {})).toThrow(/not built yet/);
    expect(() => getOfficialGrader('harness-bench', {})).toThrow(/requires a HarnessBenchGraderConfig/);
  });
  it('throws for an unsupported family', () => {
    expect(() => getOfficialGrader('made-up', {})).toThrow(/unsupported/);
  });
});

describe('real-plan replay own-test receipt validation', () => {
  const sourceCommit = 'a'.repeat(40), graderCommit = 'b'.repeat(40);
  function replayTask(): Task {
    return { ...task('real-plan/P-001'), benchmark: 'harness-bench', baseCommit: sourceCommit,
      graderMeta: { graderCommit, testFiles: ['src/own.test.ts'] } };
  }
  function receipt(): HarnessBenchReceipt {
    return { instanceId: 'real-plan/P-001', prefix: 'seed-0', sourceCommit, graderCommit,
      submissionSha256: createHash('sha256').update('PATCH').digest('hex'),
      checkoutRealpath: '/private/replay-1', exitCode: 0,
      tests: [{ path: 'src/own.test.ts', passed: 3, failed: 0, skipped: 0, collectionFailed: false }],
      rawOutput: 'original own-test output' };
  }
  const submission = () => diffSub('real-plan/P-001', 'PATCH');
  const config = (evaluate: (sub: Extract<ArmSubmission, { modality: 'diff' }>, item: Task) => Promise<HarnessBenchReceipt>) =>
    ({ version: 'own-tests@' + graderCommit, sharedCheckoutRealpath: '/shared/staging', evaluate });

  it('reuses the registry and returns the task own measured verdict and original receipt', async () => {
    const original = receipt(), evaluate = vi.fn(async () => original);
    const grader = getOfficialGrader('harness-bench', { harnessBench: config(evaluate) });
    const [grade] = await grader.grade([submission()], [replayTask()]);
    expect(evaluate).toHaveBeenCalledWith(submission(), replayTask());
    expect(grade).toMatchObject({ resolved: true, graderFamily: 'harness-bench',
      graderVersion: 'own-tests@' + graderCommit, failToPass: [{ test: 'src/own.test.ts', passed: true }] });
    expect(grade!.rawGraderOutput).toBe(original);
    expect(grade!.graderError).toBeUndefined();
  });

  it('records an actual assertion failure as a measured failure', async () => {
    const original = receipt(); original.tests[0]!.failed = 1; original.exitCode = 1;
    const [grade] = await makeHarnessBenchGrader(config(async () => original)).grade([submission()], [replayTask()]);
    expect(grade!.resolved).toBe(false);
    expect(grade!.graderError).toBeUndefined();
    expect(grade!.failToPass).toEqual([{ test: 'src/own.test.ts', passed: false }]);
  });

  it.each([
    ['different task', (r: HarnessBenchReceipt) => { r.instanceId = 'other'; }],
    ['different sample', (r: HarnessBenchReceipt) => { r.prefix = 'other'; }],
    ['different source', (r: HarnessBenchReceipt) => { r.sourceCommit = 'c'.repeat(40); }],
    ['different grader', (r: HarnessBenchReceipt) => { r.graderCommit = 'c'.repeat(40); }],
    ['different patch', (r: HarnessBenchReceipt) => { r.submissionSha256 = 'c'.repeat(64); }],
    ['shared checkout', (r: HarnessBenchReceipt) => { r.checkoutRealpath = '/shared/staging/sub'; }],
    ['relative checkout', (r: HarnessBenchReceipt) => { r.checkoutRealpath = 'private/replay'; }],
    ['missing test', (r: HarnessBenchReceipt) => { r.tests = []; }],
    ['different test', (r: HarnessBenchReceipt) => { r.tests[0]!.path = 'different.test.ts'; }],
    ['duplicate test', (r: HarnessBenchReceipt) => { r.tests.push({ ...r.tests[0]! }); }],
    ['collection failure', (r: HarnessBenchReceipt) => { r.tests[0]!.collectionFailed = true; }],
    ['all skipped', (r: HarnessBenchReceipt) => { r.tests[0]!.passed = 0; r.tests[0]!.skipped = 3; }],
    ['partial skip', (r: HarnessBenchReceipt) => { r.tests[0]!.skipped = 1; }],
    ['zero assertions', (r: HarnessBenchReceipt) => { r.tests[0]!.passed = 0; }],
    ['unknown count', (r: HarnessBenchReceipt) => { r.tests[0]!.passed = NaN; }],
    ['negative count', (r: HarnessBenchReceipt) => { r.tests[0]!.failed = -1; }],
    ['lost output', (r: HarnessBenchReceipt) => { r.rawOutput = ''; }],
    ['timeout', (r: HarnessBenchReceipt) => { r.exitCode = 124; }],
    ['failed finalization', (r: HarnessBenchReceipt) => { r.exitCode = 7; }],
    ['false passing exit', (r: HarnessBenchReceipt) => { r.tests[0]!.failed = 1; }],
  ])('preserves %s as grader infrastructure error rather than success or capability failure', async (_name, change) => {
    const original = receipt(); change(original);
    const [grade] = await makeHarnessBenchGrader(config(async () => original)).grade([submission()], [replayTask()]);
    expect(grade!.resolved).toBe(false);
    expect(grade!.graderError).toBeTruthy();
    expect(grade!.rawGraderOutput).toBe(original);
  });

  it.each([
    ['unfrozen source', (t: Task) => { t.baseCommit = 'staging'; }],
    ['unfrozen grader', (t: Task) => { t.graderMeta.graderCommit = 'main'; }],
    ['missing own tests', (t: Task) => { t.graderMeta.testFiles = []; }],
    ['escaping own tests', (t: Task) => { t.graderMeta.testFiles = ['../own.test.ts']; }],
    ['duplicate own tests', (t: Task) => { t.graderMeta.testFiles = ['src/own.test.ts', 'src/own.test.ts']; }],
  ])('refuses %s before execution', async (_name, change) => {
    const item = replayTask(); change(item); const evaluate = vi.fn(async () => receipt());
    const [grade] = await makeHarnessBenchGrader(config(evaluate)).grade([submission()], [item]);
    expect(grade!.graderError).toBeTruthy(); expect(evaluate).not.toHaveBeenCalled();
  });

  it('keeps evaluator failure from becoming a measured capability failure', async () => {
    const [grade] = await makeHarnessBenchGrader(config(async () => { throw Error('private runtime unavailable'); }))
      .grade([submission()], [replayTask()]);
    expect(grade!.graderError).toBe('private runtime unavailable');
    expect(grade!.rawGraderOutput).toEqual({ unmeasured: true });
  });

  it('refuses a second submission that reuses the same grader checkout', async () => {
    const grader = makeHarnessBenchGrader(config(async sub => ({ ...receipt(), prefix: sub.prefix })));
    const grades = await grader.grade([submission(), diffSub('real-plan/P-001', 'PATCH', 'seed-1')], [replayTask()]);
    expect(grades[0]!.resolved).toBe(true); expect(grades[1]!.graderError).toMatch(/reused/);
  });
});
