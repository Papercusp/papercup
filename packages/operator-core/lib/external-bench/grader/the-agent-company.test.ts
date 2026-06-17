/**
 * TheAgentCompany grader (plan benchmark-suite-theagentcompany-2026-06-17) — pure partial-credit math +
 * the live grader flow over INJECTED fake exec/fs (NO docker, NO services, NO real eval.py). The scoring
 * math is the load-bearing piece: S = 0.5·(Σresult/Σtotal) + 0.5·(all-points-earned ? 1 : 0).
 */
import { describe, it, expect } from 'vitest';
import {
  computeTacScore,
  extractTacCheckpoints,
  parseTheAgentCompanyResult,
  makeTheAgentCompanyGrader,
  type TacCheckpoint,
  type TheAgentCompanyGraderConfig,
} from './the-agent-company';
import type { ArmSubmission, BenchTask } from '../types';
import type { GraderFs, ProcExec } from './swe-bench-pro';

const VERSION = 'theagentcompany@testsha / task-images-test';

function cp(total: number, result: number, extra: Record<string, unknown> = {}): TacCheckpoint {
  return { total, result, ...extra };
}

describe('computeTacScore', () => {
  it('full completion → partial 1, full 1, score 1', () => {
    const s = computeTacScore([cp(2, 2), cp(3, 3)]);
    expect(s.partial).toBe(1);
    expect(s.full).toBe(1);
    expect(s.score).toBe(1);
    expect(s.earned).toBe(5);
    expect(s.possible).toBe(5);
    expect(s.checkpointCount).toBe(2);
  });

  it('partial completion → blends 0.5·partial + 0.5·0 (full=0)', () => {
    // earned 3 of 6 → partial 0.5, full 0 → score 0.25
    const s = computeTacScore([cp(2, 2), cp(4, 1)]);
    expect(s.partial).toBeCloseTo(0.5, 10);
    expect(s.full).toBe(0);
    expect(s.score).toBeCloseTo(0.25, 10);
  });

  it('zero earned → score 0', () => {
    const s = computeTacScore([cp(2, 0), cp(3, 0)]);
    expect(s.partial).toBe(0);
    expect(s.full).toBe(0);
    expect(s.score).toBe(0);
  });

  it('skips 0-total marker checkpoints (no denominator inflation)', () => {
    // one real checkpoint (4/4) + a 0-total marker → full completion, score 1
    const s = computeTacScore([cp(4, 4), cp(0, 0, { description: 'marker' })]);
    expect(s.possible).toBe(4);
    expect(s.checkpointCount).toBe(1);
    expect(s.full).toBe(1);
    expect(s.score).toBe(1);
  });

  it('clamps a buggy evaluator (result > total, or negative) into [0,total]', () => {
    const s = computeTacScore([cp(2, 5), cp(2, -3)]);
    // clamped to 2 and 0 → earned 2 of 4 → partial 0.5, full 0
    expect(s.earned).toBe(2);
    expect(s.possible).toBe(4);
    expect(s.partial).toBeCloseTo(0.5, 10);
    expect(s.full).toBe(0);
  });

  it('no positive-total checkpoints → empty score (possible 0)', () => {
    const s = computeTacScore([]);
    expect(s.possible).toBe(0);
    expect(s.checkpointCount).toBe(0);
    expect(s.score).toBe(0);
  });
});

describe('extractTacCheckpoints', () => {
  it('reads the canonical `checkpoints` key', () => {
    expect(extractTacCheckpoints({ checkpoints: [cp(1, 1)] })).toHaveLength(1);
  });
  it('falls back to `result` / `checkpoint_results` / a bare array', () => {
    expect(extractTacCheckpoints({ result: [cp(1, 1), cp(2, 0)] })).toHaveLength(2);
    expect(extractTacCheckpoints({ checkpoint_results: [cp(1, 1)] })).toHaveLength(1);
    expect(extractTacCheckpoints([cp(1, 1), cp(1, 1)])).toHaveLength(2);
  });
  it('returns [] for null/garbage', () => {
    expect(extractTacCheckpoints(null)).toEqual([]);
    expect(extractTacCheckpoints(undefined)).toEqual([]);
  });
});

describe('parseTheAgentCompanyResult', () => {
  it('maps full completion → resolved:true, score:1', () => {
    const g = parseTheAgentCompanyResult({ checkpoints: [cp(2, 2), cp(3, 3)] }, 'task-1', 'seed-0', VERSION);
    expect(g.resolved).toBe(true);
    expect(g.score).toBe(1);
    expect(g.instanceId).toBe('task-1');
    expect(g.prefix).toBe('seed-0');
    expect(g.graderFamily).toBe('the-agent-company');
    expect(g.graderVersion).toBe(VERSION);
    expect(g.graderError).toBeUndefined();
  });

  it('maps partial completion → resolved:false but score reflects partial credit', () => {
    const g = parseTheAgentCompanyResult({ checkpoints: [cp(2, 2), cp(4, 1)] }, 'task-2', 'seed-0', VERSION);
    expect(g.resolved).toBe(false);
    expect(g.score).toBeCloseTo(0.25, 10);
    // the per-checkpoint breakdown is preserved verbatim for reproducibility
    expect((g.rawGraderOutput as { earned: number }).earned).toBe(3);
    expect((g.rawGraderOutput as { possible: number }).possible).toBe(6);
  });

  it('an empty / no-verdict result → graderError + score:null (surfaced, NOT a silent 0-fail)', () => {
    const g = parseTheAgentCompanyResult({ checkpoints: [] }, 'task-3', 'seed-0', VERSION);
    expect(g.resolved).toBe(false);
    expect(g.score).toBeNull();
    expect(g.graderError).toMatch(/no gradable checkpoints/);
  });

  it('a result with only 0-total markers → graderError (Σtotal = 0)', () => {
    const g = parseTheAgentCompanyResult({ checkpoints: [cp(0, 0)] }, 'task-4', 'seed-0', VERSION);
    expect(g.score).toBeNull();
    expect(g.graderError).toBeTruthy();
  });
});

// ── live grader flow over fake exec/fs ─────────────────────────────────────────

interface FakeFsState {
  files: Map<string, string>;
}

function fakeFs(state: FakeFsState): GraderFs {
  let n = 0;
  return {
    mkdtemp: async (prefix) => `${prefix}${n++}`,
    writeFile: async (path, data) => void state.files.set(path, data),
    readFile: async (path) => {
      const v = state.files.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v;
    },
    rm: async (path) => void state.files.delete(path),
  };
}

function envSub(instanceId: string, envRef: string, prefix = 'seed-0'): ArmSubmission {
  return { modality: 'in-container', instanceId, envRef, prefix };
}

function cfgWith(over: Partial<TheAgentCompanyGraderConfig> = {}): TheAgentCompanyGraderConfig {
  return {
    version: VERSION,
    buildEvalCommand: ({ instanceId, envRef, resultOutPath }) => ({
      cmd: 'python3',
      args: ['eval.py', '--instance', instanceId, '--env', envRef, '--out', resultOutPath],
    }),
    readResult: async ({ resultOutPath, readFile }) => JSON.parse(await readFile(resultOutPath)),
    ...over,
  };
}

describe('makeTheAgentCompanyGrader', () => {
  const tasks: BenchTask[] = [];

  it('runs eval.py per task, reads result.json, folds into partial-credit GradeResults', async () => {
    const state: FakeFsState = { files: new Map() };
    // The fake eval.py "writes" result.json into the scratch path the grader passed it.
    const exec: ProcExec = async (_cmd, args) => {
      const outIdx = args.indexOf('--out');
      const outPath = args[outIdx + 1];
      const inst = args[args.indexOf('--instance') + 1];
      const payload =
        inst === 'task-full'
          ? { checkpoints: [cp(2, 2), cp(2, 2)] } // full → score 1
          : { checkpoints: [cp(2, 2), cp(2, 0)] }; // half → partial 0.5, full 0, score 0.25
      state.files.set(outPath, JSON.stringify(payload));
      return { stdout: 'ok', stderr: '', code: 0 };
    };
    const grader = makeTheAgentCompanyGrader(cfgWith(), { exec, fs: fakeFs(state) });

    const res = await grader.grade([envSub('task-full', 'ctr-1'), envSub('task-half', 'ctr-2')], tasks);
    expect(res).toHaveLength(2);
    const full = res.find((r) => r.instanceId === 'task-full')!;
    const half = res.find((r) => r.instanceId === 'task-half')!;
    expect(full.resolved).toBe(true);
    expect(full.score).toBe(1);
    expect(half.resolved).toBe(false);
    expect(half.score).toBeCloseTo(0.25, 10);
    expect(grader.family).toBe('the-agent-company');
    expect(grader.modality).toBe('in-container');
  });

  it('eval.py failure (no result.json) → graderError for that task, never a silent fail', async () => {
    const state: FakeFsState = { files: new Map() };
    const exec: ProcExec = async () => ({ stdout: '', stderr: 'eval.py: traceback ...', code: 1 });
    const grader = makeTheAgentCompanyGrader(cfgWith(), { exec, fs: fakeFs(state) });

    const res = await grader.grade([envSub('task-x', 'ctr-x')], tasks);
    expect(res).toHaveLength(1);
    expect(res[0].resolved).toBe(false);
    expect(res[0].score).toBeNull();
    expect(res[0].graderError).toMatch(/could not read TheAgentCompany result\.json/);
    expect(res[0].graderError).toMatch(/eval\.py exit 1/);
  });

  it('ignores diff submissions (TheAgentCompany is in-container only) → []', async () => {
    const state: FakeFsState = { files: new Map() };
    const exec: ProcExec = async () => ({ stdout: '', stderr: '', code: 0 });
    const grader = makeTheAgentCompanyGrader(cfgWith(), { exec, fs: fakeFs(state) });
    const diff: ArmSubmission = { modality: 'diff', instanceId: 'd', patch: 'x', prefix: 'seed-0' };
    expect(await grader.grade([diff], tasks)).toEqual([]);
  });
});
