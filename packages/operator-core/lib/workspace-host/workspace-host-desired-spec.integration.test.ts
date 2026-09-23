/**
 * workspace-host-desired-spec.integration.test.ts — provisioning intent persisted on the host
 * record, against REAL Postgres (testcontainer) exercising REAL RLS (P-046 / WI-40474).
 *
 * Migration 956 adds `workspace_hosts.desired_spec` so a lifecycle action handed only a hostId can
 * recover WHICH cloud instance that host is. Two properties here are the reason this test exists
 * rather than a unit test with a fake store:
 *
 * 1. PRESERVE-ON-OMIT. The upsert writes
 *    `COALESCE(EXCLUDED.desired_spec, workspace_hosts.desired_spec)`, so an observation refresh
 *    (which carries no spec) must not erase provisioning intent. Get that COALESCE backwards and
 *    nothing fails loudly — the column just silently empties on the next status poll, and the
 *    symptom appears much later as a host that can no longer be initialized. Only a real upsert
 *    against a real ON CONFLICT path can catch it.
 *
 * 2. RLS. `workspace_hosts` carries a `workspace_id = current_setting('app.workspace_id')` policy
 *    (migration 887), and the store runs as the RLS-SUBJECT harness_app role via `withWorkspace`.
 *    A spec recorded in one workspace must be invisible in another — enforced by a real policy,
 *    not by a WHERE clause the test itself supplies.
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

const { readWorkspaceHostDesiredSpec, recordWorkspaceHostImage, upsertWorkspaceHost } = await import(
  './observability-store'
);
const { createOrgTestDb } = await import('../../test/_org-test-db');

let n = 0;
const freshWs = () => `whd_ws_${++n}_${randomBytes(2).toString('hex')}`;

function spec(overrides: Partial<WorkspaceHostDesiredSpec> = {}): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-alpha',
    target: 'gcp',
    scope: { kind: 'project', id: 'active-alcove-504205-q3' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-standard-4',
    image: { id: 'projects/p/global/images/papercusp-host-v1' },
    data: { volumeGiB: 64, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' } },
    ...overrides,
  } as WorkspaceHostDesiredSpec;
}

describe('workspace-host provisioning intent (real PG + real RLS)', () => {
  let db: OrgTestDb;

  /** The connection row a host is FK'd to. */
  async function seedConnection(workspaceId: string): Promise<string> {
    const connectionId = `conn_${randomBytes(3).toString('hex')}`;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_connections (
        workspace_id, id, target, label, credential_ref
      ) VALUES (${workspaceId}, ${connectionId}, 'gcp', 'test connection', 'cloudCredentialRef:test')
    `;
    return connectionId;
  }

  function hostInput(workspaceId: string, connectionId: string, id: string) {
    return {
      workspaceId,
      id,
      name: 'test host',
      connectionId,
      target: 'gcp',
      scopeLabel: 'test-project',
      region: 'us-central1',
      size: 'e2-standard-4',
      image: 'papercusp-host-v1',
      diskGiB: 64,
      network: 'default',
      desiredState: 'running',
      observedState: 'running',
    };
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('round-trips the provisioning intent the provisioner recorded', async () => {
    const ws = freshWs();
    const connectionId = await seedConnection(ws);
    const desired = spec({ hostId: 'host-round-trip' });

    await upsertWorkspaceHost({ ...hostInput(ws, connectionId, 'host-round-trip'), desiredSpec: desired });

    const lookup = await readWorkspaceHostDesiredSpec(ws, 'host-round-trip');
    expect(lookup.miss).toBeUndefined();
    expect(lookup.desired).toEqual(desired);
    // The instance identity is what initialization actually needs back out of this column.
    expect(lookup.desired?.zone).toBe('us-central1-a');
    expect(lookup.desired?.scope.id).toBe('active-alcove-504205-q3');
  });

  it('PRESERVES a recorded spec across an upsert that omits one', async () => {
    const ws = freshWs();
    const connectionId = await seedConnection(ws);
    const desired = spec({ hostId: 'host-preserve' });

    await upsertWorkspaceHost({ ...hostInput(ws, connectionId, 'host-preserve'), desiredSpec: desired });

    // An observation refresh: same row, new observed state, NO spec supplied. This is the write
    // that would silently erase provisioning intent if the COALESCE were the other way round.
    await upsertWorkspaceHost({
      ...hostInput(ws, connectionId, 'host-preserve'),
      observedState: 'degraded',
    });

    const lookup = await readWorkspaceHostDesiredSpec(ws, 'host-preserve');
    expect(lookup.desired).toEqual(desired);
  });

  it('replaces the spec when a caller actually supplies a new one', async () => {
    const ws = freshWs();
    const connectionId = await seedConnection(ws);

    await upsertWorkspaceHost({
      ...hostInput(ws, connectionId, 'host-replace'),
      desiredSpec: spec({ hostId: 'host-replace', zone: 'us-central1-a' }),
    });
    await upsertWorkspaceHost({
      ...hostInput(ws, connectionId, 'host-replace'),
      desiredSpec: spec({ hostId: 'host-replace', zone: 'us-central1-b' }),
    });

    const lookup = await readWorkspaceHostDesiredSpec(ws, 'host-replace');
    expect(lookup.desired?.zone).toBe('us-central1-b');
  });

  it('an upgrade records its runtime release with its image; a rollback (no release) keeps the recorded one', async () => {
    // WI-10002798: the upgraded machine ran only r42 while its row still named r41.
    const ws = freshWs();
    const connectionId = await seedConnection(ws);
    const release = (version: string) => ({
      version,
      bundleSha256: 'a'.repeat(64),
      signingKeySha256: 'b'.repeat(64),
      protocolVersion: 'papercusp-workspace-host.v1',
      schemaVersion: 'schema-1202',
    });
    await upsertWorkspaceHost({
      ...hostInput(ws, connectionId, 'host-upgrade'),
      desiredSpec: spec({ hostId: 'host-upgrade' }),
      runtimeRelease: release('0.0.21-p318r41'),
    });
    const runtimeVersion = async () =>
      (
        await db.adminSql`
          SELECT runtime_release->>'version' AS version, desired_spec->'image'->>'id' AS image
            FROM harness_shared.workspace_hosts WHERE workspace_id = ${ws} AND id = 'host-upgrade'`
      )[0];

    await recordWorkspaceHostImage({
      workspaceId: ws,
      hostId: 'host-upgrade',
      image: { id: 'projects/p/global/images/papercusp-host-v2' },
      runtimeRelease: release('0.0.21-p318r42'),
    });
    expect(await runtimeVersion()).toEqual({
      version: '0.0.21-p318r42',
      image: 'projects/p/global/images/papercusp-host-v2',
    });

    await recordWorkspaceHostImage({
      workspaceId: ws,
      hostId: 'host-upgrade',
      image: { id: 'projects/p/global/images/papercusp-host-v1' },
    });
    expect(await runtimeVersion()).toEqual({
      version: '0.0.21-p318r42',
      image: 'projects/p/global/images/papercusp-host-v1',
    });
  });

  it('distinguishes an unknown host from a host that recorded no intent', async () => {
    const ws = freshWs();
    const connectionId = await seedConnection(ws);

    // A host written WITHOUT a spec — e.g. provisioned before migration 956.
    await upsertWorkspaceHost(hostInput(ws, connectionId, 'host-no-intent'));

    expect(await readWorkspaceHostDesiredSpec(ws, 'host-no-intent')).toEqual({
      desired: null,
      miss: 'no-recorded-spec',
    });
    expect(await readWorkspaceHostDesiredSpec(ws, 'host-that-never-existed')).toEqual({
      desired: null,
      miss: 'host-not-found',
    });
  });

  it('REFUSES to persist a spec carrying secret material', async () => {
    const ws = freshWs();
    const connectionId = await seedConnection(ws);

    await expect(
      upsertWorkspaceHost({
        ...hostInput(ws, connectionId, 'host-secret'),
        desiredSpec: spec({ hostId: 'host-secret', provider: { accessKey: 'AKIAIOSFODNN7EXAMPLE' } }),
      }),
    ).rejects.toThrow(/Secret-shaped field/);

    // The refusal must happen BEFORE the write, not after: nothing may be persisted.
    expect(await readWorkspaceHostDesiredSpec(ws, 'host-secret')).toEqual({
      desired: null,
      miss: 'host-not-found',
    });
  });

  it('does not leak a recorded spec across workspaces', async () => {
    const owner = freshWs();
    const other = freshWs();
    const connectionId = await seedConnection(owner);

    await upsertWorkspaceHost({
      ...hostInput(owner, connectionId, 'host-scoped'),
      desiredSpec: spec({ hostId: 'host-scoped' }),
    });

    // Same host id, different workspace: the reader must not see it.
    expect(await readWorkspaceHostDesiredSpec(other, 'host-scoped')).toEqual({
      desired: null,
      miss: 'host-not-found',
    });
    expect((await readWorkspaceHostDesiredSpec(owner, 'host-scoped')).desired).not.toBeNull();
  });

  it('is hidden by the RLS POLICY itself, not merely by the reader\'s predicate', async () => {
    // The test above cannot tell RLS apart from `readWorkspaceHostDesiredSpec`'s own
    // `WHERE workspace_id = ...` — it would pass with the policy dropped entirely. So probe the
    // policy directly: query the table as the RLS-subject role with NO workspace predicate at all,
    // under each workspace's GUC. If the policy were absent, the foreign workspace would see the
    // row and this fails; the owner-side read is the positive control proving the query works.
    const owner = freshWs();
    const other = freshWs();
    const connectionId = await seedConnection(owner);

    await upsertWorkspaceHost({
      ...hostInput(owner, connectionId, 'host-policy'),
      desiredSpec: spec({ hostId: 'host-policy' }),
    });

    const unscopedRead = (ws: string) =>
      h.appSql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return tx`SELECT id, desired_spec FROM harness_shared.workspace_hosts WHERE id = 'host-policy'`;
      });

    expect(await unscopedRead(other)).toHaveLength(0);

    const ownerRows = await unscopedRead(owner);
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0].desired_spec).toMatchObject({ zone: 'us-central1-a' });
  });
});
