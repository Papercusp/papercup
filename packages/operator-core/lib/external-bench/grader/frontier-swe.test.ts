import { describe, it, expect } from 'vitest';
import type { ArmSubmission, BenchTask } from '../types';
import type { GraderFs, ProcExec } from './swe-bench-pro';
import {
  makeFrontierSweGrader,
  parseFrontierSweReward,
  rewardFromJson,
  type FrontierSweGraderConfig,
  type FrontierSweRawReward,
} from './frontier-swe';

const VERSION = 'frontier-swe@testsha / task-images v4';

function inContainerSub(instanceId: string, prefix = 'seed-0', envRef = `cid-${instanceId}`): ArmSubmission {
  return { modality: 'in-container', instanceId, envRef, prefix };
}

/** A grader whose verifier exec is a no-op (code 0) and whose reward read returns `raw` (or throws). */
function graderWithReward(
  rawByInstance: Record<string, FrontierSweRawReward | (() => never)>,
  cfgOverrides: Partial<FrontierSweGraderConfig> = {},
) {
  const calls: { instanceId: string; envRef: string; oracle?: boolean }[] = [];
  const exec: ProcExec = async () => ({ stdout: '', stderr: '', code: 0 });
  const fs: GraderFs = {
    mkdtemp: async (p) => `${p}tmp`,
    writeFile: async () => {},
    readFile: async () => '',
    rm: async () => {},
  };
  const cfg: FrontierSweGraderConfig = {
    version: VERSION,
    buildVerifierCommand: (ctx) => {
      calls.push(ctx);
      return { cmd: 'docker', args: ['exec', ctx.envRef, 'bash', '/tests/test.sh'] };
    },
    readReward: async ({ instanceId }) => {
      const r = rawByInstance[instanceId];
      if (typeof r === 'function') return r();
      if (!r) throw new Error(`no reward fixture for ${instanceId}`);
      return r;
    },
    ...cfgOverrides,
  };
  return { grader: makeFrontierSweGrader(cfg, { exec, fs }), calls };
}

describe('rewardFromJson', () => {
  it('reads a bare number', () => expect(rewardFromJson(0.42)).toBe(0.42));
  it('prefers the `reward` key', () => expect(rewardFromJson({ reward: 0.7, score: 0.1 })).toBe(0.7));
  it('falls back to the `score` key', () => expect(rewardFromJson({ score: 0.33 })).toBe(0.33));
  it('returns null for a non-numeric / shapeless value', () => {
    expect(rewardFromJson({ foo: 'bar' })).toBeNull();
    expect(rewardFromJson(null)).toBeNull();
    expect(rewardFromJson('0.5')).toBeNull();
    expect(rewardFromJson(Number.NaN)).toBeNull();
  });
});

describe('parseFrontierSweReward — the pure scoring map', () => {
  it('scores a partial reward.txt scalar (resolved false — the common FrontierSWE case)', () => {
    const g = parseFrontierSweReward({ rewardScalar: 0.6 }, 'cranelift-codegen-opt', 'seed-0', VERSION);
    expect(g.score).toBe(0.6);
    expect(g.resolved).toBe(false);
    expect(g.graderError).toBeUndefined();
    expect(g.graderFamily).toBe('frontier-swe');
    expect(g.graderVersion).toBe(VERSION);
  });

  it('resolved=true only when score reaches 1', () => {
    expect(parseFrontierSweReward({ rewardScalar: 1 }, 'git-to-zig', 's', VERSION).resolved).toBe(true);
    expect(parseFrontierSweReward({ rewardScalar: 0.999 }, 'git-to-zig', 's', VERSION).resolved).toBe(false);
  });

  it('a real 0 reward COUNTS (score 0, resolved false, NO graderError) — empty/no-progress is a capability fail', () => {
    const g = parseFrontierSweReward({ rewardScalar: 0 }, 'lua-native-compiler', 's', VERSION);
    expect(g.score).toBe(0);
    expect(g.resolved).toBe(false);
    expect(g.graderError).toBeUndefined();
  });

  it('falls back to reward.json when reward.txt scalar is absent', () => {
    expect(parseFrontierSweReward({ rewardScalar: null, rewardJson: { reward: 0.4 } }, 'x', 's', VERSION).score).toBe(0.4);
    expect(parseFrontierSweReward({ rewardScalar: null, rewardJson: { score: 0.25 } }, 'x', 's', VERSION).score).toBe(0.25);
  });

  it('clamps out-of-range rewards into [0,1]', () => {
    expect(parseFrontierSweReward({ rewardScalar: 1.5 }, 'x', 's', VERSION).score).toBe(1);
    expect(parseFrontierSweReward({ rewardScalar: 1.5 }, 'x', 's', VERSION).resolved).toBe(true);
    expect(parseFrontierSweReward({ rewardScalar: -0.3 }, 'x', 's', VERSION).score).toBe(0);
  });

  it('an ABSENT reward (no scalar, no json) is a graderError — surfaced + excluded, score null (NOT a silent 0)', () => {
    const g = parseFrontierSweReward({ rewardScalar: null, rewardJson: null }, 'x', 's', VERSION);
    expect(g.score).toBeNull();
    expect(g.resolved).toBe(false);
    expect(g.graderError).toBeTruthy();
  });

  it('null/undefined raw → graderError', () => {
    expect(parseFrontierSweReward(null, 'x', 's', VERSION).graderError).toBeTruthy();
    expect(parseFrontierSweReward(undefined, 'x', 's', VERSION).score).toBeNull();
  });
});

describe('makeFrontierSweGrader — in-container batch', () => {
  const tasks: BenchTask[] = [];

  it('grades each in-container submission via its own verifier → continuous score', async () => {
    const { grader, calls } = graderWithReward({
      'cranelift-codegen-opt': { rewardScalar: 0.73 },
      'git-to-zig': { rewardScalar: 0.0 },
    });
    const subs = [inContainerSub('cranelift-codegen-opt'), inContainerSub('git-to-zig')];
    const results = await grader.grade(subs, tasks);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.instanceId === 'cranelift-codegen-opt')?.score).toBe(0.73);
    expect(results.find((r) => r.instanceId === 'git-to-zig')?.score).toBe(0);
    expect(results.every((r) => r.graderError === undefined)).toBe(true);
    expect(calls.map((c) => c.instanceId).sort()).toEqual(['cranelift-codegen-opt', 'git-to-zig']);
  });

  it('family + modality are frontier-swe / in-container', () => {
    const { grader } = graderWithReward({});
    expect(grader.family).toBe('frontier-swe');
    expect(grader.modality).toBe('in-container');
  });

  it('ignores non-in-container submissions (FrontierSWE is in-container only)', async () => {
    const { grader } = graderWithReward({});
    const diffSub: ArmSubmission = { modality: 'diff', instanceId: 'x', patch: '', prefix: 's' };
    expect(await grader.grade([diffSub], tasks)).toEqual([]);
  });

  it('a reward-read failure becomes a graderError (surfaced, never a silent fail)', async () => {
    const { grader } = graderWithReward({
      broken: () => {
        throw new Error('docker cp: no such file /logs/verifier/reward.txt');
      },
    });
    const [r] = await grader.grade([inContainerSub('broken')], tasks);
    expect(r.score).toBeNull();
    expect(r.resolved).toBe(false);
    expect(r.graderError).toContain('could not read FrontierSWE reward');
  });

  it('a verifier exec that throws (spawn failure) becomes a graderError, not a crash', async () => {
    const exec: ProcExec = async () => {
      throw new Error('spawn docker ENOENT');
    };
    const fs: GraderFs = { mkdtemp: async (p) => p, writeFile: async () => {}, readFile: async () => '', rm: async () => {} };
    const grader = makeFrontierSweGrader(
      {
        version: VERSION,
        buildVerifierCommand: (ctx) => ({ cmd: 'docker', args: ['exec', ctx.envRef] }),
        readReward: async () => ({ rewardScalar: 1 }),
      },
      { exec, fs },
    );
    const [r] = await grader.grade([inContainerSub('boom')], tasks);
    expect(r.graderError).toContain('verifier exec failed');
    expect(r.score).toBeNull();
  });
});
