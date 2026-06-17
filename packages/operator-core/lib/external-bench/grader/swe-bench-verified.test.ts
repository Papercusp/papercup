/**
 * Unit coverage for the SWE-bench Verified grader (swe-bench-verified.ts) —
 * the pure report→verdict mapping, the injectable-deps grade pipeline (no
 * Docker / no image pulls), and the harness-installed gate.
 *
 * The fairness/safety invariants under test:
 *  - RESOLVED iff the instance is in the harness `resolved_ids`.
 *  - An instance the harness produced NO verdict for (error_ids, or absent from
 *    every list) is surfaced as `graderError` — an infra failure, NEVER a
 *    silent fail (that would mis-score the arm comparison).
 *  - predictions use `model_patch` + `model_name_or_path` (NOT Pro's `patch`).
 */
import { describe, expect, it } from 'vitest';
import {
  assertVerifiedHarnessInstalled,
  makeSweBenchVerifiedGrader,
  parseSweBenchVerifiedReport,
  type SweBenchVerifiedReport,
} from './swe-bench-verified';
import type { GraderFs, ProcExec } from './swe-bench-pro';
import type { ArmSubmission } from '../types';

const VERSION = 'swebench@abc123 / images 2026-06';

const diffSub = (instanceId: string, prefix = 'seed0', patch = `diff-for-${instanceId}`): Extract<ArmSubmission, { modality: 'diff' }> => ({
  modality: 'diff',
  instanceId,
  patch,
  prefix,
});

// ── Pure report → verdict mapping ────────────────────────────────────────────

describe('parseSweBenchVerifiedReport', () => {
  it('marks an instance in resolved_ids as resolved:true', () => {
    const report: SweBenchVerifiedReport = { resolved_ids: ['i1'] };
    const [r] = parseSweBenchVerifiedReport(report, [diffSub('i1')], VERSION);
    expect(r).toMatchObject({
      instanceId: 'i1',
      prefix: 'seed0',
      resolved: true,
      rawGraderOutput: { resolved: true },
      graderFamily: 'swe-bench-verified',
      graderVersion: VERSION,
    });
    expect(r.graderError).toBeUndefined();
  });

  it('marks an unresolved instance resolved:false WITHOUT a graderError (a real fail, not infra)', () => {
    const [r] = parseSweBenchVerifiedReport({ unresolved_ids: ['i2'] }, [diffSub('i2')], VERSION);
    expect(r).toMatchObject({ resolved: false, rawGraderOutput: { resolved: false, empty: false } });
    expect(r.graderError).toBeUndefined();
  });

  it('treats empty_patch_ids as a (non-error) resolved:false with empty:true', () => {
    const [r] = parseSweBenchVerifiedReport({ empty_patch_ids: ['i3'] }, [diffSub('i3')], VERSION);
    expect(r).toMatchObject({ resolved: false, rawGraderOutput: { resolved: false, empty: true } });
    expect(r.graderError).toBeUndefined();
  });

  it('surfaces error_ids as graderError (infra failure, NOT a silent fail)', () => {
    const [r] = parseSweBenchVerifiedReport({ error_ids: ['i4'] }, [diffSub('i4')], VERSION);
    expect(r.resolved).toBe(false);
    expect(r.rawGraderOutput).toEqual({ missing: true });
    expect(r.graderError).toMatch(/error_ids/);
  });

  it('surfaces an instance absent from EVERY list as graderError (no verdict produced)', () => {
    const [r] = parseSweBenchVerifiedReport({ resolved_ids: ['other'] }, [diffSub('ghost')], VERSION);
    expect(r.resolved).toBe(false);
    expect(r.graderError).toMatch(/no resolved\/unresolved\/error entry/);
  });

  it('resolved_ids takes precedence when an id appears in multiple lists', () => {
    const report: SweBenchVerifiedReport = { resolved_ids: ['i5'], error_ids: ['i5'], unresolved_ids: ['i5'] };
    const [r] = parseSweBenchVerifiedReport(report, [diffSub('i5')], VERSION);
    expect(r.resolved).toBe(true);
    expect(r.graderError).toBeUndefined();
  });

  it('maps every submission, preserving order and prefix', () => {
    const report: SweBenchVerifiedReport = { resolved_ids: ['a'], unresolved_ids: ['b'] };
    const out = parseSweBenchVerifiedReport(report, [diffSub('a', 's1'), diffSub('b', 's2')], VERSION);
    expect(out.map((r) => [r.instanceId, r.prefix, r.resolved])).toEqual([
      ['a', 's1', true],
      ['b', 's2', false],
    ]);
  });
});

// ── Injectable-deps grade pipeline ───────────────────────────────────────────

interface ExecCall { cmd: string; args: string[]; opts?: { cwd?: string } }
function fakeExec(result: { code: number; stdout?: string; stderr?: string }): ProcExec & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const fn = (async (cmd: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ cmd, args, opts });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code };
  }) as ProcExec & { calls: ExecCall[] };
  fn.calls = calls;
  return fn;
}

function fakeFs(): GraderFs & { written: Record<string, string>; removed: string[] } {
  const written: Record<string, string> = {};
  const removed: string[] = [];
  const fs = {
    written,
    removed,
    mkdtemp: async (prefix: string) => `${prefix}scratch`,
    writeFile: async (path: string, data: string) => { written[path] = data; },
    readFile: async () => '{}',
    rm: async (path: string) => { removed.push(path); },
  };
  return fs as GraderFs & { written: Record<string, string>; removed: string[] };
}

const baseCfg = (over: Partial<Parameters<typeof makeSweBenchVerifiedGrader>[0]> = {}) => ({
  swebenchDir: '/swebench',
  version: VERSION,
  runId: 'run-1',
  buildEvalCommand: (ctx: { predsPath: string; runId: string; datasetName: string; modelName: string; maxWorkers: number; instanceIds: string[] }) => ({
    cmd: 'python',
    args: ['-m', 'swebench.harness.run_evaluation', '--predictions_path', ctx.predsPath, '--run_id', ctx.runId],
  }),
  readReport: async () => ({ resolved_ids: [] }) as SweBenchVerifiedReport,
  ...over,
});

describe('makeSweBenchVerifiedGrader', () => {
  it('returns [] (and never execs) when there are no diff-modality submissions', async () => {
    const exec = fakeExec({ code: 0 });
    const grader = makeSweBenchVerifiedGrader(baseCfg(), { exec, fs: fakeFs() });
    const out = await grader.grade([{ modality: 'qa', instanceId: 'q', answer: 'x', prefix: 's' } as ArmSubmission], []);
    expect(out).toEqual([]);
    expect(exec.calls).toHaveLength(0);
  });

  it('writes predictions with model_patch + model_name_or_path (NOT Pro\'s `patch`) and parses the report', async () => {
    const exec = fakeExec({ code: 0 });
    const fs = fakeFs();
    const grader = makeSweBenchVerifiedGrader(
      baseCfg({ modelName: 'papercusp', readReport: async () => ({ resolved_ids: ['i1'], unresolved_ids: ['i2'] }) }),
      { exec, fs },
    );
    const out = await grader.grade([diffSub('i1'), diffSub('i2')], []);
    // The predictions file content shape.
    const predsBody = Object.values(fs.written)[0];
    const preds = JSON.parse(predsBody) as Array<Record<string, unknown>>;
    expect(preds[0]).toEqual({ instance_id: 'i1', model_name_or_path: 'papercusp', model_patch: 'diff-for-i1' });
    expect(preds[0]).not.toHaveProperty('patch');
    // The verdicts.
    expect(out.map((r) => [r.instanceId, r.resolved])).toEqual([['i1', true], ['i2', false]]);
    // The scratch dir was cleaned up.
    expect(fs.removed).toHaveLength(1);
    expect(exec.calls).toHaveLength(1);
  });

  it('passes resolved defaults (dataset, maxWorkers) and the instance ids to buildEvalCommand', async () => {
    let seen: { datasetName: string; maxWorkers: number; instanceIds: string[]; modelName: string } | null = null;
    const grader = makeSweBenchVerifiedGrader(
      baseCfg({
        buildEvalCommand: (ctx) => { seen = { datasetName: ctx.datasetName, maxWorkers: ctx.maxWorkers, instanceIds: ctx.instanceIds, modelName: ctx.modelName }; return { cmd: 'python', args: [] }; },
      }),
      { exec: fakeExec({ code: 0 }), fs: fakeFs() },
    );
    await grader.grade([diffSub('i1')], []);
    expect(seen).toEqual({ datasetName: 'princeton-nlp/SWE-bench_Verified', maxWorkers: 8, instanceIds: ['i1'], modelName: 'papercusp' });
  });

  it('a report-read failure becomes a per-instance graderError (NEVER a silent pass), with the harness exit code', async () => {
    const exec = fakeExec({ code: 7, stderr: 'docker: image pull failed' });
    const grader = makeSweBenchVerifiedGrader(
      baseCfg({ readReport: async () => { throw new Error('ENOENT report.json'); } }),
      { exec, fs: fakeFs() },
    );
    const out = await grader.grade([diffSub('i1'), diffSub('i2')], []);
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(r.resolved).toBe(false);
      expect(r.graderError).toMatch(/could not read SWE-bench Verified report/);
      expect(r.graderError).toMatch(/harness exit 7/);
      expect(r.graderError).toMatch(/image pull failed/);
    }
  });
});

// ── Harness-installed gate ───────────────────────────────────────────────────

describe('assertVerifiedHarnessInstalled', () => {
  it('resolves when the probe exits 0', async () => {
    const exec = fakeExec({ code: 0 });
    await expect(assertVerifiedHarnessInstalled('/swebench', { exec })).resolves.toBeUndefined();
    expect(exec.calls[0].cmd).toBe('python3');
  });

  it('honors a custom pythonBin', async () => {
    const exec = fakeExec({ code: 0 });
    await assertVerifiedHarnessInstalled('/swebench', { exec, pythonBin: '/venv/bin/python' });
    expect(exec.calls[0].cmd).toBe('/venv/bin/python');
  });

  it('throws an actionable message when the probe fails (harness not installed)', async () => {
    const exec = fakeExec({ code: 1, stderr: "ModuleNotFoundError: No module named 'swebench'" });
    await expect(assertVerifiedHarnessInstalled('/swebench', { exec })).rejects.toThrow(/pip install swebench/);
  });
});
