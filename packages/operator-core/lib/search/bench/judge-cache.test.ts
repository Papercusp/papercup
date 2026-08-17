/**
 * judge-cache.test.ts — the recurrence guard for EI-20653219342536753.
 *
 * The defect: paid LLM judgements lived only in a JSON file under /tmp, so
 * ~$21.68 of grades were reaped along with the "$0 re-sweep" capability and
 * bench resume. The guard below fails if grades stop round-tripping through the
 * durable store, and — separately — if the key stops being rank/tool
 * independent, which is what makes a control arm reuse the rerank arm's labels.
 *
 * Falsifiability is proven WITHOUT mutating the shared tree: the cache is a
 * plain module, so the wrong implementations are kept here permanently as
 * controls (CLAUDE.md's tier-1 pattern). A copy-out or in-tree mutation probe
 * would be the wrong instrument for a module you can simply import.
 */
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { JudgeVerdict } from './judge-agreement';
import { createCachedJudge, isReapablePath, sha256, type JudgeCacheSql } from './judge-cache';

/** Minimal in-memory stand-in for the postgres.js surface the cache uses. */
function fakeSql(opts: { failReads?: boolean; failWrites?: boolean } = {}): JudgeCacheSql & {
  rows: Map<string, Record<string, unknown>>;
  writes: number;
} {
  const rows = new Map<string, Record<string, unknown>>();
  let writes = 0;
  const sql = {
    rows,
    get writes() {
      return writes;
    },
    async unsafe<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
      if (query.includes('SELECT')) {
        if (opts.failReads) throw new Error('simulated read fault');
        // Key mirrors the table PK: workspace, model, rubric, queryHash, docId, docTextHash.
        const key = params.slice(0, 6).join('|');
        const hit = rows.get(key);
        return (hit ? [hit] : []) as T[];
      }
      if (opts.failWrites) throw new Error('simulated write fault');
      writes += 1;
      const key = params.slice(0, 6).join('|');
      // ON CONFLICT DO NOTHING — first writer wins.
      if (!rows.has(key)) {
        rows.set(key, {
          relevance: params[6],
          judged_relevant: params[7],
          judge_notes: params[8],
          judge_cost_usd: params[9],
        });
      }
      return [] as T[];
    },
  };
  return sql as JudgeCacheSql & { rows: Map<string, Record<string, unknown>>; writes: number };
}

function verdict(relevance: number, cost = 0.01): JudgeVerdict {
  return { relevance, judgedRelevant: relevance >= 3, judgeCostUsd: cost, judgeNotes: 'n' };
}

const BASE = {
  workspaceId: 'ws',
  judgeModel: 'claude-sonnet-4-6',
  rubricVersion: 'search-relevance.v1',
};

describe('judge cache — grades survive as durable state', () => {
  it('buys a grade once, then serves it without calling the judge again', async () => {
    const sql = fakeSql();
    let calls = 0;
    const cache = createCachedJudge({
      ...BASE,
      sql,
      inner: async () => {
        calls += 1;
        return verdict(4);
      },
    });

    const input = { pairId: 'v1:search:fulltext:doc-1:0', query: 'q', docId: 'doc-1', docText: 'text' };
    const first = await cache.judge(input);
    const second = await cache.judge(input);

    expect(calls).toBe(1);
    expect(first.judgeCostUsd).toBe(0.01);
    // A hit must bill ZERO, or every run over-reports what it actually spent.
    expect(second.judgeCostUsd).toBe(0);
    expect(second.relevance).toBe(4);
    expect(second.judgedRelevant).toBe(true);

    const stats = cache.stats();
    expect(stats).toMatchObject({ hits: 1, misses: 1, errors: 0 });
    expect(stats.costUsd).toBeCloseTo(0.01);
    expect(stats.reusedCostUsd).toBeCloseTo(0.01);
  });

  it('THE POINT: the control arm reuses the rerank arm — rank and tool do not affect the key', async () => {
    const sql = fakeSql();
    let calls = 0;
    const cache = createCachedJudge({
      ...BASE,
      sql,
      inner: async () => {
        calls += 1;
        return verdict(5);
      },
    });

    // Same (query, doc) judged at rank 0 under one tool...
    await cache.judge({ pairId: 'v1:search:fulltext:doc-9:0', query: 'q', docId: 'doc-9', docText: 'body' });
    // ...then at a different rank under a different tool, which is exactly what
    // a --no-rerank control arm produces: same documents, different order.
    await cache.judge({ pairId: 'v1:docs:search:doc-9:7', query: 'q', docId: 'doc-9', docText: 'body' });

    expect(calls).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('CORRECTNESS GUARD: changed presentation MISSES rather than serving a stale label', async () => {
    const sql = fakeSql();
    let calls = 0;
    const cache = createCachedJudge({
      ...BASE,
      sql,
      inner: async () => {
        calls += 1;
        return verdict(2);
      },
    });

    await cache.judge({ pairId: 'p', query: 'q', docId: 'doc-1', docText: 'excerpt A' });
    await cache.judge({ pairId: 'p', query: 'q', docId: 'doc-1', docText: 'excerpt B' });
    expect(calls).toBe(2);

    // Same guard on the frozen contract: a rubric bump must not serve old grades.
    const bumped = createCachedJudge({
      ...BASE,
      rubricVersion: 'search-relevance.v2',
      sql,
      inner: async () => {
        calls += 1;
        return verdict(2);
      },
    });
    await bumped.judge({ pairId: 'p', query: 'q', docId: 'doc-1', docText: 'excerpt A' });
    expect(calls).toBe(3);
  });

  it('a different query on the same document is a different judgement', async () => {
    const sql = fakeSql();
    let calls = 0;
    const cache = createCachedJudge({
      ...BASE,
      sql,
      inner: async () => {
        calls += 1;
        return verdict(3);
      },
    });
    await cache.judge({ pairId: 'p', query: 'query one', docId: 'd', docText: 't' });
    await cache.judge({ pairId: 'p', query: 'query two', docId: 'd', docText: 't' });
    expect(calls).toBe(2);
  });

  it('a cache fault degrades to the live judge instead of failing a paid run', async () => {
    const warnings: string[] = [];
    const readFault = createCachedJudge({
      ...BASE,
      sql: fakeSql({ failReads: true }),
      inner: async () => verdict(4),
      onWarn: (m) => warnings.push(m),
    });
    await expect(readFault.judge({ pairId: 'p', query: 'q', docId: 'd', docText: 't' })).resolves.toMatchObject({
      relevance: 4,
    });
    expect(readFault.stats().errors).toBeGreaterThan(0);

    // A lost WRITE costs money later but never correctness now — the caller
    // still receives the verdict it paid for.
    const writeFault = createCachedJudge({
      ...BASE,
      sql: fakeSql({ failWrites: true }),
      inner: async () => verdict(4),
      onWarn: (m) => warnings.push(m),
    });
    await expect(writeFault.judge({ pairId: 'p', query: 'q', docId: 'd', docText: 't' })).resolves.toMatchObject({
      relevance: 4,
    });
    expect(warnings.some((w) => w.includes('WRITE FAILED'))).toBe(true);
  });

  it('bypassReads re-judges but still persists, so an audit never discards the corpus', async () => {
    const sql = fakeSql();
    let calls = 0;
    const cache = createCachedJudge({
      ...BASE,
      sql,
      bypassReads: true,
      inner: async () => {
        calls += 1;
        return verdict(4);
      },
    });
    const input = { pairId: 'p', query: 'q', docId: 'd', docText: 't' };
    await cache.judge(input);
    await cache.judge(input);
    expect(calls).toBe(2);
    expect(cache.stats().hits).toBe(0);
    expect(sql.rows.size).toBe(1);
  });

  it('numeric columns survive the driver returning them as strings', async () => {
    // postgres.js hands back numeric/real as string depending on type and
    // driver config; a raw passthrough would put "0.01" into arithmetic and
    // silently produce string concatenation in the cost roll-up.
    const sql = fakeSql();
    await sql.unsafe('INSERT', [
      'ws',
      BASE.judgeModel,
      BASE.rubricVersion,
      sha256('q'),
      'd',
      sha256('t'),
      '4.5',
      true,
      null,
      '0.02',
    ]);
    const cache = createCachedJudge({
      ...BASE,
      sql,
      inner: async () => {
        throw new Error('must not be called');
      },
    });
    const got = await cache.judge({ pairId: 'p', query: 'q', docId: 'd', docText: 't' });
    expect(got.relevance).toBe(4.5);
    expect(typeof got.relevance).toBe('number');
    expect(cache.stats().reusedCostUsd).toBeCloseTo(0.02);
  });
});

describe('reapable-path detection', () => {
  it('flags the temp paths every lost artifact actually lived under', () => {
    // These are the real paths from the incident, not invented examples.
    expect(isReapablePath('/tmp/rr-p24-v3.json')).toBe(true);
    expect(isReapablePath('/tmp/claude-1000/p038-floor/report.json')).toBe(true);
    expect(isReapablePath('/var/tmp/x.json')).toBe(true);
    expect(isReapablePath('/dev/shm/x.json')).toBe(true);
  });

  it('CONTROL: does not over-fire on durable paths', () => {
    // Without this the guard could pass by returning true for everything,
    // which would warn on every run and train readers to ignore it.
    expect(isReapablePath(path.join(os.homedir(), 'reports', 'p038.json'))).toBe(false);
    expect(isReapablePath('./out/report.json')).toBe(false);
    // A path merely CONTAINING "tmp" is not a temp path.
    expect(isReapablePath('/home/user/tmpfiles/report.json')).toBe(false);
    expect(isReapablePath('/opt/tmp-archive/report.json')).toBe(false);
  });
});
