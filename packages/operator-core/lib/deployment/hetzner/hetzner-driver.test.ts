import { describe, it, expect, vi } from 'vitest';
import type { DeploymentConfig, DeploymentContext } from '@papercusp/deployment-driver';
import { makeHetznerDriver, toHetznerAttributes, HetznerDriver } from './hetzner-driver';
import { createHetznerApiClient } from './hetzner-api';
import type { HetznerApiClient, HetznerServer } from './hetzner-api';

const ctx: DeploymentContext = { harnessSlug: 'papercup', workspaceId: 'ws' };
const cfg: DeploymentConfig = { target: 'hetzner', region: 'nbg1', size: 'cx22' };

function fakeClient(script: HetznerServer[]): HetznerApiClient & { deleted: string[]; created: unknown[] } {
  let i = 0;
  const deleted: string[] = [];
  const created: unknown[] = [];
  return {
    deleted,
    created,
    async createServer(a) {
      created.push(a);
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
const srv = (o: Partial<HetznerServer>): HetznerServer => ({ id: '101', status: 'initializing', ...o });

describe('toHetznerAttributes', () => {
  it('maps config → Hetzner attributes', () => {
    expect(toHetznerAttributes(cfg, ctx)).toEqual({
      name: 'papercusp-papercup',
      server_type: 'cx22',
      image: 'ubuntu-22.04',
      location: 'nbg1',
      ssh_keys: undefined,
      user_data: undefined,
    });
  });
  it('requires size (server_type)', () => {
    expect(() => toHetznerAttributes({ target: 'hetzner' }, ctx)).toThrow(/missing required field 'size'/);
  });
});

describe('HetznerDriver provision/teardown', () => {
  const sleep = vi.fn(async () => {});
  it('creates + polls until running with an IP', async () => {
    const client = fakeClient([srv({ status: 'initializing' }), srv({ status: 'starting' }), srv({ status: 'running', ipv4: '5.5.5.5' })]);
    const driver = makeHetznerDriver({ client, sleep, pollIntervalMs: 1 });
    const frame = await driver.provision(cfg, ctx);
    expect(frame).toMatchObject({ id: '101', target: 'hetzner', placement: 'remote', host: '5.5.5.5', kind: 'vm', region: 'nbg1' });
  });
  it('teardown DESTROYS', async () => {
    const client = fakeClient([]);
    await makeHetznerDriver({ client }).teardown({ id: '101', target: 'hetzner', placement: 'remote' }, cfg, ctx);
    expect(client.deleted).toEqual(['101']);
  });
  it('install delegates to the shared installer (same bootstrap as Latitude)', async () => {
    const scripts: string[] = [];
    const exec = {
      async runScript(s: string) {
        scripts.push(s);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async copyFile() {},
    };
    const driver = makeHetznerDriver({ client: fakeClient([]), makeRemoteExec: () => exec });
    await driver.install({ id: '101', target: 'hetzner', placement: 'remote', host: 'h' }, cfg, {
      ...ctx,
      bootstrap: { repoUrl: 'g', install: ['npm ci'] },
    });
    expect(scripts[0]).toContain('PAPERCUSP_DBOS_ORCHESTRATOR=1'); // same provider-agnostic bootstrap
    expect(scripts[0]).toContain('npm ci');
  });
  it('default export declares hetzner/remote', () => {
    expect(HetznerDriver.target).toBe('hetzner');
    expect(HetznerDriver.placement).toBe('remote');
  });
});

describe('createHetznerApiClient (different envelope from Latitude)', () => {
  function fetchMock(status: number, body: unknown) {
    return vi.fn(async (_url: string, _init?: { method?: string; headers?: Record<string, string>; body?: string }) => ({
      status,
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    }));
  }
  it('createServer parses {server:{public_net:{ipv4:{ip}}}}', async () => {
    const fetchImpl = fetchMock(201, { server: { id: 7, status: 'running', public_net: { ipv4: { ip: '9.9.9.9' } } } });
    const client = createHetznerApiClient({ apiToken: 'T', fetchImpl: fetchImpl as never });
    const s = await client.createServer({ name: 'n', server_type: 'cx22', image: 'ubuntu-22.04' });
    expect(s).toMatchObject({ id: '7', status: 'running', ipv4: '9.9.9.9' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.hetzner.cloud/v1/servers');
    expect(init?.headers?.Authorization).toBe('Bearer T');
  });
});
