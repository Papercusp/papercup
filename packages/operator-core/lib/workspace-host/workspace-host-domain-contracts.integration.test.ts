/**
 * P-312 / D-295 domain persistence against real Postgres and real workspace RLS.
 *
 * The migration is applied explicitly while it is parked as `.DRAFT`; after it is armed,
 * createOrgTestDb applies it during template creation and this second application proves the
 * migration remains idempotent. Provider calls are outside this store-level contract.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceHostDesiredSpec, WorkspaceHostRuntimeRelease } from '@papercusp/deployment-driver';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(workspaceId: string, run: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return run(tx);
    }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: () => {} }));

const {
  WorkspaceHostControllerFenceError,
  beginWorkspaceHostOperation,
  readWorkspaceHostControl,
  WORKSPACE_HOST_FENCE_REFUSED_CODE,
  readWorkspaceHostDestroyTarget,
  recordWorkspaceHostObservation,
  recordWorkspaceHostHealth,
  updateWorkspaceHostLifecycleState,
  updateWorkspaceHostOperation,
  upsertWorkspaceHost,
  upsertWorkspaceHostConnection,
  upsertWorkspaceHostResourceCheckpoint,
} = await import('./observability-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARMED_MIGRATION = path.resolve(
  HERE,
  '../../../../libs/papercusp/libs/db/sql/1127-workspace-host-domain-contracts.sql',
);
const MIGRATION_PATH = existsSync(ARMED_MIGRATION) ? ARMED_MIGRATION : `${ARMED_MIGRATION}.DRAFT`;
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8');

let sequence = 0;
const freshWorkspace = () => `wh_domain_ws_${++sequence}_${randomBytes(2).toString('hex')}`;
const release: WorkspaceHostRuntimeRelease = {
  version: '0.0.18-r21',
  bundleSha256: 'a'.repeat(64),
  signingKeySha256: 'b'.repeat(64),
  protocolVersion: 'workspace-host-bootstrap-v1',
  schemaVersion: '1127',
};

function desired(hostId: string): WorkspaceHostDesiredSpec {
  return {
    hostId,
    target: 'gcp',
    scope: { kind: 'project', id: 'project-1' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-standard-4',
    image: { id: 'projects/project-1/global/images/papercusp-host-v1' },
    data: { volumeGiB: 64, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://integration-test' } },
  };
}

function hostInput(workspaceId: string, connectionId: string, hostId: string) {
  return {
    workspaceId,
    id: hostId,
    name: `Host ${hostId}`,
    connectionId,
    target: 'gcp',
    scopeLabel: 'project-1',
    region: 'us-central1',
    size: 'e2-standard-4',
    image: 'papercusp-host-v1',
    diskGiB: 64,
    network: 'default',
    desiredState: 'running',
    observedState: 'running',
    desiredSpec: desired(hostId),
  };
}

describe('workspace-host domain contracts (real PG + real RLS)', () => {
  let db: OrgTestDb;

  async function seedConnection(workspaceId: string): Promise<string> {
    const connectionId = `conn_${randomBytes(3).toString('hex')}`;
    await upsertWorkspaceHostConnection({
      workspaceId,
      id: connectionId,
      target: 'gcp',
      label: 'P-312 integration connection',
      credentialRef: 'adc://integration-test',
      status: 'connected',
      authenticatedIdentity: 'serviceAccount:p312@test.invalid',
    });
    return connectionId;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    await db.adminSql.unsafe(MIGRATION_SQL).simple();
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('installs the explicit connection, host, and operation domain columns', async () => {
    const columns = await db.adminSql<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'harness_shared'
        AND (
          (table_name = 'workspace_host_connections' AND column_name = 'authenticated_identity')
          OR (table_name = 'workspace_hosts' AND column_name IN (
            'host_generation', 'desired_revision', 'observed_revision', 'runtime_release',
            'controller_id', 'controller_fence'
          ))
          OR (table_name = 'workspace_host_operations' AND column_name IN (
            'desired_revision', 'controller_id', 'controller_fence'
          ))
        )
      ORDER BY table_name, column_name
    `;

    expect(columns).toEqual([
      { table_name: 'workspace_host_connections', column_name: 'authenticated_identity', data_type: 'text' },
      { table_name: 'workspace_host_operations', column_name: 'controller_fence', data_type: 'bigint' },
      { table_name: 'workspace_host_operations', column_name: 'controller_id', data_type: 'text' },
      { table_name: 'workspace_host_operations', column_name: 'desired_revision', data_type: 'bigint' },
      { table_name: 'workspace_hosts', column_name: 'controller_fence', data_type: 'bigint' },
      { table_name: 'workspace_hosts', column_name: 'controller_id', data_type: 'text' },
      { table_name: 'workspace_hosts', column_name: 'desired_revision', data_type: 'bigint' },
      { table_name: 'workspace_hosts', column_name: 'host_generation', data_type: 'bigint' },
      { table_name: 'workspace_hosts', column_name: 'observed_revision', data_type: 'bigint' },
      { table_name: 'workspace_hosts', column_name: 'runtime_release', data_type: 'jsonb' },
    ]);
  });

  it('round-trips authenticated identity, signed runtime compatibility, and controller authority', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = 'host-round-trip';
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, hostId),
      hostGeneration: 1,
      desiredRevision: 1,
      observedRevision: 0,
      runtimeRelease: release,
      controllerAuthority: { controllerId: 'controller-a', fence: 1 },
    });

    const control = await readWorkspaceHostControl(workspaceId);
    expect(control).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'connection',
          id: connectionId,
          authenticatedIdentity: 'serviceAccount:p312@test.invalid',
        }),
        expect.objectContaining({
          kind: 'workspace',
          id: hostId,
          hostGeneration: 1,
          desiredRevision: 1,
          observedRevision: 0,
          runtimeRelease: release,
          controllerAuthority: { controllerId: 'controller-a', fence: 1 },
        }),
      ]),
    );
    await expect(readWorkspaceHostDestroyTarget(workspaceId, hostId)).resolves.toMatchObject({
      id: hostId,
      connectionId,
      hostGeneration: 1,
      desiredRevision: 1,
      observedRevision: 0,
      runtimeRelease: release,
      controllerAuthority: { controllerId: 'controller-a', fence: 1 },
    });
  });

  it('allows only monotonic authority takeover and refuses stale checkpoints and host upserts', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = 'host-fenced';
    const authorityA = { controllerId: 'controller-a', fence: 1 } as const;
    const authorityB = { controllerId: 'controller-b', fence: 2 } as const;
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, hostId),
      hostGeneration: 1,
      desiredRevision: 1,
      observedRevision: 0,
      runtimeRelease: release,
      controllerAuthority: authorityA,
    });
    await beginWorkspaceHostOperation({
      workspaceId,
      operationId: 'operation-a',
      hostId,
      action: 'provision',
      desiredRevision: 1,
      controllerAuthority: authorityA,
    });
    await beginWorkspaceHostOperation({
      workspaceId,
      operationId: 'operation-b',
      hostId,
      action: 'restart',
      controllerAuthority: authorityB,
    });

    await expect(
      beginWorkspaceHostOperation({
        workspaceId,
        operationId: 'operation-stale',
        hostId,
        action: 'repair',
        controllerAuthority: authorityA,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
    await expect(
      upsertWorkspaceHostResourceCheckpoint({
        workspaceId,
        hostId,
        operationId: 'operation-a',
        checkpoint: { logicalKey: 'create-instance', state: 'planned', attempts: 0 },
        controllerAuthority: authorityA,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
    await expect(
      upsertWorkspaceHost({
        ...hostInput(workspaceId, connectionId, hostId),
        hostGeneration: 1,
        desiredRevision: 1,
        observedRevision: 0,
        runtimeRelease: release,
        controllerAuthority: authorityA,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);

    const [host] = await db.adminSql<{ controller_id: string; controller_fence: number; desired_revision: number }[]>`
      SELECT controller_id, controller_fence, desired_revision
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    expect(host).toEqual({ controller_id: 'controller-b', controller_fence: 2, desired_revision: 2 });
  });

  // WI-10005307: a host whose FIRST provision failed was fenced forever. The first-operation
  // exemption (a provision/restore may claim the revision its host row was written with) required
  // "no prior operation", and the failed provision counted as one — so every retry, under a fresh
  // operationId and the SAME controller authority, threw WorkspaceHostControllerFenceError while the
  // API had already answered 202. Measured live on host-0f9b1ba8db30d143becc130a, 2026-10-02.
  async function seedFirstProvision(hostId: string) {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const authority = { controllerId: 'controller-a', fence: 1 } as const;
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, hostId),
      hostGeneration: 1,
      desiredRevision: 1,
      observedRevision: 0,
      runtimeRelease: release,
      controllerAuthority: authority,
    });
    const provision = (operationId: string) =>
      beginWorkspaceHostOperation({
        workspaceId,
        operationId,
        hostId,
        action: 'provision',
        desiredRevision: 1,
        controllerAuthority: authority,
      });
    const finish = (operationId: string, status: 'succeeded' | 'failed') =>
      updateWorkspaceHostOperation({
        workspaceId,
        operationId,
        status,
        percent: 100,
        message: status,
        controllerAuthority: authority,
      });
    await provision('prov-1');
    return { workspaceId, provision, finish };
  }

  it('lets a failed first provision be retried under a new operation id at the same revision', async () => {
    const { workspaceId, provision, finish } = await seedFirstProvision('host-retry-after-failed-first');

    // Control: while the first provision is still in flight, a second one at the same revision is
    // fenced — the exemption must not become "any number of concurrent first operations".
    await expect(provision('prov-1-concurrent')).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);

    await finish('prov-1', 'failed');
    await provision('prov-1-r2');

    const operations = await db.adminSql<{ id: string; status: string; desired_revision: string }[]>`
      SELECT id, status, desired_revision FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${workspaceId} AND host_id = 'host-retry-after-failed-first'
      ORDER BY created_at, id
    `;
    // prov-1-concurrent's refusal is recorded (WI-10005312) and, never having run, did not fence
    // the retry.
    expect(operations.map((row) => [row.id, row.status, Number(row.desired_revision)])).toEqual([
      ['prov-1', 'failed', 1],
      ['prov-1-concurrent', 'failed', 1],
      ['prov-1-r2', 'queued', 1],
    ]);

    // Control: the retry is now the in-flight first operation, so a third attempt is fenced again.
    await expect(provision('prov-1-r3')).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
  });

  // WI-10005312: a fenced begin rolled back the only write of the operation row, so a request
  // already answered 202 had no row and its timeline could never show the failure.
  it('records a fence refusal as a terminal row that never runs, holds authority, or hides live progress', async () => {
    const hostId = 'host-refusal-recorded';
    const { workspaceId, provision, finish } = await seedFirstProvision(hostId);

    await expect(provision('prov-refused')).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
    const [refused] = await db.adminSql<
      { status: string; code: string | null; finished: boolean; controller_id: string | null; desired_revision: number }[]
    >`
      SELECT status, error->>'code' AS code, finished_at IS NOT NULL AS finished, controller_id, desired_revision
      FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${workspaceId} AND id = 'prov-refused'
    `;
    expect(refused).toEqual({
      status: 'failed',
      code: WORKSPACE_HOST_FENCE_REFUSED_CODE,
      finished: true,
      controller_id: 'controller-a',
      desired_revision: 1,
    });

    // The refusal is newer than prov-1, yet the host's current progress is still the in-flight
    // prov-1, because a refused request never ran on the host.
    const control = await readWorkspaceHostControl(workspaceId);
    expect(control).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'workspace', id: hostId, operation: expect.objectContaining({ id: 'prov-1' }) }),
      ]),
    );

    // The refused row names the host's current controller AND revision, so only the refusal
    // exclusion keeps it from passing the authority check and being "finished" as a success.
    await expect(finish('prov-refused', 'succeeded')).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);

    // DBOS re-runs a failed step with the same input: once the fence clears, the retry of the
    // refused id is admitted and replaces its refusal in place.
    await finish('prov-1', 'failed');
    await provision('prov-refused');
    const [retried] = await db.adminSql<{ status: string; error: unknown; finished_at: Date | null }[]>`
      SELECT status, error, finished_at FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${workspaceId} AND id = 'prov-refused'
    `;
    expect(retried).toEqual({ status: 'queued', error: null, finished_at: null });
  });

  it('still fences a same-revision provision after a succeeded first provision or a failed one under recovery', async () => {
    const succeeded = await seedFirstProvision('host-first-succeeded');
    await succeeded.finish('prov-1', 'succeeded');
    await expect(succeeded.provision('prov-1-again')).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);

    const recovering = await seedFirstProvision('host-first-failed-recovering');
    await recovering.finish('prov-1', 'failed');
    await db.adminSql`
      UPDATE harness_shared.workspace_host_operations SET recovery_state = 'recovering'
      WHERE workspace_id = ${recovering.workspaceId} AND id = 'prov-1'
    `;
    await expect(recovering.provision('prov-1-r2')).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
  });

  it('advances observed revision only through the fenced operation that produced the observation', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = 'host-observed';
    const authority = { controllerId: 'controller-b', fence: 2 } as const;
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, hostId),
      desiredRevision: 1,
      observedRevision: 0,
      controllerAuthority: { controllerId: 'controller-a', fence: 1 },
    });
    await beginWorkspaceHostOperation({
      workspaceId,
      operationId: 'operation-observe',
      hostId,
      action: 'restart',
      controllerAuthority: authority,
    });
    await recordWorkspaceHostObservation(
      workspaceId,
      {
        host: { hostId, target: 'gcp', resources: [] },
        state: 'running',
        resources: [],
        observedAt: '2026-09-06T00:00:00.000Z',
        drift: [],
      },
      { operationId: 'operation-observe', controllerAuthority: authority },
    );

    const [host] = await db.adminSql<{ desired_revision: number; observed_revision: number }[]>`
      SELECT desired_revision, observed_revision
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    expect(host).toEqual({ desired_revision: 2, observed_revision: 2 });
  });

  it.each(['start', 'stop', 'restart'] as const)(
    'clears the previous health attestation when a %s operation begins',
    async (action) => {
      const workspaceId = freshWorkspace();
      const connectionId = await seedConnection(workspaceId);
      const hostId = `host-health-${action}`;
      const authority = { controllerId: 'controller-health', fence: 1 } as const;
      const observedAt = '2026-10-02T00:00:00.000Z';
      await upsertWorkspaceHost({
        ...hostInput(workspaceId, connectionId, hostId),
        desiredRevision: 1,
        observedRevision: 1,
        controllerAuthority: authority,
      });
      await recordWorkspaceHostHealth(workspaceId, {
        hostId,
        observedAt,
        status: 'healthy',
        checks: [{ name: 'compute-running', ok: true, detail: 'RUNNING' }],
      });

      const operationId = `operation-health-${action}`;
      await beginWorkspaceHostOperation({
        workspaceId,
        operationId,
        hostId,
        action,
        controllerAuthority: authority,
      });
      await recordWorkspaceHostObservation(
        workspaceId,
        {
          host: { hostId, target: 'gcp', resources: [] },
          state: action === 'stop' ? 'stopped' : 'running',
          resources: [],
          observedAt: '2026-10-02T00:01:00.000Z',
          drift: [],
        },
        { operationId, controllerAuthority: authority },
      );

      const [host] = await db.adminSql<{
        observed_state: string;
        health_status: string | null;
        health_attested_at: Date | string | null;
        health_checks: unknown[];
      }[]> `
        SELECT observed_state, health_status, health_attested_at, health_checks
        FROM harness_shared.workspace_hosts
        WHERE workspace_id = ${workspaceId} AND id = ${hostId}
      `;
      expect(host).toEqual({
        observed_state: action === 'stop' ? 'stopped' : 'running',
        health_status: null,
        health_attested_at: null,
        health_checks: [],
      });
      expect(await readWorkspaceHostControl(workspaceId)).toContainEqual(
        expect.objectContaining({ kind: 'workspace', id: hostId, health: undefined }),
      );
    },
  );

  it('preserves health while a snapshot operation leaves provider liveness unchanged', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = 'host-health-snapshot';
    const authority = { controllerId: 'controller-health', fence: 1 } as const;
    const observedAt = '2026-10-02T00:00:00.000Z';
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, hostId),
      desiredRevision: 1,
      observedRevision: 1,
      controllerAuthority: authority,
    });
    await recordWorkspaceHostHealth(workspaceId, {
      hostId,
      observedAt,
      status: 'healthy',
      checks: [{ name: 'compute-running', ok: true, detail: 'RUNNING' }],
    });

    await beginWorkspaceHostOperation({
      workspaceId,
      operationId: 'operation-health-snapshot',
      hostId,
      action: 'snapshot',
      controllerAuthority: authority,
    });

    const [host] = await db.adminSql<{
      health_status: string | null;
      health_attested_at: Date | string | null;
      health_checks: unknown[];
    }[]> `
      SELECT health_status, health_attested_at, health_checks
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    expect(host).toMatchObject({
      health_status: 'healthy',
      health_attested_at: expect.anything(),
      health_checks: [{ name: 'compute-running', ok: true, detail: 'RUNNING' }],
    });
  });

  it.each([
    ['provision', 'running'],
    ['provision', 'stopped'],
    ['restore', 'running'],
    ['restore', 'stopped'],
    ['repair', 'running'],
  ] as const)('repairs legacy provisioning intent through a current %s observation of %s', async (action, state) => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = 'host-legacy-intent';
    const authority = { controllerId: 'controller-a', fence: 1 };
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, hostId),
      desiredState: 'provisioning',
      observedState: 'provisioning',
      controllerAuthority: authority,
    });
    await beginWorkspaceHostOperation({
      workspaceId, hostId, operationId: 'operation-legacy', action,
      ...(action === 'provision' ? { desiredRevision: 1 } : {}),
      controllerAuthority: authority,
    });
    const observation = {
      host: { hostId, target: 'gcp' as const, resources: [] },
      state, resources: [], observedAt: '2026-09-20T00:00:00.000Z', drift: [],
    };
    const control = { operationId: 'operation-legacy', controllerAuthority: authority };
    await recordWorkspaceHostObservation(workspaceId, observation, control);
    // Re-observation is idempotent; it must not invent a new desired revision.
    await recordWorkspaceHostObservation(workspaceId, observation, control);
    const rows = await db.adminSql`
      SELECT desired_state, observed_state, desired_revision, observed_revision
      FROM harness_shared.workspace_hosts WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    const revision = action === 'provision' ? 1 : 2;
    expect(rows[0]).toEqual({
      desired_state: 'running', observed_state: state,
      desired_revision: revision, observed_revision: revision,
    });
  });

  it.each([false, true])('does not infer desired intent from an observation without provisioning authority (controlled=%s)', async (controlled) => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = 'host-no-provision-authority';
    const authority = { controllerId: 'controller-a', fence: 1 };
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, hostId),
      desiredState: 'provisioning', controllerAuthority: authority,
    });
    await beginWorkspaceHostOperation({
      workspaceId, hostId, operationId: 'operation-restart', action: 'restart',
      controllerAuthority: authority,
    });
    await recordWorkspaceHostObservation(workspaceId, {
      host: { hostId, target: 'gcp', resources: [] },
      state: 'running', resources: [], observedAt: '2026-09-20T00:00:00.000Z', drift: [],
    }, controlled ? { operationId: 'operation-restart', controllerAuthority: authority } : undefined);
    const rows = await db.adminSql`
      SELECT desired_state FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    expect(rows[0]?.desired_state).toBe('provisioning');
  });

  it('refuses stale and cross-workspace legacy repair and preserves a newer destroy intent', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = 'host-newer-intent';
    const authority = { controllerId: 'controller-a', fence: 1 };
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, hostId),
      desiredState: 'provisioning', controllerAuthority: authority,
    });
    await beginWorkspaceHostOperation({
      workspaceId, hostId, operationId: 'operation-provision', action: 'provision',
      desiredRevision: 1, controllerAuthority: authority,
    });
    const observation = {
      host: { hostId, target: 'gcp' as const, resources: [] },
      state: 'running' as const, resources: [], observedAt: '2026-09-20T00:00:00.000Z', drift: [],
    };
    const control = { operationId: 'operation-provision', controllerAuthority: authority };
    await expect(recordWorkspaceHostObservation(freshWorkspace(), observation, control))
      .rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
    // The SAME controller can supersede its provision operation. Fence alone is insufficient.
    await beginWorkspaceHostOperation({
      workspaceId, hostId, operationId: 'operation-destroy', action: 'destroy',
      controllerAuthority: authority,
    });
    await updateWorkspaceHostLifecycleState({
      workspaceId, hostId, state: 'destroying', operationId: 'operation-destroy',
      controllerAuthority: authority,
    });
    await expect(recordWorkspaceHostObservation(workspaceId, observation, control))
      .rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
    await recordWorkspaceHostObservation(workspaceId, observation, {
      operationId: 'operation-destroy', controllerAuthority: authority,
    });
    const rows = await db.adminSql`
      SELECT desired_state FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    expect(rows[0]?.desired_state).toBe('destroying');
  });

  it('persists replacement Hosts separately while preserving stable Workspace/data identity', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, 'host-original'),
      hostGeneration: 1,
      desiredRevision: 2,
      observedRevision: 2,
      runtimeRelease: release,
      controllerAuthority: { controllerId: 'controller-a', fence: 2 },
    });
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, 'host-replacement'),
      hostGeneration: 2,
      desiredRevision: 3,
      observedRevision: 2,
      runtimeRelease: release,
      controllerAuthority: { controllerId: 'controller-b', fence: 3 },
    });

    const rows = await db.adminSql<
      { workspace_id: string; id: string; connection_id: string; host_generation: number }[]
    >`
      SELECT workspace_id, id, connection_id, host_generation
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId}
      ORDER BY host_generation
    `;
    expect(rows).toEqual([
      { workspace_id: workspaceId, id: 'host-original', connection_id: connectionId, host_generation: 1 },
      { workspace_id: workspaceId, id: 'host-replacement', connection_id: connectionId, host_generation: 2 },
    ]);
    await expect(readWorkspaceHostDestroyTarget(workspaceId, 'host-replacement')).resolves.toMatchObject({
      id: 'host-replacement',
      connectionId,
      hostGeneration: 2,
      desiredRevision: 3,
      observedRevision: 2,
    });
  });

  it('round-trips a fenced snapshot recovery point after the host becomes absent', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = 'host-snapshot-destroy';
    const destroyAuthority = { controllerId: 'controller-destroy', fence: 2 } as const;
    const recoverability = {
      kind: 'snapshot' as const,
      label: 'projects/project-1/global/snapshots/pc-destroy-host-snapshot-data',
      updatedAt: '2026-09-06T12:00:00.000Z',
    };
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, hostId),
      desiredRevision: 1,
      observedRevision: 1,
      controllerAuthority: { controllerId: 'controller-provision', fence: 1 },
    });
    await beginWorkspaceHostOperation({
      workspaceId,
      operationId: 'operation-snapshot-destroy',
      hostId,
      action: 'destroy',
      desiredRevision: 2,
      controllerAuthority: destroyAuthority,
      request: { disposition: 'snapshot' },
    });

    await updateWorkspaceHostLifecycleState({
      workspaceId,
      hostId,
      state: 'absent',
      observedAt: recoverability.updatedAt,
      recoverability,
      operationId: 'operation-snapshot-destroy',
      controllerAuthority: destroyAuthority,
    });

    const [row] = await db.adminSql<{
      desired_state: string;
      observed_state: string;
      desired_revision: number | string;
      observed_revision: number | string;
      recoverability_kind: string;
      recoverability_label: string;
      recoverability_updated_at: Date;
    }[]>`
      SELECT desired_state, observed_state, desired_revision, observed_revision,
             recoverability_kind, recoverability_label, recoverability_updated_at
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    expect(row).toMatchObject({
      desired_state: 'absent',
      observed_state: 'absent',
      recoverability_kind: 'snapshot',
      recoverability_label: recoverability.label,
    });
    // WI-10004969: the destroy converged on its operation's revision, so release.cleanup's
    // absent-and-converged predicate (observed_revision === desired_revision) can pass.
    expect(Number(row?.desired_revision)).toBe(2);
    expect(Number(row?.observed_revision)).toBe(2);
    expect(row?.recoverability_updated_at.toISOString()).toBe(recoverability.updatedAt);
    await expect(readWorkspaceHostDestroyTarget(workspaceId, hostId)).resolves.toMatchObject({
      id: hostId,
      observedState: 'absent',
      recoverability,
      desiredRevision: 2,
      controllerAuthority: destroyAuthority,
    });
  });

  it('enforces closed signed-runtime and paired controller metadata in the database', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = 'host-constraints';
    await upsertWorkspaceHost({
      ...hostInput(workspaceId, connectionId, hostId),
      runtimeRelease: release,
      controllerAuthority: { controllerId: 'controller-a', fence: 1 },
    });

    await expect(
      db.adminSql`
        UPDATE harness_shared.workspace_hosts
        SET runtime_release = ${db.adminSql.json({ ...release, bundleUrl: 'https://forbidden.invalid' })}
        WHERE workspace_id = ${workspaceId} AND id = ${hostId}
      `,
    ).rejects.toThrow(/workspace_hosts_runtime_release_ck/i);
    await expect(
      db.adminSql`
        UPDATE harness_shared.workspace_hosts
        SET controller_id = NULL, controller_fence = 1
        WHERE workspace_id = ${workspaceId} AND id = ${hostId}
      `,
    ).rejects.toThrow(/workspace_hosts_controller_authority_ck/i);
    await expect(
      db.adminSql`
        UPDATE harness_shared.workspace_host_connections
        SET authenticated_identity = '   '
        WHERE workspace_id = ${workspaceId} AND id = ${connectionId}
      `,
    ).rejects.toThrow(/workspace_host_connections_authenticated_identity_ck/i);
  });
});
