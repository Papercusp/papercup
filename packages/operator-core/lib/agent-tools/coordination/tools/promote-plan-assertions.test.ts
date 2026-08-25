/**
 * Unit tests for `persistPlanAssertions` — the injectable persistence seam
 * promote's fail-closed refusal is built on
 * (llm-agent-evaluation-measurement-integrity-2026-08-25 P-003).
 *
 * WHY THIS FILE EXISTS. Features and assertion rows live in two different
 * datastores, so no transaction spans them and ORDERING is the only integrity
 * boundary available: promote persists assertions FIRST and refuses the whole
 * promote if any of them could not be written. That refusal is only as good as
 * this seam's error REPORTING — the defect it replaced was a persistence step
 * that swallowed its own failure into a warning, leaving features durably
 * carrying VAL-* claim ids with no assertion row behind them.
 *
 * So the property under test is not "it writes rows". It is: **every failure
 * this seam encounters is reported to the caller, attributed to the assertion
 * that failed, and never converted into a throw or a silence.** `sql` is a
 * parameter precisely so a failing store can be driven here rather than only
 * through a live PG.
 */

import { describe, expect, it } from 'vitest';
import { persistPlanAssertions } from './promote';
import type { PlanAssertion } from '../../plans/val-assertions';

type Sql = Parameters<typeof persistPlanAssertions>[0]['sql'];

function assertion(valId: string, over: Partial<PlanAssertion> = {}): PlanAssertion {
  return {
    valId,
    itemId: 'P-001',
    verifyText: `verify ${valId}`,
    evidenceText: `evidence ${valId}`,
    status: 'todo',
    requiresTest: true,
    ...over,
  };
}

/**
 * A stub tagged-template `sql`. Attribution is by INTERPOLATED VALUE, not by
 * call index, so these tests keep working if the seam ever stops writing the
 * assertions strictly in order — and still fail loudly if it attributes an
 * error to the wrong VAL.
 */
function makeSql(failFor: (valId: string) => unknown = () => null) {
  const attempted: string[] = [];
  const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const valId = values.find((v): v is string => typeof v === 'string' && v.startsWith('VAL-')) ?? '<no-val-id>';
    attempted.push(valId);
    const failure = failFor(valId);
    if (failure) throw failure;
    return [];
  }) as unknown as Sql;
  return { sql, attempted };
}

const BASE = { workspaceId: 'ws-1', harnessSlug: 'h-1', planSlug: 'my-plan' };

describe('persistPlanAssertions — the healthy path (calibration)', () => {
  /**
   * CALIBRATION. Every failure test below asserts `errors.length > 0`, which a
   * seam that ALWAYS errored would also satisfy. This control is what makes
   * those assertions meaningful: with a working store the seam must report a
   * clean result and attempt every assertion exactly once.
   */
  it('writes every assertion and reports no errors', async () => {
    const { sql, attempted } = makeSql();
    const assertions = [assertion('VAL-1'), assertion('VAL-2'), assertion('VAL-3')];

    const result = await persistPlanAssertions({ ...BASE, sql, assertions });

    expect(result).toEqual({ written: 3, errors: [] });
    expect(attempted).toEqual(['VAL-1', 'VAL-2', 'VAL-3']);
  });

  /**
   * The non-refusal case, and the reason `written`/`errors` are counted
   * separately from the assertion list. A plan carrying no inline VAL-* claims
   * must produce an EMPTY error list — promote refuses on `errors.length > 0`,
   * so an empty plan reported as an error would block every VAL-less promote.
   */
  it('is a no-op for a plan with no assertions — no store call, no errors', async () => {
    const { sql, attempted } = makeSql(() => new Error('the store must not be touched'));

    const result = await persistPlanAssertions({ ...BASE, sql, assertions: [] });

    expect(result).toEqual({ written: 0, errors: [] });
    expect(attempted).toEqual([]);
  });
});

describe('persistPlanAssertions — failures are reported, never swallowed', () => {
  /**
   * TOTAL failure: the case where every claim would dangle. `written` must be
   * 0 and every assertion must appear in `errors`, because that count is what
   * promote renders into its refusal message.
   */
  it('a store that rejects everything yields zero writes and one error per assertion', async () => {
    const { sql } = makeSql(() => new Error('connection terminated'));
    const assertions = [assertion('VAL-1'), assertion('VAL-2'), assertion('VAL-3')];

    const result = await persistPlanAssertions({ ...BASE, sql, assertions });

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(3);
    for (const valId of ['VAL-1', 'VAL-2', 'VAL-3']) {
      expect(result.errors.some((e) => e.startsWith(`${valId}:`))).toBe(true);
    }
    expect(result.errors.every((e) => e.includes('connection terminated'))).toBe(true);
  });

  /**
   * PARTIAL failure — the defect's actual shape, and the subtlest case. Two of
   * three rows land, so the write "mostly worked"; a seam that reported success
   * because it wrote SOMETHING would let promote import a feature whose VAL-2
   * claim has no row behind it. A partial failure must still be a refusal
   * signal, and must name only the assertion that actually failed.
   */
  it('a single failing assertion still reports an error, attributed to that VAL alone', async () => {
    const { sql, attempted } = makeSql((valId) => (valId === 'VAL-2' ? new Error('unique violation') : null));
    const assertions = [assertion('VAL-1'), assertion('VAL-2'), assertion('VAL-3')];

    const result = await persistPlanAssertions({ ...BASE, sql, assertions });

    expect(result.written).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('VAL-2');
    expect(result.errors[0]).toContain('unique violation');
    // Non-empty errors is exactly the condition promote refuses on: a partial
    // success is a refusal, not a warning.
    expect(result.errors.length).toBeGreaterThan(0);
    // ...and the surviving assertions are not skipped as collateral.
    expect(attempted).toEqual(['VAL-1', 'VAL-2', 'VAL-3']);
  });

  /**
   * A failure must not abort the remaining assertions. If the loop broke early,
   * `errors` would UNDER-COUNT the dangling claims — the refusal message would
   * name one failure when several rows are missing, and a later retry would be
   * reasoned about from a wrong number.
   */
  it('an early failure does not abort the rest — every assertion is still attempted', async () => {
    const { sql, attempted } = makeSql((valId) => (valId === 'VAL-1' ? new Error('first one fails') : null));
    const assertions = [assertion('VAL-1'), assertion('VAL-2'), assertion('VAL-3')];

    const result = await persistPlanAssertions({ ...BASE, sql, assertions });

    expect(attempted).toEqual(['VAL-1', 'VAL-2', 'VAL-3']);
    expect(result.written).toBe(2);
    expect(result.errors).toHaveLength(1);
  });

  /**
   * The seam reports; the CALLER decides. If this ever threw, promote's
   * `catch` would collapse a per-assertion failure list into one opaque
   * message — and a helper free to throw is a helper free to own policy, which
   * is how the swallowed-warning defect became possible in the first place.
   */
  it('never throws, even when the store rejects every write', async () => {
    const { sql } = makeSql(() => new Error('down'));

    await expect(persistPlanAssertions({ ...BASE, sql, assertions: [assertion('VAL-1')] })).resolves.toEqual({
      written: 0,
      errors: [expect.stringContaining('VAL-1')],
    });
  });

  /**
   * A driver can reject with a non-Error (postgres.js and connection layers
   * both do). Stringifying via `e.message` alone would record a literal
   * "undefined" — an error that is present but undiagnosable. The valId must
   * survive, and the message must not be the string "undefined".
   */
  it('a non-Error rejection is still captured, with a usable message', async () => {
    const { sql } = makeSql((valId) => (valId === 'VAL-1' ? 'ECONNREFUSED' : null));

    const result = await persistPlanAssertions({ ...BASE, sql, assertions: [assertion('VAL-1')] });

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('VAL-1');
    expect(result.errors[0]).toContain('ECONNREFUSED');
    expect(result.errors[0]).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// FALSIFIABILITY CONTROLS
//
// Everything above passes today. That is not evidence the assertions can
// DISCRIMINATE — a test suite that would also pass against the defect it was
// written to catch is decoration. Rather than mutate the shared tree to find
// out (git-sync sweeps it on a timer and would commit the mutant), the broken
// implementations live here permanently: the contract is stated once and run
// against the real seam AND against each way it has plausibly been written
// wrong. The real seam must pass it; every control must fail it.
// ---------------------------------------------------------------------------

type PersistFn = (opts: Parameters<typeof persistPlanAssertions>[0]) => Promise<{ written: number; errors: string[] }>;

/** The fail-closed contract, stated once so both the subject and the controls run the identical assertions. */
async function checkFailClosedContract(persist: PersistFn): Promise<void> {
  const { sql, attempted } = makeSql((valId) => (valId === 'VAL-2' ? new Error('unique violation') : null));
  const assertions = [assertion('VAL-1'), assertion('VAL-2'), assertion('VAL-3')];

  const result = await persist({ ...BASE, sql, assertions });

  expect(result.errors.length).toBeGreaterThan(0); // a partial failure is a REFUSAL signal
  expect(result.errors[0]).toContain('VAL-2'); // ...attributed to the assertion that failed
  expect(result.written).toBe(2); // ...with the survivors actually persisted
  expect(attempted).toEqual(['VAL-1', 'VAL-2', 'VAL-3']); // ...and no assertion skipped
}

/** THE ORIGINAL DEFECT: the failure is downgraded to a warning and never reaches the caller. */
const swallowsErrors: PersistFn = async ({ sql, assertions }) => {
  let written = 0;
  for (const a of assertions) {
    try {
      await sql`INSERT ${a.valId}`;
      written++;
    } catch {
      /* "best effort" — the exact silence P-003 removed */
    }
  }
  return { written, errors: [] };
};

/** Reports the first failure, then stops — so `errors` under-counts the dangling claims. */
const abortsOnFirstError: PersistFn = async ({ sql, assertions }) => {
  let written = 0;
  const errors: string[] = [];
  for (const a of assertions) {
    try {
      await sql`INSERT ${a.valId}`;
      written++;
    } catch (e) {
      errors.push(`${a.valId}: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
  }
  return { written, errors };
};

/** Owns policy by throwing — collapsing a per-assertion list into one opaque message. */
const throwsOnError: PersistFn = async ({ sql, assertions }) => {
  let written = 0;
  for (const a of assertions) {
    await sql`INSERT ${a.valId}`;
    written++;
  }
  return { written, errors: [] };
};

describe('persistPlanAssertions — duplicate VAL ids (P-003: "tests for ... duplicate ids")', () => {
  /**
   * A VAL id is the upsert KEY, so two assertions sharing one do not produce
   * two rows — the second overwrites the first. Both features keep carrying
   * VAL-1 as a claim while only ONE claim survives behind it, and every reader
   * resolves the id successfully and gets the wrong assertion. That reads as
   * present and correct, which makes it strictly harder to detect than the
   * missing-row case the ordering fix addressed.
   *
   * P-002 enforces uniqueness upstream at extraction; this is the
   * persistence-layer backstop, and the two are not redundant — a backstop is
   * what makes an upstream regression loud instead of silently lossy.
   */
  it('refuses a duplicate rather than letting it overwrite the first row', async () => {
    const { sql, attempted } = makeSql();
    const assertions = [
      assertion('VAL-1', { verifyText: 'the original claim' }),
      assertion('VAL-2'),
      assertion('VAL-1', { itemId: 'P-009', verifyText: 'a DIFFERENT claim reusing the id' }),
    ];

    const result = await persistPlanAssertions({ ...BASE, sql, assertions });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('VAL-1');
    expect(result.errors[0]).toContain('duplicate');
    // The colliding third assertion is never sent to the store, so the first
    // row survives intact instead of being overwritten by it.
    expect(attempted).toEqual(['VAL-1', 'VAL-2']);
    expect(result.written).toBe(2);
  });

  it('counts only distinct ids as written — `written` never over-reports rows', async () => {
    const { sql } = makeSql();
    const assertions = [assertion('VAL-1'), assertion('VAL-1'), assertion('VAL-1')];

    const result = await persistPlanAssertions({ ...BASE, sql, assertions });

    // One row exists, so `written` must be 1 — not 3. Over-reporting here would
    // make the refusal message describe a state that does not exist.
    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(2);
  });
});

/**
 * A stub that models the UPSERT rather than just resolving: rows are keyed by
 * valId and a repeat write replaces (ON CONFLICT DO UPDATE = last write wins).
 * Convergence claims need a store with state — a stub that only resolves cannot
 * distinguish "re-ran and converged" from "re-ran and wrote three more rows".
 * Nothing here assumes a parameter POSITION beyond locating the VAL-* token.
 */
function makeRowStore(failFor: (valId: string) => unknown = () => null) {
  const rows = new Map<string, unknown[]>();
  const calls: string[] = [];
  const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const valId = values.find((v): v is string => typeof v === 'string' && v.startsWith('VAL-')) ?? '<no-val-id>';
    calls.push(valId);
    const failure = failFor(valId);
    if (failure) throw failure;
    rows.set(valId, values);
    return [];
  }) as unknown as Sql;
  return { sql, rows, calls };
}

describe('persistPlanAssertions — retries and partial legacy state (P-003)', () => {
  /**
   * RETRY CONVERGENCE. promote's refusal message promises the caller that
   * "the upsert is idempotent — re-run once the store is reachable". That
   * promise is load-bearing (it is the entire recovery path from a refusal),
   * so it gets a test rather than a comment: a run that partially failed,
   * re-run against a healthy store, must end with every row present exactly
   * once and no errors.
   */
  it('a re-run after a partial failure converges — every row present, exactly once', async () => {
    const assertions = [assertion('VAL-1'), assertion('VAL-2'), assertion('VAL-3')];

    // Attempt 1: the store rejects VAL-2.
    const attempt1 = makeRowStore((valId) => (valId === 'VAL-2' ? new Error('deadlock detected') : null));
    const first = await persistPlanAssertions({ ...BASE, sql: attempt1.sql, assertions });

    expect(first.errors).toHaveLength(1);
    expect([...attempt1.rows.keys()].sort()).toEqual(['VAL-1', 'VAL-3']);

    // Attempt 2: identical input, healthy store. The two rows that already
    // landed are re-written by the upsert, not duplicated.
    const attempt2 = makeRowStore();
    for (const [k, v] of attempt1.rows) attempt2.rows.set(k, v); // carry the surviving rows forward
    const second = await persistPlanAssertions({ ...BASE, sql: attempt2.sql, assertions });

    expect(second.errors).toEqual([]);
    expect(second.written).toBe(3);
    expect(attempt2.rows.size).toBe(3);
    expect([...attempt2.rows.keys()].sort()).toEqual(['VAL-1', 'VAL-2', 'VAL-3']);
  });

  /**
   * PARTIAL LEGACY STATE. Rows left behind by an earlier run are explicitly
   * documented as benign and self-healing — but "self-healing" means the
   * re-run must OVERWRITE them with current content, not skip them as already
   * present. A seam that treated an existing row as done would leave a stale
   * assertion behind a live claim, which is the same wrong-row failure the
   * duplicate case produces, just reached from a different direction.
   */
  it('overwrites pre-existing rows with current content rather than skipping them', async () => {
    const store = makeRowStore();
    // Simulate a row left by an earlier promote, carrying stale text.
    store.rows.set('VAL-1', ['stale-workspace', 'stale-harness', 'VAL-1', 'stale text']);

    const result = await persistPlanAssertions({
      ...BASE,
      sql: store.sql,
      assertions: [assertion('VAL-1', { verifyText: 'the current claim' })],
    });

    expect(result.errors).toEqual([]);
    expect(result.written).toBe(1);
    expect(store.calls).toEqual(['VAL-1']); // it was actually re-written, not skipped
    expect(store.rows.get('VAL-1')).toContain('the current claim');
    expect(store.rows.get('VAL-1')).not.toContain('stale text');
  });
});

/** The duplicate-id contract, stated once, for the same subject-vs-control treatment. */
async function checkDuplicateRefusalContract(persist: PersistFn): Promise<void> {
  const { sql, attempted } = makeSql();
  const assertions = [assertion('VAL-1'), assertion('VAL-2'), assertion('VAL-1', { itemId: 'P-009' })];

  const result = await persist({ ...BASE, sql, assertions });

  expect(result.errors.length).toBeGreaterThan(0); // a duplicate is a REFUSAL
  expect(result.errors.some((e) => e.includes('VAL-1'))).toBe(true);
  expect(attempted).toEqual(['VAL-1', 'VAL-2']); // the collider never reaches the store
  expect(result.written).toBe(2); // ...and `written` counts rows, not attempts
}

/** THE PRE-FIX BEHAVIOUR: no dedupe, so the second VAL-1 silently overwrites the first. */
const overwritesDuplicates: PersistFn = async ({ sql, assertions }) => {
  let written = 0;
  const errors: string[] = [];
  for (const a of assertions) {
    try {
      await sql`INSERT ${a.valId}`;
      written++;
    } catch (e) {
      errors.push(`${a.valId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { written, errors };
};

describe('persistPlanAssertions — the contract is falsifiable', () => {
  it('the real seam SATISFIES the fail-closed contract', async () => {
    await expect(checkFailClosedContract(persistPlanAssertions)).resolves.toBeUndefined();
  });

  it('the real seam SATISFIES the duplicate-refusal contract', async () => {
    await expect(checkDuplicateRefusalContract(persistPlanAssertions)).resolves.toBeUndefined();
  });

  it('a control that overwrites duplicates FAILS the duplicate-refusal contract', async () => {
    await expect(checkDuplicateRefusalContract(overwritesDuplicates)).rejects.toThrow();
  });

  it.each([
    ['swallows errors into a warning (the original defect)', swallowsErrors],
    ['aborts on the first error, under-counting the rest', abortsOnFirstError],
    ['throws instead of reporting', throwsOnError],
  ])('a control that %s FAILS the contract', async (_name, impl) => {
    await expect(checkFailClosedContract(impl)).rejects.toThrow();
  });
});
