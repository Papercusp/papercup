/**
 * Real-Postgres regression for same-name resource recreation and stale destroy ordering.
 *
 * The fake-SQL writer tests cannot prove the unique-key conflict/update behavior or the close
 * predicate against PostgreSQL. This suite exercises the applied migration and ledger queries
 * against the real isolated test database; it never contacts a cloud provider.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  closeCloudResourceObligation,
  createCloudResourceObligationCloseObserver,
  listOpenCloudResourceObligations,
  recordCloudResourceObligation,
} from './cloud-resource-obligations';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('cloud resource obligation VM incarnation lifecycle (real Postgres)', () => {
  let db: OrgTestDb;
  const workspaceId = 'cloud-resource-obligation-incarnation-ws';
  const resourceId = 'pc-host-incarnation-regression-vm';
  const base = {
    workspaceId,
    provider: 'gcp' as const,
    resourceKind: 'vm',
    resourceId,
    projectId: 'papercusp-hosted-workspaces',
    zone: 'us-central1-a',
    hostId: 'host-incarnation-regression',
    graceMs: 60_000,
  };

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup?.();
  });

  it('reopens a same-name VM for a new incarnation and ignores a late destroy for the old one', async () => {
    const oldIncarnation = 'gce-instance-1001';
    const newIncarnation = 'gce-instance-1002';

    const old = await recordCloudResourceObligation(db.adminSql, {
      ...base,
      incarnationId: oldIncarnation,
      purpose: 'old host generation',
    });
    expect(old).toMatchObject({ created: true });

    expect(
      await closeCloudResourceObligation(db.adminSql, {
        ...base,
        incarnationId: oldIncarnation,
        reason: 'provider confirmed old instance destroy',
      }),
    ).toEqual({ closed: true });

    const recreated = await recordCloudResourceObligation(db.adminSql, {
      ...base,
      incarnationId: newIncarnation,
      purpose: 'replacement host generation',
    });
    expect(recreated).toEqual({ id: old.id, created: true });

    const onUnmatched = vi.fn();
    const closeObserver = createCloudResourceObligationCloseObserver({
      sql: db.adminSql,
      onUnmatched,
    });
    const staleDestroy = await closeObserver({
      workspaceId,
      resource: {
        deleteOp: 'delete-instance',
        providerId: resourceId,
        incarnationId: oldIncarnation,
      },
      reason: 'delayed confirmation from old destroy',
    });
    expect(staleDestroy).toEqual({ closed: false, staleIncarnation: true });
    expect(onUnmatched).not.toHaveBeenCalled();

    const open = await listOpenCloudResourceObligations(db.adminSql, { workspaceId });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: old.id,
      resourceId,
      incarnationId: newIncarnation,
      teardownOwed: true,
      closedAtMs: null,
    });

    expect(
      await closeCloudResourceObligation(db.adminSql, {
        ...base,
        incarnationId: newIncarnation,
        reason: 'provider confirmed replacement destroy',
      }),
    ).toEqual({ closed: true });

    // A replay of the same create event after its confirmed destroy is idempotent and must not
    // reopen the already-closed incarnation.
    expect(
      await recordCloudResourceObligation(db.adminSql, {
        ...base,
        incarnationId: newIncarnation,
        purpose: 'replacement host generation',
      }),
    ).toEqual({ id: old.id, created: false });
    expect(await listOpenCloudResourceObligations(db.adminSql, { workspaceId })).toEqual([]);
  });
});
