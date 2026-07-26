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

/**
 * A postgres-js-shaped fake: callable as a tagged template, with `.unsafe`/`.json`. Both a
 * query and an `unsafe(...)` return a thenable FRAGMENT — awaiting it records the statement
 * and yields no rows; interpolating it into another template records nothing. Every read
 * therefore degrades to its documented empty-result defaults, leaving the transaction shape
 * as the only thing under test.
 */
function makeHandle(log: Log, opts: { failAtQuery?: number } = {}) {
  let queries = 0;
  const handle = ((strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    return {
      then(resolve: (rows: unknown[]) => void, reject: (err: unknown) => void) {
        queries += 1;
        log.push(`QUERY:${text.slice(0, 48)}`);
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
    // All three reads landed on the TRANSACTION handle...
    expect(pg.queries).toHaveLength(3);
    // ...and NOTHING was issued on a fresh pool checkout outside the snapshot. This is the
    // regression: three independent checkouts is what let the readings disagree.
    expect(pg.poolLog).toEqual([]);
    // The reading is whole — every part present, from the one snapshot.
    expect(out.breakdown).toBeDefined();
    expect(out.rows).toEqual([]);
    expect(out.sample).toBeDefined();
  });

  it('sets REPEATABLE READ + READ ONLY before any data statement (PG rejects it after, which would silently leave the reads on READ COMMITTED)', async () => {
    const pg = makePool();
    await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20, sampleLimit: 5 });

    expect(pg.txLog[0]).toBe('EXEC:SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    expect(pg.txLog[1]).toMatch(/^EXEC:SET LOCAL statement_timeout = \d+$/);
    // Nothing may execute ahead of the isolation preamble.
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
    expect(pg.queries).toHaveLength(1);
    expect(out.rows).toEqual([]);
    expect(out.sample).toBeUndefined();
  });

  it('omitting sampleLimit reads counts + rows only, and omits `sample` entirely (absent, not an empty sample)', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20 });
    expect(pg.queries).toHaveLength(2);
    expect(out.sample).toBeUndefined();
    expect('sample' in out).toBe(false);
  });

  it('a failed read THROWS — it never degrades to a partial or zeroed reading (a synthesised 0 is indistinguishable from a genuinely drained lane)', async () => {
    const pg = makePool({ failAtQuery: 2 }); // the row list fails, after the counts succeeded
    await expect(
      readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20, sampleLimit: 5 }),
    ).rejects.toThrow(/snapshot read failed/);
  });
});
