import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  applyPackageResourceDependent, packageResourceKey, preparePackageResource,
  readPackageResourceReceipt, releasePackageResource, readPackageResourcePopulation,
  beginPackageInstallation, readPackageInstallation, beginPackageInstallationRelease, finishPackageInstallationRelease,
  carryAppliedPackageInstallation,
  declarePackageInstallationHumanOwner, type PackageInstallationHumanOwnerProof,
  declarePackageInstallationScopedGrants, packageInstallationScopedGrantsSchema,
  type PackageInstallationScopedGrantProof, type PackageInstallationScopedGrants,
  type PackageResourceAddress, type PackageResourceDriver,
} from './package-resource-receipts';
import { retainRequestPrincipal } from '../auth/require-principal';
import type { Principal } from '@papercusp/agent-mcp';
let cookiePrincipal: Principal | null = null;
vi.mock('../auth/principal/from-cookie', () => ({ principalFromCookie: vi.fn(async () => cookiePrincipal) }));

async function humanOwner(input: { workspaceId: string; ownerId: string; specificationRevision: string }, userId = 'human-one') {
  cookiePrincipal = { kind: 'user', trust: 'verified', authMethod: 'cookie-session', slug: userId,
    workspaceId: input.workspaceId, capabilities: new Set(['tasks:read']) };
  const resolvePrincipal = await retainRequestPrincipal(new Headers(), input.workspaceId);
  const declaration = { declaration: 'self' as const, userId, ownerId: input.ownerId,
    specificationRevision: input.specificationRevision };
  return { proof: await declarePackageInstallationHumanOwner({ ...input, resolvePrincipal }, declaration),
    declaration, resolvePrincipal };
}

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  const draft = new URL('../../../../libs/papercusp/libs/db/sql/1232-blueprint-package-installations.sql.DRAFT', import.meta.url);
  if (existsSync(draft)) await db.adminSql.unsafe(readFileSync(draft, 'utf8'));
  const ownership = new URL('../../../../libs/papercusp/libs/db/sql/1645-blueprint-installation-human-ownership.sql.DRAFT', import.meta.url);
  if (existsSync(ownership)) await db.adminSql.unsafe(readFileSync(ownership, 'utf8'));
  const scopes = new URL('../../../../libs/papercusp/libs/db/sql/1648-blueprint-installation-scoped-grants.sql', import.meta.url);
  await db.adminSql.unsafe(readFileSync(existsSync(scopes) ? scopes : new URL(scopes.href + '.DRAFT'), 'utf8'));
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
  const emptyInstall = (name: string) => ({ workspaceId: 'human-ownership', ownerId: 'wearer-' + name,
    dependentId: name, specificationRevision: hash(name), stateRevision: hash('state'), expectedResources: new Map<string, string>() });

  const scopedDeclaration = (): PackageInstallationScopedGrants => ({ schemaVersion: 1, layers: [{
    layerRef: 'domain:scoped-test', layerContentHash: hash('scoped-layer'),
    grants: { actions: { allow: ['read'] }, resources: { allow: ['store:read:workspace-one'] } },
  }] });

  it('stores explicit layer scopes, preserves unknown legacy rows, and includes the source in the census', async () => {
    const input = emptyInstall('scoped-recorded');
    const { proof } = await humanOwner(input);
    const declaration = scopedDeclaration();
    const scopedGrants = await declarePackageInstallationScopedGrants(proof, declaration);
    declaration.layers[0].grants.resources.allow[0] = '*'; // caller cannot widen retained evidence
    await beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof, scopedGrants });
    const receipt = await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId);
    expect(receipt?.scoped_grants).toEqual(scopedDeclaration());
    await beginPackageInstallation(db.adminSql, input); // recovery does not erase evidence
    expect((await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId))?.scoped_grants)
      .toEqual(scopedDeclaration());
    const census = await readPackageResourcePopulation(db.adminSql, input.workspaceId);
    if (census.status !== 'ok') throw new Error('expected complete journal source');
    expect(census.installations.find(row => row.dependent_id === input.dependentId)?.scoped_grants)
      .toEqual(scopedDeclaration());
    const legacy = emptyInstall('scoped-unknown');
    await beginPackageInstallation(db.adminSql, legacy);
    expect((await readPackageInstallation(db.adminSql, legacy.workspaceId, legacy.dependentId))?.scoped_grants).toBeNull();
  });

  it('refuses forged scope evidence, another ownership proof, and revoked credentials before persistence', async () => {
    const input = emptyInstall('scoped-forged');
    const { proof } = await humanOwner(input);
    const scopedGrants = await declarePackageInstallationScopedGrants(proof, scopedDeclaration());
    await expect(declarePackageInstallationScopedGrants({} as PackageInstallationHumanOwnerProof, scopedDeclaration()))
      .rejects.toThrow(/original host-local/);
    await expect(beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof,
      scopedGrants: {} as PackageInstallationScopedGrantProof })).rejects.toThrow(/same original/);
    await expect(beginPackageInstallation(db.adminSql, { ...input, scopedGrants })).rejects.toThrow(/same original/);
    const other = await humanOwner(input);
    await expect(beginPackageInstallation(db.adminSql, { ...input, humanOwner: other.proof, scopedGrants }))
      .rejects.toThrow(/same original/);
    cookiePrincipal = null;
    await expect(declarePackageInstallationScopedGrants(proof, scopedDeclaration())).rejects.toThrow(/credentials changed/);
    await expect(beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof, scopedGrants }))
      .rejects.toThrow(/credentials changed/);
    expect(await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId)).toBeNull();
  });

  it('keeps scoped grants immutable, including unknown-to-known SQL and application backfill', async () => {
    const input = emptyInstall('scoped-immutable');
    const { proof } = await humanOwner(input);
    const scopedGrants = await declarePackageInstallationScopedGrants(proof, scopedDeclaration());
    await beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof, scopedGrants });
    await expect(db.adminSql`UPDATE harness_shared.blueprint_package_installations SET scoped_grants = NULL
      WHERE workspace_id = ${input.workspaceId} AND dependent_id = ${input.dependentId}`)
      .rejects.toThrow(/immutable per attempt/);
    const changed = scopedDeclaration(); changed.layers[0].grants.actions.allow = ['*'];
    await expect(beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof,
      scopedGrants: await declarePackageInstallationScopedGrants(proof, changed) })).rejects.toThrow(/immutable per attempt/);
    const unknown = { ...input, dependentId: input.dependentId + '-unknown' };
    await beginPackageInstallation(db.adminSql, { ...unknown, humanOwner: proof });
    await expect(beginPackageInstallation(db.adminSql, { ...unknown, humanOwner: proof, scopedGrants }))
      .rejects.toThrow(/immutable per attempt/);
    await expect(db.adminSql`UPDATE harness_shared.blueprint_package_installations
      SET scoped_grants = ${db.adminSql.json(scopedDeclaration())}
      WHERE workspace_id = ${input.workspaceId} AND dependent_id = ${unknown.dependentId}`)
      .rejects.toThrow(/immutable per attempt/);
  });

  it('preserves exact scoped grants across applied carry, release and rollback without accepting replacement evidence', async () => {
    const input = emptyInstall('scoped-carry');
    const { proof } = await humanOwner(input);
    const scopedGrants = await declarePackageInstallationScopedGrants(proof, scopedDeclaration());
    await beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof, scopedGrants });
    await db.adminSql.begin(tx => applyPackageResourceDependent(tx, input.workspaceId, input.dependentId, input.expectedResources));
    const next = { ...input, dependentId: input.dependentId + '-next', stateRevision: hash('next-state'),
      fromDependentId: input.dependentId };
    await db.adminSql.begin(tx => carryAppliedPackageInstallation(tx, next));
    expect((await readPackageInstallation(db.adminSql, input.workspaceId, next.dependentId))?.scoped_grants)
      .toEqual(scopedDeclaration());
    await beginPackageInstallationRelease(db.adminSql, input.workspaceId, input.dependentId);
    await finishPackageInstallationRelease(db.adminSql, input.workspaceId, input.dependentId);
    const rollback = { ...input, dependentId: input.dependentId + '-rollback', ownershipFromDependentId: input.dependentId };
    await beginPackageInstallation(db.adminSql, rollback);
    expect((await readPackageInstallation(db.adminSql, input.workspaceId, rollback.dependentId))?.scoped_grants)
      .toEqual(scopedDeclaration());
    await expect(beginPackageInstallation(db.adminSql, { ...rollback, scopedGrants })).rejects.toThrow(/carried provenance/);
  });

  it.each(['missing-actions', 'missing-allow', 'extra-category', 'extra-field', 'duplicate', 'bad-hash', 'blank-pattern'])
  ('rejects malformed scoped grant declarations in both the authoring schema and database (%s)', async kind => {
    const value: any = scopedDeclaration();
    if (kind === 'missing-actions') delete value.layers[0].grants.actions;
    if (kind === 'missing-allow') value.layers[0].grants.actions = { deny: ['write'] };
    if (kind === 'extra-category') value.layers[0].grants.tools = { allow: ['*'] };
    if (kind === 'extra-field') value.admin = true;
    if (kind === 'duplicate') value.layers.push(structuredClone(value.layers[0]));
    if (kind === 'bad-hash') value.layers[0].layerContentHash = 'latest';
    if (kind === 'blank-pattern') value.layers[0].grants.resources.allow = [' '];
    expect(packageInstallationScopedGrantsSchema.safeParse(value).success).toBe(false);
    const [result] = await db.adminSql`SELECT harness_shared.blueprint_installation_scoped_grants_valid(${db.adminSql.json(value)}) AS valid`;
    expect(result.valid).toBe(false);
  });

  it('retains an explicit empty grant and denies a stored grant without human ownership', async () => {
    const input = emptyInstall('scoped-empty');
    const { proof } = await humanOwner(input);
    const empty = scopedDeclaration(); empty.layers[0].grants.actions.allow = []; empty.layers[0].grants.resources.allow = [];
    await beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof,
      scopedGrants: await declarePackageInstallationScopedGrants(proof, empty) });
    expect((await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId))?.scoped_grants).toEqual(empty);
    await expect(db.adminSql`INSERT INTO harness_shared.blueprint_package_installations
      (workspace_id, dependent_id, owner_id, specification_revision, state_revision, expected_resources, scoped_grants)
      VALUES (${input.workspaceId}, 'scoped-no-human', ${input.ownerId}, ${input.specificationRevision}, ${input.stateRevision}, '{}',
        ${db.adminSql.json(empty)})`).rejects.toThrow(/scoped_grants_shape/);
  });

  const populationFixture = async (name: string) => {
    const resource = { ...address(name), workspaceId: 'population-' + name };
    const key = packageResourceKey(resource);
    const input = { ...emptyInstall(name), workspaceId: resource.workspaceId,
      expectedResources: new Map([[key, resource.installedHash]]) };
    const { proof } = await humanOwner(input);
    await beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof });
    const store = externalStore();
    await preparePackageResource(db.adminSql, resource, input.dependentId, store.driver);
    return { resource, key, input, store };
  };

  it('enumerates empty installs, shared resources, unknown legacy owners and released history without dropping references', async () => {
    const { input, resource, key, store } = await populationFixture('complete-journal');
    const empty = { ...emptyInstall('empty-journal'), workspaceId: input.workspaceId };
    await beginPackageInstallation(db.adminSql, empty);
    const legacy = { ...input, ownerId: 'legacy-wearer', dependentId: 'legacy-journal' };
    await beginPackageInstallation(db.adminSql, legacy);
    await preparePackageResource(db.adminSql, resource, legacy.dependentId, store.driver);
    // Supported pre-parent journal rows must remain visible with unknown
    // ownership; an INNER JOIN would silently omit this shared dependent.
    await preparePackageResource(db.adminSql, resource, 'no-parent-receipt', store.driver);
    await db.adminSql.begin(tx => applyPackageResourceDependent(tx, input.workspaceId, input.dependentId));
    await beginPackageInstallationRelease(db.adminSql, input.workspaceId, empty.dependentId);
    await finishPackageInstallationRelease(db.adminSql, input.workspaceId, empty.dependentId);
    await beginPackageInstallation(db.adminSql, { ...emptyInstall('foreign-journal'), workspaceId: 'foreign-journal' });
    const census = await readPackageResourcePopulation(db.adminSql, input.workspaceId);
    expect(census.status).toBe('ok');
    if (census.status !== 'ok') throw new Error('expected journal population');
    expect(census.scope).toBe('workspace-package-resource-journal');
    expect(census.installations.map(row => row.dependent_id)).toEqual([input.dependentId, empty.dependentId, legacy.dependentId]);
    expect(census.installations.find(row => row.dependent_id === empty.dependentId))
      .toMatchObject({ phase: 'released', expected_resources: {}, human_ownership: null });
    expect(census.installations.find(row => row.dependent_id === input.dependentId)?.human_ownership)
      .toMatchObject({ userId: 'human-one', ownerId: input.ownerId, specificationRevision: input.specificationRevision });
    expect(census.installations.find(row => row.dependent_id === legacy.dependentId)?.human_ownership).toBeNull();
    expect(census.resources).toHaveLength(1);
    expect(census.resources[0].resource_key).toBe(key);
    expect(census.dependents.map(row => row.dependent_id)).toEqual([input.dependentId, legacy.dependentId, 'no-parent-receipt']);
    // Detaching a result must not mutate the canonical source or its revision.
    census.installations[0].owner_id = 'forged-owner';
    expect(await readPackageResourcePopulation(db.adminSql, input.workspaceId)).toMatchObject({ revision: census.revision });
  });

  it('distinguishes verified empty journals and connection visibility, including RLS scope mismatch', async () => {
    const empty = await readPackageResourcePopulation(db.adminSql, 'empty-population');
    expect(empty).toMatchObject({ status: 'ok', installations: [], resources: [], dependents: [] });
    await expect(readPackageResourcePopulation(db.appSql, 'empty-population')).rejects.toThrow(/not visible/);
    await db.appSql.begin('isolation level repeatable read read only', async tx => {
      await tx`SELECT set_config('app.workspace_id', 'other-population', true)`;
      await expect(readPackageResourcePopulation(tx, 'empty-population')).rejects.toThrow(/not visible/);
    });
    const visible = await db.appSql.begin('isolation level repeatable read read only', async tx => {
      await tx`SELECT set_config('app.workspace_id', 'empty-population', true)`;
      return readPackageResourcePopulation(tx, 'empty-population');
    });
    expect(visible).toEqual(empty);
  });

  it.each(['installation', 'resource', 'dependent'] as const)('refuses stale %s evidence before a protected effect', async domain => {
    const { input, key } = await populationFixture('stale-' + domain);
    const before = await readPackageResourcePopulation(db.adminSql, input.workspaceId);
    if (domain === 'installation') await beginPackageInstallation(db.adminSql, {
      ...emptyInstall('new-install'), workspaceId: input.workspaceId });
    if (domain === 'resource') await db.adminSql`UPDATE harness_shared.blueprint_package_resources
      SET external_refs = '[{"id":"changed","fingerprint":"changed"}]'::jsonb
      WHERE workspace_id = ${input.workspaceId} AND resource_key = ${key}`;
    if (domain === 'dependent') await db.adminSql`UPDATE harness_shared.blueprint_package_dependents
      SET phase = 'released' WHERE workspace_id = ${input.workspaceId} AND dependent_id = ${input.dependentId}`;
    let effects = 0;
    await db.adminSql.begin(async tx => {
      const current = await readPackageResourcePopulation(tx, input.workspaceId, { expectedRevision: before.revision });
      expect(current.status).toBe('stale');
      if (current.status === 'ok') effects++;
    });
    expect(effects).toBe(0);
  });

  it.each(['installation', 'resource', 'dependent'] as const)('holds %s writes, including phantoms, until the effect transaction ends', async domain => {
    const { input, key } = await populationFixture('lease-' + domain);
    const before = await readPackageResourcePopulation(db.adminSql, input.workspaceId);
    let pending: Promise<unknown> | undefined;
    try {
      await db.adminSql.begin(async tx => {
        const [holder] = await tx`SELECT pg_backend_pid() AS pid`;
        expect(await readPackageResourcePopulation(tx, input.workspaceId, { expectedRevision: before.revision }))
          .toMatchObject({ status: 'ok', revision: before.revision });
        if (domain === 'installation') pending = beginPackageInstallation(db.adminSql, {
          ...emptyInstall('phantom-install'), workspaceId: input.workspaceId }).catch(error => error);
        if (domain === 'resource') pending = db.adminSql`UPDATE harness_shared.blueprint_package_resources
          SET error = 'concurrent-update' WHERE workspace_id = ${input.workspaceId} AND resource_key = ${key}`.execute().catch(error => error);
        if (domain === 'dependent') pending = db.adminSql`INSERT INTO harness_shared.blueprint_package_dependents
          (workspace_id, dependent_id, resource_key) VALUES (${input.workspaceId}, 'phantom-reference', ${key})`.execute().catch(error => error);
        await vi.waitFor(async () => {
          const [waiter] = await tx`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted
            AND ${holder.pid} = ANY(pg_blocking_pids(pid))`;
          expect(waiter.n).toBeGreaterThan(0);
        }, { timeout: 5000 });
        expect(await readPackageResourcePopulation(tx, input.workspaceId, { expectedRevision: before.revision }))
          .toMatchObject({ status: 'ok', revision: before.revision });
      });
      expect(await pending).not.toBeInstanceOf(Error);
    } finally { await pending; }
    expect(await readPackageResourcePopulation(db.adminSql, input.workspaceId)).not.toMatchObject({ revision: before.revision });
  });

  it('refuses historical effect snapshots, unguarded transaction reads and plain-client effect claims', async () => {
    const scope = 'population-old-snapshot';
    const before = await readPackageResourcePopulation(db.adminSql, scope);
    await expect(readPackageResourcePopulation(db.adminSql, scope, { expectedRevision: before.revision }))
      .rejects.toThrow(/existing transaction/);
    await db.adminSql.begin(async tx => {
      await expect(readPackageResourcePopulation(tx, scope)).rejects.toThrow(/snapshot requires/);
    });
    let effects = 0;
    await db.adminSql.begin('isolation level repeatable read', async tx => {
      await tx`SELECT count(*) FROM harness_shared.blueprint_package_installations`;
      await beginPackageInstallation(db.adminSql, { ...emptyInstall('newer-than-snapshot'), workspaceId: scope });
      await expect(readPackageResourcePopulation(tx, scope, { expectedRevision: before.revision }).then(result => {
        if (result.status === 'ok') effects++;
        return result;
      }))
        .rejects.toThrow(/read committed/);
      // A read-only historical inventory is explicitly a different contract.
      expect(await readPackageResourcePopulation(tx, scope)).toMatchObject({ revision: before.revision });
      expect(effects).toBe(0);
    });
    expect((await readPackageResourcePopulation(db.adminSql, scope)).revision).not.toBe(before.revision);
  });

  it('uses timezone-independent canonical revisions and refuses malformed persisted resource evidence', async () => {
    const { input, key } = await populationFixture('canonical-data');
    const before = await readPackageResourcePopulation(db.adminSql, input.workspaceId);
    const elsewhere = await db.adminSql.begin('isolation level repeatable read read only', async tx => {
      await tx`SET LOCAL TIME ZONE 'Pacific/Honolulu'`;
      return readPackageResourcePopulation(tx, input.workspaceId);
    });
    expect(elsewhere.revision).toBe(before.revision);
    await db.adminSql`UPDATE harness_shared.blueprint_package_resources SET external_refs = '[{"id":"missing-fingerprint"}]'::jsonb
      WHERE workspace_id = ${input.workspaceId} AND resource_key = ${key}`;
    await expect(readPackageResourcePopulation(db.adminSql, input.workspaceId)).rejects.toThrow(/malformed resource/);
  });

  it('snapshots the explicit ownership declaration before asynchronous authentication', async () => {
    const input = emptyInstall('declaration-snapshot');
    const { resolvePrincipal } = await humanOwner(input);
    const request = { workspaceId: input.workspaceId, resolvePrincipal };
    const declaration = { declaration: 'self' as const, userId: 'human-one', ownerId: input.ownerId,
      specificationRevision: input.specificationRevision };
    const pending = declarePackageInstallationHumanOwner(request, declaration);
    declaration.ownerId = 'mutated-after-call';
    request.workspaceId = 'mutated-after-call';
    await beginPackageInstallation(db.adminSql, { ...input, humanOwner: await pending });
    expect((await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId))?.human_ownership)
      .toMatchObject({ ownerId: input.ownerId, workspaceId: input.workspaceId });
  });

  it('rejects malformed provenance at the SQL boundary, including numeric scope lookalikes', async () => {
    const input = { ...emptyInstall('sql-shape'), workspaceId: '123', ownerId: '456' };
    const { proof } = await humanOwner(input);
    await beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof });
    const original = (await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId))!.human_ownership!;
    for (const [n, changed] of [{ workspaceId: 123 }, { ownerId: 456 }, { schemaVersion: '1' },
      { userId: 1 }, { userId: null }, { principalRevision: null }, { extra: true }].entries()) {
      await expect(db.adminSql`INSERT INTO harness_shared.blueprint_package_installations
        (workspace_id, dependent_id, owner_id, specification_revision, state_revision, expected_resources, human_ownership)
        VALUES (${input.workspaceId}, ${input.dependentId + '-' + n}, ${input.ownerId}, ${input.specificationRevision},
          ${input.stateRevision}, '{}'::jsonb, ${db.adminSql.json({ ...original, ...changed })})`)
        .rejects.toThrow(/human_ownership_shape/);
    }
  });

  it('records explicit authenticated human ownership, preserves it on replay, and refuses reattribution', async () => {
    const input = emptyInstall('declared');
    const evidence = await humanOwner(input);
    evidence.declaration.userId = 'changed-after-declaration';
    await beginPackageInstallation(db.adminSql, { ...input, humanOwner: evidence.proof });
    const first = await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId);
    expect(first?.human_ownership).toMatchObject({ userId: 'human-one', ownerId: input.ownerId,
      workspaceId: input.workspaceId, specificationRevision: input.specificationRevision, declaration: 'self',
      principalRevision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await beginPackageInstallation(db.adminSql, input); // recovery does not erase or manufacture evidence
    expect(await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId)).toEqual(first);
    const other = await humanOwner(input, 'human-two');
    await expect(beginPackageInstallation(db.adminSql, { ...input, humanOwner: other.proof })).rejects.toThrow(/immutable per attempt/);
    await expect(db.adminSql`UPDATE harness_shared.blueprint_package_installations SET human_ownership = NULL
      WHERE workspace_id = ${input.workspaceId} AND dependent_id = ${input.dependentId}`).rejects.toThrow(/immutable per attempt/);
    await expect(beginPackageInstallation(db.adminSql, { ...input, dependentId: 'forged',
      humanOwner: JSON.parse(JSON.stringify(evidence.proof)) as PackageInstallationHumanOwnerProof })).rejects.toThrow(/original host-local evidence/);
    expect(await readPackageInstallation(db.adminSql, input.workspaceId, 'forged')).toBeNull();
  });

  it('leaves legacy ownership unknown and refuses both application and direct-SQL backfill', async () => {
    const input = emptyInstall('legacy');
    await beginPackageInstallation(db.adminSql, input);
    expect((await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId))?.human_ownership).toBeNull();
    const { proof } = await humanOwner(input);
    await expect(beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof })).rejects.toThrow(/immutable per attempt/);
    await expect(db.adminSql`UPDATE harness_shared.blueprint_package_installations SET human_ownership = '{}'::jsonb
      WHERE workspace_id = ${input.workspaceId} AND dependent_id = ${input.dependentId}`).rejects.toThrow(/immutable per attempt/);
    await beginPackageInstallation(db.adminSql, { ...input, dependentId: 'new-explicit-attempt', humanOwner: proof });
    expect((await readPackageInstallation(db.adminSql, input.workspaceId, 'new-explicit-attempt'))?.human_ownership?.userId).toBe('human-one');
  });

  it('refuses forwarded resolvers, non-human principals, foreign self declarations and mismatched targets', async () => {
    const input = emptyInstall('scope');
    const { proof, resolvePrincipal } = await humanOwner(input);
    const declaration = { declaration: 'self' as const, userId: 'somebody-else', ownerId: input.ownerId,
      specificationRevision: input.specificationRevision };
    await expect(declarePackageInstallationHumanOwner({ ...input, resolvePrincipal }, declaration)).rejects.toThrow(/authenticated self/);
    await expect(declarePackageInstallationHumanOwner({ ...input, resolvePrincipal: async () => cookiePrincipal },
      { ...declaration, userId: 'human-one' })).rejects.toThrow(/authenticated self/);
    for (const kind of ['device', 'service', 'system'] as const) {
      cookiePrincipal = { ...cookiePrincipal!, kind };
      const nonHuman = await retainRequestPrincipal(new Headers(), input.workspaceId);
      await expect(declarePackageInstallationHumanOwner({ ...input, resolvePrincipal: nonHuman },
        { ...declaration, userId: 'human-one' })).rejects.toThrow(/authenticated self/);
    }
    await humanOwner(input); // restore cookie principal for the original retained closure
    for (const changed of [{ ownerId: 'other-wearer' }, { specificationRevision: hash('other-spec') }, { workspaceId: 'foreign' }]) {
      await expect(beginPackageInstallation(db.adminSql, { ...input, ...changed, humanOwner: proof }))
        .rejects.toThrow(/ownership scope mismatch|credentials changed/);
    }
    expect(await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId)).toBeNull();
  });

  it('rechecks revoked and changed human credentials after waiting for the installation lock', async () => {
    const input = emptyInstall('revoked-after-wait');
    const { proof } = await humanOwner(input);
    let pending: Promise<unknown> | undefined;
    try {
      await db.adminSql.begin(async tx => {
        const [holder] = await tx`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
          'blueprint-package-resource', input.workspaceId, 'dependent:' + input.dependentId])}, 0))`;
        // Use the real public writer on another connection; observe its exact lock waiter.
        pending = beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof })
          .catch(error => error);
        await vi.waitFor(async () => {
          const [row] = await tx`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted
            AND ${holder.pid} = ANY(pg_blocking_pids(pid))`;
          expect(row.n).toBe(1);
        }, { timeout: 5000 });
        cookiePrincipal = null;
      });
      expect(await pending).toMatchObject({ message: expect.stringMatching(/credentials changed or were revoked/) });
    } finally { await pending; }
    expect(await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId)).toBeNull();
    const { proof: changed } = await humanOwner(input);
    cookiePrincipal = { ...cookiePrincipal!, capabilities: new Set() };
    await expect(beginPackageInstallation(db.adminSql, { ...input, humanOwner: changed })).rejects.toThrow(/credentials changed/);
  });

  it.each([false, true])('preserves recorded ownership through applied carry, rollback and release (known=%s)', async known => {
    const input = emptyInstall('history-' + known);
    const proof = known ? (await humanOwner(input)).proof : undefined;
    await beginPackageInstallation(db.adminSql, { ...input, humanOwner: proof });
    await db.adminSql.begin(tx => applyPackageResourceDependent(tx, input.workspaceId, input.dependentId, new Map()));
    const original = (await readPackageInstallation(db.adminSql, input.workspaceId, input.dependentId))!.human_ownership;
    cookiePrincipal = null; // recovery uses the retained durable evidence, not new authentication
    const next = { ...input, fromDependentId: input.dependentId, dependentId: input.dependentId + '-carried', stateRevision: hash('next') };
    await db.adminSql.begin(tx => carryAppliedPackageInstallation(tx, next));
    expect((await readPackageInstallation(db.adminSql, input.workspaceId, next.dependentId))!.human_ownership).toEqual(original);
    await beginPackageInstallationRelease(db.adminSql, input.workspaceId, input.dependentId);
    await finishPackageInstallationRelease(db.adminSql, input.workspaceId, input.dependentId);
    const rollback = { ...input, dependentId: input.dependentId + '-rollback', ownershipFromDependentId: input.dependentId };
    await beginPackageInstallation(db.adminSql, rollback);
    expect((await readPackageInstallation(db.adminSql, input.workspaceId, rollback.dependentId))!.human_ownership).toEqual(original);
    await expect(beginPackageInstallation(db.adminSql, { ...rollback, dependentId: 'foreign-history', ownerId: 'foreign' }))
      .rejects.toThrow(/same wearer, specification and manifest/);
  });

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

  it('records an exact pre-existing row without taking deletion ownership', async () => {
    const fingerprint = hash('organic exact row');
    const driver: PackageResourceDriver = {
      recover: vi.fn(async () => [{ id: 'organic-row', fingerprint, owned: false }]),
      create: vi.fn(async () => [{ id: 'organic-row', fingerprint, owned: false }]),
      cancel: vi.fn(async () => {}),
      removeIfUnchanged: vi.fn(async () => 'removed' as const),
    };
    const input = address('pre-existing');
    const receipt = await preparePackageResource(db.adminSql, input, 'organic-dependent', driver);
    expect(receipt).toMatchObject({ phase: 'ready',
      external_refs: [{ id: 'organic-row', fingerprint, owned: false }] });
    const released = await releasePackageResource(db.adminSql, input, 'organic-dependent', driver);
    expect(released).toMatchObject({ phase: 'detached', error: null,
      external_refs: [{ id: 'organic-row', fingerprint, owned: false, disposition: 'unowned' }] });
    expect(driver.removeIfUnchanged).not.toHaveBeenCalled();
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
