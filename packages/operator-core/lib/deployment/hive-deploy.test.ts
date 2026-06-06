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
    async deployControlFrame(hiveId) {
      calls.push(`control:${hiveId}`);
      return frame(`queen-${hiveId}`);
    },
    async teardownControlFrame(hiveId) {
      calls.push(`teardown-control:${hiveId}`);
      return { destroyed: true };
    },
    ...over,
  };
  return deps;
}

const spec = (over: Partial<HiveDeploySpec> = {}): HiveDeploySpec => ({
  hiveId: 'h1',
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

  it('reapHiveFrames tears down the selected frames', async () => {
    const deps = memDeps();
    const reaped = await reapHiveFrames(s, [{ slug: 'a', costUsd: 50 }], now, 'ws', deps);
    expect(reaped).toEqual([{ slug: 'a', reason: 'budget' }]);
    expect(deps.calls).toContain('teardown:a');
  });
});
