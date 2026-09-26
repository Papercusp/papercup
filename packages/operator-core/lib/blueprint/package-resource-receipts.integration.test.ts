import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  applyPackageResourceDependent, packageResourceKey, preparePackageResource,
  readPackageResourceReceipt, releasePackageResource,
  type PackageResourceAddress, type PackageResourceDriver,
} from './package-resource-receipts';

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  // Exercise the reserved draft against an isolated database before arming it.
  await db.adminSql.unsafe(readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1230-blueprint-package-resource-receipts.sql.DRAFT', import.meta.url), 'utf8'));
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const address = (name: string, version = '1.0.0'): PackageResourceAddress => ({
  workspaceId: 'resource-test', memoryScope: 'hive:test', packageKind: 'knowledge-pack',
  packageRef: name, packageVersion: version, packageHash: hash(name + version),
  resourceKind: 'memory', itemKey: 'item', installedHash: hash('original'),
});

function externalStore() {
  const rows = new Map<string, { writeKey: string; original: string; current: string }>();
  let loseReply = false;
  let failDelete = false;
  const driver: PackageResourceDriver = {
    recover: vi.fn(async (key) => [...rows].filter(([, row]) => row.writeKey === key)
      .map(([id, row]) => ({ id, fingerprint: row.original }))),
    create: vi.fn(async (key) => {
      const id = `external-${rows.size}`;
      rows.set(id, { writeKey: key, original: hash('original'), current: hash('original') });
      if (loseReply) { loseReply = false; throw new Error('process died after external commit'); }
      return [{ id, fingerprint: hash('original') }];
    }),
    removeIfUnchanged: vi.fn(async ({ id, fingerprint }) => {
      if (failDelete) throw new Error('external cleanup unavailable');
      const row = rows.get(id);
      if (!row) return 'absent';
      if (row.current !== fingerprint) return 'changed';
      rows.delete(id);
      return 'removed';
    }),
  };
  return { driver, rows, loseReply: () => { loseReply = true; }, failDelete: (value: boolean) => { failDelete = value; } };
}

describe('blueprint package resource journal (real Postgres)', () => {
  it('shares exact-version writes, waits for the final dependent and keeps versions separate', async () => {
    const store = externalStore();
    const v1 = address('shared');
    const v2 = address('shared', '2.0.0');
    const one = await preparePackageResource(db.adminSql, v1, 'wearer-a', store.driver);
    const two = await preparePackageResource(db.adminSql, v1, 'wearer-b', store.driver);
    const newer = await preparePackageResource(db.adminSql, v2, 'wearer-c', store.driver);
    expect(one.external_refs).toEqual(two.external_refs);
    expect(newer.resource_key).not.toBe(one.resource_key);
    expect(store.driver.create).toHaveBeenCalledTimes(2);
    expect(await releasePackageResource(db.adminSql, v1, 'wearer-a', store.driver)).toMatchObject({ phase: 'ready' });
    expect(store.driver.removeIfUnchanged).not.toHaveBeenCalled();
    expect(await releasePackageResource(db.adminSql, v1, 'wearer-b', store.driver)).toMatchObject({ phase: 'deleted' });
    expect(store.rows.has(newer.external_refs[0]!.id)).toBe(true);
    await releasePackageResource(db.adminSql, v1, 'wearer-b', store.driver);
    expect(store.driver.removeIfUnchanged).toHaveBeenCalledTimes(1);
    await expect(releasePackageResource(db.adminSql, v2, 'stranger', store.driver)).rejects.toThrow(/does not own/);
  });

  it('recovers an ambiguous external commit with the persisted write key after a fresh import', async () => {
    const store = externalStore();
    const input = address('interrupted');
    store.loseReply();
    await expect(preparePackageResource(db.adminSql, input, 'restart', store.driver)).rejects.toThrow(/process died/);
    expect(await readPackageResourceReceipt(db.adminSql, input.workspaceId, packageResourceKey(input)))
      .toMatchObject({ phase: 'intent', error: 'process died after external commit' });
    vi.resetModules();
    const fresh = await import('./package-resource-receipts');
    const receipt = await fresh.preparePackageResource(db.adminSql, input, 'restart', store.driver);
    expect(receipt).toMatchObject({ phase: 'ready', external_refs: [{ id: 'external-0' }] });
    expect(store.driver.create).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(1);
  });

  it('compensates unacknowledged writes, reports retryable failures and preserves edits plus organic rows', async () => {
    const store = externalStore();
    const input = address('compensation');
    store.rows.set('organic', { writeKey: 'not-owned', original: hash('organic'), current: hash('organic') });
    store.loseReply();
    await expect(preparePackageResource(db.adminSql, input, 'failed-install', store.driver)).rejects.toThrow(/process died/);
    store.failDelete(true);
    const failed = await releasePackageResource(db.adminSql, input, 'failed-install', store.driver);
    expect(failed).toMatchObject({ phase: 'cleanup_failed', error: expect.stringContaining('external-1'),
      external_refs: [{ id: 'external-1', error: 'external cleanup unavailable' }] });
    store.rows.get('external-1')!.current = hash('user edit during recovery');
    store.failDelete(false);
    const retried = await releasePackageResource(db.adminSql, input, 'failed-install', store.driver);
    expect(retried).toMatchObject({ phase: 'detached', error: null,
      external_refs: [{ id: 'external-1', disposition: 'changed' }] });
    expect([...store.rows.keys()]).toEqual(['organic', 'external-1']);
    await expect(preparePackageResource(db.adminSql, input, 'later-install', store.driver)).rejects.toThrow(/was edited/);
  });

  it('does not promote preparation when the surrounding activation transaction rolls back', async () => {
    const store = externalStore();
    const input = address('activation');
    await expect(db.adminSql.begin((tx) => applyPackageResourceDependent(tx, input.workspaceId, 'unknown')))
      .rejects.toThrow(/has not been prepared/);
    await preparePackageResource(db.adminSql, input, 'atomic-activation', store.driver);
    await expect(db.adminSql.begin(async (tx) => {
      await applyPackageResourceDependent(tx, input.workspaceId, 'atomic-activation');
      throw new Error('host activation failed');
    })).rejects.toThrow('host activation failed');
    const read = () => db.adminSql<{ phase: string }[]>`SELECT phase FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${input.workspaceId} AND dependent_id = 'atomic-activation'`;
    expect(await read()).toEqual([{ phase: 'prepared' }]);
    await db.adminSql.begin((tx) => applyPackageResourceDependent(tx, input.workspaceId, 'atomic-activation'));
    expect(await read()).toEqual([{ phase: 'applied' }]);
    await releasePackageResource(db.adminSql, input, 'atomic-activation', store.driver);
    await expect(db.adminSql.begin((tx) => applyPackageResourceDependent(tx, input.workspaceId, 'atomic-activation')))
      .rejects.toThrow(/not prepared/);
    await expect(preparePackageResource(db.adminSql, input, 'atomic-activation', store.driver))
      .rejects.toThrow(/released installation/);
  });

  it('keeps failed recovery visible and retries discovery before cleaning uncertain external writes', async () => {
    const store = externalStore();
    const input = address('recovery-unavailable');
    store.loseReply();
    await expect(preparePackageResource(db.adminSql, input, 'retry-discovery', store.driver)).rejects.toThrow(/process died/);
    vi.mocked(store.driver.recover).mockRejectedValueOnce(new Error('backend offline'));
    expect(await releasePackageResource(db.adminSql, input, 'retry-discovery', store.driver))
      .toMatchObject({ phase: 'cleanup_failed', error: 'backend offline' });
    expect(store.rows.size).toBe(1);
    expect(await releasePackageResource(db.adminSql, input, 'retry-discovery', store.driver))
      .toMatchObject({ phase: 'deleted', error: null });
    expect(store.rows.size).toBe(0);
  });

  it('serializes concurrent installers and release without duplicate writes or deleting a dependent', async () => {
    const store = externalStore();
    const input = address('concurrent');
    const [one, two] = await Promise.all([
      preparePackageResource(db.adminSql, input, 'parallel-a', store.driver),
      preparePackageResource(db.adminSql, input, 'parallel-b', store.driver),
    ]);
    expect(one.external_refs).toEqual(two.external_refs);
    expect(store.driver.create).toHaveBeenCalledTimes(1);
    await Promise.all([
      releasePackageResource(db.adminSql, input, 'parallel-a', store.driver),
      preparePackageResource(db.adminSql, input, 'parallel-c', store.driver),
    ]);
    expect(store.driver.removeIfUnchanged).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(1);
    await expect(preparePackageResource(db.adminSql, { ...input, installedHash: hash('mutated') }, 'tampered', store.driver))
      .rejects.toThrow(/content changed/);
    expect(store.driver.create).toHaveBeenCalledTimes(1);
  });
});
