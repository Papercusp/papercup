import { describe, it, expect, vi } from 'vitest';
import type { DeploymentConfig, DeploymentContext } from '@papercusp/deployment-driver';
import { makeHetznerDriver, toHetznerAttributes, HetznerDriver } from './hetzner-driver';
import { createHetznerApiClient, HetznerApiError } from './hetzner-api';
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
    async listServers() {
      return [];
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
  const gone404 = () => new HetznerApiError('getServer', 404, null);
  const frame101 = { id: '101', target: 'hetzner', placement: 'remote' as const };

  /** Scripted teardown client: each getServer pops the next entry — a server, or an
   *  Error to throw (404 = gone). deleteServer errs scriptable (423 = action lock). */
  function teardownClient(
    gets: Array<HetznerServer | Error>,
    deleteErrs: Array<Error | undefined> = [],
  ): HetznerApiClient & { deleted: string[] } {
    const deleted: string[] = [];
    let g = 0;
    let d = 0;
    return {
      deleted,
      async createServer(): Promise<HetznerServer> {
        throw new Error('unused in teardown tests');
      },
      async getServer() {
        const next = gets[Math.min(g++, gets.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
      async deleteServer(id: string) {
        deleted.push(id);
        const err = deleteErrs[d++];
        if (err) throw err;
      },
      async listServers() {
        return [];
      },
    };
  }

  it('teardown DESTROYS and confirms the server is gone (getServer 404)', async () => {
    const client = teardownClient([gone404()]);
    await makeHetznerDriver({ client, sleep, pollIntervalMs: 1 }).teardown(frame101, cfg, ctx);
    expect(client.deleted).toEqual(['101']);
  });

  it("teardown re-issues DELETE when the destroy doesn't stick (same class Latitude hit live)", async () => {
    const client = teardownClient([srv({ status: 'running' }), gone404()]);
    await makeHetznerDriver({ client, sleep, pollIntervalMs: 1 }).teardown(frame101, cfg, ctx);
    expect(client.deleted).toEqual(['101', '101']);
  });

  it("teardown tolerates 423-locked re-DELETE while the async delete runs ('deleting')", async () => {
    const client = teardownClient(
      [srv({ status: 'deleting' }), gone404()],
      [undefined, new HetznerApiError('deleteServer', 423, 'locked')],
    );
    await makeHetznerDriver({ client, sleep, pollIntervalMs: 1 }).teardown(frame101, cfg, ctx);
    expect(client.deleted).toEqual(['101', '101']);
  });

  it('teardown throws loudly (naming billing) when the server never disappears', async () => {
    const client = teardownClient([srv({ status: 'running' })]);
    await expect(
      makeHetznerDriver({ client, sleep, pollIntervalMs: 1, teardownTimeoutMs: 0 }).teardown(frame101, cfg, ctx),
    ).rejects.toThrow(/BILLING/);
  });

  it('teardown propagates non-404 getServer errors', async () => {
    const client = teardownClient([new HetznerApiError('getServer', 500, 'boom')]);
    await expect(
      makeHetznerDriver({ client, sleep, pollIntervalMs: 1 }).teardown(frame101, cfg, ctx),
    ).rejects.toThrow(/500/);
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
    expect(scripts.at(-1)).toContain('PAPERCUSP_DBOS_ORCHESTRATOR=1'); // same provider-agnostic bootstrap
    expect(scripts.at(-1)).toContain('npm ci');
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

  // WI-1628: the orphan-frame reaper's read path — parses name/labels/created too.
  it('listServers parses {servers:[...]} including name/labels/created (WI-1628)', async () => {
    const fetchImpl = fetchMock(200, {
      servers: [
        { id: 101, status: 'running', name: 'hzdeb1234', labels: { 'pcusp-owner': 'su-abc' }, created: '2026-07-01T00:00:00Z' },
        { id: 102, status: 'running', name: 'papercusp-prod', labels: {}, created: '2026-07-02T00:00:00Z' },
      ],
    });
    const client = createHetznerApiClient({ apiToken: 'T', fetchImpl: fetchImpl as never });
    const servers = await client.listServers();
    expect(servers).toEqual([
      { id: '101', status: 'running', name: 'hzdeb1234', ipv4: undefined, labels: { 'pcusp-owner': 'su-abc' }, createdAt: '2026-07-01T00:00:00Z', raw: servers[0].raw },
      { id: '102', status: 'running', name: 'papercusp-prod', ipv4: undefined, labels: {}, createdAt: '2026-07-02T00:00:00Z', raw: servers[1].raw },
    ]);
  });

  it('listServers with a labelSelector appends the query param', async () => {
    const fetchImpl = fetchMock(200, { servers: [] });
    const client = createHetznerApiClient({ apiToken: 'T', fetchImpl: fetchImpl as never });
    await client.listServers({ labelSelector: 'pcusp-owner=su-abc' });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.hetzner.cloud/v1/servers?label_selector=pcusp-owner%3Dsu-abc');
  });
});
