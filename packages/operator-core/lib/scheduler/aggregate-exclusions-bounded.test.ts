/**
 * aggregate-exclusions-bounded.test.ts — EI-21863190622583520 recurrence guard.
 *
 * THE CLASS THIS KILLS: `aggregateIssueClaimExclusions` is the most expensive query family in
 * this system (EI-21336921007507524), and every STANDALONE caller used to run it with NO
 * server-side bound — the function took a bare pool checkout, and `adminPoolStatementTimeoutMs`
 * is a connect-time GUC that only NEW connections carry. MEASURED 2026-08-30 on the live box
 * (load 138/128 cores): one `pcusp:org-admin` backend ran this exact aggregate for >=180s
 * (sampled 93.6s -> 113.8s -> 180.5s on one monotonic query_start), with two more org-admin
 * backends at 161.3s / 112.5s on connections 40+ minutes old.
 *
 * WHY A CALLER-SIDE BOUND DID NOT COVER IT: the get_next miss path wraps the call in
 * `withBoundedTimeout(..., 1_500ms)`, but bounded-timeout.ts's own docstring says the query
 * "still runs to completion in the background even after a timeout degrades the caller"
 * (WI-7099). So the busiest call site fired the system's most expensive read on EVERY miss,
 * abandoned it after 1.5s, and left it burning a core for minutes. Only a server-side
 * `statement_timeout` actually stops the work, which is what these pin.
 *
 * FALSIFIABILITY — read this before trusting a green run. The injected-client case is not
 * merely a second scenario, it is this suite's NEGATIVE CONTROL: it drives the SAME assertion
 * through the SAME fake and requires the timeout preamble to be ABSENT. That is the pre-fix
 * shape. If someone deletes the bound, the standalone test fails; if someone makes the
 * instrument blind (a fake that stops recording, an assertion that matches nothing), the
 * control passes for the wrong reason and the standalone test fails too. The two cases can
 * only BOTH pass when the bound is genuinely present on one path and genuinely absent on the
 * other — so a vacuous instrument cannot produce a green suite.
 *
 * Run: cd packages/operator-core && npx vitest run lib/scheduler/aggregate-exclusions-bounded.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

/** Statements the code actually EXECUTED (an interpolated fragment is never awaited, so it
 *  never lands here — which is precisely the distinction under test). */
type Log = string[];

/** Render the SQL text carried by the fake postgres.js fragments, including nested fragments.
 *  A bound VALUE renders as `?`, so an assertion can match the statement without its params. */
function renderSqlFragment(fragment: unknown): string {
  if (fragment === undefined || fragment === null) return '';
  if (!fragment || typeof fragment !== 'object') return '?';
  const value = fragment as { strings?: unknown[]; args?: unknown[] };
  if (!Array.isArray(value.strings)) return '?';
  const args = value.args ?? [];
  return value.strings.map((part, index) => `${String(part)}${renderSqlFragment(args[index])}`).join('');
}

/** A postgres-js-shaped fake: callable as a tagged template, with `.unsafe`/`.json`. Awaiting a
 *  query records the statement and yields no rows, so every read degrades to its documented
 *  empty-result defaults and the TRANSACTION SHAPE is the only thing under test. */
function makeHandle(log: Log) {
  const handle = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment = { strings: Array.from(strings), args: values };
    const text = renderSqlFragment(fragment).replace(/\s+/g, ' ').trim();
    return {
      ...fragment,
      then(resolve: (rows: unknown[]) => void) {
        log.push(text);
        resolve([]);
      },
    };
  }) as unknown as Record<string, unknown> & ((s: TemplateStringsArray) => unknown);
  handle.unsafe = (text: string) => ({
    strings: [text],
    args: [],
    then(resolve: (rows: unknown[]) => void) {
      log.push(text);
      resolve([]);
    },
  });
  handle.json = (v: unknown) => ({ __json: v });
  return handle;
}

/** A pool handle whose `begin` hands the callback a SEPARATE handle, so a statement issued on
 *  the transaction is distinguishable from one issued on a bare pool checkout. */
function makePool() {
  const poolLog: Log = [];
  const txLog: Log = [];
  let beginCalls = 0;
  const pool = makeHandle(poolLog) as unknown as Record<string, unknown>;
  pool.begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    beginCalls += 1;
    return fn(makeHandle(txLog));
  };
  return {
    client: pool as never,
    poolLog,
    txLog,
    get beginCalls() {
      return beginCalls;
    },
  };
}

/** The pool the STANDALONE path reaches through `getOrgPg()`. Re-pointed per test. */
let activePool = makePool();

// Partial mock: `getOrgPg` is the ONLY member re-pointed, so pg-bounded-txn's real transaction
// logic (including its set_config preamble) runs against the fake instead of a database.
// importOriginal keeps every other export intact — enumerating them by hand is the documented
// way these suites break (see scout/nudge-recipient.ts's warning about this exact module).
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: activePool.client }),
}));

const { aggregateIssueClaimExclusions } = await import('./get-next');

const OPTS = { harness: 'papercup', assignee: 'probe' };
const STATEMENT_TIMEOUT_PREAMBLE = "set_config('statement_timeout'";

describe('aggregateIssueClaimExclusions is bounded server-side (EI-21863190622583520)', () => {
  it('STANDALONE (no client): opens ONE transaction and caps statement_timeout before the aggregate', async () => {
    activePool = makePool();

    await aggregateIssueClaimExclusions(undefined, { ...OPTS });

    expect(activePool.beginCalls).toBe(1);

    const capIndex = activePool.txLog.findIndex((s) => s.includes(STATEMENT_TIMEOUT_PREAMBLE));
    expect(
      capIndex,
      'the standalone path must set a server-side statement_timeout — without it this query ' +
        'has been measured running >=180s on a pooled connection',
    ).toBeGreaterThanOrEqual(0);

    // The cap must PRECEDE the aggregate, or the expensive statement runs unbounded anyway.
    const aggregateIndex = activePool.txLog.findIndex((s) => s.includes('AS claimable'));
    expect(aggregateIndex).toBeGreaterThanOrEqual(0);
    expect(capIndex).toBeLessThan(aggregateIndex);

    // The expensive read belongs INSIDE the bounded transaction, never on a bare checkout.
    expect(activePool.poolLog.some((s) => s.includes('AS claimable'))).toBe(false);
  });

  it('honours an explicit statementTimeoutMs on the standalone path', async () => {
    activePool = makePool();

    await aggregateIssueClaimExclusions(undefined, { ...OPTS, statementTimeoutMs: 1_500 });

    expect(activePool.txLog.some((s) => s.includes(STATEMENT_TIMEOUT_PREAMBLE))).toBe(true);
  });

  it('bounds exact-plan floor evaluation to matching rows without discarding excluded matches', async () => {
    activePool = makePool();

    await aggregateIssueClaimExclusions(
      { field: 'plan', op: '=', value: 'release-preparation' },
      { ...OPTS },
    );

    const aggregate = activePool.txLog.find((s) => s.includes('AS claimable')) ?? '';
    const cteStart = aggregate.indexOf('WITH filtered_claim_candidates AS MATERIALIZED');
    const cteEnd = aggregate.indexOf(') SELECT', cteStart);
    expect(cteStart).toBeGreaterThan(-1);
    expect(cteEnd).toBeGreaterThan(cteStart);
    const candidates = aggregate.slice(cteStart, cteEnd);
    expect(candidates).toContain('source_plan_slug');
    expect(candidates).not.toContain(' AS ok_');
    expect(candidates).not.toContain('wi.*');
    expect(aggregate).toContain('(TRUE) AS spec_match');
    expect(aggregate.indexOf(' AS ok_untaken')).toBeGreaterThan(cteEnd);
    expect(aggregate).toContain('FROM filtered_claim_candidates wi');
    // The same query still reports matches and every exclusion; it has not
    // filtered the population down to survivors merely to make admission fast.
    expect(aggregate).toContain('count(*) FILTER (WHERE spec_match)::int AS matched');
    expect(aggregate).toContain('AS claim_hold');
  });

  it('keeps unfiltered aggregates broad instead of materializing the entire issue pool', async () => {
    activePool = makePool();

    await aggregateIssueClaimExclusions(undefined, { ...OPTS });

    const aggregate = activePool.txLog.find((s) => s.includes('AS claimable')) ?? '';
    expect(aggregate).toContain('FROM harness_shared.work_items wi');
    expect(aggregate).not.toContain('filtered_claim_candidates');
  });

  it('NEGATIVE CONTROL — injected client: no transaction, no cap (the caller already owns both)', async () => {
    activePool = makePool();
    const injectedLog: Log = [];
    const injected = makeHandle(injectedLog) as never;

    await aggregateIssueClaimExclusions(undefined, { ...OPTS, client: injected });

    // readIssueClaimability shares ONE snapshot + temp table across its sibling reads (WI-5947).
    // Opening a second transaction here would break that, so the wrapper must defer entirely.
    expect(activePool.beginCalls).toBe(0);
    expect(injectedLog.some((s) => s.includes(STATEMENT_TIMEOUT_PREAMBLE))).toBe(false);

    // Calibration: the instrument DID observe this path — so the absence above is a real
    // absence, not a fake that silently recorded nothing.
    expect(injectedLog.some((s) => s.includes('AS claimable'))).toBe(true);
  });
});
