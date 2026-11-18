// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { readIdentityPermissionPopulation, type IdentityPermissionSessionSource } from './identity-grants-port';
import { narrowIdentityHistory } from './identity-receipt-narrowing';
import { packageResourceKey } from '../blueprint/package-resource-receipts';

let sql: postgres.Sql;
beforeAll(async () => {
  const uri = await getTestPg();
  const name = `identitypopulation_${randomBytes(5).toString('hex')}`;
  const admin = postgres(uri, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE "${name}"`); await markManagedTestDatabase(admin, name); }
  finally { await admin.end({ timeout: 5 }); }
  const target = new URL(uri); target.pathname = `/${name}`;
  sql = postgres(target.toString(), { max: 4, onnotice: () => {} });
  // Minimal real storage contract: no live identity, policy or package backend
  // is substituted. Malformed JSON deliberately remains representable here.
  await sql.unsafe(`CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.adv_sessions (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      launch_spec jsonb, mode text NOT NULL DEFAULT 'ended');
    CREATE TABLE harness_shared.session_briefs (
      workspace_id text NOT NULL, owner_id text NOT NULL, control_state jsonb,
      PRIMARY KEY (workspace_id, owner_id));
    CREATE TABLE harness_shared.population_effects (target text NOT NULL)`);
  for (const migration of ['1230-blueprint-package-resource-receipts.sql',
    '1232-blueprint-package-installations.sql', '1645-blueprint-installation-human-ownership.sql']) {
    // These private database fixtures use the real storage contract; global
    // app-role grants belong to the cluster bootstrap, not this isolated DB.
    const body = readFileSync(new URL(`../../../../libs/papercusp/libs/db/sql/${migration}`, import.meta.url), 'utf8');
    await sql.unsafe(body.replace(/GRANT[\s\S]*?;/g, ''));
  }
}, 60_000);
afterAll(async () => { await sql?.end({ timeout: 5 }); });
beforeEach(async () => {
  await sql.unsafe(`TRUNCATE harness_shared.adv_sessions, harness_shared.session_briefs, harness_shared.population_effects,
    harness_shared.blueprint_package_dependents, harness_shared.blueprint_package_resources,
    harness_shared.blueprint_package_installations`);
});
async function seed() {
  await sql`INSERT INTO harness_shared.adv_sessions (id, workspace_id, coord_owner_id, launch_spec)
    VALUES (1, 'ws', 'wearer', '{"revision":"old"}'),
      (2, 'ws', 'wearer', '{"revision":"desired"}'),
      (3, 'ws', 'unacknowledged', 'null'), (4, 'foreign', 'foreign', '{}'),
      (5, 'ws', NULL, '{}'), (6, 'ws', NULL, '[]')`;
  await sql`INSERT INTO harness_shared.session_briefs VALUES
    ('ws', 'wearer', '{"activation":{"applied":{"specificationRevision":"applied","stateRevision":"state"}}}'),
    ('ws', 'orphan', '{}'), ('foreign', 'foreign-anchor', '{}')`;
}
const txSql = (tx: postgres.TransactionSql) => tx as unknown as postgres.Sql;

describe('P-002 canonical session identity population', () => {
  it('retains latest desired and applied sources, ended wearers, unknown rows and orphan anchors', async () => {
    await seed();
    const bodies: IdentityPermissionSessionSource[] = [];
    const result = await readIdentityPermissionPopulation(sql, 'ws', { visit: row => { bodies.push(row); } });
    if (result.status !== 'ok') throw new Error('population unavailable');
    expect(result.sessions).toHaveLength(5);
    expect(bodies).toContainEqual({ ownerId: 'wearer', sessionId: '2', sourceRevision: expect.any(String),
      launchSpec: { revision: 'desired' }, anchorPresent: true,
      controlState: { activation: { applied: { specificationRevision: 'applied', stateRevision: 'state' } } } });
    expect(bodies).toContainEqual({ ownerId: 'orphan', sessionId: null, sourceRevision: expect.any(String),
      launchSpec: null, controlState: {}, anchorPresent: true });
    expect(bodies).toContainEqual({ ownerId: 'unacknowledged', sessionId: '3', sourceRevision: expect.any(String),
      launchSpec: null, controlState: null, anchorPresent: false });
    expect(result.sessions.filter(row => row.ownerId === null).map(row => row.sessionId)).toEqual(['5', '6']);
    expect(result.sessions.some(row => row.ownerId?.startsWith('foreign'))).toBe(false);
    expect(await readIdentityPermissionPopulation(sql, 'ws')).toEqual(result);
    expect(result.sessions.every(row => !('launchSpec' in row) && !('controlState' in row))).toBe(true);
  });

  it('streams every row across batches and narrows history without losing its revision guard', async () => {
    await seed();
    const applied = { specificationRevision: 'applied', stateRevision: 'state' };
    const record = { specificationRevision: 'desired', stateRevision: 'desired-state',
      specificationArtifact: { desired: true }, identityHistory: [
        { ...applied, specificationArtifact: { applied: true } },
        { specificationRevision: 'unrelated', stateRevision: 'old', specificationArtifact: { retained: true } },
      ] };
    await sql`UPDATE harness_shared.adv_sessions SET launch_spec = ${sql.json(record)} WHERE id = 2`;
    await sql`INSERT INTO harness_shared.adv_sessions (id, workspace_id, coord_owner_id, launch_spec)
      SELECT n, 'ws', 'wearer-' || n, '{}'::jsonb FROM generate_series(10, 50) n`;
    const bodies: IdentityPermissionSessionSource[] = [];
    const before = await readIdentityPermissionPopulation(sql, 'ws', { visit: row => { bodies.push(row); } });
    if (before.status !== 'ok') throw new Error('population unavailable');
    expect(before.sessions).toHaveLength(46);
    expect(bodies.map(row => row.sessionId)).toEqual(before.sessions.map(row => row.sessionId));
    expect(bodies.find(row => row.ownerId === 'wearer')?.launchSpec).toEqual(narrowIdentityHistory(record, [applied]));
    record.identityHistory[1].specificationArtifact = { retained: false };
    await sql`UPDATE harness_shared.adv_sessions SET launch_spec = ${sql.json(record)} WHERE id = 2`;
    expect(await sql.begin(tx => readIdentityPermissionPopulation(txSql(tx), 'ws', { expectedRevision: before.revision })))
      .toMatchObject({ status: 'stale' });
  });

  it('propagates a failed visitor instead of returning a partial population', async () => {
    await seed();
    await expect(readIdentityPermissionPopulation(sql, 'ws', { visit: () => { throw new Error('source unreadable'); } }))
      .rejects.toThrow('source unreadable');
  });

  it('preserves a legitimately empty census without manufacturing authority', async () => {
    expect(await readIdentityPermissionPopulation(sql, 'ws')).toMatchObject({ status: 'ok', sessions: [] });
  });

  it.each(['launch-add', 'launch-edit', 'launch-remove', 'anchor-add', 'anchor-edit', 'anchor-remove'] as const)(
    'refuses a changed before-image before a protected effect: %s', async change => {
      await seed();
      const before = await readIdentityPermissionPopulation(sql, 'ws');
      if (change === 'launch-add') await sql`INSERT INTO harness_shared.adv_sessions (id, workspace_id, coord_owner_id) VALUES (7, 'ws', 'new')`;
      if (change === 'launch-edit') await sql`UPDATE harness_shared.adv_sessions SET launch_spec = '{}' WHERE id = 2`;
      if (change === 'launch-remove') await sql`DELETE FROM harness_shared.adv_sessions WHERE id = 2`;
      if (change === 'anchor-add') await sql`INSERT INTO harness_shared.session_briefs VALUES ('ws', 'new', '{}')`;
      if (change === 'anchor-edit') await sql`UPDATE harness_shared.session_briefs SET control_state = '{}' WHERE owner_id = 'wearer'`;
      if (change === 'anchor-remove') await sql`DELETE FROM harness_shared.session_briefs WHERE owner_id = 'wearer'`;
      const result = await sql.begin(async tx => {
        const current = await readIdentityPermissionPopulation(txSql(tx), 'ws', { expectedRevision: before.revision });
        if (current.status === 'ok') await tx`INSERT INTO harness_shared.population_effects VALUES ('stale')`;
        return current;
      });
      expect(result.status).toBe('stale');
      expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([]);
    });

  it.each(['launch', 'anchor'] as const)('holds %s rows AND insertion gaps through the protected effect', async domain => {
    await seed();
    const before = await readIdentityPermissionPopulation(sql, 'ws');
    await sql.begin(async tx => {
      expect(await readIdentityPermissionPopulation(txSql(tx), 'ws', { expectedRevision: before.revision })).toEqual(before);
      // A different connection cannot update existing rows or add a previously
      // absent wearer. Real PG lock_timeout proves blocking without sleeps.
      for (const action of ['update', 'insert']) {
        await expect(sql.begin(async writer => {
          await writer`SET LOCAL lock_timeout = '80ms'`;
          if (domain === 'launch') {
            if (action === 'update') await writer`UPDATE harness_shared.adv_sessions SET launch_spec = '{}' WHERE id = 2`;
            else await writer`INSERT INTO harness_shared.adv_sessions (id, workspace_id, coord_owner_id) VALUES (7, 'ws', 'new')`;
          } else if (action === 'update') await writer`UPDATE harness_shared.session_briefs SET control_state = '{}' WHERE owner_id = 'wearer'`;
          else await writer`INSERT INTO harness_shared.session_briefs VALUES ('ws', 'new', '{}')`;
        })).rejects.toMatchObject({ code: '55P03' });
      }
      // The owning transaction can still perform its own activation write.
      await tx`UPDATE harness_shared.adv_sessions SET launch_spec = '{}' WHERE id = 2`;
      await tx`INSERT INTO harness_shared.population_effects VALUES ('current')`;
    });
    await sql`UPDATE harness_shared.session_briefs SET control_state = '{}' WHERE owner_id = 'wearer'`;
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([{ target: 'current' }]);
  });

  it('rejects plain clients and old snapshots at the effect boundary', async () => {
    await seed();
    const before = await readIdentityPermissionPopulation(sql, 'ws');
    await expect(readIdentityPermissionPopulation(sql, 'ws', { expectedRevision: before.revision })).rejects.toThrow('existing transaction');
    await sql.begin('isolation level repeatable read', async tx => {
      expect(await readIdentityPermissionPopulation(txSql(tx), 'ws')).toEqual(before);
      await sql`INSERT INTO harness_shared.session_briefs VALUES ('ws', 'new', '{}')`;
      await expect(readIdentityPermissionPopulation(txSql(tx), 'ws', { expectedRevision: before.revision })).rejects.toThrow('read committed');
    });
    await sql.begin(async tx => {
      await expect(readIdentityPermissionPopulation(txSql(tx), 'ws')).rejects.toThrow('repeatable read');
    });
  });

  it('serializes effect leases before their source-write lock upgrades', async () => {
    await seed();
    const before = await readIdentityPermissionPopulation(sql, 'ws');
    await sql.begin(async tx => {
      expect(await readIdentityPermissionPopulation(txSql(tx), 'ws', { expectedRevision: before.revision })).toEqual(before);
      await expect(sql.begin(async peer => {
        await peer`SET LOCAL lock_timeout = '80ms'`;
        await readIdentityPermissionPopulation(txSql(peer), 'ws', { expectedRevision: before.revision });
      })).rejects.toMatchObject({ code: '55P03' });
      await tx`UPDATE harness_shared.adv_sessions SET launch_spec = '{}' WHERE id = 2`;
    });
    expect(await sql.begin(tx => readIdentityPermissionPopulation(txSql(tx), 'ws', { expectedRevision: before.revision })))
      .toMatchObject({ status: 'stale' });
  });

  const joined = { includePackageResources: true };
  async function seedPackages() {
    const digest = 'a'.repeat(64);
    const address = { workspaceId: 'ws', memoryScope: 'hive:test', packageKind: 'knowledge-pack',
      packageRef: 'shared', packageVersion: '1', packageHash: digest, resourceKind: 'memory',
      itemKey: 'item', installedHash: digest };
    const key = packageResourceKey(address);
    await sql`INSERT INTO harness_shared.blueprint_package_installations
      (workspace_id, dependent_id, owner_id, specification_revision, state_revision, expected_resources)
      VALUES ('ws', 'empty-install', 'wearer', ${digest}, 'state', '{}')`;
    await sql`INSERT INTO harness_shared.blueprint_package_resources
      (workspace_id, resource_key, memory_scope, package_kind, package_ref, package_version,
       package_hash, resource_kind, item_key, installed_hash)
      VALUES ('ws', ${key}, ${address.memoryScope}, ${address.packageKind}, ${address.packageRef},
        ${address.packageVersion}, ${digest}, ${address.resourceKind}, ${address.itemKey}, ${digest})`;
    await sql`INSERT INTO harness_shared.blueprint_package_dependents
      (workspace_id, dependent_id, resource_key, phase)
      VALUES ('ws', 'legacy', ${key}, 'applied'), ('ws', 'old-shared', ${key}, 'released')`;
    return key;
  }

  it('joins empty installs, unknown owners and shared legacy resources without inventing session membership', async () => {
    const key = await seedPackages();
    const result = await readIdentityPermissionPopulation(sql, 'ws', joined);
    expect(result).toMatchObject({ status: 'ok', sessions: [], packages: {
      installations: [{ dependent_id: 'empty-install', human_ownership: null }],
      resources: [{ resource_key: key }],
      dependents: [{ dependent_id: 'legacy', phase: 'applied' }, { dependent_id: 'old-shared', phase: 'released' }],
    } });
    const sessionsOnly = await readIdentityPermissionPopulation(sql, 'ws');
    expect(result.revision).not.toBe(sessionsOnly.revision);
    expect(await sql.begin(tx => readIdentityPermissionPopulation(txSql(tx), 'ws', {
      ...joined, expectedRevision: sessionsOnly.revision,
    }))).toMatchObject({ status: 'stale' });
  });

  it('uses one MVCC snapshot across session traversal and package discovery', async () => {
    await seed();
    let inserted = false;
    const before = await readIdentityPermissionPopulation(sql, 'ws', { ...joined, visit: async () => {
      if (!inserted) { inserted = true; await seedPackages(); }
    } });
    expect(inserted).toBe(true);
    expect(before).toMatchObject({ status: 'ok', packages: { installations: [], resources: [], dependents: [] } });
    const after = await readIdentityPermissionPopulation(sql, 'ws', joined);
    expect(after.revision).not.toBe(before.revision);
    expect(after).toMatchObject({ status: 'ok', packages: { installations: [expect.anything()] } });
  });

  it.each(['session', 'installation', 'resource', 'dependent'] as const)
    ('refuses a changed joined %s before a protected effect', async domain => {
      await seed();
      await seedPackages();
      const before = await readIdentityPermissionPopulation(sql, 'ws', joined);
      if (domain === 'session') await sql`INSERT INTO harness_shared.session_briefs VALUES ('ws', 'new', '{}')`;
      if (domain === 'installation') await sql`DELETE FROM harness_shared.blueprint_package_installations`;
      if (domain === 'resource') await sql`UPDATE harness_shared.blueprint_package_resources SET phase = 'detached'`;
      if (domain === 'dependent') await sql`DELETE FROM harness_shared.blueprint_package_dependents WHERE dependent_id = 'legacy'`;
      const result = await sql.begin(async tx => {
        const current = await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...joined, expectedRevision: before.revision });
        if (current.status === 'ok') await tx`INSERT INTO harness_shared.population_effects VALUES ('stale')`;
        return current;
      });
      expect(result.status).toBe('stale');
      expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([]);
    });

  it('holds the joined package insertion gap through a protected effect', async () => {
    await seed();
    const before = await readIdentityPermissionPopulation(sql, 'ws', joined);
    await sql.begin(async tx => {
      expect(await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...joined, expectedRevision: before.revision })).toEqual(before);
      await expect(sql.begin(async peer => {
        await peer`SET LOCAL lock_timeout = '80ms'`;
        await peer`INSERT INTO harness_shared.blueprint_package_installations
          (workspace_id, dependent_id, owner_id, specification_revision, state_revision, expected_resources)
          VALUES ('ws', 'new', 'wearer', ${'a'.repeat(64)}, 'state', '{}')`;
      })).rejects.toMatchObject({ code: '55P03' });
      await tx`INSERT INTO harness_shared.population_effects VALUES ('current')`;
    });
    await seedPackages();
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([{ target: 'current' }]);
  });

  it('refuses malformed journal evidence instead of returning a partial joined population', async () => {
    await seed();
    await seedPackages();
    await sql`UPDATE harness_shared.blueprint_package_installations SET expected_resources = '{"bad":"not-a-hash"}'`;
    await expect(readIdentityPermissionPopulation(sql, 'ws', joined)).rejects.toThrow('malformed installation');
  });

  it.each(['sessions', 'packages'] as const)('refuses hidden %s instead of reporting a filtered empty population', async domain => {
    const role = `population_reader_${randomBytes(5).toString('hex')}`;
    const table = domain === 'sessions' ? 'adv_sessions' : 'blueprint_package_installations';
    await sql.unsafe(`CREATE ROLE "${role}"; GRANT USAGE ON SCHEMA harness_shared TO "${role}";
      GRANT SELECT ON ALL TABLES IN SCHEMA harness_shared TO "${role}";
      ALTER TABLE harness_shared.${table} ENABLE ROW LEVEL SECURITY`);
    try {
      await sql.begin('isolation level repeatable read', async tx => {
        await tx.unsafe(`SET LOCAL ROLE "${role}"`);
        await tx`SET LOCAL app.workspace_id = 'foreign'`;
        await expect(readIdentityPermissionPopulation(txSql(tx), 'ws', domain === 'packages' ? joined : {})).rejects.toThrow('not visible');
      });
    } finally {
      await sql.unsafe(`ALTER TABLE harness_shared.${table} DISABLE ROW LEVEL SECURITY;
        DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
  });
});
