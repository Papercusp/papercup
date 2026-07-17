/**
 * rubricRef ↔ rubricId: the SAME logical field on a rubric, accepted
 * under EITHER name by rubrics:get and rubrics:trend (EI-11400, P-005).
 *
 * THE BUG THIS CLOSES: agents naturally reach for rubricId (the output field name
 * from results) but the tools canonicalized to rubricRef after the strict-validation
 * fix, rejecting the reasonable synonym and forcing a retry with the "correct" name.
 * Retry tax: silent loss to schema probe calls each time an agent passes the natural
 * field name.
 *
 * THE FIX: both rubrics:get and rubrics:trend now accept `rubricRef` (canonical) and
 * `rubricId` (alias), with conflict detection when both are passed with different values.
 *
 * CLASS: the retry-tax family — not a silent failure, but a LOUD rejection forcing a
 * re-call with a renamed field. Retry tax multiplies with every agent reaching for the
 * natural synonym, burning tokens and latency.
 */
import { z } from 'zod';

/**
 * Reject the one case aliasing can't silently resolve: both `rubricRef` and `rubricId`
 * supplied with DIFFERENT values (which one wins would be ambiguous). Equal values, or
 * exactly one of the two, resolve cleanly via {@link resolveRubricRefAlias}. Shared by
 * rubrics:get and rubrics:trend so the message and the rule never drift. Pure; add via
 * `.superRefine`.
 */
export function rejectRubricRefIdConflict(
  a: { rubricRef?: unknown; rubricId?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (a.rubricRef !== undefined && a.rubricId !== undefined && a.rubricRef !== a.rubricId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rubricRef'],
      message:
        '`rubricRef` and `rubricId` are the SAME field (EI-11400) — pass only one. You passed both with different values, so which one wins would be ambiguous.',
    });
  }
}

/**
 * Resolve the single rubric-ref value from either alias. Order is irrelevant once
 * {@link rejectRubricRefIdConflict} has run at validation time: at most one differs, so
 * `??` selects whichever is present. Returns `undefined` when neither is given (required
 * validation upstream will catch this).
 */
export function resolveRubricRefAlias(a: { rubricRef?: string; rubricId?: string }): string | undefined {
  return a.rubricRef ?? a.rubricId;
}

/**
 * Array version: resolve a single rubric-ref value from either alias in an array context.
 * Returns `undefined` when neither is given.
 */
export function resolveRubricRefArrayAlias(
  a: { rubricRefs?: string[]; rubricIds?: string[] },
): string[] | undefined {
  return a.rubricRefs ?? a.rubricIds;
}
