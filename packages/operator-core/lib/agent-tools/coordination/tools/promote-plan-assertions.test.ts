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
