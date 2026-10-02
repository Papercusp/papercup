/**
 * standing-health-store.integration.test.ts — which hosts the standing health pass probes,
 * against REAL Postgres exercising REAL (forced) RLS (WI-10004950).
 *
 * Why this is an integration test and not a unit test with a fake store:
 *
 * 1. FORCED RLS. `workspace_hosts` FORCES row-level security, so a cross-workspace read through the
 *    RLS-subject app role returns ZERO rows — no error, just an empty list that reads exactly like
 *    "no live hosts". The pass would then probe nothing, forever, silently. Only a real policy can
 *    show the admin-pool read sees every workspace while the app role sees none.
 *
 * 2. THE FILTER IS THE AUTHORITY RULE. Only hosts stamped with THIS controller's id, meant to be up,
 *    on a target with standing seams, with a recorded spec, may be probed. Each exclusion here is a
 *    host that would otherwise cost an IAP reach or be attested by a controller that does not own it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    }),
}));
// The store fans sync invalidations on some writes; that transport is not under test here.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: () => {} }));

const { recordWorkspaceHostHealth, upsertWorkspaceHost } = await import('./observability-store');
const { listWorkspaceHostSpotReclaimTargets, listWorkspaceHostStandingHealthTargets } = await import(
  './standing-health-store'
);
const { createOrgTestDb } = await import('../../test/_org-test-db');

const suffix = randomBytes(3).toString('hex');
const MINE = `papercusp-workspace-host-controller:standing-${suffix}`;
const OTHER = `papercusp-workspace-host-controller:other-${suffix}`;
const WS_A = `shs_a_${suffix}`;
const WS_B = `shs_b_${suffix}`;

function spec(hostId: string, provisioningModel?: 'spot' | 'standard'): WorkspaceHostDesiredSpec {
  return {
    hostId,
    target: 'gcp',
    scope: { kind: 'project', id: 'active-alcove-504205-q3' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-standard-4',
    image: { id: 'projects/p/global/images/papercusp-host-v1' },
    data: { volumeGiB: 64, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' } },
    // The GCP provider block, where a spot host records its model (gcp-provider.ts).
    ...(provisioningModel ? { provider: { projectId: 'active-alcove-504205-q3', provisioningModel } } : {}),
  } as WorkspaceHostDesiredSpec;
}

describe('listWorkspaceHostStandingHealthTargets (real PG + forced RLS)', () => {
  let db: OrgTestDb;

  async function seedConnection(workspaceId: string): Promise<string> {
    const connectionId = `conn_${randomBytes(3).toString('hex')}`;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_connections (workspace_id, id, target, label, credential_ref)
      VALUES (${workspaceId}, ${connectionId}, 'gcp', 'test connection', 'cloudCredentialRef:test')
    `;
    return connectionId;
  }

  async function seedHost(input: {
    workspaceId: string;
    connectionId: string;
    id: string;
    controllerId: string;
    desiredState: string;
    withSpec?: boolean;
    provisioningModel?: 'spot' | 'standard';
  }): Promise<void> {
    await upsertWorkspaceHost({
      workspaceId: input.workspaceId,
      id: input.id,
      name: input.id,
      connectionId: input.connectionId,
      target: 'gcp',
      scopeLabel: 'test-project',
      region: 'us-central1',
      size: 'e2-standard-4',
      image: 'papercusp-host-v1',
      diskGiB: 64,
      network: 'default',
      desiredState: input.desiredState,
      observedState: input.desiredState,
      controllerAuthority: { controllerId: input.controllerId, fence: 1 },
      ...(input.withSpec === false ? {} : { desiredSpec: spec(input.id, input.provisioningModel) }),
    });
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    const connA = await seedConnection(WS_A);
    const connB = await seedConnection(WS_B);
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-running', controllerId: MINE, desiredState: 'running' });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-stopped', controllerId: MINE, desiredState: 'stopped' });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-repairing', controllerId: MINE, desiredState: 'repairing' });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-absent', controllerId: MINE, desiredState: 'absent' });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-other-controller', controllerId: OTHER, desiredState: 'running' });
    await seedHost({
      workspaceId: WS_A,
      connectionId: connA,
      id: 'a-no-spec',
      controllerId: MINE,
      desiredState: 'running',
      withSpec: false,
    });
    await seedHost({ workspaceId: WS_B, connectionId: connB, id: 'b-degraded', controllerId: MINE, desiredState: 'degraded' });
    // Spot hosts (WI-10005210): the reclaim sweep's population, and still standing-health targets.
    const spot = { provisioningModel: 'spot' as const };
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-spot', controllerId: MINE, desiredState: 'running', ...spot });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-spot-stopped', controllerId: MINE, desiredState: 'stopped', ...spot });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-spot-other', controllerId: OTHER, desiredState: 'running', ...spot });
    await seedHost({
      workspaceId: WS_A,
      connectionId: connA,
      id: 'a-standard',
      controllerId: MINE,
      desiredState: 'running',
      provisioningModel: 'standard',
    });
    await seedHost({ workspaceId: WS_B, connectionId: connB, id: 'b-spot-degraded', controllerId: MINE, desiredState: 'degraded', ...spot });
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('lists exactly the live, spec-bearing hosts this controller owns, across workspaces', async () => {
    const targets = await listWorkspaceHostStandingHealthTargets(MINE, db.adminSql);
    expect(targets).toEqual([
      { workspaceId: WS_A, hostId: 'a-running', healthAttestedAt: null },
      { workspaceId: WS_A, hostId: 'a-spot', healthAttestedAt: null },
      { workspaceId: WS_A, hostId: 'a-standard', healthAttestedAt: null },
      { workspaceId: WS_B, hostId: 'b-degraded', healthAttestedAt: null },
      { workspaceId: WS_B, hostId: 'b-spot-degraded', healthAttestedAt: null },
    ]);
  });

  it('the spot-reclaim sweep lists only the live SPOT hosts this controller owns (absent or standard model excluded)', async () => {
    expect(await listWorkspaceHostSpotReclaimTargets(MINE, db.adminSql)).toEqual([
      { workspaceId: WS_A, hostId: 'a-spot' },
      { workspaceId: WS_B, hostId: 'b-spot-degraded' },
    ]);
    // Positive control: the same rows are invisible to the RLS-subject role, so the admin pool is load-bearing.
    expect(await listWorkspaceHostSpotReclaimTargets(MINE, db.appSql)).toEqual([]);
  });

  it('sees nothing through the RLS-subject app role, which is why the read must use the admin pool', async () => {
    // Positive control for the test itself: the rows above exist, yet the app role cannot see them.
    expect(await listWorkspaceHostStandingHealthTargets(MINE, db.appSql)).toEqual([]);
  });

  it('carries the last attestation as an ISO timestamp so the pass can skip a host a soak just attested', async () => {
    const observedAt = '2026-10-01T17:55:00.000Z';
    await recordWorkspaceHostHealth(WS_A, {
      hostId: 'a-running',
      observedAt,
      status: 'healthy',
      checks: [{ name: 'compute-running', ok: true, detail: 'RUNNING' }],
    });
    const targets = await listWorkspaceHostStandingHealthTargets(MINE, db.adminSql);
    expect(targets.find((row) => row.hostId === 'a-running')?.healthAttestedAt).toBe(observedAt);
  });
});
