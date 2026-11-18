import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { loadChainForWorkspace, listLayers, loadScopedPolicyAuthorities, upsertLayer,
  upsertScopedPolicyAuthority, upsertScopedPolicyAuthorityInTx, type UpsertScopedAuthorityInput } from './store';
import { evaluateEffectivePermission, type AuthoritySnapshot } from './effective-authority';

let sql: postgres.Sql;
beforeAll(async () => {
  const uri = await getTestPg();
  const dbName = `scopedpolicy_${randomBytes(5).toString('hex')}`;
  const admin = postgres(uri, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE "${dbName}"`); await markManagedTestDatabase(admin, dbName); }
  finally { await admin.end({ timeout: 5 }); }
  const target = new URL(uri); target.pathname = `/${dbName}`;
  sql = postgres(target.toString(), { max: 4, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  for (const file of ['1497-governance-policy-layers.sql', '1644-governance-scoped-authority-levels.sql']) {
    const path = fileURLToPath(new URL(`../../../../libs/papercusp/libs/db/sql/${file}`, import.meta.url));
    await sql.unsafe(readFileSync(existsSync(path) ? path : `${path}.DRAFT`, 'utf8'));
  }
  await sql.unsafe('CREATE TABLE harness_shared.scoped_test_effects (target text NOT NULL)');
}, 60_000);
afterAll(async () => { await sql?.end({ timeout: 5 }); });
beforeEach(async () => { await sql.unsafe('TRUNCATE harness_shared.governance_policy_layer_versions, harness_shared.governance_policy_layers, harness_shared.scoped_test_effects'); });

const scope = { workspaceId: 'ws', userId: 'user:alice', platformIds: ['fixed-floor'] };
const policy = (kind: 'user' | 'platform', overrides: Partial<UpsertScopedAuthorityInput> = {}): UpsertScopedAuthorityInput => ({
  kind, workspaceId: scope.workspaceId, subjectId: kind === 'user' ? scope.userId : scope.platformIds[0],
  rules: { tools: { allow: ['identity:edit'] }, actions: { allow: ['edit'] }, resources: { allow: ['*'] } },
  actor: 'admin:policy-author', reason: 'explicit scoped policy', expectedVersion: 0, ...overrides,
});
async function seed() { for (const kind of ['user', 'platform'] as const) await upsertScopedPolicyAuthority(policy(kind), sql); }

describe('canonical user/platform authority storage (P-002)', () => {
  it('requires an existing transaction at the public transaction-only writer', async () => {
    await expect(upsertScopedPolicyAuthorityInTx(sql, policy('user'))).rejects.toThrow('existing transaction');
    expect(await sql`SELECT * FROM harness_shared.governance_policy_layers`).toEqual([]);
  });

  it('rejects array-shaped rules before any canonical policy or evidence write', async () => {
    const malformed = policy('user');
    Object.assign(malformed.rules, { tools: [] });
    await expect(upsertScopedPolicyAuthority(malformed, sql)).rejects.toThrow('rules must map');
    expect(await sql`SELECT * FROM harness_shared.governance_policy_layers`).toEqual([]);
    expect(await sql`SELECT * FROM harness_shared.governance_policy_layer_versions`).toEqual([]);
  });

  it('requires every scoped row and separates users, workspaces and platforms from the hierarchy', async () => {
    expect(await loadScopedPolicyAuthorities(scope, sql)).toMatchObject({ status: 'unavailable' });
    await upsertScopedPolicyAuthority(policy('user'), sql);
    expect(await loadScopedPolicyAuthorities(scope, sql)).toMatchObject({ status: 'unavailable' });
    await upsertScopedPolicyAuthority(policy('platform'), sql);
    const loaded = await loadScopedPolicyAuthorities(scope, sql);
    expect(loaded).toMatchObject({ status: 'ok', policies: expect.arrayContaining([
      { kind: 'user', id: expect.any(String), revision: expect.any(String), state: 'present', rules: policy('user').rules, exceptions: [] },
      { kind: 'platform', id: expect.any(String), revision: expect.any(String), state: 'present', rules: policy('platform').rules, exceptions: [] },
    ]) });
    for (const other of [{ ...scope, workspaceId: 'other' }, { ...scope, userId: 'user:bob' }, { ...scope, platformIds: ['other'] }])
      expect(await loadScopedPolicyAuthorities(other, sql)).toMatchObject({ status: 'unavailable' });
    expect(await loadChainForWorkspace('ws', sql)).toEqual({ status: 'none' });
    expect(await listLayers(sql)).toEqual([]);
  });

  it('uses stored rules at the shared evaluator and records complete version evidence', async () => {
    await seed();
    await upsertScopedPolicyAuthority(policy('user', { expectedVersion: 1, rules: { actions: { deny: ['edit'] } } }), sql);
    const loaded = await loadScopedPolicyAuthorities(scope, sql);
    if (loaded.status !== 'ok') throw new Error('scoped policies missing');
    const snapshot: AuthoritySnapshot = { required: [], policies: [
      ...loaded.policies,
      { kind: 'identity', id: 'identity', revision: '1', state: 'present', rules: policy('user').rules },
      ...(['organization', 'department', 'workspace'] as const).map(kind => ({ kind, id: kind, revision: '1', state: 'not-applicable' as const })),
    ], contextRevision: 'no-vault', contextVaultIds: [] };
    snapshot.required = snapshot.policies.map(({ kind, id }) => ({ kind, id }));
    expect(evaluateEffectivePermission(snapshot, { tool: 'identity:edit', action: 'edit', resource: { kind: 'store', operation: 'write', target: 'identity' } }))
      .toMatchObject({ allowed: false, code: 'denied', decidingAuthority: { kind: 'user' } });
    expect(await sql`SELECT version, rules, reason, actor FROM harness_shared.governance_policy_layer_versions WHERE level = 'user' ORDER BY version`).toEqual([
      { version: 1, rules: policy('user').rules, reason: 'explicit scoped policy', actor: 'admin:policy-author' },
      { version: 2, rules: { actions: { deny: ['edit'] } }, reason: 'explicit scoped policy', actor: 'admin:policy-author' },
    ]);
  });

  it.each(['rules', 'exceptions', 'scope_ref', 'content_hash'] as const)('refuses tampered %s', async field => {
    await seed();
    const value = field === 'rules' ? 'null' : field === 'exceptions' ? '{}' : 'tampered';
    await sql.unsafe(`UPDATE harness_shared.governance_policy_layers SET ${field} = $1 WHERE level = 'user'`, [value]);
    expect(await loadScopedPolicyAuthorities(scope, sql)).toMatchObject({ status: 'malformed' });
  });

  it('rechecks revisions in the transaction and prevents a stale protected write', async () => {
    await seed();
    const before = await loadScopedPolicyAuthorities(scope, sql);
    if (before.status !== 'ok') throw new Error('baseline missing');
    await expect(loadScopedPolicyAuthorities(scope, sql, before.revision)).rejects.toThrow('existing transaction');
    expect(await sql.begin(tx => loadScopedPolicyAuthorities(scope, tx as unknown as postgres.Sql, before.revision))).toEqual(before);
    await upsertScopedPolicyAuthority(policy('platform', { expectedVersion: 1, rules: { actions: { deny: ['edit'] } } }), sql);
    const current = await sql.begin(async tx => {
      const result = await loadScopedPolicyAuthorities(scope, tx as unknown as postgres.Sql, before.revision);
      if (result.status === 'ok') await tx`INSERT INTO harness_shared.scoped_test_effects VALUES ('write')`;
      return result;
    });
    expect(current).toMatchObject({ status: 'stale' });
    expect(await sql`SELECT * FROM harness_shared.scoped_test_effects`).toEqual([]);
  });

  it('serializes concurrent creators without recording two version-one policies', async () => {
    const outcomes = await Promise.allSettled([1, 2].map(() => upsertScopedPolicyAuthority(policy('user'), sql)));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({
      reason: { name: 'GovernancePolicyWriteError', code: 'conflict' },
    });
    expect(await sql`SELECT version FROM harness_shared.governance_policy_layer_versions`).toEqual([{ version: 1 }]);
  });

  it('holds canonical policy locks through the first protected effect', async () => {
    await seed();
    const before = await loadScopedPolicyAuthorities(scope, sql);
    if (before.status !== 'ok') throw new Error('baseline missing');
    await sql.begin(async reader => {
      expect(await loadScopedPolicyAuthorities(scope, reader as unknown as postgres.Sql, before.revision)).toEqual(before);
      await expect(sql.begin(async writer => {
        await writer`SET LOCAL lock_timeout = '150ms'`;
        await upsertScopedPolicyAuthorityInTx(writer as unknown as postgres.Sql,
          policy('platform', { expectedVersion: 1, rules: { actions: { deny: ['edit'] } } }));
      })).rejects.toMatchObject({ code: '55P03' });
      await reader`INSERT INTO harness_shared.scoped_test_effects VALUES ('held-policy-effect')`;
    });
    expect(await sql`SELECT * FROM harness_shared.scoped_test_effects`).toEqual([{ target: 'held-policy-effect' }]);
    await expect(upsertScopedPolicyAuthority(policy('platform', { expectedVersion: 1, rules: { actions: { deny: ['edit'] } } }), sql))
      .resolves.toMatchObject({ kind: 'platform', revision: expect.stringMatching(/^2:/) });
  });

  it('pins every supplied platform policy independent of declaration order', async () => {
    await seed();
    await upsertScopedPolicyAuthority(policy('platform', { subjectId: 'second-floor' }), sql);
    const extended = { ...scope, platformIds: ['fixed-floor', 'second-floor'] };
    const before = await loadScopedPolicyAuthorities(extended, sql);
    expect(before).toMatchObject({ status: 'ok', policies: expect.any(Array) });
    if (before.status !== 'ok') throw new Error('platform policies missing');
    expect(before.policies).toHaveLength(3);
    expect(await loadScopedPolicyAuthorities({ ...extended, platformIds: [...extended.platformIds].reverse() }, sql)).toEqual(before);
    await upsertScopedPolicyAuthority(policy('platform', { subjectId: 'second-floor', expectedVersion: 1, rules: {} }), sql);
    expect(await sql.begin(tx => loadScopedPolicyAuthorities(extended, tx as unknown as postgres.Sql, before.revision)))
      .toMatchObject({ status: 'stale' });
  });

  it('shares the caller transaction and rolls policy and history back with its effect', async () => {
    await expect(sql.begin(async tx => {
      await upsertScopedPolicyAuthorityInTx(tx as unknown as postgres.Sql, policy('user'));
      throw new Error('effect refused');
    })).rejects.toThrow('effect refused');
    expect(await sql`SELECT * FROM harness_shared.governance_policy_layers`).toEqual([]);
    expect(await sql`SELECT * FROM harness_shared.governance_policy_layer_versions`).toEqual([]);
  });

  it('prevents hierarchy edits from replacing or inheriting through a scoped authority', async () => {
    await seed();
    const scoped = await sql`SELECT layer_id FROM harness_shared.governance_policy_layers WHERE level = 'platform'`;
    await expect(upsertLayer({ layerId: scoped[0].layer_id, level: 'organization', scopeRef: 'org', parentLayerId: null,
      rules: {}, actor: 'admin:other', reason: 'replace', expectedVersion: 1 }, sql)).rejects.toThrow('another policy scope');
    await expect(upsertLayer({ layerId: 'workspace', level: 'workspace', scopeRef: 'ws', parentLayerId: scoped[0].layer_id,
      rules: {}, actor: 'admin:other', reason: 'inherit' }, sql)).rejects.toThrow('only an organization or department');
  });

  it.each([{ userId: '' }, { platformIds: [] }, { platformIds: ['fixed-floor', 'fixed-floor'] }])('refuses incomplete scope %j', async invalid => {
    expect(await loadScopedPolicyAuthorities({ ...scope, ...invalid }, sql)).toMatchObject({ status: 'unavailable' });
  });
});
