import { describe, it, expect } from 'vitest';
import {
  planEnvOperatorLaunch,
  launchEnvOperators,
  PROVISIONABLE_ENV_OPERATORS,
  type EnvOperatorPlanEntry,
  type EnvOperatorSpec,
  type LaunchEnvOperatorsDeps,
} from './env-operator-launcher';

const SPECS: readonly EnvOperatorSpec[] = [
  { id: 'dev', port: 3270, branch: 'staging' },
  { id: 'prod', port: 3070, branch: 'main' },
  { id: 'staging', port: 3170, branch: 'staging' },
];

/** Index a plan by env id for terse assertions. */
function byId(plan: EnvOperatorPlanEntry[]): Record<string, EnvOperatorPlanEntry> {
  return Object.fromEntries(plan.map((e) => [e.id, e]));
}

describe('planEnvOperatorLaunch (pure)', () => {
  const base = { specs: SPECS, hasSourceTree: true, hasToolchain: true } as const;

  it('spawns every candidate when nothing blocks it', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base }));
    expect(plan.dev.action).toBe('spawn');
    expect(plan.prod.action).toBe('spawn');
    expect(plan.staging.action).toBe('spawn');
    // origin is rendered from the host + port
    expect(plan.staging.origin).toBe('http://127.0.0.1:3170');
  });

  it('honours a custom bind host in the rendered origin', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, host: '0.0.0.0' }));
    expect(plan.dev.origin).toBe('http://0.0.0.0:3270');
  });

  it('skips a disabled env regardless of everything else', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, disabledIds: ['staging'] }));
    expect(plan.staging.action).toBe('skip');
    expect(plan.staging.skipReason).toBe('disabled');
    expect(plan.dev.action).toBe('spawn');
  });

  it('disabled wins over already-reachable / self / missing toolchain (most-specific reason)', () => {
    const plan = byId(
      planEnvOperatorLaunch({
        ...base,
        hasToolchain: false,
        hasSourceTree: false,
        disabledIds: ['prod'],
        reachablePorts: [3070],
        selfPort: 3070,
      }),
    );
    expect(plan.prod.skipReason).toBe('disabled');
  });

  it('never re-spawns the operator serving its own port (is-self)', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, selfPort: 3270 }));
    expect(plan.dev.action).toBe('skip');
    expect(plan.dev.skipReason).toBe('is-self');
  });

  it('is idempotent — skips a port already served by a live operator', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, reachablePorts: [3170] }));
    expect(plan.staging.action).toBe('skip');
    expect(plan.staging.skipReason).toBe('already-reachable');
    expect(plan.dev.action).toBe('spawn');
  });

  it('is-self takes precedence over already-reachable (self is trivially reachable)', () => {
    const plan = byId(
      planEnvOperatorLaunch({ ...base, selfPort: 3170, reachablePorts: [3170] }),
    );
    expect(plan.staging.skipReason).toBe('is-self');
  });

  it('skips all spawnable envs when the cloned source tree is absent', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, hasSourceTree: false }));
    for (const id of ['dev', 'prod', 'staging']) {
      expect(plan[id].action).toBe('skip');
      expect(plan[id].skipReason).toBe('no-source-tree');
    }
  });

  it('skips all spawnable envs when the toolchain is missing', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, hasToolchain: false }));
    for (const id of ['dev', 'prod', 'staging']) {
      expect(plan[id].skipReason).toBe('no-toolchain');
    }
  });

  it('already-reachable beats the source/toolchain gates (an up operator is not "no-toolchain")', () => {
    const plan = byId(
      planEnvOperatorLaunch({
        ...base,
        hasSourceTree: false,
        hasToolchain: false,
        reachablePorts: [3070],
      }),
    );
    expect(plan.prod.skipReason).toBe('already-reachable');
    // the others, with no tree, fall to no-source-tree
    expect(plan.dev.skipReason).toBe('no-source-tree');
  });

  it('defaults to the PROVISIONABLE set (dev/prod/staging — never local or release)', () => {
    const plan = planEnvOperatorLaunch({ hasSourceTree: true, hasToolchain: true });
    const ids = plan.map((e) => e.id).sort();
    expect(ids).toEqual(['dev', 'prod', 'staging']);
    expect(PROVISIONABLE_ENV_OPERATORS.some((s) => s.id === 'local')).toBe(false);
    expect(PROVISIONABLE_ENV_OPERATORS.some((s) => s.id === 'release')).toBe(false);
  });
});

/** Build launch deps wired to in-memory fakes (no fs / no network / no real spawn). */
function fakeLaunchDeps(over: Partial<LaunchEnvOperatorsDeps> = {}): {
  deps: LaunchEnvOperatorsDeps;
  spawnedCalls: { entry: EnvOperatorPlanEntry; treePath: string }[];
  staggerWaits: number[];
} {
  const spawnedCalls: { entry: EnvOperatorPlanEntry; treePath: string }[] = [];
  const staggerWaits: number[] = [];
  const deps: LaunchEnvOperatorsDeps = {
    specs: SPECS,
    readPrefs: () => ({ disabled: [] }),
    probe: async () => false, // nothing already up
    detectSourceRoot: () => '/src/papercup',
    hasToolchain: async () => true,
    selfPort: null,
    sleep: async (ms) => {
      staggerWaits.push(ms);
    },
    log: () => {},
    spawnOperator: (entry, treePath) => {
      spawnedCalls.push({ entry, treePath });
      return { id: entry.id, port: entry.port, pid: 1000 + entry.port };
    },
    ...over,
  };
  return { deps, spawnedCalls, staggerWaits };
}

describe('launchEnvOperators (effectful, fully faked)', () => {
  it('spawns every enabled env when none are up and a toolchain + tree exist', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps();
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'prod', 'staging']);
    expect(spawnedCalls).toHaveLength(3);
    // the conservative default prepareTree runs each env from the detected root
    expect(spawnedCalls.every((c) => c.treePath === '/src/papercup')).toBe(true);
  });

  it('staggers between spawns but not before the first', async () => {
    const { deps, staggerWaits } = fakeLaunchDeps({ staggerMs: 4000 });
    await launchEnvOperators(deps);
    // 3 spawns ⇒ 2 inter-spawn waits
    expect(staggerWaits).toEqual([4000, 4000]);
  });

  it('skips an already-reachable port (idempotent) and does not spawn it', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({
      probe: async (origin) => origin.endsWith(':3070'), // prod already up
    });
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'staging']);
    expect(res.skipped).toContainEqual({ id: 'prod', reason: 'already-reachable' });
    expect(spawnedCalls.some((c) => c.entry.id === 'prod')).toBe(false);
  });

  it('skips disabled envs from the prefs store', async () => {
    const { deps } = fakeLaunchDeps({ readPrefs: () => ({ disabled: ['staging'] }) });
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'prod']);
    expect(res.skipped).toContainEqual({ id: 'staging', reason: 'disabled' });
  });

  it('skips everything (no spawn) when the source tree is absent', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({ detectSourceRoot: () => null });
    const res = await launchEnvOperators(deps);
    expect(res.spawned).toHaveLength(0);
    expect(spawnedCalls).toHaveLength(0);
    expect(res.skipped.every((s) => s.reason === 'no-source-tree')).toBe(true);
  });

  it('skips everything when the toolchain is missing', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({ hasToolchain: async () => false });
    const res = await launchEnvOperators(deps);
    expect(res.spawned).toHaveLength(0);
    expect(spawnedCalls).toHaveLength(0);
    expect(res.skipped.every((s) => s.reason === 'no-toolchain')).toBe(true);
  });

  it('records a tree-prepare failure as a skip and continues with the rest', async () => {
    const { deps } = fakeLaunchDeps({
      prepareTree: async (entry, root) => (entry.id === 'prod' ? null : root),
    });
    const res = await launchEnvOperators(deps);
    expect(res.skipped).toContainEqual({ id: 'prod', reason: 'tree-prepare-failed' });
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'staging']);
  });

  it('records a spawn failure as a skip and never throws', async () => {
    const { deps } = fakeLaunchDeps({
      spawnOperator: (entry) => (entry.id === 'staging' ? null : { id: entry.id, port: entry.port }),
    });
    const res = await launchEnvOperators(deps);
    expect(res.skipped).toContainEqual({ id: 'staging', reason: 'spawn-failed' });
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'prod']);
  });

  it('never re-spawns the operator that is itself one of the env ports', async () => {
    const { deps } = fakeLaunchDeps({ selfPort: 3270 });
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['prod', 'staging']);
    expect(res.skipped).toContainEqual({ id: 'dev', reason: 'is-self' });
  });

  it('a tree-prepare failure on the first env does not eat the next env stagger', async () => {
    // prod (first) fails to prepare → no spawn; dev + staging still spawn, staggered once.
    const { deps, staggerWaits } = fakeLaunchDeps({
      specs: [
        { id: 'prod', port: 3070, branch: 'main' },
        { id: 'dev', port: 3270, branch: 'staging' },
        { id: 'staging', port: 3170, branch: 'staging' },
      ],
      prepareTree: async (entry, root) => (entry.id === 'prod' ? null : root),
      staggerMs: 100,
    });
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'staging']);
    // first spawn-action attempt is prod (prepare-fail, no stagger consumed before it);
    // dev is the first *successful* spawn (no stagger), staging staggers once.
    expect(staggerWaits).toEqual([100]);
  });
});
