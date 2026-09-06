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
  readWorkspaceHostDestroyTarget,
  recordWorkspaceHostObservation,
  updateWorkspaceHostLifecycleState,
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
      recoverability_kind: string;
      recoverability_label: string;
      recoverability_updated_at: Date;
    }[]>`
      SELECT desired_state, observed_state, recoverability_kind, recoverability_label,
             recoverability_updated_at
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    expect(row).toMatchObject({
      desired_state: 'absent',
      observed_state: 'absent',
      recoverability_kind: 'snapshot',
      recoverability_label: recoverability.label,
    });
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
