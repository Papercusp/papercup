import { describe, expect, it, vi } from 'vitest';

import {
  applyWorkspaceHostMigration,
  buildWorkspaceHostMigrationBundle,
  negotiateWorkspaceHostMigrationProtocols,
  planWorkspaceHostMigration,
  rollbackWorkspaceHostMigration,
  type WorkspaceHostManagementMode,
  type WorkspaceHostMigrationPort,
  type WorkspaceHostProtocolManifest,
} from './migration-coordinator';

const protocols: WorkspaceHostProtocolManifest = {
  psu: { minVersion: 1, maxVersion: 3 },
  desktop: { minVersion: 2, maxVersion: 4 },
  host: { minVersion: 2, maxVersion: 3 },
  control: { minVersion: 1, maxVersion: 2 },
};

function bundle() {
  return buildWorkspaceHostMigrationBundle({
    exportedAt: '2026-08-28T00:00:00Z',
    sourceWorkspaceId: 'local-control',
    directory: [{ id: 'workspace-1', name: 'Acme workspace', createdAt: '2026-08-22T00:00:00Z' }],
    connections: [
      {
        id: 'gcp:production',
        label: 'Production GCP',
        target: 'gcp',
        credentialRef: 'adc://default',
        scope: { kind: 'project', id: 'paper-prod' },
        provider: {
          projectId: 'paper-prod',
          serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
        },
        profile: {
          transportKind: 'gcp-iap-ssh',
          providerResourceId: 'projects/paper-prod/zones/us-central1-a/instances/host-1',
          region: 'us-central1',
          remoteOperatorPort: 3070,
        },
      },
    ],
    hosts: [
      {
        id: 'host-1',
        name: 'Acme host',
        connectionId: 'gcp:production',
        target: 'gcp',
        providerResourceId: 'projects/paper-prod/zones/us-central1-a/instances/host-1',
        connector: { routeLabel: 'acme', transport: 'websocket' },
      },
    ],
    protocols,
  });
}

function harness(options: { hostedFailure?: Error } = {}) {
  const directory: unknown[] = [];
  const connections: unknown[] = [];
  const hosts: unknown[] = [];
  const modes: WorkspaceHostManagementMode[] = [];
  const verifyLocal = vi.fn(async () => {});
  const port: WorkspaceHostMigrationPort = {
    async transaction(run) {
      return await run({
        async upsertDirectory(entry) {
          directory.push(entry);
        },
        async upsertConnection(connection) {
          connections.push(connection);
        },
        async pairHost(host) {
          hosts.push(host);
        },
        async setManagementMode(mode) {
          modes.push(mode);
        },
      });
    },
    async verifyHosted() {
      if (options.hostedFailure) throw options.hostedFailure;
    },
    verifyLocal,
  };
  return { port, directory, connections, hosts, modes, verifyLocal };
}

describe('workspace-host migration bundle', () => {
  it('exports only a resolver scheme and requires destination-side credential rebinding', () => {
    const exported = bundle();
    expect(exported.connections[0]).toMatchObject({
      credentialBinding: { kind: 'rebind-required', resolverScheme: 'adc' },
    });
    expect(JSON.stringify(exported)).not.toContain('adc://default');
    expect(exported.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects secret-shaped provider metadata instead of laundering it into an export', () => {
    expect(() =>
      buildWorkspaceHostMigrationBundle({
        exportedAt: '2026-08-28T00:00:00Z',
        sourceWorkspaceId: 'local-control',
        directory: [],
        connections: [
          {
            id: 'gcp:bad',
            label: 'Bad',
            target: 'gcp',
            credentialRef: 'adc://default',
            scope: { kind: 'project', id: 'paper-prod' },
            provider: { accessToken: 'must-not-leave' },
          },
        ],
        hosts: [],
        protocols,
      }),
    ).toThrow(/Secret-shaped field/);
  });
});

describe('workspace-host protocol compatibility', () => {
  it('negotiates psu, desktop, host, and control independently and avoids staged deprecations', () => {
    const result = negotiateWorkspaceHostMigrationProtocols(protocols, {
      psu: { minVersion: 2, maxVersion: 5, deprecatedVersions: [3] },
      desktop: { minVersion: 1, maxVersion: 3 },
      host: { minVersion: 1, maxVersion: 2 },
      control: { minVersion: 2, maxVersion: 4 },
    });
    expect(result.selected).toEqual({ psu: 2, desktop: 3, host: 2, control: 2 });
    expect(result.warnings).toEqual([]);
  });

  it('warns during a deprecation window, then rejects once its removal date passes', () => {
    const target: WorkspaceHostProtocolManifest = {
      ...protocols,
      control: {
        minVersion: 2,
        maxVersion: 2,
        deprecatedVersions: [2],
        removeDeprecatedAfter: '2026-09-01T00:00:00Z',
      },
    };
    expect(negotiateWorkspaceHostMigrationProtocols(protocols, target, new Date('2026-08-28T00:00:00Z')).warnings)
      .toEqual(['control protocol v2 is deprecated; upgrade before staged removal']);
    expect(() => negotiateWorkspaceHostMigrationProtocols(protocols, target, new Date('2026-09-02T00:00:00Z')))
      .toThrow('removed deprecated versions');
  });
});

describe('workspace-host hosted cutover and rollback', () => {
  it('imports the workspace directory/profiles, pairs the existing connector, and cuts over through dual mode', async () => {
    const exported = bundle();
    const H = harness();
    const receipt = await applyWorkspaceHostMigration(exported, protocols, H.port);
    expect(H.directory).toEqual(exported.directory);
    expect(H.connections).toEqual(exported.connections);
    expect(H.hosts).toEqual(exported.hosts);
    expect(H.modes).toEqual(['dual', 'hosted']);
    expect(receipt).toMatchObject({
      previousMode: 'local',
      mode: 'hosted',
      pairedHostIds: ['host-1'],
      protocols: { psu: 3, desktop: 4, host: 3, control: 2 },
    });
    expect(planWorkspaceHostMigration(exported, protocols).rollback).toEqual([
      'disable-hosted-routing',
      'restore-local-profiles',
      'verify-local-control',
    ]);

    await rollbackWorkspaceHostMigration(exported, receipt, H.port);
    expect(H.modes).toEqual(['dual', 'hosted', 'local']);
    expect(H.verifyLocal).toHaveBeenCalledWith(exported.digest);
  });

  it('automatically returns to verified local management when hosted verification fails', async () => {
    const exported = bundle();
    const H = harness({ hostedFailure: new Error('connector heartbeat missing') });
    await expect(applyWorkspaceHostMigration(exported, protocols, H.port)).rejects.toThrow(
      'connector heartbeat missing',
    );
    expect(H.modes).toEqual(['dual', 'local']);
    expect(H.verifyLocal).toHaveBeenCalledWith(exported.digest);
  });
});
