/**
 * GcpDriver unit tests — the $0 layer for the p2p public-release rig substitution
 * (p2p-public-release-remaining-lanes-2026-07-16 D-086, WI-470360).
 *
 * These pin the behaviours that decide whether a REAL two-host run is honest or
 * quietly wrong, using a fake client so no credential and no billing are touched:
 *  - the two ways to leave a BILLING ORPHAN (unreachable keyless instance;
 *    teardown that accepts a 2xx DELETE as a confirmed destroy);
 *  - the frame carrying the `sshUser` that `sshTargetForFrame` needs, since GCP
 *    images disable root and a wrong login is an unreachable frame;
 *  - name normalisation, because a label like `ash-0` or an uppercase region is
 *    otherwise discovered as a 400 at create time.
 *
 * A deliberately-wrong control implementation is kept here permanently rather
 * than mutating the driver, per the repo's falsifiability guidance.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeGcpDriver, toGcpInstanceAttributes } from './gcp-driver';
import { GcpApiError, toGcpInstanceName, lastSegment } from './gcp-compute-api';
import type { GcpComputeApiClient, GcpInstance } from './gcp-compute-api';
import type { DeploymentConfig, DeploymentContext } from '@papercusp/deployment-driver';

const ctx = (): DeploymentContext => ({ harnessSlug: 'bench-rig', log: () => {} }) as DeploymentContext;

const baseConfig = (over: Partial<DeploymentConfig> = {}): DeploymentConfig => ({
  target: 'gcp',
  region: 'us-east1-b',
  size: 'e2-standard-4',
  provider: {
    projectId: 'test-project',
    sshPublicKey: 'ssh-ed25519 AAAATEST comment',
    sshIdentityFile: '/tmp/id',
  },
  ...over,
});

/** A fake Compute client whose instance lifecycle is scripted per test. */
function fakeClient(opts: {
  statuses?: string[];
  ip?: string | undefined;
  /** How many getInstance calls after delete still return the instance (destroy-not-stuck). */
  lingerAfterDelete?: number;
  onDelete?: () => void;
}): GcpComputeApiClient & { deleteCalls: number; getCalls: number } {
  const statuses = [...(opts.statuses ?? ['RUNNING'])];
  let deleted = false;
  let linger = opts.lingerAfterDelete ?? 0;
  const api = {
    deleteCalls: 0,
    getCalls: 0,
    async createInstance(attrs): Promise<GcpInstance> {
      return api.getInstance(attrs.zone, attrs.name);
    },
    async getInstance(zone: string, name: string): Promise<GcpInstance> {
      api.getCalls++;
      if (deleted) {
        if (linger > 0) {
          linger--;
          return { id: '1', name, zone, status: 'STOPPING', ipv4: opts.ip };
        }
        throw new GcpApiError('not found', 404, undefined);
      }
      const status = statuses.length > 1 ? (statuses.shift() as string) : statuses[0];
      return { id: '1', name, zone, status, ipv4: status === 'RUNNING' ? (opts.ip ?? '203.0.113.7') : undefined };
    },
    async deleteInstance(): Promise<void> {
      api.deleteCalls++;
      opts.onDelete?.();
      deleted = true;
    },
  } as GcpComputeApiClient & { deleteCalls: number; getCalls: number };
  return api;
}

const noSleep = async () => {};

describe('toGcpInstanceName — RFC1035 normalisation', () => {
  it('normalises the label shapes the bench harness actually produces', () => {
    expect(toGcpInstanceName('papercusp-bench-rig')).toBe('papercusp-bench-rig');
    expect(toGcpInstanceName('US-East_1')).toBe('us-east-1');
    // A leading digit is invalid in GCP and is the shape `frameCount` suffixes produce.
    expect(toGcpInstanceName('0-frame')).toBe('pc-0-frame');
    expect(toGcpInstanceName('trailing-')).toBe('trailing');
    expect(toGcpInstanceName('a'.repeat(80)).length).toBeLessThanOrEqual(63);
  });

  it('lastSegment unwraps GCP self-links (zone URLs) and tolerates a bare value', () => {
    expect(lastSegment('https://www.googleapis.com/compute/v1/projects/p/zones/us-east1-b')).toBe('us-east1-b');
    expect(lastSegment('us-east1-b')).toBe('us-east1-b');
    expect(lastSegment(undefined)).toBe('');
  });
});

describe('toGcpInstanceAttributes', () => {
  it('reads region as a ZONE and injects the ssh key inline as <user>:<key>', () => {
    const attrs = toGcpInstanceAttributes(baseConfig(), ctx());
    expect(attrs.zone).toBe('us-east1-b');
    expect(attrs.machineType).toBe('e2-standard-4');
    expect(attrs.sshKeys).toBe('papercusp:ssh-ed25519 AAAATEST comment');
    expect(attrs.sourceImage).toContain('ubuntu-2204-lts');
  });

  it('lets provider.zone override region, and provider.sshUser override the default login', () => {
    const attrs = toGcpInstanceAttributes(
      baseConfig({ provider: { projectId: 'p', zone: 'europe-west1-c', sshUser: 'bench', sshPublicKey: 'ssh-ed25519 K' } }),
      ctx(),
    );
    expect(attrs.zone).toBe('europe-west1-c');
    expect(attrs.sshKeys).toBe('bench:ssh-ed25519 K');
  });

  it('refuses a config with no zone rather than defaulting one', () => {
    expect(() => toGcpInstanceAttributes({ target: 'gcp', provider: { projectId: 'p' } }, ctx())).toThrow(/region/i);
  });
});

describe('GcpDriver.provision', () => {
  it('returns a frame carrying host, zone and the sshUser that sshTargetForFrame needs', async () => {
    const client = fakeClient({ ip: '203.0.113.9' });
    const driver = makeGcpDriver({ client, sleep: noSleep });
    const frame = await driver.provision!(baseConfig(), ctx());
    expect(frame.host).toBe('203.0.113.9');
    expect(frame.target).toBe('gcp');
    expect(frame.placement).toBe('remote');
    expect(frame.region).toBe('us-east1-b');
    // GCP images disable root; without sshUser on meta every remote exec logs in wrong.
    expect(frame.meta?.sshUser).toBe('papercusp');
    expect(frame.meta?.zone).toBe('us-east1-b');
    // Addressed by NAME — every zonal Compute call takes the name, not the numeric id.
    expect(frame.id).toBe('papercusp-bench-rig');
  });

  it('polls until RUNNING with an external IP instead of returning a half-ready frame', async () => {
    const client = fakeClient({ statuses: ['PROVISIONING', 'STAGING', 'RUNNING'], ip: '203.0.113.11' });
    const driver = makeGcpDriver({ client, sleep: noSleep, pollIntervalMs: 0 });
    const frame = await driver.provision!(baseConfig(), ctx());
    expect(frame.host).toBe('203.0.113.11');
    expect(client.getCalls).toBeGreaterThan(1);
  });

  it('BILLING GUARD: refuses before creating anything when no ssh public key is supplied', async () => {
    const createInstance = vi.fn();
    const client = { ...fakeClient({}), createInstance } as unknown as GcpComputeApiClient;
    const driver = makeGcpDriver({ client, sleep: noSleep });
    await expect(
      driver.provision!(baseConfig({ provider: { projectId: 'p' } }), ctx()),
    ).rejects.toThrow(/sshPublicKey/);
    // The point of the guard: a keyless instance would boot, bill, and be unreachable.
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('fails fast on a terminal status rather than burning the whole poll timeout', async () => {
    const client = fakeClient({ statuses: ['TERMINATED'] });
    const driver = makeGcpDriver({ client, sleep: noSleep });
    await expect(driver.provision!(baseConfig(), ctx())).rejects.toThrow(/TERMINATED/);
  });
});

describe('GcpDriver.teardown — destroy-not-stuck', () => {
  it('re-issues DELETE until the instance is CONFIRMED gone (a 2xx is not a destroy)', async () => {
    // Instance lingers for two confirmation rounds after the first accepted DELETE.
    const client = fakeClient({ lingerAfterDelete: 2 });
    const driver = makeGcpDriver({ client, sleep: noSleep, pollIntervalMs: 0 });
    const frame = await driver.provision!(baseConfig(), ctx());
    await driver.teardown!(frame, baseConfig(), ctx());
    expect(client.deleteCalls).toBeGreaterThan(1);
  });

  it('treats an already-gone instance (404) as success, not an error', async () => {
    const client = {
      async createInstance() {
        return { id: '1', name: 'n', zone: 'us-east1-b', status: 'RUNNING', ipv4: '1.2.3.4' };
      },
      async getInstance() {
        throw new GcpApiError('not found', 404, undefined);
      },
      async deleteInstance() {
        throw new GcpApiError('not found', 404, undefined);
      },
    } as GcpComputeApiClient;
    const driver = makeGcpDriver({ client, sleep: noSleep });
    const frame = {
      id: 'gone',
      target: 'gcp',
      placement: 'remote' as const,
      region: 'us-east1-b',
      meta: { zone: 'us-east1-b' },
    };
    await expect(driver.teardown!(frame, baseConfig(), ctx())).resolves.toBeUndefined();
  });

  it('LOUDLY refuses a frame with no zone rather than silently leaving it billing', async () => {
    const client = fakeClient({});
    const driver = makeGcpDriver({ client, sleep: noSleep });
    const frame = { id: 'orphan', target: 'gcp', placement: 'remote' as const };
    await expect(driver.teardown!(frame, baseConfig(), ctx())).rejects.toThrow(/BILLING/);
    expect(client.deleteCalls).toBe(0);
  });

  it('gives up with a BILLING warning when the instance never disappears', async () => {
    // Never gone: getInstance always succeeds even after delete.
    const client = {
      async createInstance() {
        return { id: '1', name: 'stuck', zone: 'us-east1-b', status: 'RUNNING', ipv4: '1.2.3.4' };
      },
      async getInstance() {
        return { id: '1', name: 'stuck', zone: 'us-east1-b', status: 'RUNNING', ipv4: '1.2.3.4' };
      },
      async deleteInstance() {},
    } as GcpComputeApiClient;
    const driver = makeGcpDriver({ client, sleep: noSleep, teardownTimeoutMs: 0, pollIntervalMs: 0 });
    const frame = { id: 'stuck', target: 'gcp', placement: 'remote' as const, meta: { zone: 'us-east1-b' } };
    await expect(driver.teardown!(frame, baseConfig(), ctx())).rejects.toThrow(/BILLING/);
  });
});

describe('falsifiability control — a naive teardown that trusts the DELETE', () => {
  /**
   * Kept permanently as a deliberately-wrong implementation (never a mutation of
   * the real driver). If the destroy-not-stuck assertions above ever stop being
   * able to fail, this control stops failing too and the guard is revealed as
   * vacuous.
   */
  async function naiveTeardown(client: GcpComputeApiClient, zone: string, id: string): Promise<void> {
    await client.deleteInstance(zone, id); // trusts the 2xx — the actual bug class
  }

  it('the control does NOT confirm the destroy, which is exactly what the driver must not do', async () => {
    const client = fakeClient({ lingerAfterDelete: 2 });
    await naiveTeardown(client, 'us-east1-b', 'n');
    expect(client.deleteCalls).toBe(1); // one accepted DELETE, zero confirmation
    // and the instance is still there right after the "successful" teardown
    await expect(client.getInstance('us-east1-b', 'n')).resolves.toMatchObject({ status: 'STOPPING' });
  });
});
