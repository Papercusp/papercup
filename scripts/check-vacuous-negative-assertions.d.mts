/**
 * Types for the vacuous-negative-assertion lint's exported judge (EI-18765867705399052),
 * so `packages/operator-core/lib/check-vacuous-negative-assertions.test.ts` drives it with
 * real types instead of an implicit `any` (which is a TS7016 error under the repo's
 * per-file tsc baseline, and would also let the tests assert against a shape that no
 * longer exists).
 */

/**
 * DRIFTED gates: a prose literal that exists nowhere emittable, while a long fragment of
 * it IS in the source — the guard is pinned to that string's OLD wording.
 * ORPHANED reports only: nothing resembling the literal survives, or the literal is not
 * prose (a value pin, a shape guard, fixture-composed output).
 */
export type VacuousVerdict = 'DRIFTED' | 'ORPHANED';

export interface NegativeAssertion {
  /** 1-indexed line of the assertion in the test file. */
  line: number;
  /** Rendered matcher form, e.g. `not.toMatch(/…/)`. */
  kind: string;
  /** The static string the assertion pins. */
  lit: string;
  /** The matched assertion text, used to exclude self-references. */
  span: string;
}

export interface VacuousFinding {
  file: string;
  line: number;
  kind: string;
  lit: string;
  verdict: VacuousVerdict;
  /** The reworded fragment the source still carries, or null when nothing is close. */
  fragment: string | null;
}

/** Answers "does the non-test corpus contain this string". */
export type IncludesFn = (needle: string) => boolean;

export function regexSourceToLiteral(src: string): string | null;
export function proseShaped(lit: string): boolean;
export function extractNegativeLiterals(text: string): NegativeAssertion[];
export function driftFragment(
  lit: string,
  includes: IncludesFn,
): { fragment: string; residue: [string, string] } | null;
export function judgeFile(args: { file: string; text: string; includes: IncludesFn }): {
  considered: number;
  findings: VacuousFinding[];
};
