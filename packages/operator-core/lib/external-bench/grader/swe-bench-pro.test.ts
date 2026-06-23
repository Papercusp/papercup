/**
 * swe-bench-pro.test.ts — the SWE-bench Pro official grader backend.
 *
 * Reliability of the eval: a wrong parse or mishandled grader failure = wrong pass/fail verdicts.
 * Subprocess + fs are injected, so the parse and the grade orchestration (predictions written,
 * eval args assembled, report read, failure → batchError, scratch cleaned up) run with no Docker.
 */
import { describe, expect, it } from 'vitest';
import {
  parseSweBenchProReport,
  makeSweBenchProGrader,
  type SweBenchProEvalResults,
  type ProcExec,
  type GraderFs,
} from './swe-bench-pro';
import type { ArmSubmission } from '../types';

const diffSub = (instanceId: string, patch = 'DIFF', prefix = 'seed-0'): ArmSubmission =>
  ({ modality: 'diff', instanceId, patch, prefix } as unknown as ArmSubmission);

const VERSION = 'sweap@2026-05';

describe('parseSweBenchProReport — eval_results.json → GradeResult[]', () => {
  it('maps a resolved=true verdict (no error)', () => {
    const out = parseSweBenchProReport({ 'i-1': true }, [diffSub('i-1', 'D', 'p1')], VERSION);
    expect(out).toEqual([
      { instanceId: 'i-1', prefix: 'p1', resolved: true, rawGraderOutput: { resolved: true }, graderFamily: 'swe-bench-pro', graderVersion: VERSION },
    ]);
  });

  it('maps a resolved=false verdict as a genuine non-resolution (NOT an error)', () => {
    const out = parseSweBenchProReport({ 'i-1': false }, [diffSub('i-1')], VERSION);
    expect(out[0].resolved).toBe(false);
    expect(out[0].graderError).toBeUndefined();
  });

  it('flags a missing instance as a grader error (ran but produced no verdict)', () => {
    const out = parseSweBenchProReport({}, [diffSub('i-1')], VERSION);
    expect(out[0].resolved).toBe(false);
    expect(out[0].graderError).toMatch(/no eval_results.json entry/);
    expect(out[0].rawGraderOutput).toEqual({ missing: true });
  });

  it('treats a non-boolean report value as missing', () => {
    const out = parseSweBenchProReport({ 'i-1': 'yes' } as unknown as SweBenchProEvalResults, [diffSub('i-1')], VERSION);
    expect(out[0].graderError).toBeDefined();
  });

  it('preserves each submission prefix across a batch', () => {
    const out = parseSweBenchProReport({ a: true, b: false }, [diffSub('a', 'D', 'pa'), diffSub('b', 'D', 'pb')], VERSION);
    expect(out.map((r) => [r.instanceId, r.prefix, r.resolved])).toEqual([['a', 'pa', true], ['b', 'pb', false]]);
  });
});

// ── grade orchestration (injected exec + fs) ──────────────────────────────────

function fakeFs(files: Record<string, string> = {}) {
  const writes: Record<string, string> = {};
  const rmCalls: string[] = [];
  const fs: GraderFs = {
    async mkdtemp() { return '/scratch'; },
    async writeFile(path, data) { writes[path] = data; },
    async readFile(path) {
      if (path in files) return files[path];
      throw new Error(`ENOENT ${path}`);
    },
    async rm(path) { rmCalls.push(path); },
  };
  return { fs, writes, rmCalls };
}

function fakeExec(result: { stdout?: string; stderr?: string; code?: number } = {}) {
  const calls: Array<{ cmd: string; args: string[]; opts?: unknown }> = [];
  const exec: ProcExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 };
  };
  return { exec, calls };
}

const CFG = { evalRepoDir: '/eval', rawSamplePath: '/raw.csv', version: VERSION };

describe('makeSweBenchProGrader.grade', () => {
  it('returns [] without touching exec/fs when there are no diff submissions', async () => {
    const { exec, calls } = fakeExec();
    const { fs, rmCalls } = fakeFs();
    const grader = makeSweBenchProGrader(CFG, { exec, fs });
    const res = await grader.grade([{ modality: 'agent' } as unknown as ArmSubmission], []);
    expect(res).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(rmCalls).toHaveLength(0);
  });

  it('writes predictions, runs the eval with the right args, parses the report, and cleans up', async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const { fs, writes, rmCalls } = fakeFs({ '/scratch/out/eval_results.json': JSON.stringify({ 'i-1': true }) });
    const grader = makeSweBenchProGrader(CFG, { exec, fs });

    const res = await grader.grade([diffSub('i-1', 'PATCH', 'p1')], []);

    expect(JSON.parse(writes['/scratch/predictions.json'])).toEqual([{ instance_id: 'i-1', patch: 'PATCH', prefix: 'p1' }]);
    expect(calls[0].cmd).toBe('python3');
    expect(calls[0].args).toEqual([
      'swe_bench_pro_eval.py',
      '--raw_sample_path=/raw.csv',
      '--patch_path=/scratch/predictions.json',
      '--output_dir=/scratch/out',
      '--scripts_dir=run_scripts',
      '--num_workers=16',
      '--dockerhub_username=jefzda',
      '--use_local_docker',
    ]);
    expect(calls[0].opts).toEqual({ cwd: '/eval' });
    expect(res[0]).toMatchObject({ instanceId: 'i-1', resolved: true });
    expect(rmCalls).toEqual(['/scratch']); // scratch cleaned in finally
  });

  it('omits --use_local_docker when useLocalDocker is false; honors pythonBin/numWorkers/dockerhub overrides', async () => {
    const { exec, calls } = fakeExec();
    const { fs } = fakeFs({ '/scratch/out/eval_results.json': '{}' });
    const grader = makeSweBenchProGrader(
      { ...CFG, useLocalDocker: false, pythonBin: 'py', numWorkers: 4, dockerhubUsername: 'acme' },
      { exec, fs },
    );
    await grader.grade([diffSub('i-1')], []);
    expect(calls[0].cmd).toBe('py');
    expect(calls[0].args).not.toContain('--use_local_docker');
    expect(calls[0].args).toContain('--num_workers=4');
    expect(calls[0].args).toContain('--dockerhub_username=acme');
  });

  it('turns a missing report into a batch error on every instance, including the eval exit code', async () => {
    const { exec } = fakeExec({ code: 2, stderr: 'boom' });
    const { fs, rmCalls } = fakeFs({}); // no eval_results.json → readFile throws
    const grader = makeSweBenchProGrader(CFG, { exec, fs });

    const res = await grader.grade([diffSub('i-1'), diffSub('i-2')], []);

    expect(res).toHaveLength(2);
    for (const r of res) {
      expect(r.resolved).toBe(false);
      expect(r.graderError).toMatch(/could not read grader eval_results.json/);
      expect(r.graderError).toMatch(/eval exit 2/); // surfaces the non-zero exit + stderr
    }
    expect(rmCalls).toEqual(['/scratch']); // still cleans up
  });
});
