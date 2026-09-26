import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { preflightCarryCohortUsageQuery, readCarryCohortUsage } from './carry-cohort-driver';

const WS = 'p005-cohort-ledger-test';
let org: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1205-interactive-usage-request-provenance.sql', import.meta.url);
  await sql.unsafe(readFileSync(migration, 'utf8'));
});
beforeEach(async () => { await sql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`; });
afterAll(async () => { await org?.cleanup(); });

describe('P-005 canonical cohort ledger (real PostgreSQL)', () => {
  it('preflights the same query before charge and reads bigint epoch-ms rows in event order', async () => {
    await expect(preflightCarryCohortUsageQuery(sql, WS)).resolves.toBeUndefined();
    await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id,ts,event_ts,source,provider,bucket_key,model_class,session_id,model,usage_event_key,
       input_tokens,cache_read_tokens,cache_creation_tokens,output_tokens,cost_usd)
      VALUES
      (${WS},1790463000002,null,'interactive','openai','openai:gpt','gpt','candidate','gpt-6-sol','p005-later',100,20,0,5,0),
      (${WS},1790463000003,1790463000001,'interactive','openai','openai:gpt','gpt','candidate','gpt-6-sol','p005-earlier',90,10,0,4,0),
      (${WS},1790463000000,null,'interactive','openai','openai:gpt','gpt','other','gpt-6-sol','p005-other',80,0,0,3,0)`;
    const rows = await readCarryCohortUsage(sql, { workspaceId: WS, sessionIds: ['candidate'] });
    expect(rows.map(row => [row.usage_event_key, row.ts, row.input_tokens])).toEqual([
      ['p005-earlier', '1790463000001', 90], ['p005-later', '1790463000002', 100],
    ]);
    expect(await readCarryCohortUsage(sql, { workspaceId: WS, sessionIds: [] })).toEqual([]);
  });

  it('fails closed on an unavailable canonical token category', async () => {
    await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id,ts,source,provider,bucket_key,model_class,session_id,model,usage_event_key,
       input_tokens,cache_read_tokens,cache_creation_tokens,output_tokens,cost_usd)
      VALUES (${WS},1790463000000,'interactive','openai','openai:gpt','gpt','candidate','gpt-6-sol','p005-unknown',
              null,20,0,5,null)`;
    await expect(readCarryCohortUsage(sql, { workspaceId: WS, sessionIds: ['candidate'] }))
      .rejects.toThrow('unavailable input_tokens');
  });
});
