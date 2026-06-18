import { describe, it, expect } from 'vitest';
import type { BenchTask } from '../types';
import type { ProcExec } from './swe-bench-pro';
import {
  resolveFrontierSweConfigFromEnv,
  liveBuildVerifierCommand,
  liveReadReward,
  preflightFrontierSwe,
  describeFrontierSweRun,
} from './frontier-swe-live';

const task = (overrides: Record<string, unknown> = {}): BenchTask => ({
  benchmark: 'frontier-swe',
  instanceId: 'cranelift-codegen-opt',
  problemStatement: 'x',
  graderMeta: { verifierCmd: 'bash /tests/test.sh', rewardPath: '/logs/verifier/reward.txt', rewardJsonPath: '/logs/verifier/reward.json', ...overrides },
});

describe('resolveFrontierSweConfigFromEnv', () => {
  it('throws without the version pin', () => {
    expect(() => resolveFrontierSweConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(/PAPERCUSP_FRONTIER_SWE_VERSION/);
  });
  it('returns a config carrying the version + live ports', () => {
    const cfg = resolveFrontierSweConfigFromEnv({ PAPERCUSP_FRONTIER_SWE_VERSION: 'fs@sha' } as unknown as NodeJS.ProcessEnv);
    expect(cfg.version).toBe('fs@sha');
    expect(typeof cfg.buildVerifierCommand).toBe('function');
    expect(typeof cfg.readReward).toBe('function');
  });
});

describe('liveBuildVerifierCommand', () => {
  it('docker-execs the task verifier; oracle mode sets HARBOR_ORACLE_MODE', () => {
    const normal = liveBuildVerifierCommand({ instanceId: 'i', envRef: 'cid', task: task() });
    expect(normal.cmd).toBe('docker');
    expect(normal.args).toEqual(['exec', 'cid', 'bash', '-lc', 'bash /tests/test.sh']);
    const oracle = liveBuildVerifierCommand({ instanceId: 'i', envRef: 'cid', task: task(), oracle: true });
    expect(oracle.args).toContain('HARBOR_ORACLE_MODE=1');
  });
  it('falls back to the default verifier cmd when the task carries none', () => {
    const r = liveBuildVerifierCommand({ instanceId: 'i', envRef: 'cid' });
    expect(r.args).toContain('bash /tests/test.sh');
  });
});

describe('liveReadReward', () => {
  const fakeExec =
    (files: Record<string, { stdout: string; code: number }>): ProcExec =>
    async (_cmd, args) => {
      const path = args[args.length - 1];
      const f = files[path];
      return f ? { stdout: f.stdout, stderr: '', code: f.code } : { stdout: '', stderr: 'no such file', code: 1 };
    };

  it('reads reward.txt as the bare scalar', async () => {
    const exec = fakeExec({ '/logs/verifier/reward.txt': { stdout: '0.4200\n', code: 0 } });
    const r = await liveReadReward({ instanceId: 'i', envRef: 'cid', task: task(), readFile: async () => '', exec });
    expect(r.rewardScalar).toBe(0.42);
  });

  it('parses reward.json when present', async () => {
    const exec = fakeExec({
      '/logs/verifier/reward.txt': { stdout: '0.5', code: 0 },
      '/logs/verifier/reward.json': { stdout: '{"reward":0.5,"breakdown":{"speedup":1.4}}', code: 0 },
    });
    const r = await liveReadReward({ instanceId: 'i', envRef: 'cid', task: task(), readFile: async () => '', exec });
    expect(r.rewardScalar).toBe(0.5);
    expect((r.rewardJson as { reward: number }).reward).toBe(0.5);
  });

  it('rewardScalar null when reward.txt is absent (verifier produced no verdict)', async () => {
    const exec = fakeExec({});
    const r = await liveReadReward({ instanceId: 'i', envRef: 'cid', task: task(), readFile: async () => '', exec });
    expect(r.rewardScalar).toBeNull();
  });
});

describe('preflightFrontierSwe (no spend)', () => {
  const okDocker: ProcExec = async () => ({ stdout: '27.0.1', stderr: '', code: 0 });
  const noDocker: ProcExec = async () => ({ stdout: '', stderr: 'Cannot connect to the Docker daemon', code: 1 });

  it('ready when docker + repo + corpus all present', async () => {
    const pf = await preflightFrontierSwe(
      { repoDir: '/vendor/frontier-swe', corpusPath: '/corpus/tasks.jsonl' },
      { exec: okDocker, pathExists: async () => true },
    );
    expect(pf.ready).toBe(true);
    expect(pf.issues).toEqual([]);
  });

  it('surfaces every gap without spending', async () => {
    const pf = await preflightFrontierSwe(
      { repoDir: undefined, corpusPath: '/corpus/tasks.jsonl' },
      { exec: noDocker, pathExists: async () => false },
    );
    expect(pf.ready).toBe(false);
    expect(pf.issues.join(' ')).toMatch(/Docker daemon not reachable/);
    expect(pf.issues.join(' ')).toMatch(/PAPERCUSP_FRONTIER_SWE_DIR unset/);
    expect(pf.issues.join(' ')).toMatch(/corpus JSONL missing/);
  });
});

describe('describeFrontierSweRun', () => {
  it('documents the exact docker exec verifier + reward read', () => {
    const s = describeFrontierSweRun('mycid');
    expect(s).toContain('docker exec mycid');
    expect(s).toContain('/logs/verifier/reward.txt');
    expect(s).toContain('HARBOR_ORACLE_MODE=1');
  });
});
