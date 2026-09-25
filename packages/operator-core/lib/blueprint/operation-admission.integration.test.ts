import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { compileAgentSpecification, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg } from './project-to-pg';
import { submitBlueprintOperation } from './operation-service';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));

const workspaceId = 'program-child-pin-it';
const harnessSlug = 'program-child-pin-it';
let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  connection.sql = sql;
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${Buffer.from([0])}, 'kc-program-child-pin-it', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
}, 120_000);
afterAll(async () => db?.cleanup(), 120_000);

const definition = (version: string) => compileAgentSpecification({
  source: {
    id: 'program-child-pin', version, workItem: { kind: 'feature' },
    roles: [{ id: 'worker' }], spine: { edges: { DONE: { to: 'done' } } },
    operations: [{
      id: 'leaf', version,
      target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'agent', role: 'worker' },
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      acceptance: { resultSchema: { type: 'object' } },
    }],
  },
});

describe('program child admission pins the root specification', () => {
  it('accepts revision A after pointer B and refuses a changed replay', async () => {
    const first = definition('A');
    const second = definition('B');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: first.configuration as Blueprint, specification: first });
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: second.configuration as Blueprint, specification: second });

    const request = { workspaceId, harnessSlug, callerId: 'program-root-1', operationId: 'leaf',
      requestKey: 'root:step-1', input: { value: 'original' }, title: 'Pinned child' };
    const accepted = await submitBlueprintOperation(sql, request,
      { expectedSpecificationRevision: first.specificationRevision });
    expect(accepted.specificationRevision).toBe(first.specificationRevision);
    expect(accepted.target.kind).toBe('work-item');
    const replay = await submitBlueprintOperation(sql, request,
      { expectedSpecificationRevision: first.specificationRevision });
    expect(replay).toEqual(accepted);
    await expect(submitBlueprintOperation(sql, request,
      { expectedSpecificationRevision: second.specificationRevision }))
      .rejects.toThrow('receipt differs from the expected specification revision');

    const [item] = await sql<Array<{ payload: { blueprintOperation: { specificationRevision: string } } }>>`
      SELECT payload FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND feature_id = ${(accepted.target as { id: string }).id}
    `;
    expect(item.payload.blueprintOperation.specificationRevision).toBe(first.specificationRevision);
  }, 90_000);
});
