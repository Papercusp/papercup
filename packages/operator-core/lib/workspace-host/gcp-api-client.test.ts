import type {
  WorkspaceHostDesiredSpec,
  WorkspaceHostProviderConnection,
  WorkspaceHostProviderContext,
} from '@papercusp/deployment-driver';
import { describe, expect, it, vi } from 'vitest';
import { GoogleComputeWorkspaceHostApiClient } from './gcp-api-client';
import {
  createAdcGcpWorkspaceHostProvider,
  type GcpDiskInsertInput,
  type GcpInstanceInsertInput,
  type GcpOperationRef,
} from './gcp-provider';

const PROJECT = 'active-alcove-504205-q3';
const ZONE = 'us-central1-a';
const REGION = 'us-central1';
const TOKEN = 'ya29.must-never-escape';
const NOW = '2026-08-22T07:30:00.000Z';
const REQUEST_ID = '5c4b3b5e-80f8-55f2-9499-8b52e1efce24';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function connection(): WorkspaceHostProviderConnection {
  return {
    target: 'gcp',
    cloudCredentialRef: { kind: 'cloud', ref: 'adc://authorized_user' },
    scope: { kind: 'project', id: PROJECT },
    provider: { projectId: PROJECT, credentialSource: 'adc' },
  };
}

function makeClient(fetchImpl: typeof fetch): GoogleComputeWorkspaceHostApiClient {
  return new GoogleComputeWorkspaceHostApiClient({
    acquireAuth: vi.fn(async () => ({ accessToken: TOKEN, projectId: PROJECT, identity: 'operator@example.com' })),
    fetch: fetchImpl,
    now: () => NOW,
  });
}

function desired(): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-gcp-live-client',
    target: 'gcp',
    scope: { kind: 'project', id: PROJECT },
    region: REGION,
    zone: ZONE,
    size: 'n2-standard-2',
    image: { id: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-test' },
    data: { volumeGiB: 120, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://authorized_user' } },
  };
}

describe('ADC-backed GCP workspace-host API client', () => {
  it('validates an ADC connection and maps bounded project catalogs without returning credential material', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/projects/${PROJECT}?fields=name`)) return json({ name: PROJECT });
      if (url.includes('/regions?')) return json({ items: [{ name: REGION, status: 'UP' }] });
      if (url.includes('/zones?')) {
        return json({ items: [{ name: ZONE, status: 'UP', region: `projects/${PROJECT}/regions/${REGION}` }] });
      }
      if (url.includes('/aggregated/machineTypes?')) {
        return json({
          items: {
            [`zones/${ZONE}`]: {
              machineTypes: [{ name: 'n2-standard-2', guestCpus: 2, memoryMb: 8192 }],
            },
            'zones/europe-west1-b': {
              machineTypes: [{ name: 'n2-standard-2', guestCpus: 2, memoryMb: 8192 }],
            },
          },
        });
      }
      if (url.includes('/global/images/family/ubuntu-2404-lts-amd64')) {
        return json({
          name: 'ubuntu-2404-noble-amd64-v20260801',
          selfLink: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260801',
          architecture: 'X86_64',
          creationTimestamp: '2026-08-01T00:00:00.000Z',
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = makeClient(fetchImpl);

    const validation = await client.validateConnection(connection());
    const scopes = await client.listScopes(connection());
    const regions = await client.listRegions({ scope: { kind: 'project', id: PROJECT } }, connection());
    const sizes = await client.listSizes({ scope: { kind: 'project', id: PROJECT }, region: REGION }, connection());
    const images = await client.listImages(
      { scope: { kind: 'project', id: PROJECT }, architecture: 'x86_64' },
      connection(),
    );
    const estimate = await client.estimatePrice(desired(), connection());

    expect(validation).toMatchObject({ ok: true, identity: 'operator@example.com' });
    expect(scopes).toEqual([{ kind: 'project', id: PROJECT, label: PROJECT }]);
    expect(regions).toEqual([{ id: REGION, label: REGION, available: true, zones: [ZONE] }]);
    expect(sizes).toEqual([
      { id: 'n2-standard-2', label: 'n2-standard-2', cpuCount: 2, memoryMiB: 8192, available: true },
    ]);
    expect(images[0]).toMatchObject({
      id: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260801',
      version: 'ubuntu-2404-noble-amd64-v20260801',
      architecture: 'x86_64',
      signed: true,
    });
    expect(images[0]?.id).not.toContain('/images/family/');
    expect(estimate).toMatchObject({ currency: 'USD', hourlyAmount: 0, confidence: 'unknown' });
    expect(JSON.stringify({ validation, scopes, regions, sizes, images, estimate })).not.toContain(TOKEN);
    for (const [, init] of vi.mocked(fetchImpl).mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('resolves a configured Papercusp family but exposes only its immutable member to consumers', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain(`/projects/${PROJECT}/global/images/family/papercusp-workspace-host`);
      return json({
        name: 'papercusp-workspace-host-2026-8-23-1',
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${PROJECT}/global/images/` +
          'papercusp-workspace-host-2026-8-23-1',
        architecture: 'X86_64',
        creationTimestamp: '2026-08-23T01:00:00.000Z',
      });
    }) as typeof fetch;
    const client = new GoogleComputeWorkspaceHostApiClient({
      acquireAuth: vi.fn(async () => ({
        accessToken: TOKEN,
        projectId: PROJECT,
        identity: 'operator@example.com',
      })),
      fetch: fetchImpl,
      now: () => NOW,
      imageFamily: { project: PROJECT, family: 'papercusp-workspace-host', label: 'Papercusp workspace host' },
    });

    await expect(
      client.listImages({ scope: { kind: 'project', id: PROJECT }, architecture: 'x86_64' }, connection()),
    ).resolves.toEqual([
      {
        id: `projects/${PROJECT}/global/images/papercusp-workspace-host-2026-8-23-1`,
        version: 'papercusp-workspace-host-2026-8-23-1',
        label: 'Papercusp workspace host',
        architecture: 'x86_64',
        signed: true,
        publishedAt: '2026-08-23T01:00:00.000Z',
      },
    ]);
  });

  it('maps resource observations, rebuilds a secret-free recreate input, and treats only HTTP 404 as absence', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/global/networks/missing')) return json({ error: { message: TOKEN } }, 404);
      if (url.endsWith(`/zones/${ZONE}/instances/pc-host-vm`)) {
        return json({
          name: 'pc-host-vm',
          selfLink: `projects/${PROJECT}/zones/${ZONE}/instances/pc-host-vm`,
          status: 'RUNNING',
          machineType: `zones/${ZONE}/machineTypes/n2-standard-2`,
          labels: { 'papercusp-managed': 'true', 'papercusp-host-id': 'host-gcp-live-client' },
          tags: { items: ['pc-host'] },
          networkInterfaces: [
            {
              network: 'global/networks/pc-host-net',
              subnetwork: `regions/${REGION}/subnetworks/pc-host-subnet`,
              stackType: 'IPV4_ONLY',
              networkIP: '10.132.12.2',
              accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT', natIP: '203.0.113.42' }],
            },
          ],
          disks: [
            { boot: true, autoDelete: true, source: `zones/${ZONE}/disks/pc-host-boot` },
            {
              boot: false,
              autoDelete: false,
              source: `zones/${ZONE}/disks/pc-host-data`,
              deviceName: 'papercusp-data',
              mode: 'READ_WRITE',
            },
          ],
          serviceAccounts: [
            {
              email: `workspace-host@${PROJECT}.iam.gserviceaccount.com`,
              scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            },
          ],
          metadata: { items: [{ key: 'enable-oslogin', value: 'TRUE' }] },
        });
      }
      if (url.endsWith(`/zones/${ZONE}/disks/pc-host-boot`)) {
        return json({
          name: 'pc-host-boot',
          status: 'READY',
          sizeGb: '40',
          type: `zones/${ZONE}/diskTypes/pd-balanced`,
          sourceImage: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-test',
          diskEncryptionKey: {
            kmsKeyName: `projects/${PROJECT}/locations/${REGION}/keyRings/workspaces/cryptoKeys/disk`,
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = makeClient(fetchImpl);

    await expect(client.getNetwork(PROJECT, 'missing')).resolves.toBeUndefined();
    const instance = await client.getInstance(PROJECT, ZONE, 'pc-host-vm');

    expect(instance).toMatchObject({
      name: 'pc-host-vm',
      status: 'RUNNING',
      attachedDiskNames: ['pc-host-boot', 'pc-host-data'],
      internalIp: '10.132.12.2',
      externalIp: '203.0.113.42',
      sourceImage: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-test',
      recreateInput: {
        machineType: `zones/${ZONE}/machineTypes/n2-standard-2`,
        disks: [
          {
            initializeParams: {
              diskSizeGb: 40,
              diskType: `zones/${ZONE}/diskTypes/pd-balanced`,
            },
          },
          { source: `zones/${ZONE}/disks/pc-host-data`, deviceName: 'papercusp-data' },
        ],
      },
    });
    expect(instance).not.toHaveProperty('agentOnline');
    expect(JSON.stringify(instance)).not.toContain(TOKEN);
  });

  it('uses scoped Compute endpoints, normalizes resource references, and retains durable operation coordinates', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/wait')) {
        return json({
          name: 'operation-1',
          status: 'DONE',
          zone: `projects/${PROJECT}/zones/${ZONE}`,
          error: { errors: [{ code: 'QUOTA_EXCEEDED', message: `provider detail ${TOKEN}` }] },
        });
      }
      const zone = url.includes(`/zones/${ZONE}/`) ? `projects/${PROJECT}/zones/${ZONE}` : undefined;
      const region = url.includes(`/regions/${REGION}/`) ? `projects/${PROJECT}/regions/${REGION}` : undefined;
      return json({ name: `operation-${calls.length}`, status: 'PENDING', zone, region });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const disk: GcpDiskInsertInput = {
      name: 'pc-host-data',
      zone: ZONE,
      sizeGb: 120,
      type: 'pd-ssd',
      labels: { 'papercusp-managed': 'true' },
    };
    const instance: GcpInstanceInsertInput = {
      name: 'pc-host-vm',
      zone: ZONE,
      machineType: 'n2-standard-2',
      labels: { 'papercusp-managed': 'true' },
      tags: { items: ['pc-host'] },
      networkInterfaces: [
        {
          network: 'pc-host-net',
          subnetwork: 'pc-host-subnet',
          stackType: 'IPV4_ONLY',
        },
      ],
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-test',
            diskSizeGb: 40,
            diskType: 'pd-balanced',
          },
        },
        {
          boot: false,
          autoDelete: false,
          source: 'pc-host-data',
          deviceName: 'papercusp-data',
          mode: 'READ_WRITE',
        },
      ],
      serviceAccounts: [
        {
          email: `workspace-host@${PROJECT}.iam.gserviceaccount.com`,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        },
      ],
      metadata: { items: [{ key: 'enable-oslogin', value: 'TRUE' }] },
    };

    const diskOperation = await client.insertDisk(PROJECT, ZONE, disk, REQUEST_ID);
    await client.insertSubnetwork(
      PROJECT,
      REGION,
      {
        name: 'pc-host-subnet',
        network: 'pc-host-net',
        ipCidrRange: '10.132.12.0/24',
        region: REGION,
        privateIpGoogleAccess: true,
        stackType: 'IPV4_ONLY',
      },
      REQUEST_ID,
    );
    await client.insertInstance(PROJECT, ZONE, instance, REQUEST_ID);
    await client.createSnapshot(
      PROJECT,
      ZONE,
      { name: 'pc-host-snapshot', sourceDisk: 'pc-host-data', labels: { 'papercusp-host-id': 'host-1' } },
      REQUEST_ID,
    );
    const observed = await client.waitForOperation(
      { name: 'operation-1', projectId: PROJECT, scope: 'zone', location: ZONE, requestId: REQUEST_ID },
      undefined,
    );

    expect(diskOperation).toMatchObject({ projectId: PROJECT, scope: 'zone', location: ZONE, requestId: REQUEST_ID });
    const diskCall = calls.find(({ url }) => url.includes(`/zones/${ZONE}/disks?`))!;
    expect(JSON.parse(String(diskCall.init?.body))).toMatchObject({ type: `zones/${ZONE}/diskTypes/pd-ssd` });
    expect(JSON.parse(String(diskCall.init?.body))).not.toHaveProperty('zone');
    const subnetCall = calls.find(({ url }) => url.includes('/subnetworks?'))!;
    expect(JSON.parse(String(subnetCall.init?.body))).toMatchObject({ network: 'global/networks/pc-host-net' });
    expect(JSON.parse(String(subnetCall.init?.body))).not.toHaveProperty('region');
    const instanceCall = calls.find(({ url }) => url.includes(`/instances?`))!;
    expect(JSON.parse(String(instanceCall.init?.body))).toMatchObject({
      machineType: `zones/${ZONE}/machineTypes/n2-standard-2`,
      networkInterfaces: [
        {
          network: 'global/networks/pc-host-net',
          subnetwork: `regions/${REGION}/subnetworks/pc-host-subnet`,
        },
      ],
      disks: [
        { initializeParams: { diskType: `zones/${ZONE}/diskTypes/pd-balanced` } },
        { source: `zones/${ZONE}/disks/pc-host-data` },
      ],
    });
    const snapshotCall = calls.find(({ url }) => url.includes('/createSnapshot?'))!;
    expect(snapshotCall.url).toContain(`/zones/${ZONE}/disks/pc-host-data/createSnapshot`);
    expect(JSON.parse(String(snapshotCall.init?.body))).toEqual({
      name: 'pc-host-snapshot',
      labels: { 'papercusp-host-id': 'host-1' },
    });
    expect(observed).toMatchObject({
      projectId: PROJECT,
      scope: 'zone',
      location: ZONE,
      status: 'DONE',
      error: { code: 'QUOTA_EXCEEDED', message: 'GCP operation failed (QUOTA_EXCEEDED)' },
    });
    expect(JSON.stringify(observed)).not.toContain(TOKEN);
  });

  it('wires the explicit ADC production composition without changing injected-client fail-closed construction', async () => {
    const fetchImpl = vi.fn(async () => json({ name: PROJECT })) as typeof fetch;
    const provider = createAdcGcpWorkspaceHostProvider({
      acquireAuth: async () => ({ accessToken: TOKEN, projectId: PROJECT, identity: 'operator@example.com' }),
      fetch: fetchImpl,
      now: () => NOW,
    });
    const context: WorkspaceHostProviderContext = {
      workspaceId: 'workspace-1',
      requestId: 'request-1',
      connection: connection(),
    };

    await expect(provider.validateConnection(context)).resolves.toMatchObject({ ok: true });
    expect(JSON.stringify(await provider.validateConnection(context))).not.toContain(TOKEN);
  });
});
