// Type declarations for check-no-unthreaded-apply.mjs — a plain ESM script with no build
// step, consumed both as a CLI (`node scripts/check-no-unthreaded-apply.mjs`) and, for its
// pure core, imported from a Vitest test
// (packages/operator-core/lib/__tests__/check-no-unthreaded-apply.test.ts).

export interface UnthreadedApplyHit {
  /** 1-based line of the offending `applyOpVia(` call. */
  line: number;
  /** Human-readable cause — which of the two detectable shapes matched. */
  reason: string;
}

/**
 * Blank out comments and string/template literals, preserving length and newlines so byte
 * offsets and line numbers survive unchanged.
 */
export function maskCommentsAndStrings(src: string): string;

/**
 * Split a call's argument list at TOP-LEVEL commas only, so an object literal or nested
 * call counts as ONE argument. `masked` must already be masked.
 *
 * Returns `null` when the parens never balance, so a caller can decline to judge rather
 * than report a confident wrong arity.
 */
export function splitArgs(masked: string, openParenIdx: number): string[] | null;

/** Find un-threaded `applyOpVia` call sites in one file's RAW source. */
export function findUnthreadedApplies(src: string): UnthreadedApplyHit[];
