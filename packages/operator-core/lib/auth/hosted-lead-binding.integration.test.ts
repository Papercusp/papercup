import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  const migration = await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1607-hosted-lead-binding-receipts.sql', import.meta.url), 'utf8');
  await db.adminSql.unsafe(migration);
  await db.adminSql.unsafe(migration);
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

async function challenge() {
  const id = randomUUID();
  await db.adminSql.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    await tx`INSERT INTO papercusp_auth.hosted_lead_bindings
      (challenge_id, graph_workspace_id, person_ref, environment, issuer_ref, issued_at, expires_at)
      VALUES (${id}::uuid, 'graph-a', ${`PER-${randomUUID()}`}, 'production', 'operator-a',
        '2026-10-28T19:00:00Z', '2026-10-28T19:10:00Z')`;
  });
  return id;
}
describe('hosted lead binding durable proof', () => {
  it('allows service-only access and refuses changing the issued scope', async () => {
    const id = await challenge();
    await expect(db.appSql`SELECT * FROM papercusp_auth.hosted_lead_bindings`).rejects.toThrow();
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_lead_bindings SET person_ref = 'PER-foreign'
      WHERE challenge_id = ${id}::uuid`).rejects.toThrow('immutable');
  });
  it('enforces a bounded lifetime and complete redemption identity', async () => {
    await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_lead_bindings
      (challenge_id, graph_workspace_id, person_ref, environment, issuer_ref, issued_at, expires_at)
      VALUES (${randomUUID()}::uuid, 'graph-a', 'PER-a', 'production', 'operator-a',
        '2026-10-28T19:00:00Z', '2026-10-28T20:00:00Z')`).rejects.toThrow();
    const id = await challenge();
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_lead_bindings SET redeemed_at = '2026-10-28T19:05:00Z'
      WHERE challenge_id = ${id}::uuid`).rejects.toThrow();
  });
  it('permits one atomic redemption and keeps identity and revocation immutable', async () => {
    const id = await challenge();
    const [user] = await db.adminSql`INSERT INTO papercusp_auth.hosted_users DEFAULT VALUES RETURNING id`;
    const [org] = await db.adminSql`INSERT INTO papercusp_auth.organizations (external_organization_id, display_name)
      VALUES (${randomUUID()}, 'Binding test') RETURNING id`;
    const redeem = () => db.adminSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return tx`UPDATE papercusp_auth.hosted_lead_bindings
        SET user_id = ${user!.id}::uuid, organization_id = ${org!.id}::uuid, redeemed_at = '2026-10-28T19:05:00Z'
        WHERE challenge_id = ${id}::uuid AND redeemed_at IS NULL AND revoked_at IS NULL RETURNING challenge_id`;
    });
    const attempts = await Promise.all([redeem(), redeem()]);
    expect(attempts.map(rows => rows.length).sort()).toEqual([0, 1]);
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_lead_bindings SET redeemed_at = '2026-10-28T19:06:00Z'
      WHERE challenge_id = ${id}::uuid`).rejects.toThrow('immutable');
    await db.adminSql`UPDATE papercusp_auth.hosted_lead_bindings SET revoked_at = '2026-10-28T19:07:00Z'
      WHERE challenge_id = ${id}::uuid`;
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_lead_bindings SET revoked_at = NULL
      WHERE challenge_id = ${id}::uuid`).rejects.toThrow('immutable');
  });
});
