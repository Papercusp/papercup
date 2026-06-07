import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerDeploymentDriver,
  _resetDeploymentDriversForTests,
  type DeploymentDriver,
  type Frame,
} from '@papercusp/deployment-driver';
import { parseDeploymentConfig, DeploymentConfigSchema } from './config-schema';

const fakeLatitude: DeploymentDriver = {
  target: 'latitude',
  placement: 'remote',
  async provision(): Promise<Frame> {
    return { id: 'lat-1', target: 'latitude', placement: 'remote' };
  },
  async install() {},
  async join() {},
  async teardown() {},
};

describe('parseDeploymentConfig', () => {
  beforeEach(() => _resetDeploymentDriversForTests());

  it('defaults absent/undefined input to {target:"local"}', () => {
    expect(parseDeploymentConfig(undefined)).toMatchObject({ ok: true, config: { target: 'local' } });
    expect(parseDeploymentConfig(null)).toMatchObject({ ok: true, config: { target: 'local' } });
    expect(parseDeploymentConfig({})).toMatchObject({ ok: true, config: { target: 'local' } });
  });

  it('accepts an explicit local config', () => {
    expect(parseDeploymentConfig({ target: 'local' })).toMatchObject({ ok: true, config: { target: 'local' } });
  });

  it('fails fast on a non-local target with no registered driver', () => {
    const r = parseDeploymentConfig({ target: 'latitude', region: 'NYC' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no deployment driver registered for target 'latitude'/);
    expect(r.registeredTargets).toEqual(['local']);
  });

  it('accepts a cloud target once its driver is registered', () => {
    registerDeploymentDriver(fakeLatitude);
    const r = parseDeploymentConfig({ target: 'latitude', region: 'NYC', kind: 'vm' });
    expect(r.ok).toBe(true);
    expect(r.config).toMatchObject({ target: 'latitude', region: 'NYC', kind: 'vm' });
  });

  it('preserves provider-specific extras', () => {
    registerDeploymentDriver(fakeLatitude);
    const r = parseDeploymentConfig({ target: 'latitude', provider: { projectId: 'proj_42' } });
    expect(r.ok).toBe(true);
    expect(r.config.provider).toEqual({ projectId: 'proj_42' });
  });

  it('rejects a malformed shape (wrong kind enum)', () => {
    const r = parseDeploymentConfig({ target: 'local', kind: 'spaceship' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid deployment config/);
  });

  it('schema applies the local default for a bare target', () => {
    expect(DeploymentConfigSchema.parse({}).target).toBe('local');
  });

  it('accepts the desktop knob — boolean and object forms (hive-frame-desktops P-003)', () => {
    registerDeploymentDriver(fakeLatitude);
    expect(parseDeploymentConfig({ target: 'latitude', desktop: true })).toMatchObject({
      ok: true,
      config: { desktop: true },
    });
    const r = parseDeploymentConfig({
      target: 'latitude',
      desktop: { displays: 2, geometry: '1280x800x24' },
    });
    expect(r.ok).toBe(true);
    expect(r.config.desktop).toEqual({ displays: 2, geometry: '1280x800x24' });
  });

  it('rejects a malformed desktop knob', () => {
    expect(parseDeploymentConfig({ target: 'local', desktop: { displays: 0 } }).ok).toBe(false);
    expect(parseDeploymentConfig({ target: 'local', desktop: { geometry: 'huge' } }).ok).toBe(false);
    expect(parseDeploymentConfig({ target: 'local', desktop: 'yes' }).ok).toBe(false);
  });
});
