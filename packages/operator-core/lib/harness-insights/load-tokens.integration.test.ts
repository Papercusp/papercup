import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { loadHarnessTokens } from './load-tokens';

let db: OrgTestDb;
const workspace = `local-usage-${randomUUID()}`;
const harness = 'customer-runtime';
beforeAll(async () => { db = await createOrgTestDb(); });
afterAll(async () => { await db?.cleanup(); });

it('reads scoped local per-call usage with honest costs independently of analytics consent', async () => {
  const now = Date.now();
  await db.adminSql`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, harness_slug, ts, bucket_key, provider, model_class, source,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_source)
    VALUES
      (${workspace}, ${harness}, ${now}, 'local', 'openai', 'known', 'jsonl', 100, 20, 50, 5, 0.2, 'provider'),
      (${workspace}, ${harness}, ${now - 1}, 'local', 'openai', 'known', 'jsonl', 200, 30, 60, 6, 0.1, 'estimated'),
      (${workspace}, ${harness}, ${now - 2}, 'local', 'other', 'unknown', 'jsonl', NULL, 40, 0, NULL, NULL, NULL),
      (${workspace}, ${harness}, ${now - 3}, 'local', 'other', 'unknown', 'jsonl', 10, 10, 0, 0, 999, NULL),
      (${workspace + '-other'}, ${harness}, ${now}, 'private-other', 'openai', 'known', 'jsonl', 99999, 99999, 99999, 99999, 99999, 'provider'),
      (${workspace}, 'different-harness', ${now}, 'private-other', 'openai', 'known', 'jsonl', 99999, 99999, 99999, 99999, 99999, 'provider')
  `;
  const read = () => loadHarnessTokens({ workspace_id: workspace, harness_slug: harness, windowMs: 60000,
    runQuery: async <T>(query: string, params: unknown[]) => await db.adminSql.unsafe(query, params as never) as unknown as T[],
  });
  const snapshot = await read();
  expect(snapshot.observation).toBe('observed');
  expect(snapshot.totals).toMatchObject({ runs: 4, tokens: 531, reportedUsd: 0.2, estimatedUsd: 0.1, unpricedCalls: 2 });
  expect(snapshot.totals.costUsd).toBeCloseTo(0.3);
  expect(snapshot.recentCalls).toHaveLength(4);
  expect(snapshot.recentCalls?.map(row => row.costSource)).toEqual(['provider', 'estimated', 'unknown', 'unknown']);
  expect(snapshot.recentCalls?.[2]).toMatchObject({ inputTokens: null, cacheCreationTokens: null, costUsd: null });
  expect(snapshot.recentCalls?.[3].costUsd).toBeNull();
  expect(snapshot.byModel.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(0.3);
  // No hosted preferences or analytics sender exists in this fixture. A local
  // read is still available, and never uses consent as authority to read usage.
  expect((await read()).totals).toEqual(snapshot.totals);
  const empty = await loadHarnessTokens({ workspace_id: workspace + '-absent', harness_slug: harness,
    runQuery: async <T>(query: string, params: unknown[]) => await db.adminSql.unsafe(query, params as never) as unknown as T[],
  });
  expect(empty.observation).toBe('observed');
  expect(empty.totals.runs).toBe(0);
});
