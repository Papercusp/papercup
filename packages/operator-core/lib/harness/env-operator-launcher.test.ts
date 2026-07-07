import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  planEnvOperatorLaunch,
  launchEnvOperators,
  PROVISIONABLE_ENV_OPERATORS,
  type EnvOperatorPlanEntry,
  type EnvOperatorSpec,
  type LaunchEnvOperatorsDeps,
  defaultDetectSourceRoot,
  sourceChildEnv,
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

  it('defaults to the PROVISIONABLE set (dev/prod/staging/local — never release)', () => {
    const plan = planEnvOperatorLaunch({ hasSourceTree: true, hasToolchain: true });
    const ids = plan.map((e) => e.id).sort();
    expect(ids).toEqual(['dev', 'local', 'prod', 'staging']);
    // local (:3055, the Vite SPA over the working tree) is provisionable since WI-3285;
    // release is the immutable bundled sidecar and is never spawned from source.
    const local = PROVISIONABLE_ENV_OPERATORS.find((s) => s.id === 'local');
    expect(local?.run).toBe('vite');
    expect(local?.port).toBe(3055);
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
    // Never let a unit test fall through to the REAL default (fs probe of the package).
    detectBundledSidecar: () => null,
    selfPort: null,
    // Passthrough tree-prepare by default — the real git-worktree prepare is exercised
    // in env-tree-prepare.test.ts; these tests focus on launcher orchestration.
    prepareTree: async (_entry, root) => root,
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

  it('skips everything when the toolchain is missing and cannot be installed', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({ hasToolchain: async () => false });
    const res = await launchEnvOperators(deps);
    expect(res.spawned).toHaveLength(0);
    expect(spawnedCalls).toHaveLength(0);
    expect(res.skipped.every((s) => s.reason === 'no-toolchain')).toBe(true);
  });

  it('a bundled env sidecar spawns with NO source tree and NO toolchain (packaged install)', async () => {
    // The pinned V1 packaged layout: env-sidecars/staging/ shipped, prod falling back
    // to the primary's own serve.mjs (the resolver's prod special case — here faked).
    const { deps, spawnedCalls } = fakeLaunchDeps({
      detectSourceRoot: () => null,
      hasToolchain: async () => false,
      detectBundledSidecar: (envId) =>
        envId === 'staging'
          ? '/opt/pkg/sidecar/env-sidecars/staging/serve.mjs'
          : envId === 'prod'
            ? '/opt/pkg/sidecar/serve.mjs'
            : null,
    });
    const res = await launchEnvOperators(deps);
    // staging runs its bundle; prod runs the primary's own bundle on :3070; dev has
    // neither a bundle nor a source tree → honest skip.
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['prod', 'staging']);
    expect(res.skipped).toContainEqual({ id: 'dev', reason: 'no-source-tree' });
    const staging = spawnedCalls.find((c) => c.entry.id === 'staging');
    expect(staging?.entry.spawnMode).toBe('bundled');
    expect(staging?.entry.bundlePath).toBe('/opt/pkg/sidecar/env-sidecars/staging/serve.mjs');
    // bundled spawns run from the bundle dir — prepareTree is bypassed
    expect(staging?.treePath).toBe('/opt/pkg/sidecar/env-sidecars/staging');
    const prod = spawnedCalls.find((c) => c.entry.id === 'prod');
    expect(prod?.entry.bundlePath).toBe('/opt/pkg/sidecar/serve.mjs');
  });

  it('a bundled sidecar wins over the source path even when a tree+toolchain exist', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({
      detectBundledSidecar: (envId) =>
        envId === 'prod' ? `/opt/pkg/env-sidecars/prod/serve.mjs` : null,
    });
    await launchEnvOperators(deps);
    const prod = spawnedCalls.find((c) => c.entry.id === 'prod');
    expect(prod?.entry.spawnMode).toBe('bundled');
    const dev = spawnedCalls.find((c) => c.entry.id === 'dev');
    expect(dev?.entry.spawnMode).toBe('source');
  });

  it('a vite env never uses a bundle — source-only (SPA dev server transforms the tree)', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({
      specs: [{ id: 'local', port: 3055, branch: 'staging', run: 'vite' }],
      detectSourceRoot: () => null,
      hasToolchain: async () => false,
      detectBundledSidecar: () => '/opt/pkg/env-sidecars/staging/serve.mjs',
    });
    const res = await launchEnvOperators(deps);
    expect(res.spawned).toHaveLength(0);
    expect(spawnedCalls).toHaveLength(0);
    expect(res.skipped).toContainEqual({ id: 'local', reason: 'no-source-tree' });
  });

  it('spawns the local vite env alongside the source operators (WI-3285)', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({
      specs: [...SPECS, { id: 'local', port: 3055, branch: 'staging', run: 'vite' }],
    });
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'local', 'prod', 'staging']);
    const localCall = spawnedCalls.find((c) => c.entry.id === 'local');
    expect(localCall?.entry.run).toBe('vite');
    expect(localCall?.entry.port).toBe(3055);
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

describe('defaultDetectSourceRoot (WI-3306/WI-3308 extraction contract)', () => {
  const saved = process.env.PAPERCUSP_DEV_SOURCE_ROOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCUSP_DEV_SOURCE_ROOT;
    else process.env.PAPERCUSP_DEV_SOURCE_ROOT = saved;
  });

  it('prefers a PAPERCUSP_DEV_SOURCE_ROOT that carries both repo markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-devsrc-'));
    mkdirSync(join(root, 'apps', 'operator'), { recursive: true });
    mkdirSync(join(root, 'libs', 'papercusp'), { recursive: true });
    writeFileSync(join(root, 'apps', 'operator', 'package.json'), '{}');
    writeFileSync(join(root, 'libs', 'papercusp', 'package.json'), '{}');
    process.env.PAPERCUSP_DEV_SOURCE_ROOT = root;
    expect(defaultDetectSourceRoot()).toBe(resolve(root));
    rmSync(root, { recursive: true, force: true });
  });

  it('a marker-less PAPERCUSP_DEV_SOURCE_ROOT (half-extracted tree) is ignored, not walked up', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-devsrc-empty-'));
    process.env.PAPERCUSP_DEV_SOURCE_ROOT = root;
    // Falls back to the dev-box walk — whatever it returns, it is NOT the empty dir.
    expect(defaultDetectSourceRoot()).not.toBe(resolve(root));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('sourceChildEnv (WI-3306 source-child contract)', () => {
  const saved = process.env.PAPERCUSP_SIDECAR_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCUSP_SIDECAR_BIN;
    else process.env.PAPERCUSP_SIDECAR_BIN = saved;
  });

  it('always pins the child PAPERCUSP_INTEGRATION_ROOT to its own tree', () => {
    delete process.env.PAPERCUSP_SIDECAR_BIN;
    expect(sourceChildEnv('/some/tree')).toEqual({
      PAPERCUSP_INTEGRATION_ROOT: '/some/tree',
    });
  });

  it('prepends the sidecar dir (and its bin/) to PATH when PAPERCUSP_SIDECAR_BIN is set', () => {
    const sidecarDir = mkdtempSync(join(tmpdir(), 'pc-sidecar-'));
    mkdirSync(join(sidecarDir, 'bin'), { recursive: true });
    process.env.PAPERCUSP_SIDECAR_BIN = join(sidecarDir, 'serve.mjs');
    const env = sourceChildEnv('/tree');
    expect(env.PAPERCUSP_INTEGRATION_ROOT).toBe('/tree');
    const parts = (env.PATH ?? '').split(delimiter);
    expect(parts[0]).toBe(sidecarDir);
    expect(parts[1]).toBe(join(sidecarDir, 'bin'));
    // The inherited PATH tail is preserved.
    expect(env.PATH?.endsWith(process.env.PATH ?? '')).toBe(true);
    rmSync(sidecarDir, { recursive: true, force: true });
  });
});
