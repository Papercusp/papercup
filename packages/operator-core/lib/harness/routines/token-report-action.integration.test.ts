import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { readTokenReportAggregation, readUsageHealth, evaluateUsageHealth, readCarryHealth, renderCarryHealth } from './token-report-action';
import { evaluateCarryStartup } from '../../launch-cost/launch-cost-metrics';

let org: OrgTestDb;
const WS = 'cache-report-coverage';
beforeAll(async () => {
  org = await createOrgTestDb();
  const migration = new URL('../../../../../libs/papercusp/libs/db/sql/1205-interactive-usage-request-provenance.sql', import.meta.url);
  await org.adminSql.unsafe(await fs.readFile(migration, 'utf8'));
});
afterAll(async () => { await org?.cleanup(); });

describe('token report source coverage (real PostgreSQL)', () => {
  it('detects carry regressions from scoped ordered request provenance while preserving partial windows as unknown', async () => {
    const sql = org.adminSql;
    const workspace = 'carry-health-ledger';
    for (const ws of [workspace, 'other-carry-workspace']) {
      for (const [ordinal, input, cached, generation] of [[3, 90205, 7936, 1], [1, 691102, 0, 0], [2, 690650, 2816, 0]]) {
        await sql`INSERT INTO harness_shared.agent_usage_samples
          (workspace_id,ts,event_ts,source,provider,bucket_key,model_class,model,session_id,
           cache_read_tokens,cache_creation_tokens,usage_provenance)
          VALUES (${ws},${ordinal},${ordinal},'interactive','openai','openai:test','default','gpt-6-sol','native-fork',
            ${cached},NULL,${JSON.stringify({ grain: 'request', adapter: 'codex', sourceFile: '/fixture/fork', fileGeneration: 0,
              requestOrdinal: ordinal, inputTotalTokens: input, contextGeneration: generation, predecessorSessionId: 'parent' })}::jsonb)`;
      }
    }
    const rows = await readCarryHealth(sql, workspace, 0, 4);
    expect(rows).toHaveLength(1);
    expect(evaluateCarryStartup(rows[0].observations)).toMatchObject({ state: 'regression',
      signals: ['cold-inherited-startup', 'oversized-startup-immediately-compacted'], firstTwoUncachedInput: null });
    expect(renderCarryHealth(rows)).toContain('1 source groups; 0 incomplete; 1 cold inherited startup; 1 oversized startup immediately compacted');
    const partial = await readCarryHealth(sql, workspace, 2, 4);
    expect(evaluateCarryStartup(partial[0].observations)).toMatchObject({ state: 'unknown', signals: [] });
    expect(await readCarryHealth(sql, workspace, 4, 5)).toEqual([]);
  });

  it('detects tier and model-provenance contradictions from the scoped ledger', async () => {
    const sql = org.adminSql;
    const workspace = 'cache-accounting-health';
    for (const ws of [workspace, 'unrelated-health-workspace']) {
      await sql`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id,ts,event_ts,source,provider,bucket_key,model_class,model,
         cache_creation_tokens,cache_creation_5m_tokens,cache_creation_1h_tokens,usage_provenance)
        VALUES (${ws},100,100,'interactive','anthropic','anthropic:test','default',NULL,100,20,30,
          ${JSON.stringify({ grain: 'request', modelSource: 'transcript' })}::jsonb)`;
    }
    const rows = await readUsageHealth(sql, workspace, 0, 101);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].samples)).toBe(1);
    expect(Number(rows[0].timed_requests)).toBe(1);
    expect(Number(rows[0].tier_mismatches)).toBe(1);
    expect(Number(rows[0].model_provenance_mismatches)).toBe(1);
    expect(evaluateUsageHealth(rows[0], 101).signals).toHaveLength(2);
    expect(await readUsageHealth(sql, workspace, 101, 200)).toEqual([]);
  });

  it('includes unavailable-source rows in coverage but not token or price estimates', async () => {
    const sql = org.adminSql;
    const workspace = 'cache-unrecoverable-report';
    await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id,ts,source,provider,bucket_key,model_class,usage_provenance)
      VALUES (${workspace},100,'interactive','openai','openai:gpt','default',
        ${JSON.stringify({ grain: 'unrecoverable-legacy', historicalAvailability: { status: 'source-unavailable' } })}::jsonb)`;
    const [row] = await readTokenReportAggregation(sql, workspace, 'source', 0, 101);
    expect(Number(row.unrecoverable_samples)).toBe(1);
    expect(Number(row.unpriced)).toBe(1);
    expect(Number(row.comparable_samples)).toBe(0);
    expect(Number(row.request_observations)).toBe(0);
    expect(row.in_t).toBeNull();
    expect(row.usd).toBeNull();
  });
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
