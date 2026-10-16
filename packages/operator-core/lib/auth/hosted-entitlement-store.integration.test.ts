/** P-537: actual ledger persistence, role isolation and concurrent revisions. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  readHostedEntitlementAuthority, writeHostedEntitlementAuthority, type HostedEntitlementAuthorityRecords,
} from './hosted-entitlement-store';

const migration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1524-hosted-entitlement-authority.sql', import.meta.url));
const migrationSql = readFileSync(existsSync(migration) ? migration : `${migration}.DRAFT`, 'utf8');
const now = new Date('2026-10-16T08:00:00Z');

describe('hosted entitlement authority (real PG + hosted roles)', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql.unsafe(migrationSql);
    await db.adminSql.unsafe(migrationSql);
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });
  const service = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => db.appSql.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
  const read = (org: string, at = now) => db.appSql.begin(tx =>
    readHostedEntitlementAuthority(tx as unknown as Sql, org, at));
  async function grant() {
    const organizationId = randomUUID();
    const userId = randomUUID();
    await service(async sql => {
      await sql`INSERT INTO papercusp_auth.hosted_entitlements (organization_id, user_id, kind, source)
        VALUES (${organizationId}::uuid, ${userId}::uuid, 'hosted-free', 'self_signup')`;
    });
    return { organizationId, userId, kind: 'hosted-free', expectedRevision: 0 };
  }
  function authority(organizationId: string, agents = 50): HostedEntitlementAuthorityRecords {
    const record = { source: 'migration', actor: { kind: 'service', principalId: 'service:trial-policy' },
      auditReceiptId: 'audit:trial-policy-v1', effectiveFrom: '2026-10-01T00:00:00Z', effectiveUntil: '2026-11-01T00:00:00Z' };
    return { schemaVersion: 1,
      bundles: [{ schemaVersion: 1, bundleId: 'trial-v1', bundleVersion: 1, record,
        entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 1 },
          browserAccess: { pty: true, files: true }, supportTier: 'trial',
          quotas: { 'pool.agents': agents, 'pool.db-gib': 256 }, budgets: {}, rolloutFlags: {} } }],
      assignments: [{ schemaVersion: 1, assignmentId: `trial:${organizationId}`, organizationId,
        bundleId: 'trial-v1', bundleVersion: 1,
        record: { ...record, auditReceiptId: 'audit:trial-assignment-v1' } }], overrides: [] };
  }
  it('keeps legacy labels allowance-free and stores versioned authority on the existing grant', async () => {
    const g = await grant();
    expect(await read(g.organizationId)).toEqual({ ok: false, reason: 'authority_missing' });
    expect(await writeHostedEntitlementAuthority({ ...g, authority: authority(g.organizationId) }, service)).toBe(1);
    expect(await read(g.organizationId)).toMatchObject({ ok: true, authorityRevision: 1, grantUserId: g.userId,
      resolution: { organizationId: g.organizationId, bundleVersion: 1,
        quotas: { 'pool.agents': 50, 'pool.db-gib': 256 },
        auditReceiptIds: ['audit:trial-policy-v1', 'audit:trial-assignment-v1'] } });
    expect(await read(randomUUID())).toEqual({ ok: false, reason: 'authority_missing' });
    await expect(db.appSql`SELECT authority FROM papercusp_auth.hosted_entitlements`).rejects.toMatchObject({ code: '42501' });
    await db.appSql.begin(async tx => {
      expect(await readHostedEntitlementAuthority(tx as unknown as Sql, g.organizationId, now)).toMatchObject({ ok: true });
      expect((await tx`SELECT current_user AS role`)[0].role).toBe('harness_app');
    });
  });
  it('serializes competing revisions, supports downgrade/revocation, and never creates a missing grant', async () => {
    const g = await grant();
    const writes = await Promise.allSettled([10, 20].map(agents =>
      writeHostedEntitlementAuthority({ ...g, authority: authority(g.organizationId, agents) }, service)));
    expect(writes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter(row => row.status === 'rejected')).toHaveLength(1);
    await writeHostedEntitlementAuthority({ ...g, expectedRevision: 1, authority: authority(g.organizationId, 1) }, service);
    expect(await read(g.organizationId)).toMatchObject({ ok: true, authorityRevision: 2,
      resolution: { quotas: { 'pool.agents': 1 } } });
    expect(await read(g.organizationId, new Date('2026-11-01T00:00:00Z'))).toMatchObject({ ok: false, reason: 'no_active_assignment' });
    await writeHostedEntitlementAuthority({ ...g, expectedRevision: 2, authority: null }, service);
    expect(await read(g.organizationId)).toMatchObject({ ok: false, reason: 'authority_missing' });
    await expect(writeHostedEntitlementAuthority({ ...g, userId: randomUUID(), authority: authority(g.organizationId) }, service))
      .rejects.toThrow('hosted_entitlement_revision_conflict');
  });
  it('refuses foreign history, malformed persisted records and ambiguous grant authorities', async () => {
    const g = await grant();
    for (const malformed of [{}, { schemaVersion: null, bundles: [], assignments: [], overrides: [] }]) {
      await expect(service(async sql => {
        await sql`UPDATE papercusp_auth.hosted_entitlements SET authority = ${JSON.stringify(malformed)}::jsonb,
          authority_revision = 1 WHERE organization_id = ${g.organizationId}::uuid`;
      })).rejects.toMatchObject({ code: '23514' });
    }
    await expect(writeHostedEntitlementAuthority({ ...g, authority: authority(randomUUID()) }, service))
      .rejects.toThrow('hosted_entitlement_assignment_invalid');
    const bad = authority(g.organizationId);
    (bad.bundles[0] as any).entitlements.quotas['pool.agents'] = -1;
    await expect(writeHostedEntitlementAuthority({ ...g, authority: bad }, service)).rejects.toThrow('hosted_entitlement_bundle_invalid');
    // A service/old-version writer can bypass the parser. Validate persisted bytes too.
    await service(async sql => { await sql`UPDATE papercusp_auth.hosted_entitlements SET authority = ${JSON.stringify(bad)}::jsonb,
      authority_revision = 1 WHERE organization_id = ${g.organizationId}::uuid`; });
    expect(await read(g.organizationId)).toEqual({ ok: false, reason: 'invalid_authority_records' });
    await writeHostedEntitlementAuthority({ ...g, expectedRevision: 1, authority: authority(g.organizationId) }, service);
    await service(async sql => { await sql`INSERT INTO papercusp_auth.hosted_entitlements
      (organization_id, user_id, kind, source, authority, authority_revision)
      VALUES (${g.organizationId}::uuid, ${randomUUID()}::uuid, 'hosted-paid:untrusted-label', 'billing',
        ${JSON.stringify(authority(g.organizationId))}::jsonb, 1)`; });
    expect(await read(g.organizationId)).toEqual({ ok: false, reason: 'ambiguous_authority' });
  });
  it('shares the admission lock with authority writers and rolls back authority with its transaction', async () => {
    const g = await grant();
    await writeHostedEntitlementAuthority({ ...g, authority: authority(g.organizationId) }, service);
    let started!: () => void;
    const writerStarted = new Promise<void>(resolve => { started = resolve; });
    let writer!: Promise<number>;
    await db.appSql.begin(async tx => {
      expect(await readHostedEntitlementAuthority(tx as unknown as Sql, g.organizationId, now)).toMatchObject({ ok: true });
      writer = writeHostedEntitlementAuthority({ ...g, expectedRevision: 1, authority: null }, async run => {
        started(); return service(run);
      });
      await writerStarted;
      const [probe] = await db.adminSql`SELECT pg_try_advisory_xact_lock(hashtextextended(
        ${`hosted-entitlement:organization:${g.organizationId}`}, 0)) AS acquired`;
      expect(probe.acquired).toBe(false);
    });
    expect(await writer).toBe(2);
    await expect(service(async tx => {
      await writeHostedEntitlementAuthority({ ...g, expectedRevision: 2, authority: authority(g.organizationId) }, async run => run(tx));
      throw new Error('injected_rollback');
    })).rejects.toThrow('injected_rollback');
    expect(await read(g.organizationId)).toMatchObject({ ok: false, reason: 'authority_missing' });
  });
});
