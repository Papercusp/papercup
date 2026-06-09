import { describe, it, expect, beforeEach } from 'vitest';
import type { DeploymentConfig, DeploymentDriver, Frame } from '@papercusp/deployment-driver';
import { deployHarness, teardownHarness, type DeployDeps } from './deploy';
import { resolveCredential } from './bootstrap-input';

function fakeDriver(calls: string[]): DeploymentDriver {
  const frame: Frame = { id: 'sv_1', target: 'latitude', placement: 'remote', host: '1.2.3.4' };
  return {
    target: 'latitude',
    placement: 'remote',
    async provision() {
      calls.push('provision');
      return frame;
    },
    async install() {
      calls.push('install');
    },
    async join() {
      calls.push('join');
    },
    async teardown() {
      calls.push('teardown');
    },
  };
}

/** In-memory deps: config + frame in Maps, a recording driver. */
function memDeps(config: DeploymentConfig | undefined, calls: string[], driverOverride?: DeploymentDriver): DeployDeps & { frames: Map<string, Frame> } {
  const frames = new Map<string, Frame>();
  const driver = driverOverride ?? fakeDriver(calls);
  return {
    frames,
    resolveDriver: () => driver,
    async getDeploymentConfig() {
      return config;
    },
    async buildBootstrap() {
      return { repoUrl: 'g', install: ['npm ci'] };
    },
    async persistFrame(slug, ws, frame) {
      calls.push('persist');
      frames.set(`${ws}:${slug}`, frame);
    },
    async loadFrame(slug, ws) {
      return frames.get(`${ws}:${slug}`);
    },
    async clearFrame(slug, ws) {
      calls.push('clear');
      frames.delete(`${ws}:${slug}`);
    },
  };
}

const cloud: DeploymentConfig = { target: 'latitude', region: 'NYC', size: 'c2-small-x86', provider: { project: 'p' } };

describe('deployHarness', () => {
  it('runs provision → persist → install → join in order and persists the frame', async () => {
    const calls: string[] = [];
    const deps = memDeps(cloud, calls);
    const { frame } = await deployHarness('papercup', 'ws', deps);
    expect(calls).toEqual(['provision', 'persist', 'install', 'join']);
    expect(frame.id).toBe('sv_1');
    expect(deps.frames.get('ws:papercup')).toBeDefined();
  });

  it('refuses a local-only (or missing) harness', async () => {
    await expect(deployHarness('h', 'ws', memDeps({ target: 'local' }, []))).rejects.toThrow(/no cloud deployment/);
    await expect(deployHarness('h', 'ws', memDeps(undefined, []))).rejects.toThrow(/no cloud deployment/);
  });

  it('refuses a double-deploy: a recorded frame must be torn down first (orphaned-billing guard)', async () => {
    const calls: string[] = [];
    const deps = memDeps(cloud, calls);
    await deployHarness('papercup', 'ws', deps);
    calls.length = 0;
    await expect(deployHarness('papercup', 'ws', deps)).rejects.toThrow(/already has a deployed frame.*sv_1.*deploy:teardown/s);
    expect(calls).toEqual([]); // guard fires BEFORE provision — no second machine created
    // teardown clears the handle, after which deploy works again
    await teardownHarness('papercup', 'ws', deps);
    calls.length = 0;
    await deployHarness('papercup', 'ws', deps);
    expect(calls).toEqual(['provision', 'persist', 'install', 'join']);
  });

  it('persists the frame BEFORE install, so a failed install leaves a destroyable frame', async () => {
    const calls: string[] = [];
    const failingDriver: DeploymentDriver = {
      target: 'latitude',
      placement: 'remote',
      async provision() {
        calls.push('provision');
        return { id: 'sv_x', target: 'latitude', placement: 'remote', host: 'h' };
      },
      async install() {
        calls.push('install');
        throw new Error('bootstrap blew up');
      },
      async join() {
        calls.push('join');
      },
      async teardown() {
        calls.push('teardown');
      },
    };
    const deps = memDeps(cloud, calls, failingDriver);
    await expect(deployHarness('papercup', 'ws', deps)).rejects.toThrow(/bootstrap blew up/);
    expect(calls).toEqual(['provision', 'persist', 'install']); // persisted before the failed install
    expect(deps.frames.get('ws:papercup')).toBeDefined(); // still recorded → teardown can destroy it
  });
});

describe('teardownHarness', () => {
  it('loads the frame, DESTROYs it, then clears the record', async () => {
    const calls: string[] = [];
    const deps = memDeps(cloud, calls);
    await deployHarness('papercup', 'ws', deps);
    calls.length = 0;
    const r = await teardownHarness('papercup', 'ws', deps);
    expect(r.destroyed).toBe(true);
    expect(calls).toEqual(['teardown', 'clear']);
    expect(deps.frames.get('ws:papercup')).toBeUndefined();
  });

  it('is a no-op when nothing is deployed', async () => {
    const calls: string[] = [];
    const r = await teardownHarness('papercup', 'ws', memDeps(cloud, calls));
    expect(r.destroyed).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('resolveCredential', () => {
  it('routes file:/absolute/~ refs to the credentials-bundle channel', () => {
    expect(resolveCredential('file:/a/b.json')).toEqual({ credentialsLocalPath: '/a/b.json' });
    expect(resolveCredential('/abs/creds.json')).toEqual({ credentialsLocalPath: '/abs/creds.json' });
    expect(resolveCredential('~/c.json')).toEqual({
      credentialsLocalPath: `${process.env.HOME}/c.json`,
    });
  });

  it('routes token: refs to the long-lived OAuth token channel (claude setup-token)', () => {
    expect(resolveCredential('token:/secrets/claude-token')).toEqual({
      oauthTokenLocalPath: '/secrets/claude-token',
    });
    expect(resolveCredential('token:~/.papercusp/frame-claude/token')).toEqual({
      oauthTokenLocalPath: `${process.env.HOME}/.papercusp/frame-claude/token`,
    });
  });

  it('env-style / absent refs are the provider API key, not a frame credential', () => {
    expect(resolveCredential(undefined)).toEqual({});
    expect(resolveCredential('env:LATITUDE_API_KEY')).toEqual({});
    expect(resolveCredential('LATITUDE_API_KEY')).toEqual({});
  });
});
