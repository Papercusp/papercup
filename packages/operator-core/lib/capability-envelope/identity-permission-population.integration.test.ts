// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { readIdentityPermissionPopulation, type IdentityPermissionSessionSource } from './identity-grants-port';
import { narrowIdentityHistory } from './identity-receipt-narrowing';
import { packageResourceKey } from '../blueprint/package-resource-receipts';
import { sessionPackageDependentId } from '../blueprint/session-package-resources';
import { upsertLayer, upsertLayerInTx, upsertScopedPolicyAuthority } from '../governance-policy/store';

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
    CREATE TABLE harness_shared.users (id text PRIMARY KEY, is_active boolean,
      username text, password_hash text);
    CREATE TABLE harness_shared.user_sessions (token text PRIMARY KEY, user_id text,
      workspace_id text, capabilities text[], expires_at timestamptz, last_seen_at timestamptz);
    CREATE TABLE harness_shared.population_effects (target text NOT NULL)`);
  for (const migration of ['1230-blueprint-package-resource-receipts.sql',
    '1232-blueprint-package-installations.sql', '1645-blueprint-installation-human-ownership.sql',
    '1646-governance-host-authority-bindings.sql', '1647-governance-inherited-human-ownership.sql',
    '1497-governance-policy-layers.sql',
    '1644-governance-scoped-authority-levels.sql']) {
    // These private database fixtures use the real storage contract; global
    // app-role grants belong to the cluster bootstrap, not this isolated DB.
    const path = new URL(`../../../../libs/papercusp/libs/db/sql/${migration}`, import.meta.url);
    const body = readFileSync(existsSync(path) ? path : new URL(path.href + '.DRAFT'), 'utf8');
    await sql.unsafe(body.replace(/GRANT[\s\S]*?;/g, ''));
  }
}, 60_000);
afterAll(async () => { await sql?.end({ timeout: 5 }); });
beforeEach(async () => {
  await sql.unsafe(`TRUNCATE harness_shared.adv_sessions, harness_shared.session_briefs, harness_shared.population_effects,
    harness_shared.blueprint_package_dependents, harness_shared.blueprint_package_resources,
    harness_shared.blueprint_package_installations, harness_shared.users, harness_shared.user_sessions,
    harness_shared.governance_host_authority_bindings,
    harness_shared.governance_policy_layer_versions, harness_shared.governance_policy_layers`);
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
  const appliedPackageRevision = { specificationRevision: 'c'.repeat(64), stateRevision: 'applied-state' };
  const desiredPackageRevision = { specificationRevision: 'd'.repeat(64), stateRevision: 'desired-state' };
  async function seedPackageOwner(revision = appliedPackageRevision, options: {
    attemptId?: string; phase?: string; human?: string | null; workspaceId?: string;
  } = {}) {
    const workspaceId = options.workspaceId ?? 'ws';
    const dependentId = sessionPackageDependentId('wearer', revision, options.attemptId);
    const human = options.human === undefined ? 'explicit-human' : options.human;
    const ownership = human === null ? null : { schemaVersion: 1, declaration: 'self', authMethod: 'cookie-session',
      workspaceId, ownerId: 'wearer', userId: human, specificationRevision: revision.specificationRevision,
      principalRevision: 'e'.repeat(64) };
    // Stored-provenance fixtures only; no browser credential or live enrollment.
    await sql`INSERT INTO harness_shared.blueprint_package_installations
      (workspace_id, dependent_id, owner_id, specification_revision, state_revision, expected_resources, phase, human_ownership)
      VALUES (${workspaceId}, ${dependentId}, 'wearer', ${revision.specificationRevision}, ${revision.stateRevision},
        '{}', ${options.phase ?? 'applied'}, ${ownership === null ? null : sql.json(ownership)})`;
    return dependentId;
  }
  async function seedPackageSession() {
    await sql`INSERT INTO harness_shared.adv_sessions (id, workspace_id, coord_owner_id, launch_spec)
      VALUES (1, 'ws', 'wearer', ${sql.json({ ...desiredPackageRevision, identityHistory: [appliedPackageRevision] })})`;
    await sql`INSERT INTO harness_shared.session_briefs VALUES ('ws', 'wearer',
      ${sql.json({ activation: { applied: appliedPackageRevision } })})`;
  }

  it('reconciles session package owners using the runtime attempt and exact applied/desired revisions', async () => {
    await seedPackageSession();
    const applied = await seedPackageOwner();
    await seedPackageOwner(desiredPackageRevision, { phase: 'released', human: 'released-human' });
    const desired = await seedPackageOwner(desiredPackageRevision, {
      attemptId: 'attempt:1', phase: 'preparing', human: 'desired-human',
    });
    await seedPackageOwner(appliedPackageRevision, { attemptId: 'unselected-explicit-attempt', human: 'other-human' });
    expect(await readIdentityPermissionPopulation(sql, 'ws', joined)).toMatchObject({
      sessionPackageOwners: [{ ownerId: 'wearer', sessionId: '1',
        applied: { revision: appliedPackageRevision, dependentId: applied, humanOwnerId: 'explicit-human' },
        desired: { revision: desiredPackageRevision, dependentId: desired, humanOwnerId: 'desired-human' },
      }],
    });
  });

  it('keeps selected unknown, unprovisioned and control-only package ownership unknown', async () => {
    await seedPackageSession();
    const applied = await seedPackageOwner(appliedPackageRevision, { human: null });
    await seedPackageOwner(appliedPackageRevision, { attemptId: 'different-attempt', human: 'must-not-substitute' });
    const first = await readIdentityPermissionPopulation(sql, 'ws', joined);
    expect(first).toMatchObject({ sessionPackageOwners: [{
      applied: { dependentId: applied, humanOwnerId: null }, desired: { humanOwnerId: null },
    }] });
    await sql`UPDATE harness_shared.session_briefs SET control_state =
      ${sql.json({ activation: { applied: { ...appliedPackageRevision, stateRevision: 'control-only' } } })}`;
    expect(await readIdentityPermissionPopulation(sql, 'ws', joined)).toMatchObject({
      sessionPackageOwners: [{ applied: { humanOwnerId: null }, desired: { humanOwnerId: null } }],
      packages: { installations: expect.arrayContaining([expect.objectContaining({ dependent_id: applied })]) },
    });
  });

  it('pins the runtime cross-workspace attempt decision before an ownership-dependent effect', async () => {
    await seedPackageSession();
    await seedPackageOwner();
    const before = await readIdentityPermissionPopulation(sql, 'ws', joined);
    // Runtime retries inspect the wearer's matching attempts across workspaces.
    // A foreign terminal receipt must not make the census pick the local base.
    await seedPackageOwner(appliedPackageRevision, { workspaceId: 'foreign', phase: 'released', human: 'foreign-human' });
    expect(await readIdentityPermissionPopulation(sql, 'ws', joined)).toMatchObject({
      sessionPackageOwners: [{ applied: { humanOwnerId: null } }],
    });
    await sql.begin(async tx => {
      const current = await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...joined, expectedRevision: before.revision });
      if (current.status === 'ok') await tx`INSERT INTO harness_shared.population_effects VALUES ('wrong-owner')`;
      expect(current.status).toBe('stale');
    });
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([]);
  });

  it.each(['preparing', 'applied', 'releasing', 'released', 'cleanup_failed'])(
    'never substitutes a noncurrent %s installation for an applied human owner', async phase => {
      await seedPackageSession();
      const dependentId = await seedPackageOwner(appliedPackageRevision, { phase });
      const before = await readIdentityPermissionPopulation(sql, 'ws', joined);
      expect(before).toMatchObject({ sessionPackageOwners: [{ applied: {
        humanOwnerId: phase === 'applied' ? 'explicit-human' : null,
      } }], packages: { installations: [expect.objectContaining({ dependent_id: dependentId, phase })] } });
    });

  it('keeps package attempt ownership unknown when RLS hides other workspaces', async () => {
    await seedPackageSession(); await seedPackageOwner();
    const role = `package_owner_reader_${randomBytes(5).toString('hex')}`;
    await sql.unsafe(`CREATE ROLE "${role}"; GRANT USAGE ON SCHEMA harness_shared TO "${role}";
      GRANT SELECT ON ALL TABLES IN SCHEMA harness_shared TO "${role}";
      ALTER TABLE harness_shared.blueprint_package_installations ENABLE ROW LEVEL SECURITY;
      CREATE POLICY local_package_owner ON harness_shared.blueprint_package_installations TO "${role}"
        USING (workspace_id = current_setting('app.workspace_id', true))`);
    try {
      await sql.begin('isolation level repeatable read', async tx => {
        await tx.unsafe(`SET LOCAL ROLE "${role}"`);
        await tx`SELECT set_config('app.workspace_id', 'ws', true)`;
        expect(await readIdentityPermissionPopulation(txSql(tx), 'ws', joined)).toMatchObject({
          packages: { installations: [expect.objectContaining({ human_ownership: expect.objectContaining({ userId: 'explicit-human' }) })] },
          sessionPackageOwners: [{ applied: { humanOwnerId: null, reason: 'attempt-scope-not-visible' } }],
        });
      });
    } finally {
      await sql.unsafe(`DROP POLICY local_package_owner ON harness_shared.blueprint_package_installations;
        ALTER TABLE harness_shared.blueprint_package_installations DISABLE ROW LEVEL SECURITY;
        DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
  });

  it('joins session ownership in the same MVCC snapshot and holds global attempt insertion gaps through effect', async () => {
    await seedPackageSession(); await seedPackageOwner();
    const before = await readIdentityPermissionPopulation(sql, 'ws', joined);
    let changed = false;
    const during = await readIdentityPermissionPopulation(sql, 'ws', { ...joined, visit: async () => {
      if (changed) return;
      changed = true;
      await seedPackageOwner(appliedPackageRevision, { workspaceId: 'foreign', phase: 'released' });
    } });
    expect(changed).toBe(true);
    expect(during).toEqual(before);
    const after = await readIdentityPermissionPopulation(sql, 'ws', joined);
    expect(after.revision).not.toBe(before.revision);
    await sql.begin(async tx => {
      expect(await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...joined, expectedRevision: after.revision })).toEqual(after);
      await expect(sql.begin(async peer => {
        await peer`SET LOCAL lock_timeout = '80ms'`;
        await peer`DELETE FROM harness_shared.blueprint_package_installations WHERE workspace_id = 'foreign'`;
      })).rejects.toMatchObject({ code: '55P03' });
      await expect(sql.begin(async peer => {
        await peer`SET LOCAL lock_timeout = '80ms'`;
        await peer`INSERT INTO harness_shared.blueprint_package_installations
          (workspace_id, dependent_id, owner_id, specification_revision, state_revision, expected_resources)
          VALUES ('another-workspace', 'phantom-attempt', 'wearer', ${appliedPackageRevision.specificationRevision},
            ${appliedPackageRevision.stateRevision}, '{}')`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
  });

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

  const hostJoined = { ...joined, includeWorkspaceUsers: true };
  async function seedUsers() {
    await sql`INSERT INTO harness_shared.users VALUES
      ('alice', true, 'Alice', 'secret-password'), ('inactive', false, 'Inactive', NULL),
      ('unclaimed', true, 'Unclaimed', NULL), ('foreign', true, 'Foreign', NULL)`;
    await sql`INSERT INTO harness_shared.user_sessions (token, user_id, workspace_id, capabilities, expires_at) VALUES
      ('secret-current', 'alice', 'ws', ARRAY['identity:edit'], '2099-01-01'),
      ('secret-expired', 'alice', 'ws', ARRAY['*'], '2000-01-01'),
      ('secret-inactive', 'inactive', 'ws', ARRAY['*'], '2099-01-01'),
      ('secret-orphan', 'missing', 'ws', NULL, NULL),
      ('secret-unowned', NULL, 'ws', ARRAY['*'], '2099-01-01'),
      ('secret-foreign', 'foreign', 'foreign', ARRAY['*'], '2099-01-01')`;
  }

  it('joins redacted host user claims without inferring human ownership or session membership', async () => {
    await seedUsers();
    await seedPackages();
    const result = await readIdentityPermissionPopulation(sql, 'ws', hostJoined);
    expect(result).toMatchObject({ status: 'ok', sessions: [], workspaceUsers: { status: 'ok', users: [
      { userId: 'alice', userPresent: true, active: true, claimRevisions: [expect.any(String), expect.any(String)] },
      { userId: 'inactive', userPresent: true, active: false, claimRevisions: [expect.any(String)] },
      { userId: 'missing', userPresent: false, active: null, claimRevisions: [expect.any(String)] },
      { userId: null, userPresent: false, active: null, claimRevisions: [expect.any(String)] },
    ] }, packages: { installations: [{ human_ownership: null }] } });
    expect(JSON.stringify(result)).not.toMatch(/secret|password|unclaimed|foreign/);
    const packagesOnly = await readIdentityPermissionPopulation(sql, 'ws', joined);
    expect(packagesOnly).not.toHaveProperty('workspaceUsers');
    expect(result.revision).not.toBe(packagesOnly.revision);
    expect(await sql.begin(tx => readIdentityPermissionPopulation(txSql(tx), 'ws', {
      ...hostJoined, expectedRevision: packagesOnly.revision,
    }))).toMatchObject({ status: 'stale' });
    expect(await readIdentityPermissionPopulation(sql, 'ws', hostJoined)).toEqual(result);
  });

  it('keeps an empty host claim slice explicit and independently selectable', async () => {
    const result = await readIdentityPermissionPopulation(sql, 'ws', { includeWorkspaceUsers: true });
    expect(result).toMatchObject({ status: 'ok', sessions: [], workspaceUsers: { status: 'ok', users: [] } });
    expect(result).not.toHaveProperty('packages');
    expect(result.revision).not.toBe((await readIdentityPermissionPopulation(sql, 'ws')).revision);
  });

  it('uses one MVCC snapshot across session, package and host-user discovery', async () => {
    await seed();
    let inserted = false;
    const before = await readIdentityPermissionPopulation(sql, 'ws', { ...hostJoined, visit: async () => {
      if (!inserted) { inserted = true; await seedPackages(); await seedUsers(); }
    } });
    expect(inserted).toBe(true);
    expect(before).toMatchObject({ status: 'ok', workspaceUsers: { users: [] },
      packages: { installations: [], resources: [], dependents: [] } });
    const after = await readIdentityPermissionPopulation(sql, 'ws', hostJoined);
    expect(after.revision).not.toBe(before.revision);
    expect(after).toMatchObject({ workspaceUsers: { users: expect.arrayContaining([{ userId: 'alice',
      userPresent: true, active: true, claimRevisions: [expect.any(String), expect.any(String)] }]) },
    packages: { installations: [expect.anything()] } });
  });

  it.each(['active', 'capability', 'expiry', 'workspace', 'orphan', 'claim-add', 'claim-remove'] as const)(
    'refuses a changed host %s source before a protected effect', async change => {
      await seedUsers();
      const before = await readIdentityPermissionPopulation(sql, 'ws', hostJoined);
      if (change === 'active') await sql`UPDATE harness_shared.users SET is_active = false WHERE id = 'alice'`;
      if (change === 'capability') await sql`UPDATE harness_shared.user_sessions SET capabilities = ARRAY['*'] WHERE token = 'secret-current'`;
      if (change === 'expiry') await sql`UPDATE harness_shared.user_sessions SET expires_at = '2000-01-01' WHERE token = 'secret-current'`;
      if (change === 'workspace') await sql`UPDATE harness_shared.user_sessions SET workspace_id = 'foreign' WHERE token = 'secret-current'`;
      if (change === 'orphan') await sql`DELETE FROM harness_shared.users WHERE id = 'alice'`;
      if (change === 'claim-add') await sql`INSERT INTO harness_shared.user_sessions (token, user_id, workspace_id)
        VALUES ('new', 'unclaimed', 'ws')`;
      if (change === 'claim-remove') await sql`DELETE FROM harness_shared.user_sessions WHERE token = 'secret-current'`;
      const result = await sql.begin(async tx => {
        const current = await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...hostJoined, expectedRevision: before.revision });
        if (current.status === 'ok') await tx`INSERT INTO harness_shared.population_effects VALUES ('stale')`;
        return current;
      });
      expect(result.status).toBe('stale');
      expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([]);
    });

  it.each(['users', 'user_sessions'] as const)('pins joined host %s updates and insertion gaps through the effect', async table => {
    await seedUsers();
    const before = await readIdentityPermissionPopulation(sql, 'ws', hostJoined);
    await sql.begin(async tx => {
      expect(await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...hostJoined, expectedRevision: before.revision })).toEqual(before);
      for (const action of ['update', 'insert']) {
        await expect(sql.begin(async peer => {
          await peer`SET LOCAL lock_timeout = '80ms'`;
          if (table === 'users') {
            if (action === 'update') await peer`UPDATE harness_shared.users SET is_active = false WHERE id = 'alice'`;
            else await peer`INSERT INTO harness_shared.users (id, is_active) VALUES ('new', true)`;
          } else if (action === 'update') await peer`UPDATE harness_shared.user_sessions SET capabilities = ARRAY['*'] WHERE token = 'secret-current'`;
          else await peer`INSERT INTO harness_shared.user_sessions (token, user_id, workspace_id) VALUES ('new', 'unclaimed', 'ws')`;
        })).rejects.toMatchObject({ code: '55P03' });
      }
      await tx`INSERT INTO harness_shared.population_effects VALUES ('current')`;
    });
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([{ target: 'current' }]);
  });

  it('keeps last-seen writes outside the authorization revision', async () => {
    await seedUsers();
    const before = await readIdentityPermissionPopulation(sql, 'ws', hostJoined);
    await sql`UPDATE harness_shared.user_sessions SET last_seen_at = now()`;
    expect(await sql.begin(tx => readIdentityPermissionPopulation(txSql(tx), 'ws', {
      ...hostJoined, expectedRevision: before.revision,
    }))).toEqual(before);
  });

  it.each(['users', 'user_sessions'] as const)('refuses filtered host %s with a matching workspace setting', async table => {
    await seedUsers();
    const role = `population_auth_reader_${randomBytes(5).toString('hex')}`;
    await sql.unsafe(`CREATE ROLE "${role}"; GRANT USAGE ON SCHEMA harness_shared TO "${role}";
      GRANT SELECT ON ALL TABLES IN SCHEMA harness_shared TO "${role}";
      ALTER TABLE harness_shared.${table} ENABLE ROW LEVEL SECURITY`);
    try {
      await sql.begin('isolation level repeatable read', async tx => {
        await tx.unsafe(`SET LOCAL ROLE "${role}"`);
        await tx`SET LOCAL app.workspace_id = 'ws'`;
        await expect(readIdentityPermissionPopulation(txSql(tx), 'ws', hostJoined)).rejects.toThrow('not visible');
      });
    } finally {
      await sql.unsafe(`ALTER TABLE harness_shared.${table} DISABLE ROW LEVEL SECURITY;
        DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
  });

  const authorityJoined = { ...hostJoined, includeHostAuthorities: true };
  async function seedAuthorities() {
    // Storage fixtures only: neither claims nor policy roots enroll subjects.
    await sql`INSERT INTO harness_shared.governance_host_authority_bindings
      (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
      VALUES ('ws', 'user', 'enrolled-human', 'enrolled-human', ${'a'.repeat(64)}, 'explicit user fixture'),
        ('ws', 'platform', 'missing-policy-floor', 'enrolled-human', ${'b'.repeat(64)}, 'explicit floor fixture'),
        ('foreign', 'platform', 'foreign-floor', 'foreign-human', ${'c'.repeat(64)}, 'foreign fixture')`;
  }

  it('joins independent required subjects without relying on policy roots, claims or session wearers', async () => {
    await seed(); await seedUsers(); await seedPackages(); await seedAuthorities();
    const result = await readIdentityPermissionPopulation(sql, 'ws', authorityJoined);
    expect(result).toMatchObject({ status: 'ok', hostAuthorities: { status: 'ok',
      bindings: [
        { kind: 'platform', subjectId: 'missing-policy-floor', humanOwnerId: 'enrolled-human' },
        { kind: 'user', subjectId: 'enrolled-human', humanOwnerId: 'enrolled-human' },
      ], requiredUserIds: ['enrolled-human'], requiredPlatformIds: ['missing-policy-floor'] } });
    expect(await sql`SELECT count(*)::int AS policies FROM harness_shared.governance_policy_layers`)
      .toEqual([{ policies: 0 }]);
    const unjoined = await readIdentityPermissionPopulation(sql, 'ws', hostJoined);
    expect(unjoined).not.toHaveProperty('hostAuthorities');
    expect(result.revision).not.toBe(unjoined.revision);
    expect(await sql.begin(tx => readIdentityPermissionPopulation(txSql(tx), 'ws', {
      ...authorityJoined, expectedRevision: unjoined.revision,
    }))).toMatchObject({ status: 'stale' });
    expect(await readIdentityPermissionPopulation(sql, 'ws', authorityJoined)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('foreign-floor');
  });

  it('keeps empty enrollment explicit and selectable without claims or package readers', async () => {
    const result = await readIdentityPermissionPopulation(sql, 'ws', { includeHostAuthorities: true });
    expect(result).toMatchObject({ status: 'ok', hostAuthorities: { bindings: [],
      requiredUserIds: [], requiredPlatformIds: [] } });
    expect(result).not.toHaveProperty('workspaceUsers');
    expect(result).not.toHaveProperty('packages');
    expect(result.revision).not.toBe((await readIdentityPermissionPopulation(sql, 'ws')).revision);
  });

  it('uses one MVCC snapshot for sessions, packages, host claims and independent enrollment', async () => {
    await seed();
    let inserted = false;
    const before = await readIdentityPermissionPopulation(sql, 'ws', { ...authorityJoined, visit: async () => {
      if (!inserted) {
        inserted = true; await seedUsers(); await seedPackages(); await seedAuthorities();
      }
    } });
    expect(inserted).toBe(true);
    expect(before).toMatchObject({ status: 'ok', hostAuthorities: { bindings: [],
      requiredUserIds: [], requiredPlatformIds: [] }, workspaceUsers: { users: [] },
    packages: { installations: [], resources: [], dependents: [] } });
    const after = await readIdentityPermissionPopulation(sql, 'ws', authorityJoined);
    expect(after.revision).not.toBe(before.revision);
    expect(after).toMatchObject({ hostAuthorities: { requiredPlatformIds: ['missing-policy-floor'] } });
  });

  it.each(['owner', 'principal-revision', 'reason', 'timestamp', 'insert', 'delete'] as const)(
    'refuses changed enrollment %s before the protected effect', async change => {
      await seedAuthorities();
      const before = await readIdentityPermissionPopulation(sql, 'ws', authorityJoined);
      if (change === 'owner') await sql`UPDATE harness_shared.governance_host_authority_bindings
        SET human_owner_id = 'other-human' WHERE workspace_id = 'ws' AND kind = 'platform'`;
      if (change === 'principal-revision') await sql`UPDATE harness_shared.governance_host_authority_bindings
        SET request_principal_revision = ${'d'.repeat(64)} WHERE workspace_id = 'ws'`;
      if (change === 'reason') await sql`UPDATE harness_shared.governance_host_authority_bindings SET reason = 'changed' WHERE workspace_id = 'ws'`;
      if (change === 'timestamp') await sql`UPDATE harness_shared.governance_host_authority_bindings SET recorded_at = '2030-01-01' WHERE workspace_id = 'ws'`;
      if (change === 'insert') await sql`INSERT INTO harness_shared.governance_host_authority_bindings
        (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
        VALUES ('ws', 'platform', 'new-required', 'human', ${'e'.repeat(64)}, 'new fixture')`;
      if (change === 'delete') await sql`DELETE FROM harness_shared.governance_host_authority_bindings WHERE workspace_id = 'ws'`;
      const result = await sql.begin(async tx => {
        const current = await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...authorityJoined,
          expectedRevision: before.revision });
        if (current.status === 'ok') await tx`INSERT INTO harness_shared.population_effects VALUES ('stale')`;
        return current;
      });
      expect(result.status).toBe('stale');
      expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([]);
    });

  it.each([false, true])('pins enrollment edits and insertion gaps through effect commit (seeded=%s)', async seeded => {
    if (seeded) await seedAuthorities();
    const before = await readIdentityPermissionPopulation(sql, 'ws', authorityJoined);
    await sql.begin(async tx => {
      expect(await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...authorityJoined,
        expectedRevision: before.revision })).toEqual(before);
      for (const action of seeded ? ['update', 'delete', 'insert'] : ['insert']) {
        await expect(sql.begin(async peer => {
          await peer`SET LOCAL lock_timeout = '80ms'`;
          if (action === 'update') await peer`UPDATE harness_shared.governance_host_authority_bindings SET reason = 'changed'`;
          else if (action === 'delete') await peer`DELETE FROM harness_shared.governance_host_authority_bindings`;
          else await peer`INSERT INTO harness_shared.governance_host_authority_bindings
            (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
            VALUES ('ws', 'platform', 'new-required', 'human', ${'e'.repeat(64)}, 'new fixture')`;
        })).rejects.toMatchObject({ code: '55P03' });
      }
      await tx`INSERT INTO harness_shared.population_effects VALUES ('current')`;
    });
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([{ target: 'current' }]);
    expect(await readIdentityPermissionPopulation(sql, 'ws', authorityJoined)).toEqual(before);
  });

  async function seedScopedPolicy(kind: 'user' | 'platform', subjectId = kind === 'user'
    ? 'enrolled-human' : 'missing-policy-floor', expectedVersion = 0) {
    return upsertScopedPolicyAuthority({ kind, workspaceId: 'ws', subjectId,
      rules: { actions: { allow: [expectedVersion === 0 ? 'edit' : 'inspect'] } },
      actor: 'technical-author-is-not-owner', reason: 'scoped policy fixture', expectedVersion }, sql);
  }

  it('joins the stored scoped policies using required subjects from independent enrollment', async () => {
    await seedAuthorities(); await seedScopedPolicy('user'); await seedScopedPolicy('platform');
    await seedScopedPolicy('user', 'stored-user-without-claims');
    await seedScopedPolicy('platform', 'additional-stored-floor');
    const result = await readIdentityPermissionPopulation(sql, 'ws', { includeScopedPolicies: true });
    if (result.status !== 'ok') throw new Error('population unavailable');
    expect(result.hostAuthorities).toMatchObject({ requiredUserIds: ['enrolled-human'],
      requiredPlatformIds: ['missing-policy-floor'] });
    expect(result.scopedPolicies?.policies).toHaveLength(4);
    expect(result.scopedPolicies?.policies.map(policy => policy.kind).sort())
      .toEqual(['platform', 'platform', 'user', 'user']);
    expect(result).not.toHaveProperty('workspaceUsers');
    expect(result).not.toHaveProperty('packages');
    expect(result.revision).not.toBe((await readIdentityPermissionPopulation(sql, 'ws', {
      includeHostAuthorities: true,
    })).revision);
  });

  it.each(['enrollment', 'user', 'platform'] as const)(
    'refuses missing %s instead of deriving required IDs from the remaining stored policies', async missing => {
      if (missing !== 'enrollment') await seedAuthorities();
      if (missing !== 'user') await seedScopedPolicy('user');
      if (missing !== 'platform') await seedScopedPolicy('platform');
      await seedScopedPolicy('user', 'unrelated-user');
      await seedScopedPolicy('platform', 'unrelated-floor');
      await expect(readIdentityPermissionPopulation(sql, 'ws', { includeScopedPolicies: true }))
        .rejects.toThrow('scoped policy population is unavailable');
    });

  it('reads enrolled subjects and their policy in the same MVCC snapshot as the session source', async () => {
    await seed(); await seedAuthorities(); await seedScopedPolicy('user'); await seedScopedPolicy('platform');
    const before = await readIdentityPermissionPopulation(sql, 'ws', { includeScopedPolicies: true });
    let changed = false;
    const during = await readIdentityPermissionPopulation(sql, 'ws', { includeScopedPolicies: true, visit: async () => {
      if (!changed) { changed = true; await seedScopedPolicy('platform', 'missing-policy-floor', 1); }
    } });
    expect(changed).toBe(true);
    expect(during).toEqual(before);
    expect((await readIdentityPermissionPopulation(sql, 'ws', { includeScopedPolicies: true })).revision)
      .not.toBe(before.revision);
    expect(await sql.begin(tx => readIdentityPermissionPopulation(txSql(tx), 'ws', {
      includeScopedPolicies: true, expectedRevision: before.revision,
    }))).toMatchObject({ status: 'stale' });
  });

  it('holds scoped policies and new authority roots through the protected effect', async () => {
    await seedAuthorities(); await seedScopedPolicy('user'); await seedScopedPolicy('platform');
    const before = await readIdentityPermissionPopulation(sql, 'ws', { includeScopedPolicies: true });
    await sql.begin(async tx => {
      expect(await readIdentityPermissionPopulation(txSql(tx), 'ws', {
        includeScopedPolicies: true, expectedRevision: before.revision,
      })).toEqual(before);
      for (const action of ['update', 'delete', 'insert']) {
        await expect(sql.begin(async peer => {
          await peer`SET LOCAL lock_timeout = '80ms'`;
          if (action === 'update') await peer`UPDATE harness_shared.governance_policy_layers SET rules = '{}'`;
          else if (action === 'delete') await peer`DELETE FROM harness_shared.governance_policy_layers`;
          else await peer`INSERT INTO harness_shared.governance_policy_layers SELECT
            'new-root', level, scope_ref || 'extra', parent_layer_id, version, rules,
            exceptions, content_hash, updated_by, updated_at
            FROM harness_shared.governance_policy_layers LIMIT 1`;
        })).rejects.toMatchObject({ code: '55P03' });
      }
      await tx`INSERT INTO harness_shared.population_effects VALUES ('current')`;
    });
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([{ target: 'current' }]);
  });

  const inherited = { includeInheritedPolicies: true };
  async function seedInherited(department = true) {
    const common = { actor: 'editor-is-not-owner', reason: 'inherited source fixture', rules: { actions: { allow: ['inspect'] } } };
    await upsertLayer({ ...common, layerId: 'organization', level: 'organization', scopeRef: 'org', parentLayerId: null }, sql);
    if (department) await upsertLayer({ ...common, layerId: 'department', level: 'department', scopeRef: 'dept', parentLayerId: 'organization' }, sql);
    await upsertLayer({ ...common, layerId: 'workspace', level: 'workspace', scopeRef: 'ws',
      parentLayerId: department ? 'department' : 'organization' }, sql);
  }

  async function inheritedOwner(kind: 'organization' | 'department' | 'workspace', workspace = 'ws') {
    await sql`INSERT INTO harness_shared.governance_host_authority_bindings
      (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
      VALUES (${workspace}, ${kind}, ${kind}, ${`human-${kind}`}, ${'a'.repeat(64)}, 'explicit ownership fixture')`;
  }

  it('joins inherited authority ownership only from explicit same-workspace enrollment', async () => {
    await seedInherited();
    const unknown = await readIdentityPermissionPopulation(sql, 'ws', inherited);
    expect(unknown).toMatchObject({ inheritedPolicyOwners: [
      { authority: { kind: 'organization', id: 'organization' }, ownerId: null },
      { authority: { kind: 'department', id: 'department' }, ownerId: null },
      { authority: { kind: 'workspace', id: 'workspace' }, ownerId: null },
    ] });
    await inheritedOwner('organization');
    await inheritedOwner('department', 'foreign');
    await inheritedOwner('workspace');
    const current = await readIdentityPermissionPopulation(sql, 'ws', inherited);
    expect(current).toMatchObject({ hostAuthorities: { status: 'ok' }, inheritedPolicyOwners: [
      { authority: { kind: 'organization', id: 'organization', revision: expect.any(String) }, ownerId: 'human-organization' },
      { authority: { kind: 'department', id: 'department' }, ownerId: null },
      { authority: { kind: 'workspace', id: 'workspace' }, ownerId: 'human-workspace' },
    ] });
    expect(current.revision).not.toBe(unknown.revision);
    expect(JSON.stringify(current)).not.toContain('editor-is-not-owner');
    expect(await readIdentityPermissionPopulation(sql, 'ws')).not.toHaveProperty('inheritedPolicyOwners');
  });

  it('retains unmatched explicit owners while excluding a proven inapplicable department from ownership', async () => {
    await seedInherited(false); await inheritedOwner('department');
    expect(await readIdentityPermissionPopulation(sql, 'ws', inherited)).toMatchObject({
      hostAuthorities: { bindings: [{ kind: 'department', subjectId: 'department', humanOwnerId: 'human-department' }] },
      inheritedPolicyOwners: [
        { authority: { kind: 'organization' }, ownerId: null },
        { authority: { kind: 'workspace' }, ownerId: null },
      ],
    });
  });

  it('joins new inherited ownership in the session snapshot and invalidates the aggregate before effect', async () => {
    await seed(); await seedInherited();
    const before = await readIdentityPermissionPopulation(sql, 'ws', inherited);
    let inserted = false;
    const during = await readIdentityPermissionPopulation(sql, 'ws', { ...inherited, visit: async () => {
      if (inserted) return;
      inserted = true;
      await inheritedOwner('organization');
    } });
    expect(inserted).toBe(true);
    expect(during).toEqual(before);
    expect((await readIdentityPermissionPopulation(sql, 'ws', inherited)).revision).not.toBe(before.revision);
    const checked = await sql.begin(async tx => {
      const current = await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...inherited, expectedRevision: before.revision });
      if (current.status === 'ok') await tx`INSERT INTO harness_shared.population_effects VALUES ('stale')`;
      return current;
    });
    expect(checked.status).toBe('stale');
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([]);
  });

  it('rechecks inherited ownership committed while the reader waits for the enrollment lease', async () => {
    await seedInherited();
    const before = await readIdentityPermissionPopulation(sql, 'ws', inherited);
    let pending: Promise<unknown> | undefined;
    await sql.begin(async writer => {
      await writer`INSERT INTO harness_shared.governance_host_authority_bindings
        (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
        VALUES ('ws', 'organization', 'organization', 'new-human', ${'b'.repeat(64)}, 'explicit ownership fixture')`;
      pending = sql.begin(async reader => {
        const current = await readIdentityPermissionPopulation(txSql(reader), 'ws', { ...inherited, expectedRevision: before.revision });
        if (current.status === 'ok') await reader`INSERT INTO harness_shared.population_effects VALUES ('stale')`;
        return current;
      }).catch(error => error);
      const deadline = Date.now() + 10_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const [row] = await writer`SELECT EXISTS(SELECT 1 FROM pg_locks
          WHERE relation = 'harness_shared.governance_host_authority_bindings'::regclass
            AND mode = 'ShareLock' AND NOT granted) AS waiting`;
        waiting = row.waiting;
        if (!waiting) await writer`SELECT pg_sleep(0.01)`;
      }
      expect(waiting, 'reader reached the actual inherited ownership lock wait').toBe(true);
    });
    expect(await pending).toMatchObject({ status: 'stale' });
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([]);
  });

  it('holds inherited ownership edits and first enrollment gaps through effect', async () => {
    await seedInherited(); await inheritedOwner('organization');
    const before = await readIdentityPermissionPopulation(sql, 'ws', inherited);
    await sql.begin(async tx => {
      expect(await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...inherited, expectedRevision: before.revision })).toEqual(before);
      for (const action of ['insert', 'update', 'delete']) {
        await expect(sql.begin(async peer => {
          await peer`SET LOCAL lock_timeout = '80ms'`;
          if (action === 'insert') await peer`INSERT INTO harness_shared.governance_host_authority_bindings
            (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
            VALUES ('ws', 'department', 'department', 'new-human', ${'a'.repeat(64)}, 'new explicit owner')`;
          else if (action === 'update') await peer`UPDATE harness_shared.governance_host_authority_bindings SET human_owner_id = 'changed-human'`;
          else await peer`DELETE FROM harness_shared.governance_host_authority_bindings`;
        })).rejects.toMatchObject({ code: '55P03' });
      }
      await tx`INSERT INTO harness_shared.population_effects VALUES ('current')`;
    });
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([{ target: 'current' }]);
  });

  it('joins the canonical inherited chain without turning its editor into a human owner', async () => {
    await seedInherited();
    const result = await readIdentityPermissionPopulation(sql, 'ws', inherited);
    expect(result).toMatchObject({ status: 'ok', inheritedPolicies: { status: 'ok', policies: [
      { kind: 'organization', id: 'organization', state: 'present' },
      { kind: 'department', id: 'department', state: 'present' },
      { kind: 'workspace', id: 'workspace', state: 'present' },
    ] } });
    expect(JSON.stringify(result)).not.toContain('editor-is-not-owner');
    const unjoined = await readIdentityPermissionPopulation(sql, 'ws');
    expect(unjoined).not.toHaveProperty('inheritedPolicies');
    expect(result.revision).not.toBe(unjoined.revision);
    expect(await readIdentityPermissionPopulation(sql, 'ws', inherited)).toEqual(result);
  });

  it('retains canonical explicit no-department evidence in the inherited join', async () => {
    await seedInherited(false);
    expect(await readIdentityPermissionPopulation(sql, 'ws', inherited)).toMatchObject({ inheritedPolicies: { policies: [
      { kind: 'organization' }, { kind: 'workspace' }, { kind: 'department', state: 'not-applicable' },
    ] } });
  });

  it.each(['absent', 'broken-parent', 'hash-mismatch'] as const)('refuses %s inherited sources', async mode => {
    if (mode !== 'absent') await seedInherited();
    if (mode === 'broken-parent') await sql`UPDATE harness_shared.governance_policy_layers SET parent_layer_id = 'workspace' WHERE layer_id = 'department'`;
    if (mode === 'hash-mismatch') await sql`UPDATE harness_shared.governance_policy_layers SET rules = '{}' WHERE layer_id = 'organization'`;
    await expect(readIdentityPermissionPopulation(sql, 'ws', inherited)).rejects.toThrow('inherited policy population is unavailable');
  });

  it('reads sessions and inherited policies in one MVCC snapshot and refuses the changed source at effect', async () => {
    await seed(); await seedInherited();
    const before = await readIdentityPermissionPopulation(sql, 'ws', inherited);
    let changed = false;
    const during = await readIdentityPermissionPopulation(sql, 'ws', { ...inherited, visit: async () => {
      if (changed) return;
      changed = true;
      await upsertLayer({ layerId: 'organization', level: 'organization', scopeRef: 'org', parentLayerId: null,
        rules: { actions: { allow: ['edit'] } }, actor: 'different-editor', reason: 'concurrent change', expectedVersion: 1 }, sql);
    } });
    expect(changed).toBe(true);
    expect(during).toEqual(before);
    expect((await readIdentityPermissionPopulation(sql, 'ws', inherited)).revision).not.toBe(before.revision);
    const result = await sql.begin(async tx => {
      const current = await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...inherited, expectedRevision: before.revision });
      if (current.status === 'ok') await tx`INSERT INTO harness_shared.population_effects VALUES ('stale')`;
      return current;
    });
    expect(result.status).toBe('stale');
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([]);
  });

  it('rejects inherited changes committed while the effect reader waits for its policy lock', async () => {
    await seedInherited();
    const before = await readIdentityPermissionPopulation(sql, 'ws', inherited);
    let pending: Promise<unknown> | undefined;
    await sql.begin(async writer => {
      await upsertLayerInTx(txSql(writer), { layerId: 'organization', level: 'organization', scopeRef: 'org', parentLayerId: null,
        rules: { actions: { allow: ['edit'] } }, actor: 'concurrent-editor', reason: 'change during lease wait',
        expectedVersion: 1 });
      pending = sql.begin(async reader => {
        const current = await readIdentityPermissionPopulation(txSql(reader), 'ws', {
          ...inherited, expectedRevision: before.revision,
        });
        if (current.status === 'ok') await reader`INSERT INTO harness_shared.population_effects VALUES ('stale')`;
        return current;
      });
      // Preserve a rejection immediately, including when synchronization fails.
      pending = pending.catch(error => error);
      const deadline = Date.now() + 10_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const [row] = await writer`SELECT EXISTS(SELECT 1 FROM pg_locks
          WHERE relation = 'harness_shared.governance_policy_layers'::regclass
            AND mode = 'ShareLock' AND NOT granted) AS waiting`;
        waiting = row.waiting;
        if (!waiting) await writer`SELECT pg_sleep(0.01)`;
      }
      expect(waiting, 'reader reached the actual inherited policy lock wait').toBe(true);
    });
    expect(await pending).toMatchObject({ status: 'stale' });
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([]);
  });

  it('holds inherited updates, removals and new roots through the protected effect', async () => {
    await seedInherited();
    const before = await readIdentityPermissionPopulation(sql, 'ws', inherited);
    await sql.begin(async tx => {
      expect(await readIdentityPermissionPopulation(txSql(tx), 'ws', { ...inherited, expectedRevision: before.revision })).toEqual(before);
      for (const action of ['update', 'delete', 'insert']) {
        await expect(sql.begin(async peer => {
          await peer`SET LOCAL lock_timeout = '80ms'`;
          if (action === 'update') await peer`UPDATE harness_shared.governance_policy_layers SET rules = '{}' WHERE layer_id = 'organization'`;
          else if (action === 'delete') await peer`DELETE FROM harness_shared.governance_policy_layers WHERE layer_id = 'workspace'`;
          else await peer`INSERT INTO harness_shared.governance_policy_layers SELECT
            'new-root', level, scope_ref || '-new', parent_layer_id, version, rules, exceptions, content_hash, updated_by, updated_at
            FROM harness_shared.governance_policy_layers WHERE layer_id = 'organization'`;
        })).rejects.toMatchObject({ code: '55P03' });
      }
      await tx`INSERT INTO harness_shared.population_effects VALUES ('current')`;
    });
    expect(await sql`SELECT * FROM harness_shared.population_effects`).toEqual([{ target: 'current' }]);
  });

  it.each(['sessions', 'packages', 'host-authorities', 'scoped-policies', 'inherited-policies'] as const)('refuses hidden %s instead of reporting a filtered empty population', async domain => {
    const role = `population_reader_${randomBytes(5).toString('hex')}`;
    const table = domain === 'sessions' ? 'adv_sessions' : domain === 'packages'
      ? 'blueprint_package_installations' : domain === 'host-authorities'
        ? 'governance_host_authority_bindings' : 'governance_policy_layers';
    await sql.unsafe(`CREATE ROLE "${role}"; GRANT USAGE ON SCHEMA harness_shared TO "${role}";
      GRANT SELECT ON ALL TABLES IN SCHEMA harness_shared TO "${role}";
      ALTER TABLE harness_shared.${table} ENABLE ROW LEVEL SECURITY`);
    try {
      await sql.begin('isolation level repeatable read', async tx => {
        await tx.unsafe(`SET LOCAL ROLE "${role}"`);
        const workspace = ['host-authorities', 'scoped-policies', 'inherited-policies'].includes(domain) ? 'ws' : 'foreign';
        expect(await tx`SELECT set_config('app.workspace_id', ${workspace}, true) AS workspace`)
          .toEqual([{ workspace }]);
        await expect(readIdentityPermissionPopulation(txSql(tx), 'ws', domain === 'packages' ? joined
          : domain === 'host-authorities' ? { includeHostAuthorities: true }
            : domain === 'scoped-policies' ? { includeScopedPolicies: true }
              : domain === 'inherited-policies' ? { includeInheritedPolicies: true } : {})).rejects.toThrow(/not (fully )?visible/);
      });
    } finally {
      await sql.unsafe(`ALTER TABLE harness_shared.${table} DISABLE ROW LEVEL SECURITY;
        DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
  });
});
