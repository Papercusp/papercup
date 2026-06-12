/**
 * store.integration.test.ts — prompt-ablation run rows over migration 249
 * (self-learning-frontier P-023 / FB-09). Provisions a throwaway DB with the
 * full live schema (provisionGymDatabase applies 000-baseline + every pending
 * migration, so 249's prompt_ablation_runs exists), then round-trips: insert
 * (incl. jsonb legs + ISO-string timestamps — the db-org Date-param gotcha),
 * list filters/order, the rotation recency map, and the CHECK constraints.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { provisionGymDatabase } from '../gym/gym-db-init';
import { insertAblationRun, lastAblatedAtByRule, listAblationRuns, type InsertAblationRunInput } from './store';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `ablat_${randomBytes(5).toString('hex')}`;
const WS = 'ws-ablation-test';

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await maint.end({ timeout: 5 });
  }
  // Best-effort: the reused test container is shared across vitest processes.
  if (!process.env.KEEP_TEST_PG) await teardownTestPg().catch(() => {});
});

function input(over: Partial<InsertAblationRunInput> = {}): InsertAblationRunInput {
  return {
    workspaceId: WS,
    startedAtMs: Date.parse('2026-06-12T04:35:00Z'),
    playbookPath: 'apps/operator/prompts/papercusp-su-engineer.tools.md',
    playbookHash: 'feedfacefeedface',
    ruleKey: 'working-rules/never-poll-await',
    ruleHash: 'aaaaaaaaaaaa',
    ruleExcerpt: 'Never poll; await. — Register a one-shot wake…',
    scenarioCount: 12,
    baselinePassRate: 0.9,
    ablatedPassRate: 0.85,
    passRateDelta: -0.05,
    verdict: 'no-delta',
    capped: false,
    costUsd: 2.4,
    ledgerContext: [{ source: 'repo-scan', target: 'apps/operator/prompts/papercusp-su-engineer.tools.md' }],
    detail: { scenarios: [{ scenarioId: 's1', baseline: { passRate: 1 }, ablated: { passRate: 1 } }] },
    ...over,
  };
}

describe('prompt_ablation_runs (migration 249)', () => {
  it('inserts a full row (jsonb legs, ISO timestamps) and reads it back shaped', async () => {
    const id = await insertAblationRun(sql, input({ replayLeg: { batteryId: 'b1', compositeDelta: -0.2 } }));
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const rows = await listAblationRuns(sql, WS);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      id,
      workspaceId: WS,
      origin: 'shadow',
      ruleKey: 'working-rules/never-poll-await',
      verdict: 'no-delta',
      passRateDelta: -0.05,
      capped: false,
      costUsd: 2.4,
    });
    expect(row.startedAt).toBe('2026-06-12T04:35:00.000Z');
    expect(Date.parse(row.finishedAt)).toBeGreaterThan(0);
    expect(row.detail.scenarios).toHaveLength(1);
    expect((row.replayLeg as { batteryId: string }).batteryId).toBe('b1');
    expect(row.ledgerContext).toHaveLength(1);
  });

  it('lists newest-first, filters by ruleKey, and scopes by workspace', async () => {
    await insertAblationRun(sql, input({ ruleKey: 'discipline/tests-ship', startedAtMs: Date.parse('2026-06-19T04:35:00Z') }));
    await insertAblationRun(sql, input({ workspaceId: 'other-ws' }));
    const all = await listAblationRuns(sql, WS);
    expect(all).toHaveLength(2);
    const one = await listAblationRuns(sql, WS, { ruleKey: 'discipline/tests-ship' });
    expect(one).toHaveLength(1);
    expect(one[0]!.ruleKey).toBe('discipline/tests-ship');
  });

  it('lastAblatedAtByRule maps each rule to its latest finished_at', async () => {
    const map = await lastAblatedAtByRule(sql, WS);
    expect([...map.keys()].sort()).toEqual(['discipline/tests-ship', 'working-rules/never-poll-await']);
    for (const iso of map.values()) expect(Date.parse(iso)).toBeGreaterThan(0);
  });

  it('rejects non-shadow origins and unknown verdicts (CHECKs)', async () => {
    await expect(
      sql`INSERT INTO harness_shared.prompt_ablation_runs
            (workspace_id, started_at, playbook_path, playbook_hash, rule_key, rule_hash,
             rule_excerpt, verdict, detail, origin)
          VALUES (${WS}, now(), 'p', 'h', 'k', 'rh', 'x', 'no-delta', '{"scenarios":[]}'::jsonb, 'organic')`,
    ).rejects.toThrow(/origin_check/);
    await expect(insertAblationRun(sql, input({ verdict: 'sideways' as never }))).rejects.toThrow(/verdict_check/);
  });
});
