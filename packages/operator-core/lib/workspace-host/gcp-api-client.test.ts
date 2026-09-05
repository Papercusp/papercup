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
  type GcpNatInsertInput,
  type GcpOperationRef,
  type GcpRouterInsertInput,
} from './gcp-provider';
import { censusGcpWorkspaceHostResources } from './gcp-safety';

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

  it('admits the explicit gcloud active-user chain and rejects arbitrary credential schemes', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/projects/${PROJECT}?fields=name`)) return json({ name: PROJECT });
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = makeClient(fetchImpl);

    await expect(
      client.validateConnection({
        ...connection(),
        cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.validateConnection({
        ...connection(),
        cloudCredentialRef: { kind: 'cloud', ref: 'env:GOOGLE_APPLICATION_CREDENTIALS' },
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('classifies local metadata and active-user resolver failures without exposing arbitrary errors', async () => {
    const acquireAuth = vi.fn(async () => ({ accessToken: TOKEN, projectId: PROJECT }));
    const fetchImpl = vi.fn(async () => json({ name: PROJECT })) as typeof fetch;
    const client = new GoogleComputeWorkspaceHostApiClient({ acquireAuth, fetch: fetchImpl, now: () => NOW });
    const missingProject: WorkspaceHostProviderConnection = {
      target: 'gcp',
      cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
      provider: {},
    };

    await expect(client.validateConnection(missingProject)).resolves.toMatchObject({
      ok: false,
      errors: ['GCP connection project is missing; reconnect with an explicit project.'],
    });
    expect(acquireAuth).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const tokenFailure = new GoogleComputeWorkspaceHostApiClient({
      acquireAuth: async () => {
        throw new Error('gcp_gcloud_active_user_token_unavailable');
      },
      fetch: fetchImpl,
      now: () => NOW,
    });
    await expect(tokenFailure.validateConnection(connection())).resolves.toMatchObject({
      ok: false,
      errors: ['GCP active-user credential resolution failed: an access token is unavailable.'],
    });

    const unknownFailure = new GoogleComputeWorkspaceHostApiClient({
      acquireAuth: async () => {
        throw new Error(`resolver stderr contained ${TOKEN}`);
      },
      fetch: fetchImpl,
      now: () => NOW,
    });
    const validation = await unknownFailure.validateConnection(connection());
    expect(validation).toMatchObject({
      ok: false,
      errors: [
        'GCP Compute API was unreachable or returned an unreadable response; the connection itself was not disproved.',
      ],
      // WI-1743793: an unclassified failure is transport-class, so it must stay retryable rather
      // than terminally failing the lifecycle action.
      retryable: true,
    });
    // Every credential-class failure this client raises carries a mapped code, so an unmapped error
    // must NEVER be reported as a credential fault — that sent an operator to audit a credential
    // that had driven three other operations to success minutes earlier.
    expect(validation.errors.join(' ')).not.toMatch(/credential/i);
    expect(JSON.stringify(validation)).not.toContain(TOKEN);
  });

  it('admits a hosted delegation only when the injected auth supplier is bound to its exact reference', async () => {
    const hostedRef = 'resolver://workspace-1/gcp/generation-2';
    const hostedConnection: WorkspaceHostProviderConnection = {
      ...connection(),
      cloudCredentialRef: { kind: 'cloud', ref: hostedRef },
      provider: { projectId: PROJECT, credentialSource: 'hosted-delegation', generation: 2 },
    };
    const fetchImpl = vi.fn(async () => json({ name: PROJECT })) as typeof fetch;
    const acquireAuth = vi.fn(async () => ({ accessToken: TOKEN, projectId: PROJECT, identity: 'delegated' }));

    await expect(
      new GoogleComputeWorkspaceHostApiClient({ acquireAuth, fetch: fetchImpl, now: () => NOW })
        .validateConnection(hostedConnection),
    ).resolves.toMatchObject({ ok: false });

    await expect(
      new GoogleComputeWorkspaceHostApiClient({
        acquireAuth,
        credentialRef: hostedRef,
        fetch: fetchImpl,
        now: () => NOW,
      }).validateConnection(hostedConnection),
    ).resolves.toMatchObject({ ok: true, identity: 'delegated' });
    expect(acquireAuth).toHaveBeenCalledTimes(1);
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

  it('reads the hostkeys guest-attribute namespace through the authenticated Compute endpoint', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(
        `/compute/v1/projects/${PROJECT}/zones/${ZONE}/instances/pc-host-vm/getGuestAttributes`,
      );
      expect(url.searchParams.get('queryPath')).toBe('hostkeys/');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      return json({
        queryPath: 'hostkeys/',
        queryValue: {
          items: [
            { namespace: 'hostkeys', key: 'ecdsa-sha2-nistp256', value: 'AAAA' },
            { namespace: 'hostkeys', key: 'ssh-ed25519', value: 'AAAA' },
          ],
        },
      });
    }) as typeof fetch;

    await expect(
      makeClient(fetchImpl).getInstanceGuestAttributes(PROJECT, ZONE, 'pc-host-vm', 'hostkeys/'),
    ).resolves.toEqual([
      { namespace: 'hostkeys', key: 'ecdsa-sha2-nistp256', value: 'AAAA' },
      { namespace: 'hostkeys', key: 'ssh-ed25519', value: 'AAAA' },
    ]);
  });

  it('fails closed when Compute returns a malformed guest-attribute item', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ queryValue: { items: [{ namespace: 'hostkeys', key: 'ssh-ed25519' }] } }),
    ) as typeof fetch;

    await expect(
      makeClient(fetchImpl).getInstanceGuestAttributes(PROJECT, ZONE, 'pc-host-vm', 'hostkeys/'),
    ).rejects.toThrow(/guest attribute value/);
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
      sourceSnapshot: `projects/${PROJECT}/global/snapshots/pc-host-source-q3`,
      sourceSnapshotEncryptionKey: {
        kmsKeyName: `projects/${PROJECT}/locations/${REGION}/keyRings/workspaces/cryptoKeys/snapshot-source`,
      },
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
    await client.setInstanceMetadata(
      PROJECT,
      ZONE,
      'pc-host-vm',
      { fingerprint: 'metadata-fingerprint-1', items: [{ key: 'startup-script', value: '#!/bin/bash\necho current' }] },
      REQUEST_ID,
    );
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
    expect(JSON.parse(String(diskCall.init?.body))).toMatchObject({
      type: `zones/${ZONE}/diskTypes/pd-ssd`,
      sourceSnapshot: `projects/${PROJECT}/global/snapshots/pc-host-source-q3`,
      sourceSnapshotEncryptionKey: {
        kmsKeyName: `projects/${PROJECT}/locations/${REGION}/keyRings/workspaces/cryptoKeys/snapshot-source`,
      },
    });
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
    const metadataCall = calls.find(({ url }) => url.includes('/setMetadata?'))!;
    expect(JSON.parse(String(metadataCall.init?.body))).toEqual({
      fingerprint: 'metadata-fingerprint-1',
      items: [{ key: 'startup-script', value: '#!/bin/bash\necho current' }],
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

  it('creates, reads, and deletes a dedicated regional Router/NAT with provider-read absence', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let router:
      | {
          name: string;
          network: string;
          region: string;
          fingerprint: string;
          nats: unknown[];
        }
      | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith(`/regions/${REGION}/routers/pc-host-router`)) {
        return router ? json(router) : json({ error: { message: 'not found' } }, 404);
      }
      if (url.includes(`/regions/${REGION}/routers?`)) {
        const body = JSON.parse(String(init?.body)) as typeof router;
        router = { ...body!, fingerprint: 'fp-1', nats: [] };
        return json({ name: 'insert-router-op', status: 'PENDING', region: `projects/${PROJECT}/regions/${REGION}` });
      }
      if (url.includes(`/regions/${REGION}/routers/pc-host-router?`) && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as NonNullable<typeof router>;
        router = { ...body, fingerprint: 'fp-2' };
        return json({ name: 'patch-router-op', status: 'PENDING', region: `projects/${PROJECT}/regions/${REGION}` });
      }
      if (url.includes(`/regions/${REGION}/routers/pc-host-router?`) && init?.method === 'DELETE') {
        router = undefined;
        return json({ name: 'delete-router-op', status: 'PENDING', region: `projects/${PROJECT}/regions/${REGION}` });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const routerInput: GcpRouterInsertInput = {
      name: 'pc-host-router',
      network: 'pc-host-net',
      region: REGION,
    };
    const natInput: GcpNatInsertInput = {
      name: 'pc-host-nat',
      routerName: 'pc-host-router',
      network: 'pc-host-net',
      subnetwork: 'pc-host-subnet',
      region: REGION,
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
      minPortsPerVm: 64,
      enableEndpointIndependentMapping: false,
    };

    await client.insertRouter(PROJECT, REGION, routerInput, REQUEST_ID);
    await expect(client.getRouter(PROJECT, REGION, routerInput.name)).resolves.toMatchObject({
      name: routerInput.name,
      network: 'pc-host-net',
      region: REGION,
      natNames: [],
    });
    await client.insertNat(PROJECT, REGION, natInput, REQUEST_ID);
    await expect(client.getNat(PROJECT, REGION, routerInput.name, natInput.name)).resolves.toMatchObject({
      name: natInput.name,
      routerName: routerInput.name,
      subnetwork: 'pc-host-subnet',
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
    });
    await client.deleteNat(PROJECT, REGION, routerInput.name, natInput.name, REQUEST_ID);
    await expect(client.getNat(PROJECT, REGION, routerInput.name, natInput.name)).resolves.toBeUndefined();
    await client.deleteRouter(PROJECT, REGION, routerInput.name, REQUEST_ID);
    await expect(client.getRouter(PROJECT, REGION, routerInput.name)).resolves.toBeUndefined();

    const natPatch = calls.find(
      ({ url, init }) => url.includes('/routers/pc-host-router?') && init?.method === 'PATCH',
    )!;
    expect(JSON.parse(String(natPatch.init?.body))).toMatchObject({
      network: 'global/networks/pc-host-net',
      nats: [
        {
          name: 'pc-host-nat',
          natIpAllocateOption: 'AUTO_ONLY',
          sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
          minPortsPerVm: 64,
          enableEndpointIndependentMapping: false,
          subnetworks: [
            {
              name: `regions/${REGION}/subnetworks/pc-host-subnet`,
              sourceIpRangesToNat: ['ALL_IP_RANGES'],
            },
          ],
        },
      ],
    });
    expect(
      calls.filter(({ url, init }) => url.includes('/routers/pc-host-router?') && init?.method === 'PATCH'),
    ).toHaveLength(2);
  });

  it('collects non-vacuous all-kind inventory evidence for the orphan census', async () => {
    const managedLabels = {
      'papercusp-managed': 'true',
      'papercusp-host-id': 'host-gcp-live-client',
      'papercusp-workspace-id': 'workspace-1',
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/aggregated/instances?')) {
        return json({ items: { [`zones/${ZONE}`]: { instances: [{ name: 'pc-host-vm', labels: managedLabels }] } } });
      }
      if (url.includes('/aggregated/disks?')) {
        return json({ items: { [`zones/${ZONE}`]: { disks: [{ name: 'pc-host-data', labels: managedLabels }] } } });
      }
      if (url.includes('/global/snapshots?'))
        return json({ items: [{ name: 'pc-host-snapshot', labels: managedLabels }] });
      if (url.endsWith('/global/networks/pc-host-net')) return json({ name: 'pc-host-net' });
      if (url.endsWith(`/regions/${REGION}/subnetworks/pc-host-subnet`)) return json({ name: 'pc-host-subnet' });
      if (url.endsWith('/global/firewalls/pc-host-iap')) {
        return json({
          name: 'pc-host-iap',
          direction: 'INGRESS',
          sourceRanges: ['35.235.240.0/20'],
          targetTags: ['pc-host'],
          allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
        });
      }
      if (url.endsWith(`/regions/${REGION}/routers/pc-host-router`)) {
        return json({
          name: 'pc-host-router',
          network: 'global/networks/pc-host-net',
          region: `regions/${REGION}`,
          nats: [
            {
              name: 'pc-host-nat',
              natIpAllocateOption: 'AUTO_ONLY',
              sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
              minPortsPerVm: 64,
              enableEndpointIndependentMapping: false,
              subnetworks: [
                { name: `regions/${REGION}/subnetworks/pc-host-subnet`, sourceIpRangesToNat: ['ALL_IP_RANGES'] },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const inventory = await client.inventoryManagedResources({
      projectId: PROJECT,
      region: REGION,
      workspaceId: 'workspace-1',
      deterministicNames: {
        networks: ['pc-host-net'],
        subnetworks: ['pc-host-subnet'],
        firewalls: ['pc-host-iap'],
        routers: ['pc-host-router'],
        nats: [{ routerName: 'pc-host-router', name: 'pc-host-nat' }],
      },
    });

    expect(inventory.complete).toBe(true);
    expect(inventory.inventoryEvidence.map(({ kind }) => kind)).toEqual([
      'vm',
      'disk',
      'firewall',
      'subnetwork',
      'network',
      'snapshot',
      'router',
      'nat',
    ]);
    expect(inventory.observed.map(({ resource }) => resource.kind).sort()).toEqual(
      ['vm', 'disk', 'snapshot', 'network', 'subnetwork', 'firewall', 'router', 'nat'].sort(),
    );
    expect(
      censusGcpWorkspaceHostResources({
        hostId: 'host-gcp-live-client',
        workspaceId: 'workspace-1',
        expected: inventory.observed.map(({ resource }) => resource),
        observed: inventory.observed,
        inventoryEvidence: inventory.inventoryEvidence,
        evaluatedAt: NOW,
        orphanGraceMs: 60_000,
      }),
    ).toMatchObject({ inventoryComplete: true, clean: true, untracked: [], missing: [], labelMismatches: [] });
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

describe('boot disk sizing against the source image', () => {
  function bootInstance(diskSizeGb: number): GcpInstanceInsertInput {
    return {
      name: 'pc-host-vm',
      zone: ZONE,
      machineType: 'n2-standard-2',
      labels: { 'papercusp-managed': 'true' },
      tags: { items: ['pc-host'] },
      networkInterfaces: [{ network: 'pc-host-net', subnetwork: 'pc-host-subnet', stackType: 'IPV4_ONLY' }],
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18-r18`,
            diskSizeGb,
            diskType: 'pd-balanced',
          },
        },
        { boot: false, autoDelete: false, source: 'pc-host-data', deviceName: 'papercusp-data', mode: 'READ_WRITE' },
      ],
      serviceAccounts: [{ email: `workspace-host@${PROJECT}.iam.gserviceaccount.com`, scopes: [] }],
      metadata: { items: [] },
    };
  }

  /** Records the POSTed instance body while answering the image lookup with `imageDiskSizeGb`. */
  function harness(imageDiskSizeGb: string | undefined) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/global/images/')) {
        return imageDiskSizeGb === undefined
          ? json({ error: { message: 'not found' } }, 404)
          : json({ name: 'papercusp-workspace-host-0-0-18-r18', diskSizeGb: imageDiskSizeGb });
      }
      return json({ name: 'operation-1', status: 'PENDING', zone: `projects/${PROJECT}/zones/${ZONE}` });
    }) as typeof fetch;
    const body = () => JSON.parse(String(calls.find(({ url }) => url.includes('/instances?'))!.init?.body));
    return { client: makeClient(fetchImpl), body };
  }

  // The failure this exists to prevent: bootDiskGiB defaults to 30 while the shipped
  // workspace-host image is 32 GB, so GCP rejected every default-config provision with
  // "Requested disk size cannot be smaller than the image size (32 GB)".
  it('raises a boot disk that is smaller than its source image up to the image size', async () => {
    const { client, body } = harness('32');

    await client.insertInstance(PROJECT, ZONE, bootInstance(30), REQUEST_ID);

    expect(body().disks[0].initializeParams.diskSizeGb).toBe(32);
  });

  it('never shrinks a boot disk the caller deliberately sized larger than the image', async () => {
    const { client, body } = harness('32');

    await client.insertInstance(PROJECT, ZONE, bootInstance(100), REQUEST_ID);

    expect(body().disks[0].initializeParams.diskSizeGb).toBe(100);
  });

  it('falls back to the requested size when the image cannot be read', async () => {
    const { client, body } = harness(undefined);

    await client.insertInstance(PROJECT, ZONE, bootInstance(30), REQUEST_ID);

    expect(body().disks[0].initializeParams.diskSizeGb).toBe(30);
  });
});
