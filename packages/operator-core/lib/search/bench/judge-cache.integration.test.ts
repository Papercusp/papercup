/**
 * judge-cache.integration.test.ts — the cache's SQL against REAL Postgres.
 *
 * The unit tier (judge-cache.test.ts) proves the LOGIC against a fake `sql`. It
 * cannot prove the SQL itself: a wrong column name, a mis-ordered parameter, or
 * an ON CONFLICT that does not match the real PK all pass happily against a
 * fake and fail on the one run that matters — a paid one. Migration 841 is what
 * this pins against.
 *
 * `createCachedJudge` takes its `sql` by injection against a structural
 * interface, so the fixture's real client goes straight in with no mocking.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrgTestDb } from '../../../test/_org-test-db';
import { createCachedJudge, sha256, type JudgeCacheSql } from './judge-cache';

let db: OrgTestDb;
let sql: JudgeCacheSql;
const WS = `ws-${randomBytes(6).toString('hex')}`;

const BASE = {
  workspaceId: WS,
  judgeModel: 'claude-sonnet-4-6',
  rubricVersion: 'search-relevance.v1',
};

beforeAll(async () => {
  const { createOrgTestDb } = await import('../../../test/_org-test-db');
  db = await createOrgTestDb();
  sql = db.adminSql as unknown as JudgeCacheSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('judge cache against real Postgres (migration 841)', () => {
  it('round-trips a judgement through the durable table', async () => {
    let calls = 0;
    const cache = createCachedJudge({
      ...BASE,
      sql,
      runId: 'run-a',
      inner: async () => {
        calls += 1;
        return { relevance: 4, judgedRelevant: true, judgeCostUsd: 0.0125, judgeNotes: 'why' };
      },
    });

    const input = {
      pairId: 'search-relevance-labelled.v1:search:fulltext:doc-1:3',
      query: 'how does rerank work',
      docId: 'doc-1',
      docText: 'the presented excerpt',
    };

    const bought = await cache.judge(input);
    expect(bought.judgeCostUsd).toBeCloseTo(0.0125);
    expect(calls).toBe(1);

    // The row must be readable by a FRESH cache instance — no in-process state.
    const reader = createCachedJudge({
      ...BASE,
      sql,
      inner: async () => {
        throw new Error('cache miss: the durable read did not work');
      },
    });
    const served = await reader.judge(input);
    expect(served.relevance).toBe(4);
    expect(served.judgedRelevant).toBe(true);
    expect(served.judgeNotes).toBe('why');
    expect(served.judgeCostUsd).toBe(0);
    expect(reader.stats().reusedCostUsd).toBeCloseTo(0.0125);

    // Forensic columns actually landed.
    const rows = await sql.unsafe<{ pair_id: string; run_id: string; query_text: string }>(
      `SELECT pair_id, run_id, query_text FROM harness_shared.search_judge_grades
        WHERE workspace_id = $1 AND doc_id = $2 AND query_hash = $3`,
      [WS, 'doc-1', sha256(input.query)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pair_id).toBe(input.pairId);
    expect(rows[0]?.run_id).toBe('run-a');
    expect(rows[0]?.query_text).toBe(input.query);
  });

  it('the real PK makes a concurrent double-write idempotent, not a crash', async () => {
    // judgeConcurrency defaults to 4, so two in-flight calls CAN race the same
    // key. ON CONFLICT DO NOTHING must match the actual PK or this throws.
    const mk = () =>
      createCachedJudge({
        ...BASE,
        sql,
        bypassReads: true, // force both to attempt a write
        inner: async () => ({ relevance: 2, judgedRelevant: false, judgeCostUsd: 0.01 }),
      });
    const input = { pairId: 'p', query: 'racy', docId: 'doc-race', docText: 'body' };

    const [a, b] = await Promise.all([mk().judge(input), mk().judge(input)]);
    expect(a.relevance).toBe(2);
    expect(b.relevance).toBe(2);

    const rows = await sql.unsafe<{ n: string }>(
      `SELECT count(*)::text AS n FROM harness_shared.search_judge_grades
        WHERE workspace_id = $1 AND doc_id = $2`,
      [WS, 'doc-race'],
    );
    expect(rows[0]?.n).toBe('1');
    // No cache error was swallowed — a conflict must not look like a write fault.
    expect(mk().stats().errors).toBe(0);
  });

  it('cross-arm reuse holds through the real key: same pair, different rank and tool', async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return { relevance: 5, judgedRelevant: true, judgeCostUsd: 0.02 };
    };
    const armA = createCachedJudge({ ...BASE, sql, runId: 'arm-rerank', inner });
    const armB = createCachedJudge({ ...BASE, sql, runId: 'arm-control', inner });

    const doc = { query: 'paired query', docId: 'doc-paired', docText: 'identical presented text' };
    await armA.judge({ ...doc, pairId: 'v1:search:fulltext:doc-paired:0' });
    await armB.judge({ ...doc, pairId: 'v1:docs:search:doc-paired:9' });

    // This is the property the whole change exists for: the control arm is the
    // same documents in a different order, so it must cost nothing.
    expect(calls).toBe(1);
    expect(armB.stats().hits).toBe(1);
    expect(armB.stats().costUsd).toBe(0);
  });

  it('changed presented text misses, so a stale label is never served', async () => {
    let calls = 0;
    const cache = createCachedJudge({
      ...BASE,
      sql,
      inner: async () => {
        calls += 1;
        return { relevance: 1, judgedRelevant: false, judgeCostUsd: 0.01 };
      },
    });
    await cache.judge({ pairId: 'p', query: 'q-drift', docId: 'doc-drift', docText: 'excerpt v1' });
    await cache.judge({ pairId: 'p', query: 'q-drift', docId: 'doc-drift', docText: 'excerpt v2' });
    expect(calls).toBe(2);
  });
});
