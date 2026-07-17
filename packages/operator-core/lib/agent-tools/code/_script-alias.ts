/**
 * script ↔ code: the SAME logical field on a code:run invocation, accepted
 * under EITHER name by code:run (EI-11400, P-005).
 *
 * THE BUG THIS CLOSES: older/cognate surfaces use `code` while code:run canonicalized
 * to `script` after the strict-validation fix, rejecting the reasonable synonym and
 * forcing a retry with the "correct" name. Retry tax: silent loss to schema probe calls
 * each time an agent passes the natural field name.
 *
 * THE FIX: code:run now accepts `script` (canonical) and `code` (alias), with conflict
 * detection when both are passed with different values.
 *
 * CLASS: the retry-tax family — not a silent failure, but a LOUD rejection forcing a
 * re-call with a renamed field. Retry tax multiplies with every agent reaching for the
 * natural synonym, burning tokens and latency.
 */
import { z } from 'zod';

/**
 * Reject the one case aliasing can't silently resolve: both `script` and `code`
 * supplied with DIFFERENT values (which one wins would be ambiguous). Equal values, or
 * exactly one of the two, resolve cleanly via {@link resolveScriptAlias}. Pure; add via
 * `.superRefine`.
 */
export function rejectScriptCodeConflict(
  a: { script?: unknown; code?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (a.script !== undefined && a.code !== undefined && a.script !== a.code) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['script'],
      message:
        '`script` and `code` are the SAME field (EI-11400) — pass only one. You passed both with different values, so which one wins would be ambiguous.',
    });
  }
}

/**
 * Resolve the single script value from either alias. Order is irrelevant once
 * {@link rejectScriptCodeConflict} has run at validation time: at most one differs, so
 * `??` selects whichever is present. Returns `undefined` when neither is given (required
 * validation upstream will catch this).
 */
export function resolveScriptAlias(a: { script?: string; code?: string }): string | undefined {
  return a.script ?? a.code;
}
