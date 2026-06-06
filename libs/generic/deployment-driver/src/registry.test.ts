import { describe, it, expect, beforeEach } from 'vitest';
import {
  configureDeployment,
  registerDeploymentDriver,
  resolveDeploymentDriver,
  registeredDeploymentTargets,
  isLocalDeployment,
  _resetDeploymentDriversForTests,
} from './registry';
import { LocalDriver } from './local-driver';
import type { DeploymentConfig, DeploymentContext, DeploymentDriver, Frame } from './types';

const ctx: DeploymentContext = { harnessSlug: 'demo', workspaceId: 'ws' };

/** A minimal fake remote driver for registry/placement tests. */
function fakeRemoteDriver(target: string): DeploymentDriver & { calls: string[] } {
  const calls: string[] = [];
  const frame: Frame = { id: `${target}-1`, target, placement: 'remote', host: '10.0.0.1' };
  return {
    target,
    placement: 'remote',
    calls,
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

describe('deployment driver registry', () => {
  beforeEach(() => {
    _resetDeploymentDriversForTests();
  });

  it('LocalDriver is registered by default', () => {
    expect(registeredDeploymentTargets()).toEqual(['local']);
    expect(resolveDeploymentDriver(undefined)).toBe(LocalDriver);
    expect(resolveDeploymentDriver({ target: 'local' })).toBe(LocalDriver);
  });

  it('null/absent config resolves to the local driver', () => {
    expect(resolveDeploymentDriver(null)).toBe(LocalDriver);
  });

  it('registerDeploymentDriver adds a cloud backend', () => {
    const latitude = fakeRemoteDriver('latitude');
    registerDeploymentDriver(latitude);
    expect(registeredDeploymentTargets().sort()).toEqual(['latitude', 'local']);
    expect(resolveDeploymentDriver({ target: 'latitude' })).toBe(latitude);
  });

  it('configureDeployment registers a batch', () => {
    const fly = fakeRemoteDriver('fly');
    const hetzner = fakeRemoteDriver('hetzner');
    configureDeployment({ drivers: [fly, hetzner] });
    expect(registeredDeploymentTargets().sort()).toEqual(['fly', 'hetzner', 'local']);
  });

  it('re-registering the same target replaces it', () => {
    const a = fakeRemoteDriver('latitude');
    const b = fakeRemoteDriver('latitude');
    registerDeploymentDriver(a);
    registerDeploymentDriver(b);
    expect(resolveDeploymentDriver({ target: 'latitude' })).toBe(b);
  });

  it('resolving an unregistered target throws a descriptive error', () => {
    expect(() => resolveDeploymentDriver({ target: 'nope' })).toThrowError(/No deployment driver registered for target 'nope'/);
  });

  describe('isLocalDeployment', () => {
    it('true for local / absent / null', () => {
      expect(isLocalDeployment({ target: 'local' })).toBe(true);
      expect(isLocalDeployment(undefined)).toBe(true);
      expect(isLocalDeployment(null)).toBe(true);
    });

    it('false for a registered remote driver', () => {
      registerDeploymentDriver(fakeRemoteDriver('latitude'));
      expect(isLocalDeployment({ target: 'latitude' })).toBe(false);
    });

    it('true (conservative) for an unregistered non-local target', () => {
      expect(isLocalDeployment({ target: 'mystery' })).toBe(true);
    });
  });

  it('drives a remote frame through the full lifecycle', async () => {
    const latitude = fakeRemoteDriver('latitude');
    registerDeploymentDriver(latitude);
    const cfg: DeploymentConfig = { target: 'latitude', region: 'NYC', kind: 'vm' };
    const driver = resolveDeploymentDriver(cfg);
    const frame = await driver.provision(cfg, ctx);
    await driver.install(frame, cfg, ctx);
    await driver.join(frame, cfg, ctx);
    await driver.teardown(frame, cfg, ctx);
    expect(latitude.calls).toEqual(['provision', 'install', 'join', 'teardown']);
    expect(frame.placement).toBe('remote');
  });
});
