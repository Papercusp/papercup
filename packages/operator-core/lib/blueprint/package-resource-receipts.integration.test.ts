import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  applyPackageResourceDependent, packageResourceKey, preparePackageResource,
  readPackageResourceReceipt, releasePackageResource,
  beginPackageInstallation, readPackageInstallation, beginPackageInstallationRelease, finishPackageInstallationRelease,
  carryAppliedPackageInstallation,
  type PackageResourceAddress, type PackageResourceDriver,
} from './package-resource-receipts';

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  const draft = new URL('../../../../libs/papercusp/libs/db/sql/1232-blueprint-package-installations.sql.DRAFT', import.meta.url);
  if (existsSync(draft)) await db.adminSql.unsafe(readFileSync(draft, 'utf8'));
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
    cancel: vi.fn(async () => {}),
    recover: vi.fn(async (key) => [...rows].filter(([, row]) => row.writeKey === key)
      .map(([id, row]) => ({ id, fingerprint: row.original,
        ...(row.current === row.original ? {} : { disposition: 'changed' as const }) }))),
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
  it('carries unchanged applied resources across state revisions atomically and keeps independent release ownership', async () => {
    const store = externalStore();
    const resource = address('control-state-carry');
    const from = { workspaceId: resource.workspaceId, dependentId: 'control-before', ownerId: 'control-wearer',
      specificationRevision: hash('control-spec'), stateRevision: hash('mode-before'),
      expectedResources: new Map([[packageResourceKey(resource), resource.installedHash]]) };
    await beginPackageInstallation(db.adminSql, from);
    const receipt = await preparePackageResource(db.adminSql, resource, from.dependentId, store.driver);
    const to = { ...from, dependentId: 'control-after', stateRevision: hash('mode-after'), fromDependentId: from.dependentId };
    await expect(db.adminSql.begin((tx) => carryAppliedPackageInstallation(tx, to))).rejects.toThrow(/applied specification/);
    await db.adminSql.begin((tx) => applyPackageResourceDependent(tx, from.workspaceId, from.dependentId));
    await expect(db.adminSql.begin(async (tx) => {
      await carryAppliedPackageInstallation(tx, to);
      throw new Error('mode write rolled back');
    })).rejects.toThrow('mode write rolled back');
    expect(await readPackageInstallation(db.adminSql, to.workspaceId, to.dependentId)).toBeNull();
    for (const wrong of [{ ownerId: 'another-wearer' }, { specificationRevision: hash('changed-spec') },
      { expectedResources: new Map<string, string>() }]) {
      await expect(db.adminSql.begin((tx) => carryAppliedPackageInstallation(tx, { ...to, ...wrong })))
        .rejects.toThrow(/applied specification|complete applied pin set/);
    }
    await db.adminSql.begin((tx) => carryAppliedPackageInstallation(tx, to));
    await db.adminSql.begin((tx) => carryAppliedPackageInstallation(tx, to));
    expect(await readPackageInstallation(db.adminSql, to.workspaceId, to.dependentId)).toMatchObject({ phase: 'preparing' });
    expect(await db.adminSql`SELECT phase FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${to.workspaceId} AND dependent_id = ${to.dependentId}`).toEqual([{ phase: 'prepared' }]);
    await beginPackageInstallationRelease(db.adminSql, from.workspaceId, from.dependentId);
    expect((await releasePackageResource(db.adminSql, resource, from.dependentId, store.driver))?.phase).toBe('ready');
    await finishPackageInstallationRelease(db.adminSql, from.workspaceId, from.dependentId);
    await expect(db.adminSql.begin((tx) => carryAppliedPackageInstallation(tx, { ...to, dependentId: 'late-control' })))
      .rejects.toThrow(/applied specification/);
    await db.adminSql.begin((tx) => applyPackageResourceDependent(tx, to.workspaceId, to.dependentId));
    expect(store.driver.create).toHaveBeenCalledTimes(1);
    expect(await readPackageResourceReceipt(db.adminSql, resource.workspaceId, receipt.resource_key)).toEqual(receipt);
    await beginPackageInstallationRelease(db.adminSql, to.workspaceId, to.dependentId);
    await releasePackageResource(db.adminSql, resource, to.dependentId, store.driver);
    await finishPackageInstallationRelease(db.adminSql, to.workspaceId, to.dependentId);
    expect(store.rows.size).toBe(0);
    await expect(db.adminSql.begin((tx) => carryAppliedPackageInstallation(tx, { ...from, fromDependentId: to.dependentId })))
      .rejects.toThrow(/applied specification/);
  });

  it('distinguishes an explicit empty manifest from missing preparation and fences it after release', async () => {
    const workspaceId = 'empty-manifest';
    const dependentId = 'empty';
    const input = { workspaceId, dependentId, ownerId: 'wearer', specificationRevision: hash('spec'),
      stateRevision: hash('state'), expectedResources: new Map<string, string>() };
    await beginPackageInstallation(db.adminSql, input);
    await db.adminSql.begin((tx) => applyPackageResourceDependent(tx, workspaceId, dependentId, new Map()));
    expect(await readPackageInstallation(db.adminSql, workspaceId, dependentId)).toMatchObject({ phase: 'applied', expected_resources: {} });
    expect(await beginPackageInstallationRelease(db.adminSql, workspaceId, dependentId, { onlyUnapplied: true })).toBe(false);
    await beginPackageInstallationRelease(db.adminSql, workspaceId, dependentId);
    await finishPackageInstallationRelease(db.adminSql, workspaceId, dependentId);
    expect(await readPackageInstallation(db.adminSql, workspaceId, dependentId)).toMatchObject({ phase: 'released' });
    await expect(beginPackageInstallation(db.adminSql, input)).rejects.toThrow(/released installation/);
    await expect(db.adminSql.begin((tx) => applyPackageResourceDependent(tx, workspaceId, dependentId, new Map(), { allowLegacyUnprepared: true })))
      .rejects.toThrow(/has been released/);
  });

  it('refuses incomplete or changed manifests and records retryable whole-install cleanup', async () => {
    const store = externalStore();
    const resource = address('manifest-members');
    const second = { ...resource, itemKey: 'second' };
    const input = { workspaceId: resource.workspaceId, dependentId: 'manifest-members', ownerId: 'wearer',
      specificationRevision: hash('spec'), stateRevision: hash('state'),
      expectedResources: new Map([resource, second].map((a) => [packageResourceKey(a), a.installedHash])) };
    await beginPackageInstallation(db.adminSql, input);
    await beginPackageInstallation(db.adminSql, input); // crash/restart replay
    await expect(beginPackageInstallation(db.adminSql, { ...input, expectedResources: new Map() })).rejects.toThrow(/manifest cannot change/);
    await expect(preparePackageResource(db.adminSql, { ...resource, itemKey: 'foreign' }, input.dependentId, store.driver))
      .rejects.toThrow(/outside the installation manifest/);
    await preparePackageResource(db.adminSql, resource, input.dependentId, store.driver);
    await expect(db.adminSql.begin((tx) => applyPackageResourceDependent(tx, input.workspaceId, input.dependentId)))
      .rejects.toThrow(/complete applied pin set/);
    await beginPackageInstallationRelease(db.adminSql, input.workspaceId, input.dependentId);
    await expect(preparePackageResource(db.adminSql, second, input.dependentId, store.driver)).rejects.toThrow(/released installation/);
    store.failDelete(true);
    await releasePackageResource(db.adminSql, resource, input.dependentId, store.driver);
    await finishPackageInstallationRelease(db.adminSql, input.workspaceId, input.dependentId);
    expect(await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId))
      .toMatchObject({ phase: 'cleanup_failed', error: expect.stringContaining('external cleanup unavailable') });
    store.failDelete(false);
    await beginPackageInstallationRelease(db.adminSql, input.workspaceId, input.dependentId);
    await releasePackageResource(db.adminSql, resource, input.dependentId, store.driver);
    await finishPackageInstallationRelease(db.adminSql, input.workspaceId, input.dependentId);
    expect(await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId)).toMatchObject({ phase: 'released', error: null });
    expect(store.rows.size).toBe(0);
  });

  it('checks the exact expected set at promotion and seals it against late preparation', async () => {
    const store = externalStore();
    const first = address('sealed-set');
    const second = { ...first, itemKey: 'second' };
    const dependent = 'sealed-dependent';
    const prepared = await preparePackageResource(db.adminSql, first, dependent, store.driver);
    // This is the host's validated set. A preparer adds a row before promotion.
    const expected = new Map([[prepared.resource_key, prepared.installed_hash]]);
    await preparePackageResource(db.adminSql, second, dependent, store.driver);
    await expect(db.adminSql.begin((tx) => applyPackageResourceDependent(tx, first.workspaceId, dependent, expected)))
      .rejects.toThrow(/complete applied pin set/);
    expect(await db.adminSql`SELECT DISTINCT phase FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${first.workspaceId} AND dependent_id = ${dependent}`)
      .toEqual([{ phase: 'prepared' }]);
    expected.set(packageResourceKey(second), second.installedHash);
    await db.adminSql.begin((tx) => applyPackageResourceDependent(tx, first.workspaceId, dependent, expected));
    await expect(preparePackageResource(db.adminSql, { ...first, itemKey: 'late' }, dependent, store.driver))
      .rejects.toThrow(/applied installation/);
    // An idempotent replay of an existing member remains safe and supported.
    expect(await preparePackageResource(db.adminSql, first, dependent, store.driver)).toEqual(prepared);
    expect(store.driver.create).toHaveBeenCalledTimes(2);
  });

  it('rechecks the expected hashes after waiting for the dependent transaction lock', async () => {
    const store = externalStore();
    const input = address('locked-set');
    const dependent = 'locked-dependent';
    const receipt = await preparePackageResource(db.adminSql, input, dependent, store.driver);
    const expected = new Map([[receipt.resource_key, receipt.installed_hash]]);
    let promote!: Promise<unknown>;
    const contender = await db.adminSql.reserve();
    try {
      const [connection] = await contender`SELECT pg_backend_pid() AS pid`;
      await contender`BEGIN`;
      await db.adminSql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
          'blueprint-package-resource', input.workspaceId, 'dependent:' + dependent,
        ])}, 0))`;
        promote = (async () => {
          try {
            await applyPackageResourceDependent(contender as unknown as TransactionSql, input.workspaceId, dependent, expected);
            await contender`COMMIT`;
            return null;
          } catch (error) {
            await contender`ROLLBACK`;
            return error;
          }
        })();
        // Observe THIS already-connected contender, not any unrelated waiter.
        await vi.waitFor(async () => {
          const [waiting] = await tx`SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND pid = ${connection.pid}`;
          expect(waiting.n).toBe(1);
        }, { timeout: 5_000 });
        await tx`UPDATE harness_shared.blueprint_package_resources SET installed_hash = ${hash('changed')}
          WHERE workspace_id = ${input.workspaceId} AND resource_key = ${receipt.resource_key}`;
      });
      expect(await promote).toMatchObject({ message: expect.stringMatching(/complete applied pin set/) });
    } finally {
      await promote;
      contender.release();
    }
    expect(await db.adminSql`SELECT phase FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${input.workspaceId} AND dependent_id = ${dependent}`).toEqual([{ phase: 'prepared' }]);
  });

  it('isolates both receipt tables by workspace for the application role', async () => {
    for (const workspaceId of ['private-a', 'private-b']) {
      await beginPackageInstallation(db.adminSql, { workspaceId, dependentId: 'empty-private', ownerId: 'wearer',
        specificationRevision: hash('spec'), stateRevision: hash('state'), expectedResources: new Map() });
      await preparePackageResource(db.adminSql, { ...address('private'), workspaceId }, 'same-dependent', externalStore().driver);
    }
    await db.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', 'private-a', true)`;
      expect(await tx`SELECT workspace_id FROM harness_shared.blueprint_package_resources`)
        .toEqual([{ workspace_id: 'private-a' }]);
      expect(await tx`SELECT workspace_id FROM harness_shared.blueprint_package_dependents`)
        .toEqual([{ workspace_id: 'private-a' }]);
      expect(await tx`SELECT workspace_id FROM harness_shared.blueprint_package_installations`)
        .toEqual([{ workspace_id: 'private-a' }]);
    });
  });

  it('shares exact-version writes, waits for the final dependent and keeps versions separate', async () => {
    const store = externalStore();
    const v1 = address('shared');
    const v2 = address('shared', '2.0.0');
    const one = await preparePackageResource(db.adminSql, v1, 'wearer-a', store.driver);
    const two = await preparePackageResource(db.adminSql, v1, 'wearer-b', store.driver);
    const newer = await preparePackageResource(db.adminSql, v2, 'wearer-c', store.driver);
    await expect(preparePackageResource(db.adminSql, v2, 'wearer-a', store.driver)).rejects.toThrow(/package-pin-conflict/);
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
    await expect(preparePackageResource(db.adminSql, input, 'cannot-pin-failed-cleanup', store.driver))
      .rejects.toThrow(/cleanup recovery/);
    expect(await db.adminSql`SELECT dependent_id FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${input.workspaceId} AND dependent_id = 'cannot-pin-failed-cleanup'`).toHaveLength(0);
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

  it('refuses adoption of an edited ready resource and preserves it during interrupted-write cleanup', async () => {
    const store = externalStore();
    const input = address('edited-ready');
    await preparePackageResource(db.adminSql, input, 'original-user', store.driver);
    store.rows.get('external-0')!.current = hash('edited');
    await expect(preparePackageResource(db.adminSql, input, 'new-user', store.driver)).rejects.toThrow(/resource changed/);
    await releasePackageResource(db.adminSql, input, 'new-user', store.driver);
    expect(await releasePackageResource(db.adminSql, input, 'original-user', store.driver)).toMatchObject({ phase: 'detached' });
    expect(store.rows.size).toBe(1);
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
