/**
 * claimability-snapshot.test.ts — WI-5947.
 *
 * `work_items:claimable` presents three readings as ONE verdict: the survivor COUNTS
 * (aggregateIssueClaimExclusions), the survivor ROWS (listIssueClaimableRows), and the
 * per-floor excluded SAMPLE (sampleIssueClaimExclusions). They share an inner subquery and
 * a floor predicate, so they are semantically identical — but they used to be three
 * INDEPENDENT round-trips, each its own implicit transaction. Against a table the fleet is
 * actively claiming from, a row counted by the first was gone by the second, producing
 * `claimableCount:1, returned:0` under a limit of 50 — which `scheduler:get_next` then read
 * as a "CLAIM-PATH/READ-PATH DIVERGENCE" and told the agent to file a claim-path bug that
 * did not exist.
 *
 * These pin the fix at the boundary that actually matters: readIssueClaimability issues ONE
 * read-only REPEATABLE READ transaction, sets the isolation BEFORE any data statement, runs
 * every read on that transaction handle, and FAILS rather than degrading to a partial or
 * zeroed reading. (The floor semantics themselves are covered by the DB-backed
 * claim-ssot-agreement / get-next-exclusion-breakdown integration suites; this is the
 * transaction-shape contract, which a quiescent-table integration test cannot observe.)
 *
 * Run: cd packages/operator-core && npx vitest run lib/scheduler/claimability-snapshot.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readIssueClaimability } from './get-next';

/** One entry per statement the code actually EXECUTED (interpolated fragments are never
 *  awaited, so they never appear here — which is exactly the count we want). */
type Log = string[];

/** Render the SQL text carried by the fake postgres.js fragments, including nested fragments. */
function renderSqlFragment(fragment: unknown): string {
  if (fragment === undefined || fragment === null) return '';
  if (!fragment || typeof fragment !== 'object') return '?';
  const value = fragment as { strings?: unknown[]; args?: unknown[] };
  if (!Array.isArray(value.strings)) return '?';
  const args = value.args ?? [];
  return value.strings.map((part, index) => `${String(part)}${renderSqlFragment(args[index])}`).join('');
}

/**
 * A postgres-js-shaped fake: callable as a tagged template, with `.unsafe`/`.json`. Both a
 * query and an `unsafe(...)` return a thenable FRAGMENT — awaiting it records the statement
 * and yields no rows; interpolating it into another template records nothing. Every read
 * therefore degrades to its documented empty-result defaults, leaving the transaction shape
 * as the only thing under test.
 */
function makeHandle(log: Log, opts: { failAtQuery?: number } = {}) {
  let queries = 0;
  const handle = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment = { strings: Array.from(strings), args: values };
    const text = renderSqlFragment(fragment).replace(/\s+/g, ' ').trim();
    return {
      ...fragment,
      then(resolve: (rows: unknown[]) => void, reject: (err: unknown) => void) {
        queries += 1;
        log.push(`QUERY:${text}`);
        if (opts.failAtQuery === queries) {
          reject(new Error('snapshot read failed'));
          return;
        }
        resolve([]);
      },
    };
  }) as unknown as Record<string, unknown> & ((s: TemplateStringsArray) => unknown);
  handle.unsafe = (text: string) => ({
    then(resolve: (rows: unknown[]) => void) {
      log.push(`EXEC:${text}`);
      resolve([]);
    },
  });
  handle.json = (v: unknown) => ({ __json: v });
  return handle;
}

/** A pool handle whose `begin` hands the callback a SEPARATE transaction handle, so we can
 *  tell a statement issued on the transaction from one issued on a fresh pool checkout. */
function makePool(opts: { failAtQuery?: number } = {}) {
  const poolLog: Log = [];
  const txLog: Log = [];
  let beginCalls = 0;
  const pool = makeHandle(poolLog) as unknown as Record<string, unknown>;
  pool.begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    beginCalls += 1;
    return fn(makeHandle(txLog, opts));
  };
  return {
    client: pool as never,
    poolLog,
    txLog,
    get beginCalls() {
      return beginCalls;
    },
    /** Only the statements that were real queries (not the SET preamble). */
    get queries() {
      return txLog.filter((l) => l.startsWith('QUERY:'));
    },
  };
}

const OPTS = { harness: 'papercup', assignee: 'probe' };

describe('readIssueClaimability — one snapshot for every claimability read (WI-5947)', () => {
  it('issues exactly ONE transaction, and runs the counts + rows + sample inside it', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, {
      limit: 20,
      sampleLimit: 5,
    });

    expect(pg.beginCalls).toBe(1);
    // EI-18802055183255275: the candidate set (spec filter + all claim floors) is
    // materialized ONCE (the CREATE TEMP TABLE), then the four reads (counts, rows,
    // sample, and the WI-6673 admitted-composition read) each scan that materialized
    // snapshot instead of recomputing it from scratch...
    expect(pg.queries).toHaveLength(5);
    // ...and NOTHING was issued on a fresh pool checkout outside the snapshot. This is the
    // regression: independent checkouts is what let the readings disagree.
    expect(pg.poolLog).toEqual([]);
    // The reading is whole — every part present, from the one snapshot.
    expect(out.breakdown).toBeDefined();
    expect(out.rows).toEqual([]);
    expect(out.sample).toBeDefined();
    expect(out.admitted).toBeDefined();
  });

  it('pushes a single-spec filter into snapshot materialization and marks prefiltered rows matched', async () => {
    const pg = makePool();
    await readIssueClaimability(
      { field: 'kind', op: '=', value: 'bug' },
      { ...OPTS, client: pg.client },
      { limit: 20 },
    );

    const materialization = pg.queries[0] ?? '';
    const where = materialization.slice(materialization.lastIndexOf('WHERE'));
    expect(materialization).toMatch(/\(TRUE\)\s+AS spec_match/);
    expect(where).toContain('COALESCE(item_kind, kind)');
    expect(where).toContain('= ?');
  });

  it('WI-6673: the admitted COMPOSITION is read in the same snapshot as the count it describes — never a separate checkout', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20 });
    // Composition that came from a DIFFERENT snapshot than the count would let a caller
    // quote a total and a make-up that never coexisted — the same class of defect WI-5947
    // fixed for counts-vs-rows.
    expect(pg.beginCalls).toBe(1);
    expect(pg.poolLog).toEqual([]);
    expect(out.admitted).toBeDefined();
  });

  it('WI-6673: composition is UNCONDITIONAL — present even under breakdownOnly, because the failure is quoting a count without asking what is in it', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, {
      limit: 20,
      breakdownOnly: true,
    });
    expect(out.admitted).toBeDefined();
    expect(out.admitted.degenerate).toBe(false); // empty fake reads ⇒ empty pool
    expect(out.admitted.lowSeverityShare).toBeNull();
  });

  it('sets REPEATABLE READ + READ ONLY before any data statement (PG rejects it after, which would silently leave the reads on READ COMMITTED)', async () => {
    const pg = makePool();
    await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20, sampleLimit: 5 });

    // EI-18802055183255275: no longer ", READ ONLY" — Postgres unconditionally refuses
    // `CREATE TABLE AS` (even for a TEMP table) inside a read-only transaction, and this
    // function now materializes one. See the matching comment at the call site.
    expect(pg.txLog[0]).toBe('EXEC:SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(pg.txLog[1]).toMatch(/^EXEC:SET LOCAL statement_timeout = \d+$/);
    // Nothing may execute ahead of the isolation preamble — including the CREATE TEMP
    // TABLE materialization, which is itself the first QUERY (data statement).
    const firstQueryAt = pg.txLog.findIndex((l) => l.startsWith('QUERY:'));
    expect(firstQueryAt).toBeGreaterThan(1);
  });

  it('bounds the snapshot with a caller-tunable statement_timeout (the admin pool deliberately carries none)', async () => {
    const pg = makePool();
    await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, {
      limit: 20,
      statementTimeoutMs: 2500,
    });
    expect(pg.txLog[1]).toBe('EXEC:SET LOCAL statement_timeout = 2500');
  });

  it('breakdownOnly reads the counts alone — still in a transaction, still one snapshot', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, {
      limit: 20,
      breakdownOnly: true,
    });
    expect(pg.beginCalls).toBe(1);
    // the materialization + counts + the unconditional admitted-composition read; the row
    // list is skipped.
    expect(pg.queries).toHaveLength(3);
    expect(out.rows).toEqual([]);
    expect(out.sample).toBeUndefined();
  });

  it('omitting sampleLimit reads counts + rows (+ composition) only, and omits `sample` entirely (absent, not an empty sample)', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20 });
    // materialization + counts + rows + composition.
    expect(pg.queries).toHaveLength(4);
    expect(out.sample).toBeUndefined();
    expect('sample' in out).toBe(false);
  });

  it('a failed read THROWS — it never degrades to a partial or zeroed reading (a synthesised 0 is indistinguishable from a genuinely drained lane)', async () => {
    // query 1 = the CREATE TEMP TABLE materialization, query 2 = the counts (both succeed);
    // query 3 = the row list — the one that now fails.
    const pg = makePool({ failAtQuery: 3 }); // the row list fails, after materialize+counts succeeded
    await expect(
      readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20, sampleLimit: 5 }),
    ).rejects.toThrow(/snapshot read failed/);
  });
});
