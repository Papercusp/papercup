import { describe, it, expect } from 'vitest';
import type { DeploymentConfig, Frame } from '@papercusp/deployment-driver';
import {
  deployHive,
  teardownHive,
  pauseHive,
  scaleHive,
  computeFramesToReap,
  reapHiveFrames,
  type HiveDeploySpec,
  type HiveDeployDeps,
} from './hive-deploy';

const swarm: DeploymentConfig = { target: 'latitude', region: 'NYC', size: 'c2-small-x86', provider: { project: 'p' } };
const frame = (slug: string): Frame => ({ id: `f-${slug}`, target: 'latitude', placement: 'remote', host: `ip-${slug}` });

function memDeps(over: Partial<HiveDeployDeps> = {}) {
  const calls: string[] = [];
  const deployments = new Map<string, DeploymentConfig>();
  const deps: HiveDeployDeps & { calls: string[]; deployments: Map<string, DeploymentConfig> } = {
    calls,
    deployments,
    async setMemberDeployment(slug, _ws, d) {
      deployments.set(slug, d);
    },
    async deployHarness(slug) {
      calls.push(`deploy:${slug}`);
      return { frame: frame(slug) };
    },
    async teardownHarness(slug) {
      calls.push(`teardown:${slug}`);
      return { destroyed: true };
    },
    async deployControlFrame(potId) {
      calls.push(`control:${potId}`);
      return frame(`queen-${potId}`);
    },
    async teardownControlFrame(potId) {
      calls.push(`teardown-control:${potId}`);
      return { destroyed: true };
    },
    ...over,
  };
  return deps;
}

const spec = (over: Partial<HiveDeploySpec> = {}): HiveDeploySpec => ({
  potId: 'h1',
  members: ['a', 'b'],
  swarm,
  ...over,
});

describe('deployHive', () => {
  it('local Queen: deploys all members, no control frame, sets member deployments', async () => {
    const deps = memDeps();
    const r = await deployHive(spec({ queen: { placement: 'local' } }), 'ws', deps);
    expect(r.controlFrame).toBeUndefined();
    expect(r.queenPlacement).toBe('local');
    expect(r.members.map((m) => m.slug)).toEqual(['a', 'b']);
    expect(r.members.every((m) => m.frame)).toBe(true);
    expect(deps.deployments.get('a')).toEqual(swarm);
    expect(deps.calls).toEqual(['deploy:a', 'deploy:b']);
  });

  it('dedicated Queen: provisions a control frame first', async () => {
    const deps = memDeps();
    const r = await deployHive(spec({ queen: { placement: 'dedicated' } }), 'ws', deps);
    expect(r.controlFrame?.id).toBe('f-queen-h1');
    expect(deps.calls[0]).toBe('control:h1');
  });

  it('dedicated without deployControlFrame throws', async () => {
    const deps = memDeps({ deployControlFrame: undefined });
    await expect(deployHive(spec({ queen: { placement: 'dedicated' } }), 'ws', deps)).rejects.toThrow(/requires deps.deployControlFrame/);
  });

  it('captures a per-member failure without stranding the rest', async () => {
    const deps = memDeps({
      async deployHarness(slug) {
        if (slug === 'a') throw new Error('provision failed');
        return { frame: frame(slug) };
      },
    });
    const r = await deployHive(spec(), 'ws', deps);
    expect(r.members.find((m) => m.slug === 'a')?.error).toMatch(/provision failed/);
    expect(r.members.find((m) => m.slug === 'b')?.frame).toBeDefined();
  });
});

describe('teardownHive / pauseHive / scaleHive', () => {
  it('teardownHive destroys every member + the dedicated control frame', async () => {
    const deps = memDeps();
    const r = await teardownHive(spec({ queen: { placement: 'dedicated' } }), 'ws', deps);
    expect(r.destroyed).toContain('a');
    expect(r.destroyed).toContain('b');
    expect(r.destroyed).toContain('queen:h1');
  });

  // DEP-1: a member teardown that throws is captured in `failed`, the loop keeps
  // going, AND the dedicated control frame is STILL torn down afterward — a member
  // failure must not strand the Queen frame as a billing leak.
  it('teardownHive: a member throw → failed, but other member + control frame still destroyed (no Queen billing leak)', async () => {
    const deps = memDeps({
      async teardownHarness(slug) {
        if (slug === 'a') throw new Error('destroy failed');
        return { destroyed: true };
      },
    });
    const r = await teardownHive(spec({ queen: { placement: 'dedicated' } }), 'ws', deps);
    expect(r.failed).toContain('a');
    expect(r.destroyed).toContain('b');
    expect(r.destroyed).toContain('queen:h1'); // control frame torn down despite the member throw
    expect(r.destroyed).not.toContain('a');
  });

  // DEP-1: the control-frame teardown itself throwing is captured in `failed`
  // (under its own try/catch) — members already destroyed are unaffected.
  it('teardownHive: control-frame teardown throwing → queen recorded in failed, members still destroyed', async () => {
    const deps = memDeps({
      async teardownControlFrame() {
        throw new Error('queen destroy failed');
      },
    });
    const r = await teardownHive(spec({ queen: { placement: 'dedicated' } }), 'ws', deps);
    expect(r.failed).toEqual(['queen:h1']);
    expect(r.destroyed).toEqual(['a', 'b']);
  });

  it('pauseHive destroys execution frames (destroy-to-stop), keeps the Queen by default', async () => {
    const deps = memDeps();
    const r = await pauseHive(spec({ queen: { placement: 'dedicated' } }), 'ws', deps);
    expect(r.paused).toEqual(['a', 'b']);
    expect(deps.calls).not.toContain('teardown-control:h1'); // Queen stays up
  });

  it('scaleHive adds + removes members', async () => {
    const deps = memDeps();
    const r = await scaleHive(spec(), 'ws', { add: ['c'], remove: ['a'] }, deps);
    expect(r.added.map((m) => m.slug)).toEqual(['c']);
    expect(r.removed).toEqual(['a']);
    expect(deps.deployments.get('c')).toEqual(swarm);
  });

  // DEP-3: pauseHive swallows a per-member teardown throw (.catch → destroyed:false)
  // so one stuck frame doesn't abort the pause — only the successfully-destroyed
  // frame appears in `paused`, and no error escapes.
  it('pauseHive: a member teardown throwing is swallowed → only the survivor is paused, no throw', async () => {
    const deps = memDeps({
      async teardownHarness(slug) {
        if (slug === 'a') throw new Error('stuck');
        return { destroyed: true };
      },
    });
    const r = await pauseHive(spec(), 'ws', deps);
    expect(r.paused).toEqual(['b']);
  });

  // DEP-3: scaleHive's remove leg likewise swallows a throwing teardown — the
  // removed list reflects only what was actually destroyed.
  it('scaleHive: a throwing removal is swallowed → only the destroyed member is in removed', async () => {
    const deps = memDeps({
      async teardownHarness(slug) {
        if (slug === 'a') throw new Error('stuck');
        return { destroyed: true };
      },
    });
    const r = await scaleHive(spec(), 'ws', { remove: ['a', 'b'] }, deps);
    expect(r.removed).toEqual(['b']);
  });
});

describe('cost controls (computeFramesToReap / reapHiveFrames)', () => {
  const s = spec({ budget: { perFrameUsdCap: 10, idleReaperMinutes: 30 } });
  const now = 1_000_000_000;

  it('reaps a frame over its per-frame budget cap', () => {
    const reap = computeFramesToReap(s, [{ slug: 'a', costUsd: 12 }, { slug: 'b', costUsd: 3 }], now);
    expect(reap).toEqual([{ slug: 'a', reason: 'budget' }]);
  });

  it('reaps a frame idle past the reaper window', () => {
    const reap = computeFramesToReap(s, [{ slug: 'a', lastActivityMs: now - 31 * 60_000 }, { slug: 'b', lastActivityMs: now - 5 * 60_000 }], now);
    expect(reap).toEqual([{ slug: 'a', reason: 'idle' }]);
  });

  it('no budget config → nothing reaped', () => {
    expect(computeFramesToReap(spec(), [{ slug: 'a', costUsd: 999, lastActivityMs: 0 }], now)).toEqual([]);
  });

  // DEP-2: budget-vs-idle precedence — the `else if` means an over-budget AND idle
  // frame reports ONLY `budget` (each frame yields at most one entry; budget wins).
  it('over-budget AND idle reports ONLY budget (else-if precedence, one entry per frame)', () => {
    const reap = computeFramesToReap(s, [{ slug: 'a', costUsd: 12, lastActivityMs: now - 31 * 60_000 }], now);
    expect(reap).toEqual([{ slug: 'a', reason: 'budget' }]);
  });

  // DEP-2: budget cap is inclusive (>=) — costUsd at the cap is reaped, just under is not.
  it('budget cap boundary is inclusive: costUsd===cap reaped, cap-0.01 not', () => {
    expect(computeFramesToReap(s, [{ slug: 'a', costUsd: 10 }], now)).toEqual([{ slug: 'a', reason: 'budget' }]);
    expect(computeFramesToReap(s, [{ slug: 'a', costUsd: 9.99 }], now)).toEqual([]);
  });

  // DEP-2: idle window is inclusive (>=) — idle exactly the window length is reaped.
  it('idle window boundary is inclusive: idle exactly idleReaperMinutes is reaped', () => {
    expect(computeFramesToReap(s, [{ slug: 'a', lastActivityMs: now - 30 * 60_000 }], now)).toEqual([{ slug: 'a', reason: 'idle' }]);
    expect(computeFramesToReap(s, [{ slug: 'a', lastActivityMs: now - (30 * 60_000 - 1) }], now)).toEqual([]);
  });

  it('reapHiveFrames tears down the selected frames', async () => {
    const deps = memDeps();
    const reaped = await reapHiveFrames(s, [{ slug: 'a', costUsd: 50 }], now, 'ws', deps);
    expect(reaped).toEqual([{ slug: 'a', reason: 'budget' }]);
    expect(deps.calls).toContain('teardown:a');
  });
});
