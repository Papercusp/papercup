/**
 * Hosted workspace admission against real Postgres and real workspace RLS.
 *
 * WHY THIS TEST EXISTS SEPARATELY FROM `workspace-admission.test.ts`. That suite injects
 * every effect and proves the ADMISSION ORDERING in isolation. It therefore cannot fail if
 * the database refuses the writes — which is exactly the failure this subsystem was born
 * from: `harness_app` held no GRANT on `harness_shared.customer_workspaces` at all, so a
 * perfectly-ordered admission would have died at the first INSERT (D-383, migration 1193).
 *
 * `OrgTestDb.appSql` is the `harness_app` role and is RLS-SUBJECT, so every statement below
 * travels the same privilege path production does. Delete migration 1193 and this file fails
 * with `permission denied for table customer_workspaces`; that is the point of it.
 *
 * The provider/DBOS boundary stays fake: this proves store ordering, idempotency and tenant
 * isolation, not that a cloud VM boots.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({
  appSql: null as any,
  controlPlaneWorkspaceId: '',
  startProvisioning: null as any,
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(workspaceId: string, run: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return run(tx);
    }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => h.controlPlaneWorkspaceId,
}));
vi.mock('../../dbos/workspace-host-provision-workflow', () => ({
  startWorkspaceHostProvisioningWorkflow: (input: unknown) => h.startProvisioning(input),
}));

const { createHostedWorkspaceAdmission, admissionIdentity, HostedWorkspaceAdmissionError } =
  await import('./workspace-admission');
const { createDefaultHostedWorkspaceAdmissionDependencies } = await import(
  './workspace-admission-dependencies'
);
const { upsertWorkspaceHostConnection } = await import('../../workspace-host/observability-store');
const { activateHostedCustomerWorkspace } = await import('../../workspace-host/hosted-bring-up');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

const CONNECTION_ID = 'conn-hosted-admission';

function desiredSpecFor(hostId: string): WorkspaceHostDesiredSpec {
  return {
    hostId,
    target: 'gcp',
    scope: { kind: 'project', id: 'project-hosted' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-small',
    image: { id: 'projects/images/global/images/papercusp-v1' },
    data: { volumeGiB: 20, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://integration-test' } },
    provider: { network: { mode: 'managed', networkName: `${hostId}-network` } },
  };
}

describe('hosted workspace admission (real Postgres, real RLS)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  /** A fresh control-plane workspace + seeded connection per case, so cases cannot alias. */
  async function freshControlPlane(): Promise<string> {
    const workspaceId = `hosted_admission_ws_${randomBytes(4).toString('hex')}`;
    h.controlPlaneWorkspaceId = workspaceId;
    // workspace_hosts FKs (workspace_id, connection_id), so the connection must exist
    // before any host row can be admitted.
    await upsertWorkspaceHostConnection({
      workspaceId,
      id: CONNECTION_ID,
      target: 'gcp',
      label: 'integration connection',
      credentialRef: 'adc://integration-test',
      status: 'connected',
    });
    return workspaceId;
  }

  function admissionFor(
    specHostId?: (derivedHostId: string) => string,
    options: { bringUp?: { requestedAgents: readonly ('claude' | 'codex' | 'omp')[] } } = {},
  ) {
    const started: unknown[] = [];
    h.startProvisioning = async (input: unknown) => {
      started.push(input);
      return { status: 'accepted' as const };
    };
    const port = createHostedWorkspaceAdmission(
      createDefaultHostedWorkspaceAdmissionDependencies({
        resolveDesiredSpec: async ({ hostId }) =>
          desiredSpecFor(specHostId ? specHostId(hostId) : hostId),
        ...options,
      }),
    );
    return { port, started };
  }

  /** Provisioning is fire-and-forget; wait for the enqueue it started to land. */
  async function enqueued(started: unknown[]): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 100 && started.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(started).toHaveLength(1);
    return started[0] as Record<string, unknown>;
  }

  it('hands a bring-up to provisioning, and the bring-up can mark the workspace active under RLS (D-401)', async () => {
    const workspaceId = await freshControlPlane();
    const { port, started } = admissionFor(undefined, { bringUp: { requestedAgents: ['omp'] } });
    const organizationId = '77777777-7777-4777-8777-777777777777';
    const admitted = await port.ensureProvisioned({
      organizationId,
      userId: 'user-7',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'Hosted workspace',
      operationKey: 'signup-bring-up',
    });
    const derived = admissionIdentity(organizationId, 'signup-bring-up');
    expect((await enqueued(started)).bringUp).toEqual({
      customerWorkspaceId: admitted.workspaceId,
      requestedAgents: ['omp'],
    });

    const state = async () => {
      const rows = await db.adminSql`
        SELECT state FROM harness_shared.customer_workspaces
         WHERE workspace_id = ${workspaceId} AND id = ${admitted.workspaceId}
      `;
      return rows[0]?.state as string | undefined;
    };
    // POSITIVE CONTROL: the row exists and is not already active, so 'active' below is this write.
    expect(await state()).toBe('provisioning');
    const activate = () =>
      activateHostedCustomerWorkspace({
        controlPlaneWorkspaceId: workspaceId,
        customerWorkspaceId: admitted.workspaceId,
        hostId: derived.hostId,
      });
    await expect(activate()).resolves.toEqual({ state: 'active' });
    expect(await state()).toBe('active');
    // A replayed step is a no-op, not a failure.
    await expect(activate()).resolves.toEqual({ state: 'active' });
    // A host the workspace is not bound to is refused, never silently "activated".
    await expect(
      activateHostedCustomerWorkspace({
        controlPlaneWorkspaceId: workspaceId,
        customerWorkspaceId: admitted.workspaceId,
        hostId: 'host-someone-else',
      }),
    ).rejects.toThrow(/not bound to host/);
  }, 120_000);

  it('hands no bring-up to an ordinary provision', async () => {
    await freshControlPlane();
    const { port, started } = admissionFor();
    await port.ensureProvisioned({
      organizationId: '88888888-8888-4888-8888-888888888888',
      userId: 'user-8',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'Plain workspace',
      operationKey: 'signup-plain',
    });
    expect(await enqueued(started)).not.toHaveProperty('bringUp');
  }, 120_000);

  it('admits a first workspace: host row, binding row, and exactly one provision enqueued', async () => {
    const workspaceId = await freshControlPlane();
    const { port, started } = admissionFor();
    const organizationId = '11111111-1111-4111-8111-111111111111';

    const result = await port.ensureProvisioned({
      organizationId,
      userId: 'user-1',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'First workspace',
      operationKey: 'signup-1',
    });

    const derived = admissionIdentity(organizationId, 'signup-1');
    expect(result).toEqual({
      workspaceId: derived.workspaceId,
      provisionOperationId: derived.provisionOperationId,
    });

    // Asserted through the RLS-BYPASS admin client: "did the row land" must be answered
    // independently of the policy that is itself under test.
    const bindings = await db.adminSql`
      SELECT id, organization_id, workspace_host_id, display_name, state,
             created_by_principal_kind, created_by_principal_id
        FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${workspaceId}
    `;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      id: derived.workspaceId,
      organization_id: organizationId,
      workspace_host_id: derived.hostId,
      display_name: 'First workspace',
      state: 'provisioning',
      created_by_principal_kind: 'user',
      created_by_principal_id: 'user-1',
    });

    // The host row must exist and must carry the spec-derived columns from the SHARED
    // projection — the same one the provisioning runner writes with.
    const hosts = await db.adminSql`
      SELECT id, connection_id, region, size, image, disk_gib, network, scope_label
        FROM harness_shared.workspace_hosts
       WHERE workspace_id = ${workspaceId}
    `;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      id: derived.hostId,
      connection_id: CONNECTION_ID,
      region: 'us-central1',
      size: 'e2-small',
      disk_gib: 20,
      network: `${derived.hostId}-network`,
      scope_label: 'project-hosted',
    });

    await Promise.resolve();
    expect(started).toHaveLength(1);
  }, 120_000);

  it('is idempotent on replay: same identity, no second row, no second provision', async () => {
    const workspaceId = await freshControlPlane();
    const { port, started } = admissionFor();
    const organizationId = '22222222-2222-4222-8222-222222222222';
    const input = {
      organizationId,
      userId: 'user-2',
      provider: 'gcp' as const,
      connectionId: CONNECTION_ID,
      displayName: 'Replayed workspace',
      operationKey: 'signup-replay',
    };

    const first = await port.ensureProvisioned(input);
    await Promise.resolve();
    const second = await port.ensureProvisioned(input);
    await Promise.resolve();

    expect(second).toEqual(first);
    const rows = await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${workspaceId}
    `;
    expect(rows[0].n).toBe(1);
    // The replay re-read its own binding and returned; it must not enqueue a second
    // provision for a host that is already being built.
    expect(started).toHaveLength(1);
  }, 120_000);

  it('refuses to adopt a workspace bound to another organization', async () => {
    await freshControlPlane();
    const { port } = admissionFor();
    const owner = '33333333-3333-4333-8333-333333333333';
    const intruder = '44444444-4444-4444-8444-444444444444';

    const admitted = await port.ensureProvisioned({
      organizationId: owner,
      userId: 'user-owner',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'Owned workspace',
      operationKey: 'signup-owner',
    });

    await expect(
      port.ensureProvisioned({
        organizationId: intruder,
        userId: 'user-intruder',
        provider: 'gcp',
        connectionId: CONNECTION_ID,
        displayName: 'Takeover attempt',
        operationKey: 'signup-intruder',
        requestedWorkspaceId: admitted.workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'organization_mismatch' });
  }, 120_000);

  it('refuses a desired spec that names a different host, and writes no binding', async () => {
    const workspaceId = await freshControlPlane();
    // A resolver that returns a spec for some OTHER host: both writes would otherwise
    // succeed and the workspace would be bound to a machine provisioning never builds.
    const { port, started } = admissionFor((hostId) => `${hostId}-divergent`);

    await expect(
      port.ensureProvisioned({
        organizationId: '55555555-5555-4555-8555-555555555555',
        userId: 'user-5',
        provider: 'gcp',
        connectionId: CONNECTION_ID,
        displayName: 'Divergent spec',
        operationKey: 'signup-divergent',
      }),
    ).rejects.toBeInstanceOf(HostedWorkspaceAdmissionError);

    const rows = await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${workspaceId}
    `;
    expect(rows[0].n).toBe(0);
    expect(started).toHaveLength(0);
  }, 120_000);

  it('keeps the binding inside its control-plane workspace under RLS', async () => {
    const workspaceId = await freshControlPlane();
    const { port } = admissionFor();
    const organizationId = '66666666-6666-4666-8666-666666666666';
    const admitted = await port.ensureProvisioned({
      organizationId,
      userId: 'user-6',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'Scoped workspace',
      operationKey: 'signup-scoped',
    });

    const visible = async (asWorkspaceId: string) =>
      db.appSql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.workspace_id', ${asWorkspaceId}, true)`;
        const rows = await tx`
          SELECT count(*)::int AS n FROM harness_shared.customer_workspaces
           WHERE id = ${admitted.workspaceId}
        `;
        return rows[0].n as number;
      });

    // POSITIVE CONTROL first: without it, the zero below could equally mean the probe is
    // broken, the row was never written, or RLS is working.
    expect(await visible(workspaceId)).toBe(1);
    expect(await visible(`${workspaceId}_other`)).toBe(0);
  }, 120_000);
});
