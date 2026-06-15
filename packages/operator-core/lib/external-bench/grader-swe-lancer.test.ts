/**
 * SWE-Lancer (P-027) grader unit tests — fake exec/fs/buildEvalCommand, no Docker / Playwright.
 */
import { describe, expect, it, vi } from 'vitest';
import { getOfficialGrader, makeSweLancerGrader, parseSweLancerReport } from './grader';
import type { GraderFs, SweLancerGraderConfig } from './grader';
import type { ArmSubmission, BenchTask } from './types';

function diffSub(id: string, patch = 'diff', prefix = 'seed-0'): ArmSubmission {
  return { modality: 'diff', instanceId: id, patch, prefix };
}
function task(id: string): BenchTask {
  return { benchmark: 'swe-lancer', instanceId: id, problemStatement: 'x', repo: 'a/b', baseCommit: 'abc1234', valueUsd: 250, graderMeta: {} };
}

describe('parseSweLancerReport', () => {
  const subs = [diffSub('ic-1'), diffSub('ic-2')];

  it('maps E2E resolved per instance and stamps the swe-lancer family', () => {
    const res = parseSweLancerReport({ 'ic-1': { resolved: true }, 'ic-2': { resolved: false } }, subs, 'diamond@v1');
    expect(res[0].resolved).toBe(true);
    expect(res[1].resolved).toBe(false);
    expect(res[0].graderFamily).toBe('swe-lancer');
    expect(res[0].graderVersion).toBe('diamond@v1');
  });
  it('surfaces an entry error + a missing entry as graderError', () => {
    const res = parseSweLancerReport({ 'ic-1': { error: 'e2e timeout' } }, subs, 'v');
    expect(res[0].graderError).toBe('e2e timeout');
    expect(res[1].graderError).toMatch(/no grader report entry/);
  });
  it('falls back to a top-level resolved-list form', () => {
    const res = parseSweLancerReport({ resolved: ['ic-2'] }, subs, 'v');
    expect(res[0].resolved).toBe(false);
    expect(res[1].resolved).toBe(true);
  });
});

describe('makeSweLancerGrader', () => {
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

  const cfg: SweLancerGraderConfig = {
    swelancerDir: '/preparedness/project/swelancer',
    version: 'diamond@2026-02',
    buildEvalCommand: ({ predsPath, outDir, split }) => ({
      cmd: 'uv',
      args: ['run', 'python', '-m', 'swelancer.eval', `--predictions=${predsPath}`, `--output_dir=${outDir}`, `--split=${split}`],
    }),
  };

  it('writes predictions, runs the configured eval (cwd defaults to swelancerDir), maps the report', async () => {
    const { fs, writes } = fakeFs({ 'ic-1': { resolved: true } });
    const exec = vi.fn(async (_cmd: string, _args: string[], _opts?: { cwd?: string }) => ({ stdout: '', stderr: '', code: 0 }));
    const grader = makeSweLancerGrader(cfg, { exec, fs });

    const res = await grader.grade([diffSub('ic-1', 'PATCH', 'seed-2')], [task('ic-1')]);
    expect(res[0].resolved).toBe(true);
    expect(grader.family).toBe('swe-lancer');

    const preds = JSON.parse(Object.values(writes)[0]);
    expect(preds[0]).toMatchObject({ instance_id: 'ic-1', patch: 'PATCH', prefix: 'seed-2' });

    const [cmd, argv, opts] = exec.mock.calls[0];
    expect(cmd).toBe('uv');
    expect(argv).toContain('--split=diamond');
    expect(argv.some((a: string) => a.startsWith('--predictions='))).toBe(true);
    expect(opts?.cwd).toBe('/preparedness/project/swelancer');
  });

  it('turns a missing report into a batch-wide graderError', async () => {
    const { fs } = fakeFs(null, { failRead: true });
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'died', code: 1 }));
    const grader = makeSweLancerGrader(cfg, { exec, fs });
    const res = await grader.grade([diffSub('ic-1'), diffSub('ic-2')], [task('ic-1'), task('ic-2')]);
    expect(res.every((r) => r.graderError)).toBe(true);
  });

  it('ignores non-diff submissions and SWE-Manager has no diff path', async () => {
    const { fs } = fakeFs({});
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const grader = makeSweLancerGrader(cfg, { exec, fs });
    const res = await grader.grade([{ modality: 'in-container', instanceId: 'm-1', envRef: 'x', prefix: 'seed-0' }], [task('m-1')]);
    expect(res).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('getOfficialGrader(swe-lancer)', () => {
  it('builds the swe-lancer grader from config', () => {
    const g = getOfficialGrader(
      'swe-lancer',
      { sweLancer: { swelancerDir: '/s', version: 'v', buildEvalCommand: () => ({ cmd: 'uv', args: [] }) } },
      { exec: async () => ({ stdout: '', stderr: '', code: 0 }), fs: {} as never },
    );
    expect(g.family).toBe('swe-lancer');
    expect(g.modality).toBe('diff');
  });
  it('throws without a config', () => {
    expect(() => getOfficialGrader('swe-lancer', {})).toThrow(/requires a SweLancerGraderConfig/);
  });
});
