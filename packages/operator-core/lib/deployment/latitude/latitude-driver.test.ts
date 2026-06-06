import { describe, it, expect, vi } from 'vitest';
import type { DeploymentConfig, DeploymentContext } from '@papercusp/deployment-driver';
import { makeLatitudeDriver, toLatitudeAttributes, LatitudeDriver } from './latitude-driver';
import type { LatitudeApiClient, LatitudeServer } from './latitude-api';

const ctx: DeploymentContext = { harnessSlug: 'papercup', workspaceId: 'ws' };
const cfg: DeploymentConfig = { target: 'latitude', region: 'NYC', size: 'c2-small-x86', provider: { project: 'proj_1' } };

/** A scripted fake client: createServer returns the first script entry, each
 *  getServer returns the next, so we can drive the poll loop deterministically. */
function fakeClient(script: LatitudeServer[]): LatitudeApiClient & { deleted: string[]; created: unknown[] } {
  let i = 0;
  const deleted: string[] = [];
  const created: unknown[] = [];
  return {
    deleted,
    created,
    async createServer(attrs) {
      created.push(attrs);
      return script[i++];
    },
    async getServer() {
      return script[Math.min(i++, script.length - 1)];
    },
    async deleteServer(id) {
      deleted.push(id);
    },
  };
}

const srv = (over: Partial<LatitudeServer>): LatitudeServer => ({ id: 'sv_1', status: 'deploying', ...over });

describe('toLatitudeAttributes', () => {
  it('maps config → Latitude attributes with defaults', () => {
    expect(toLatitudeAttributes(cfg, ctx)).toEqual({
      project: 'proj_1',
      plan: 'c2-small-x86',
      site: 'NYC',
      operating_system: 'ubuntu_22_04_x64_lts',
      hostname: 'papercusp-papercup',
      ssh_keys: undefined,
      user_data: undefined,
      billing: 'hourly',
    });
  });

  it('throws listing every missing required field', () => {
    expect(() => toLatitudeAttributes({ target: 'latitude' }, ctx)).toThrowError(
      /provider\.project.*size.*region/s,
    );
  });

  it('honors provider overrides (os, hostname, ssh keys, billing)', () => {
    const attrs = toLatitudeAttributes(
      {
        target: 'latitude',
        region: 'ASH',
        size: 'm4-metal',
        provider: { project: 'p', operatingSystem: 'debian_12', hostname: 'h1', sshKeys: ['k1'], billing: 'monthly' },
      },
      ctx,
    );
    expect(attrs).toMatchObject({ site: 'ASH', plan: 'm4-metal', operating_system: 'debian_12', hostname: 'h1', ssh_keys: ['k1'], billing: 'monthly' });
  });
});

describe('LatitudeDriver.provision', () => {
  const sleep = vi.fn(async () => {});

  it('creates a server and polls until ready, returning a Frame', async () => {
    const client = fakeClient([
      srv({ status: 'deploying' }), // create →
      srv({ status: 'deploying' }), // poll 1
      srv({ status: 'on', primary_ipv4: '1.2.3.4', primary_ipv6: 'ff::1', planSlug: 'c2-small-x86' }), // poll 2 ready
    ]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    const frame = await driver.provision(cfg, ctx);
    expect(frame).toMatchObject({
      id: 'sv_1',
      target: 'latitude',
      placement: 'remote',
      host: '1.2.3.4',
      kind: 'vm',
      region: 'NYC',
    });
    expect(frame.meta).toMatchObject({ ipv6: 'ff::1', planSlug: 'c2-small-x86' });
    expect(client.created).toHaveLength(1);
  });

  it('kind:metal is reflected on the Frame', async () => {
    const client = fakeClient([srv({ status: 'on', primary_ipv4: '5.6.7.8' })]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    const frame = await driver.provision({ ...cfg, kind: 'metal' }, ctx);
    expect(frame.kind).toBe('metal');
  });

  it('throws if the server enters a failed status', async () => {
    const client = fakeClient([srv({ status: 'deploying' }), srv({ status: 'failed' })]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await expect(driver.provision(cfg, ctx)).rejects.toThrow(/status 'failed'/);
  });

  it('times out if never ready', async () => {
    const client = fakeClient([srv({ status: 'deploying' })]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1, pollTimeoutMs: 0 });
    await expect(driver.provision(cfg, ctx)).rejects.toThrow(/not ready/);
  });
});

describe('LatitudeDriver teardown / install / join', () => {
  it('teardown DESTROYS the server', async () => {
    const client = fakeClient([]);
    const driver = makeLatitudeDriver({ client });
    await driver.teardown({ id: 'sv_9', target: 'latitude', placement: 'remote' }, cfg, ctx);
    expect(client.deleted).toEqual(['sv_9']);
  });

  it('install + join throw an explicit P-010 pending error (not a silent no-op)', async () => {
    const driver = makeLatitudeDriver({ client: fakeClient([]) });
    const frame = { id: 'sv_1', target: 'latitude', placement: 'remote' as const };
    await expect(driver.install(frame, cfg, ctx)).rejects.toThrow(/not implemented yet.*P-010/s);
    await expect(driver.join(frame, cfg, ctx)).rejects.toThrow(/not implemented yet/);
  });
});

describe('LatitudeDriver default export', () => {
  it('declares the latitude/remote contract', () => {
    expect(LatitudeDriver.target).toBe('latitude');
    expect(LatitudeDriver.placement).toBe('remote');
  });

  it('errors clearly when no API key is resolvable', async () => {
    const prev = process.env.LATITUDE_API_KEY;
    delete process.env.LATITUDE_API_KEY;
    try {
      await expect(LatitudeDriver.provision(cfg, ctx)).rejects.toThrow(/no API key/);
    } finally {
      if (prev !== undefined) process.env.LATITUDE_API_KEY = prev;
    }
  });
});
