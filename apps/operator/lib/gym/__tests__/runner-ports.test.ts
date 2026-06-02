import { describe, it, expect } from 'vitest';
import { createGymRunnerPorts, type GymRunnerPortsConfig } from '../runner-ports';

/**
 * Real GymRunnerPorts adapter (P-001 wiring). Binds the smoke-PROVEN operations:
 * git clone, harness register (HTTP), prompt overrides + feature (gym PG), pipeline
 * start (admin route + superuser bearer), poll (gym PG), teardown. The HTTP + exec
 * ports are tested here with injected fakes (verifying URLs/auth/commands); the gym-PG
 * ports are validated by the boot smoke / P-014.
 */
function cfg(over: Partial<GymRunnerPortsConfig> = {}): { config: GymRunnerPortsConfig; reqs: { url: string; init: RequestInit }[]; execs: string[][] } {
  const reqs: { url: string; init: RequestInit }[] = [];
  const execs: string[][] = [];
  const config: GymRunnerPortsConfig = {
    operatorBaseUrl: 'http://127.0.0.1:3971',
    gymSql: (() => {}) as never, // not exercised by the HTTP/exec tests
    superuserToken: 'sekret-token-1234567890',
    workspaceId: 'gym-ws',
    fetchFn: (async (url: string, init: RequestInit) => {
      reqs.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ ok: true, workflowID: 'pipeline:gymx:F-GYM-1:e0' }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
    exec: async (cmd: string, args: string[]) => {
      execs.push([cmd, ...args]);
    },
    rm: async () => {},
    ...over,
  };
  return { config, reqs, execs };
}

describe('createGymRunnerPorts', () => {
  it('exposes the full GymRunnerPorts surface', () => {
    const p = createGymRunnerPorts(cfg().config);
    for (const k of ['cloneSubstrate', 'registerThrowawayHarness', 'applyPromptOverride', 'fileFeature', 'startPipeline', 'pollStatus', 'teardownHarness', 'now', 'sleep']) {
      expect(typeof (p as Record<string, unknown>)[k]).toBe('function');
    }
  });

  it('cloneSubstrate runs git clone then checkout --detach at the pinned commit', async () => {
    const { config, execs } = cfg();
    const p = createGymRunnerPorts(config);
    await p.cloneSubstrate({ source: '/repos/sub', commit: '0123456789abcdef0123456789abcdef01234567', destDir: '/c/gymx' });
    expect(execs[0]).toContain('clone');
    expect(execs[1]).toEqual(['git', '-C', '/c/gymx', 'checkout', '--detach', '0123456789abcdef0123456789abcdef01234567']);
  });

  it('registerThrowawayHarness POSTs the slug + path to /api/harness/projects', async () => {
    const { config, reqs } = cfg();
    const p = createGymRunnerPorts(config);
    await p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' });
    expect(reqs[0].url).toBe('http://127.0.0.1:3971/api/harness/projects');
    expect(JSON.parse(reqs[0].init.body as string)).toEqual({ slug: 'gymx', path: '/c/gymx' });
  });

  it('registerThrowawayHarness throws (fail-loud) when scaffold failed even on HTTP 200', async () => {
    // The /api/harness/projects route swallows a scaffoldHarnessSchema() failure:
    // it returns HTTP 200 / ok:true with provisioning:{ok:false,error}. If the port
    // ignores `provisioning`, the per-harness `harness_features` VIEW is never created
    // and the worker's `UPDATE harness_features` later 42P01s deep in the pipeline.
    // The port MUST surface the scaffold error at registration time.
    const { config } = cfg({
      fetchFn: (async (url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        text: async () => 'unused',
        json: async () => ({
          ok: true,
          project: { slug: 'gymx', path: '/c/gymx' },
          provisioning: { ok: false, error: 'relation "harness_shared.harness_features_consolidated" does not exist' },
        }),
      })) as unknown as typeof fetch,
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).rejects.toThrow(/scaffold|provisioning|harness_features_consolidated/);
  });

  it('registerThrowawayHarness succeeds when provisioning.ok is true (or absent)', async () => {
    // ok:true + provisioning.ok:true → no throw (the default cfg fake omits provisioning,
    // which must also be treated as success so non-scaffold registration paths still work).
    const { config } = cfg();
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).resolves.toBeUndefined();
  });

  it('startPipeline hits the admin route with the superuser bearer + returns the workflow id', async () => {
    const { config, reqs } = cfg();
    const p = createGymRunnerPorts(config);
    const out = await p.startPipeline({ slug: 'gymx', featureId: 'F-GYM-1', workspaceId: 'gym-ws' });
    expect(reqs[0].url).toContain('/api/admin/dbos/pipeline/start');
    expect(reqs[0].url).toContain('superuser=1');
    expect((reqs[0].init.headers as Record<string, string>).authorization).toBe('Bearer sekret-token-1234567890');
    expect(JSON.parse(reqs[0].init.body as string)).toEqual({ harnessSlug: 'gymx', featureId: 'F-GYM-1' });
    expect(out.workflowID).toBe('pipeline:gymx:F-GYM-1:e0');
  });

  it('now + sleep work', async () => {
    const p = createGymRunnerPorts(cfg().config);
    expect(typeof p.now()).toBe('number');
    await expect(p.sleep(1)).resolves.toBeUndefined();
  });
});
