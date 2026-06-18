import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadFrontierSweTaskSet,
  frontierSweRowToBenchTask,
  frontierSwePilotSubset,
  isFrontierSweTaskSet,
  FRONTIER_SWE_TASK_SET_IDS,
} from './task-sets';
import { loadBenchTaskSet } from './task-sets';

const ROWS = [
  {
    instanceId: 'cranelift-codegen-opt',
    category: 'programming',
    tier: 'performance',
    difficulty: 'hard',
    tags: ['compiler-optimization'],
    prompt: 'Improve Cranelift codegen speed.',
    dockerImage: 'ghcr.io/proximal-labs/frontier-swe/cranelift-codegen-opt:v6',
    agentTimeoutSec: 72000,
    verifierTimeoutSec: 86400,
    cpus: 8,
    memoryMb: 131072,
    storageMb: 50000,
    gpus: 0,
    gpuTypes: [],
    allowInternet: false,
    verifierCmd: 'bash /tests/test.sh',
    rewardPath: '/logs/verifier/reward.txt',
    rewardJsonPath: '/logs/verifier/reward.json',
    solutionCmd: 'bash /solution/solve.sh',
    hasOracle: true,
  },
  {
    instanceId: 'git-to-zig',
    category: 'c-to-zig',
    tier: 'implementation',
    difficulty: 'very_hard',
    tags: ['zig'],
    prompt: 'Reimplement git in Zig.',
    dockerImage: 'ghcr.io/proximal-labs/frontier-swe/git-to-zig:v4',
    agentTimeoutSec: 72000,
    verifierTimeoutSec: 86400,
    cpus: 4,
    memoryMb: 16384,
    storageMb: 30720,
    gpus: 0,
    gpuTypes: [],
    allowInternet: false,
    verifierCmd: 'bash /tests/test.sh',
    rewardPath: '/logs/verifier/reward.txt',
    solutionCmd: 'bash /solution/solve.sh',
    hasOracle: true,
  },
  {
    instanceId: 'optimizer-design',
    category: 'ml-research',
    tier: 'research',
    difficulty: 'frontier',
    tags: ['optimizer'],
    prompt: 'Design a better optimizer.',
    dockerImage: 'ghcr.io/proximal-labs/frontier-swe/optimizer-design-task:v4',
    agentTimeoutSec: 72000,
    verifierTimeoutSec: 10800,
    cpus: 8,
    memoryMb: 131072,
    storageMb: 102400,
    gpus: 1,
    gpuTypes: ['H100'],
    allowInternet: false,
    verifierCmd: 'bash /tests/test.sh',
    rewardPath: '/logs/verifier/reward.txt',
    solutionCmd: null,
    hasOracle: false,
  },
];

let dir: string;
const prevEnv = process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frontier-swe-ts-'));
  const path = join(dir, 'tasks.jsonl');
  writeFileSync(path, ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = path;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL;
  else process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = prevEnv;
});

describe('isFrontierSweTaskSet', () => {
  it('recognizes the FrontierSWE set ids', () => {
    for (const id of FRONTIER_SWE_TASK_SET_IDS) expect(isFrontierSweTaskSet(id)).toBe(true);
    expect(isFrontierSweTaskSet('metr-hcast')).toBe(false);
    expect(isFrontierSweTaskSet('gdpval-pilot')).toBe(false);
  });
});

describe('frontierSweRowToBenchTask', () => {
  it('exposes only the prompt to the arm; scorer cmd + image + budgets ride graderMeta (un-gameable)', () => {
    const t = frontierSweRowToBenchTask(ROWS[0]);
    expect(t.benchmark).toBe('frontier-swe');
    expect(t.instanceId).toBe('cranelift-codegen-opt');
    expect(t.problemStatement).toBe('Improve Cranelift codegen speed.');
    // The arm-facing fields must NOT carry the scorer/image.
    expect(JSON.stringify(t.problemStatement)).not.toContain('reward');
    expect(t.graderMeta.dockerImage).toBe('ghcr.io/proximal-labs/frontier-swe/cranelift-codegen-opt:v6');
    expect(t.graderMeta.verifierCmd).toBe('bash /tests/test.sh');
    expect(t.graderMeta.rewardPath).toBe('/logs/verifier/reward.txt');
    expect(t.graderMeta.bucket).toBe('performance');
    expect(t.graderMeta.agentTimeoutSec).toBe(72000);
    expect(t.graderMeta.gpus).toBe(0);
  });
});

describe('loadFrontierSweTaskSet', () => {
  it('frontier-swe loads the full corpus', () => {
    const tasks = loadFrontierSweTaskSet('frontier-swe');
    expect(tasks.map((t) => t.instanceId).sort()).toEqual(['cranelift-codegen-opt', 'git-to-zig', 'optimizer-design']);
    expect(tasks.every((t) => t.benchmark === 'frontier-swe')).toBe(true);
  });

  it('frontier-swe-pilot picks 1 task per bucket (impl/perf/research)', () => {
    const tasks = loadFrontierSweTaskSet('frontier-swe-pilot');
    const buckets = tasks.map((t) => t.graderMeta.bucket).sort();
    expect(buckets).toEqual(['implementation', 'performance', 'research']);
    expect(tasks).toHaveLength(3);
  });

  it('frontier-swe-cpu excludes GPU tasks (the B200/H100 infra gate)', () => {
    const tasks = loadFrontierSweTaskSet('frontier-swe-cpu');
    expect(tasks.map((t) => t.instanceId).sort()).toEqual(['cranelift-codegen-opt', 'git-to-zig']);
    expect(tasks.find((t) => t.instanceId === 'optimizer-design')).toBeUndefined();
  });

  it('frontier-swe-custom filters to taskIds; empty list throws', () => {
    const tasks = loadFrontierSweTaskSet('frontier-swe-custom', ['git-to-zig']);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].instanceId).toBe('git-to-zig');
    expect(() => loadFrontierSweTaskSet('frontier-swe-custom', [])).toThrow(/non-empty/);
    expect(() => loadFrontierSweTaskSet('frontier-swe-custom', ['nope'])).toThrow(/matched/);
  });

  it('a missing corpus file throws an actionable error', () => {
    process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = join(dir, 'does-not-exist.jsonl');
    expect(() => loadFrontierSweTaskSet('frontier-swe')).toThrow(/ingest the corpus/);
  });
});

describe('frontierSwePilotSubset', () => {
  it('prefers GPU-free, then a gold-solution control, per bucket', () => {
    const picked = frontierSwePilotSubset(ROWS);
    // research bucket only has the GPU task → it is still picked (the only option)
    expect(picked.find((r) => r.tier === 'research')?.instanceId).toBe('optimizer-design');
    expect(picked.find((r) => r.tier === 'performance')?.instanceId).toBe('cranelift-codegen-opt');
    expect(picked.find((r) => r.tier === 'implementation')?.instanceId).toBe('git-to-zig');
  });
});

describe('loadBenchTaskSet routes FrontierSWE ids', () => {
  it('resolves frontier-swe through the central dispatcher', async () => {
    const tasks = await loadBenchTaskSet('frontier-swe');
    expect(tasks).toHaveLength(3);
    expect(tasks[0].benchmark).toBe('frontier-swe');
  });

  it('rejects frontier-swe-custom with no ids via the dispatcher', async () => {
    await expect(loadBenchTaskSet('frontier-swe-custom', [])).rejects.toThrow(/non-empty/);
  });
});
