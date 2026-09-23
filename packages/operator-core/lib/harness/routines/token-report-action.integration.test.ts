import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { readTokenReportAggregation } from './token-report-action';

let org: OrgTestDb;
const WS = 'cache-report-coverage';
beforeAll(async () => {
  org = await createOrgTestDb();
  const migration = new URL('../../../../../libs/papercusp/libs/db/sql/1205-interactive-usage-request-provenance.sql', import.meta.url);
  await org.adminSql.unsafe(await fs.readFile(migration, 'utf8'));
});
afterAll(async () => { await org?.cleanup(); });

describe('token report source coverage (real PostgreSQL)', () => {
  it('pairs comparable populations, separates legacy time and reports costs from the actual writer labels', async () => {
    const sql = org.adminSql;
    for (const [ws, event, input, read, write, total, cost, costSource, grain] of [
      [WS, 100, null, 800, null, 1000, 2, 'estimated', 'request'],
      [WS, 100, 100, 100, null, null, null, null, 'request'],
      [WS, null, 10, 90, 0, null, 3, 'provider', null],
      ['another-workspace', 100, 0, 999999, 0, 999999, 99, 'provider', 'request'],
    ] as const) {
      await sql`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id,ts,source,provider,bucket_key,model_class,input_tokens,output_tokens,
          cache_read_tokens,cache_creation_tokens,cost_usd,cost_source,event_ts,usage_provenance)
        VALUES (${ws},100,'interactive','openai','openai:gpt','gpt',${input},10,
          ${read},${write},${cost},${costSource},${event},${JSON.stringify({ grain, inputTotalTokens: total })}::jsonb)`;
    }
    const rows = await readTokenReportAggregation(sql, WS, 'source', 0, 101);
    expect(rows).toHaveLength(2);
    const current = rows.find(row => row.dim.endsWith('[request-time]'))!;
    expect(Number(current.calls)).toBe(2);
    expect(Number(current.comparable_samples)).toBe(1);
    expect(Number(current.comparable_input)).toBe(1000);
    expect(Number(current.comparable_read)).toBe(800); // NOT (800 + 100) / 1000
    expect(Number(current.request_observations)).toBe(2);
    expect(Number(current.request_hits)).toBe(2);
    expect(current.cw_t).toBeNull();
    expect(Number(current.unpriced)).toBe(1);
    expect(current.estimated_usd).toBe(2);
    expect(current.reported_usd).toBeNull();
    const legacy = rows.find(row => row.dim.includes('ingestion-time'))!;
    expect(legacy.reported_usd).toBe(3);
    expect(Number(legacy.request_observations)).toBe(0);
    expect(await readTokenReportAggregation(sql, WS, 'source', 101, 102)).toEqual([]);
  });
});
