/**
 * Real-Postgres regression for same-name resource recreation and stale destroy ordering.
 *
 * The fake-SQL writer tests cannot prove the unique-key conflict/update behavior or the close
 * predicate against PostgreSQL. This suite exercises the applied migration and ledger queries
 * against the real isolated test database; it never contacts a cloud provider.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import {
  closeCloudResourceObligation,
  createCloudResourceObligationCloseObserver,
  listOpenCloudResourceObligations,
  recordCloudResourceObligation,
} from './cloud-resource-obligations';

const { createOrgTestDb } = await import('../../test/_org-test-db');

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

  // WI-10003510: the r55 canary VM's delete timed out and was confirmed on the reconciling
  // NOT-FOUND read, which carries no incarnation id. The row was incarnation-stamped, so the
  // close matched nothing and the obligation escalated a phantom. An absence read at T closes the
  // row iff it was (re)recorded at or before T — never a replacement recorded after T.
  it('closes an incarnation-stamped VM on a not-found confirmation, but not a replacement recorded after the read', async () => {
    const absentWorkspace = 'cloud-resource-obligation-absent-read-ws';
    const vm = { ...base, workspaceId: absentWorkspace, resourceId: 'pc-host-absent-read-regression-vm' };
    const onUnmatched = vi.fn();
    const closeObserver = createCloudResourceObligationCloseObserver({ sql: db.adminSql, onUnmatched });

    await recordCloudResourceObligation(db.adminSql, { ...vm, incarnationId: 'gce-instance-2001', purpose: 'first' });
    const readBeforeReplacement = new Date(Date.now() + 1_000).toISOString();

    expect(
      await closeObserver({
        workspaceId: absentWorkspace,
        resource: { deleteOp: 'delete-instance', providerId: vm.resourceId, confirmedAbsentAt: readBeforeReplacement },
      }),
    ).toEqual({ closed: true });
    expect(onUnmatched).not.toHaveBeenCalled();
    expect(await listOpenCloudResourceObligations(db.adminSql, { workspaceId: absentWorkspace })).toEqual([]);

    // A replacement recorded AFTER an absence read: a late-delivered copy of that read must not
    // close it (the read proved only the earlier incarnation gone).
    const staleRead = new Date(Date.now() - 60_000).toISOString();
    await recordCloudResourceObligation(db.adminSql, { ...vm, incarnationId: 'gce-instance-2002', purpose: 'replacement' });
    expect(
      await closeObserver({
        workspaceId: absentWorkspace,
        resource: { deleteOp: 'delete-instance', providerId: vm.resourceId, confirmedAbsentAt: staleRead },
      }),
    ).toEqual({ closed: false });
    expect(onUnmatched).toHaveBeenCalledTimes(1);
    const open = await listOpenCloudResourceObligations(db.adminSql, { workspaceId: absentWorkspace });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ incarnationId: 'gce-instance-2002', teardownOwed: true, closedAtMs: null });
  });
});
