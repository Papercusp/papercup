import { describe, it, expect, vi } from 'vitest';
import type { DeploymentConfig, DeploymentContext } from '@papercusp/deployment-driver';
import { makeLatitudeDriver, toLatitudeAttributes, LatitudeDriver } from './latitude-driver';
import {
  LatitudeApiError,
  type LatitudeApiClient,
  type LatitudeServer,
  type LatitudeServerAttributes,
  type LatitudeVm,
  type LatitudeVmAttributes,
} from './latitude-api';

/** Shared no-op VM stubs for fakes that only exercise the metal surface. */
const vmStubs = {
  async listVmPlans() {
    return [];
  },
  async createVm(): Promise<LatitudeVm> {
    throw new Error('unused: VM surface not under test');
  },
  async getVm(): Promise<LatitudeVm> {
    throw new Error('unused: VM surface not under test');
  },
  async deleteVm() {},
};

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
    async listPlans() {
      return [];
    },
    ...vmStubs,
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

describe('LatitudeDriver.provision stock fallback', () => {
  const sleep = vi.fn(async () => {});
  const outOfStock = () =>
    new LatitudeApiError('createServer', 422, {
      errors: [{ code: 'SERVERS_OUT_OF_STOCK', title: 'No stock availability' }],
    });

  /** createServer fails once with `failFirst`, then succeeds; listPlans returns `stock`. */
  function fallbackClient(opts: {
    failFirst: Error;
    stock: Array<{ slug: string; inStock: string[] }>;
  }): LatitudeApiClient & { created: LatitudeServerAttributes[] } {
    const created: LatitudeServerAttributes[] = [];
    let call = 0;
    return {
      created,
      async createServer(attrs) {
        created.push(attrs);
        if (call++ === 0) throw opts.failFirst;
        return srv({ status: 'on', primary_ipv4: '1.1.1.1' });
      },
      async getServer() {
        return srv({ status: 'on', primary_ipv4: '1.1.1.1' });
      },
      async deleteServer() {},
      async listPlans() {
        return opts.stock;
      },
      ...vmStubs,
    };
  }

  it('falls back to an in-stock site on SERVERS_OUT_OF_STOCK (region = ACTUAL site)', async () => {
    const client = fallbackClient({
      failFirst: outOfStock(),
      stock: [{ slug: 'c2-small-x86', inStock: ['DAL', 'CHI'] }],
    });
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    const frame = await driver.provision(cfg, ctx); // cfg pins NYC
    expect(client.created.map((a) => a.site)).toEqual(['NYC', 'DAL']);
    expect(frame.region).toBe('DAL');
  });

  it('provider.strictRegion pins the site — no retry', async () => {
    const client = fallbackClient({
      failFirst: outOfStock(),
      stock: [{ slug: 'c2-small-x86', inStock: ['DAL'] }],
    });
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await expect(
      driver.provision({ ...cfg, provider: { ...cfg.provider, strictRegion: true } }, ctx),
    ).rejects.toThrow(/SERVERS_OUT_OF_STOCK/);
    expect(client.created).toHaveLength(1);
  });

  it('non-stock create errors are not retried', async () => {
    const client = fallbackClient({
      failFirst: new LatitudeApiError('createServer', 422, { errors: [{ code: 'BAD_PLAN' }] }),
      stock: [{ slug: 'c2-small-x86', inStock: ['DAL'] }],
    });
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await expect(driver.provision(cfg, ctx)).rejects.toThrow(/BAD_PLAN/);
    expect(client.created).toHaveLength(1);
  });

  it('throws the original error when no alternative site has stock', async () => {
    const client = fallbackClient({
      failFirst: outOfStock(),
      stock: [{ slug: 'c2-small-x86', inStock: [] }],
    });
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await expect(driver.provision(cfg, ctx)).rejects.toThrow(/SERVERS_OUT_OF_STOCK/);
    expect(client.created).toHaveLength(1);
  });
});

describe('LatitudeDriver VM path (kind:vm)', () => {
  const sleep = vi.fn(async () => {});
  const vmCfg: DeploymentConfig = {
    target: 'latitude',
    kind: 'vm',
    size: 'vm.small',
    provider: { project: 'proj_1', sshKeys: ['ssh_k'] },
  };
  const vm = (over: Partial<LatitudeVm>): LatitudeVm => ({ id: 'vm_1', status: 'Starting', ...over });

  /** Scripted VM client: createVm returns first entry, each getVm the next (or throws Errors). */
  function vmClient(script: Array<LatitudeVm | Error>, plans = [{ id: 'plan_small', name: 'vm.small' }]) {
    let i = 0;
    const created: LatitudeVmAttributes[] = [];
    const deleted: string[] = [];
    const next = () => {
      const s = script[Math.min(i++, script.length - 1)];
      if (s instanceof Error) throw s;
      return s;
    };
    const client: LatitudeApiClient & { created: LatitudeVmAttributes[]; deleted: string[] } = {
      created,
      deleted,
      async createServer(): Promise<LatitudeServer> {
        throw new Error('unused: metal surface not under test');
      },
      async getServer(): Promise<LatitudeServer> {
        throw new Error('unused: metal surface not under test');
      },
      async deleteServer() {},
      async listPlans() {
        return [];
      },
      async listVmPlans() {
        return plans;
      },
      async createVm(attrs) {
        created.push(attrs);
        return next();
      },
      async getVm() {
        return next();
      },
      async deleteVm(id: string) {
        deleted.push(id);
      },
    };
    return client;
  }

  it('resolves the plan name to its ID, polls to Running, and reports the ubuntu ssh user', async () => {
    const client = vmClient([
      vm({ status: 'Starting' }), // create echo (ignored)
      vm({ status: 'Starting' }), // poll 1
      vm({ status: 'Running', primary_ipv4: '9.9.9.9' }), // poll 2
    ]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    const frame = await driver.provision(vmCfg, ctx);
    expect(client.created[0]).toMatchObject({ plan: 'plan_small', project: 'proj_1', ssh_keys: ['ssh_k'] });
    // The OS default is LOAD-BEARING: an OS-less VM create is accepted by the
    // API and yields a Running-but-empty machine with no ssh (live 2026-06-12,
    // WI-101) — and the metal default is NOT vm-compatible, so the VM path
    // must carry its own vm-provisionable image.
    expect(client.created[0]).toMatchObject({ operating_system: 'ubuntu_24_04_x64_lts' });
    expect(frame).toMatchObject({ id: 'vm_1', kind: 'vm', host: '9.9.9.9', placement: 'remote' });
    expect(frame.meta).toMatchObject({ sshUser: 'ubuntu', planId: 'plan_small' });
  });

  it('passes a plan_ id through without a lookup and throws on unknown names', async () => {
    const ok = vmClient([vm({ status: 'Running', primary_ipv4: '1.1.1.1' })]);
    await makeLatitudeDriver({ client: ok, sleep, pollIntervalMs: 1 }).provision(
      { ...vmCfg, size: 'plan_xyz' },
      ctx,
    );
    expect(ok.created[0].plan).toBe('plan_xyz');

    const bad = vmClient([vm({})], [{ id: 'plan_small', name: 'vm.small' }]);
    await expect(
      makeLatitudeDriver({ client: bad, sleep, pollIntervalMs: 1 }).provision({ ...vmCfg, size: 'vm.huge' }, ctx),
    ).rejects.toThrow(/unknown VM plan 'vm.huge'/);
  });

  it('teardown of a vm_ frame DELETEs /virtual_machines and confirms gone (404)', async () => {
    const client = vmClient([new LatitudeApiError('getVm', 404, null)]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await driver.teardown({ id: 'vm_9', target: 'latitude', placement: 'remote' }, vmCfg, ctx);
    expect(client.deleted).toEqual(['vm_9']);
  });

  it('vm teardown re-issues DELETE while the vm persists, then confirms', async () => {
    const client = vmClient([vm({ status: 'Destroying' }), new LatitudeApiError('getVm', 404, null)]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await driver.teardown({ id: 'vm_9', target: 'latitude', placement: 'remote' }, vmCfg, ctx);
    expect(client.deleted).toEqual(['vm_9', 'vm_9']);
  });
});

describe('LatitudeDriver teardown', () => {
  const sleep = vi.fn(async () => {});
  const gone404 = () => new LatitudeApiError('getServer', 404, null);
  const frame9 = { id: 'sv_9', target: 'latitude', placement: 'remote' as const };

  /** Scripted teardown client: each getServer call pops the next entry — a server
   *  object, or an Error to throw (404 = gone). deleteServer errs are scriptable too. */
  function teardownClient(
    gets: Array<LatitudeServer | Error>,
    deleteErrs: Array<Error | undefined> = [],
  ): LatitudeApiClient & { deleted: string[] } {
    const deleted: string[] = [];
    let g = 0;
    let d = 0;
    return {
      deleted,
      async createServer(): Promise<LatitudeServer> {
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
      async listPlans() {
        return [];
      },
      ...vmStubs,
    };
  }

  it('DESTROYS the server and confirms it is gone (getServer 404)', async () => {
    const client = teardownClient([gone404()]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await driver.teardown(frame9, cfg, ctx);
    expect(client.deleted).toEqual(['sv_9']);
  });

  it("re-issues DELETE when the first doesn't stick (observed live 2026-06-06: 204 against 'deploying', not applied)", async () => {
    const client = teardownClient([srv({ status: 'deploying' }), gone404()]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await driver.teardown(frame9, cfg, ctx);
    expect(client.deleted).toEqual(['sv_9', 'sv_9']);
  });

  it("status 'deleted' counts as gone", async () => {
    const client = teardownClient([srv({ status: 'deleted' })]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await driver.teardown(frame9, cfg, ctx);
    expect(client.deleted).toEqual(['sv_9']);
  });

  it('a 404 from DELETE itself means already gone (success)', async () => {
    const client = teardownClient([gone404()], [new LatitudeApiError('deleteServer', 404, null)]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await expect(driver.teardown(frame9, cfg, ctx)).resolves.toBeUndefined();
  });

  it('throws loudly (naming billing) if the server never disappears before the teardown deadline', async () => {
    const client = teardownClient([srv({ status: 'deploying' })]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1, teardownTimeoutMs: 0 });
    await expect(driver.teardown(frame9, cfg, ctx)).rejects.toThrow(/BILLING/);
  });

  it('non-404 getServer errors propagate', async () => {
    const client = teardownClient([new LatitudeApiError('getServer', 500, 'boom')]);
    const driver = makeLatitudeDriver({ client, sleep, pollIntervalMs: 1 });
    await expect(driver.teardown(frame9, cfg, ctx)).rejects.toThrow(/500/);
  });
});

describe('LatitudeDriver.install (P-010/P-011)', () => {
  const frame = { id: 'sv_1', target: 'latitude', placement: 'remote' as const, host: '1.2.3.4' };

  function fakeExec() {
    const scripts: string[] = [];
    const copies: Array<[string, string]> = [];
    return {
      scripts,
      copies,
      async runScript(s: string) {
        scripts.push(s);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async copyFile(local: string, remote: string) {
        copies.push([local, remote]);
      },
    };
  }

  it('stages credentials then runs a bootstrap script with the env spec + frame sections', async () => {
    const exec = fakeExec();
    const driver = makeLatitudeDriver({ client: fakeClient([]), makeRemoteExec: () => exec });
    await driver.install(frame, cfg, {
      ...ctx,
      bootstrap: {
        repoUrl: 'https://github.com/acme/repo.git',
        install: ['npm ci'],
        build: ['npm run build'],
        credentialsLocalPath: '/local/claude-creds.json',
      },
    });
    // P-011: credential staged before the script ran.
    expect(exec.copies).toEqual([['/local/claude-creds.json', '/tmp/papercusp-claude-credentials.json']]);
    expect(exec.scripts).toHaveLength(3); // ssh probe + staging pre-clean + bootstrap
    expect(exec.scripts[0]).toBe('true');
    expect(exec.scripts[1]).toContain('rm -rf'); // root-owned pre-clean of staging paths
    const script = exec.scripts.at(-1)!;
    expect(script).toContain('Frame for harness: papercup');
    expect(script).toContain('npm ci'); // env-install
    expect(script).toContain('npm run build'); // env-build
    expect(script).toContain('git clone'); // repo
    expect(script).toContain('embedded-pg'); // D-007
    expect(script).toContain('PAPERCUSP_DBOS_ORCHESTRATOR=1'); // D-006 own loop
    expect(script).toContain('papercusp-claude-credentials.json'); // P-011 mount
  });

  it('skips credential staging when none provided', async () => {
    const exec = fakeExec();
    const driver = makeLatitudeDriver({ client: fakeClient([]), makeRemoteExec: () => exec });
    await driver.install(frame, cfg, { ...ctx, bootstrap: { repoUrl: 'g' } });
    expect(exec.copies).toEqual([]);
    expect(exec.scripts).toHaveLength(2); // probe + bootstrap
  });

  it('stages the runtime tarball (P-010 private-repo delivery) and the bootstrap untars it', async () => {
    const exec = fakeExec();
    const driver = makeLatitudeDriver({ client: fakeClient([]), makeRemoteExec: () => exec });
    await driver.install(frame, cfg, {
      ...ctx,
      bootstrap: { runtimeTarballLocalPath: '/local/runtime.tgz' },
    });
    expect(exec.copies).toEqual([['/local/runtime.tgz', '/tmp/papercusp-runtime.tgz']]);
    expect(exec.scripts.at(-1)).toContain('tar xzf');
    expect(exec.scripts.at(-1)).not.toContain('git clone');
  });

  it('stages a long-lived OAuth token (P-011 token channel) and exports it in the bootstrap', async () => {
    const exec = fakeExec();
    const driver = makeLatitudeDriver({ client: fakeClient([]), makeRemoteExec: () => exec });
    await driver.install(frame, cfg, {
      ...ctx,
      bootstrap: { repoUrl: 'g', oauthTokenLocalPath: '/local/frame-claude/token' },
    });
    expect(exec.copies).toEqual([['/local/frame-claude/token', '/tmp/papercusp-claude-token']]);
    expect(exec.scripts.at(-1)).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('join default is a no-op log; onJoin hook is honored when provided', async () => {
    const calls: string[] = [];
    const driver = makeLatitudeDriver({
      client: fakeClient([]),
      makeRemoteExec: () => fakeExec(),
      onJoin: async () => {
        calls.push('joined');
      },
    });
    await driver.join(frame, cfg, ctx);
    expect(calls).toEqual(['joined']);
    // default (no onJoin) resolves without throwing
    const plain = makeLatitudeDriver({ client: fakeClient([]), makeRemoteExec: () => fakeExec() });
    await expect(plain.join(frame, cfg, ctx)).resolves.toBeUndefined();
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
