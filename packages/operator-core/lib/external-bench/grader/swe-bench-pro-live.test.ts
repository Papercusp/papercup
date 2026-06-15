/**
 * Live-binding smoke for the SWE-bench Pro grader (P-009) — pure, no Docker / no image pulls. Verifies the
 * env→config resolve, the readiness preflight (mocked docker/fs), and the run-command description.
 */
import { describe, expect, it } from 'vitest';
import { describeSweBenchProRun, preflightSweBenchPro, resolveSweBenchProConfigFromEnv } from './swe-bench-pro-live';
import type { ProcExec } from './swe-bench-pro';

describe('resolveSweBenchProConfigFromEnv', () => {
  it('builds the config from env (dockerhub defaults to jefzda)', () => {
    const cfg = resolveSweBenchProConfigFromEnv({
      PAPERCUSP_SWEBENCH_EVAL_DIR: '/eval',
      PAPERCUSP_SWEBENCH_CSV: '/data.jsonl',
      PAPERCUSP_SWEBENCH_VERSION: 'sweap@2026-05',
      PAPERCUSP_SWEBENCH_NUM_WORKERS: '4',
    } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ evalRepoDir: '/eval', rawSamplePath: '/data.jsonl', version: 'sweap@2026-05', dockerhubUsername: 'jefzda', numWorkers: 4 });
  });
  it('throws listing the missing required vars', () => {
    expect(() => resolveSweBenchProConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(/PAPERCUSP_SWEBENCH_EVAL_DIR/);
  });
});

describe('preflightSweBenchPro', () => {
  const cfg = { evalRepoDir: '/eval', rawSamplePath: '/data.csv', version: 'v1' };

  it('ready when Docker is up + the checkout + CSV are present', async () => {
    const exec: ProcExec = async () => ({ stdout: '29.4.0\n', stderr: '', code: 0 });
    const pre = await preflightSweBenchPro(cfg, { exec, pathExists: async () => true });
    expect(pre.ready).toBe(true);
    expect(pre.issues).toEqual([]);
    expect(pre.docker.available).toBe(true);
  });

  it('not ready + actionable issues when Docker is down and the checkout is missing', async () => {
    const exec: ProcExec = async () => ({ stdout: '', stderr: 'cannot connect to daemon', code: 1 });
    const pre = await preflightSweBenchPro(cfg, { exec, pathExists: async (p) => p.endsWith('.csv') });
    expect(pre.ready).toBe(false);
    expect(pre.evalScript.present).toBe(false);
    expect(pre.rawSampleCsv.present).toBe(true);
    expect(pre.issues.length).toBeGreaterThanOrEqual(2); // docker + eval-harness gaps
    expect(pre.issues.some((i) => /Docker/.test(i))).toBe(true);
    expect(pre.issues.some((i) => /SWE-bench_Pro-os/.test(i))).toBe(true);
  });
});

describe('describeSweBenchProRun', () => {
  it('emits the confirmed command (local Docker + eval_results.json verdict)', () => {
    const s = describeSweBenchProRun({ evalRepoDir: '/eval', rawSamplePath: '/data.csv', version: 'v1' }, 'preds.json', 'out');
    expect(s).toContain('swe_bench_pro_eval.py');
    expect(s).toContain('--raw_sample_path=/data.csv');
    expect(s).toContain('--use_local_docker');
    expect(s).toContain('eval_results.json');
  });
});
