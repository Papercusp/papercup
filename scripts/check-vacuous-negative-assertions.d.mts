#!/usr/bin/env node
/**
 * DRIFTED gates: a prose literal that exists nowhere emittable, while a long fragment of
 * it IS in the source — the guard is pinned to that string's OLD wording.
 * ORPHANED reports only: nothing resembling the literal survives, or the literal is not
 * prose (a value pin, a shape guard, fixture-composed output).
 *
 * @typedef {'DRIFTED' | 'ORPHANED'} VacuousVerdict
 */
/**
 * A negative assertion with a static literal argument, as extracted from a test file.
 *
 * @typedef {object} NegativeAssertion
 * @property {number} line - 1-indexed line of the assertion in the test file.
 * @property {string} kind - Rendered matcher form, e.g. `not.toMatch(/…/)`.
 * @property {string} lit - The static string the assertion pins.
 * @property {string} span - The matched assertion text, used to exclude self-references.
 */
/**
 * One judged assertion that did not survive the gate.
 *
 * @typedef {object} VacuousFinding
 * @property {string} file
 * @property {number} line
 * @property {string} kind
 * @property {string} lit
 * @property {VacuousVerdict} verdict
 * @property {string | null} fragment - The reworded fragment the source still carries, or null when nothing is close.
 */
/**
 * Answers "does the non-test corpus contain this string". Injected so the unit tests can
 * drive a synthetic corpus.
 *
 * @typedef {(needle: string) => boolean} IncludesFn
 */
/**
 * The GATE is narrowed to PROSE — multi-word wording with no embedded values. That is
 * where this class actually bites (banners, prompt text, advice strings: copy that gets
 * reworded often, and carries negative guards precisely because a bad phrasing already
 * caused an incident once), and it is the shape that CANNOT be produced by interpolating
 * a value, so its absence is decisive.
 *
 * The non-prose population is dominated by legitimate guards this must not fail:
 * value pins (`SKIP_FROMREPO="${SKIP_FROMREPO:-0}"` — the default must not be 0), shape
 * guards (`kill "$PORT_LOCK_KEEPER_PID"` — stop.sh must not force-kill the keeper), and
 * fixture-composed output (`(subpath "/p")`). Every one of those was a live finding on
 * the first sweep of this repo, and every one is a *good* assertion. They stay visible
 * under --report; they do not gate.
 *
 * @param {string} lit
 * @returns {boolean}
 */
export function proseShaped(lit: string): boolean;
/**
 * The plain string a regex source encodes, or null when it uses real regex power
 * (`\d`, `\s`, a character class, alternation, a quantifier). Only a pattern that is
 * a plain literal can be judged by "does this string exist anywhere".
 *
 * @param {string} src - The regex source (no delimiters, no flags).
 * @returns {string | null}
 */
export function regexSourceToLiteral(src: string): string | null;
/**
 * Negative assertions with a static literal argument, in source order.
 *
 * @param {string} text - Full source of one test file.
 * @returns {NegativeAssertion[]}
 */
export function extractNegativeLiterals(text: string): NegativeAssertion[];
/**
 * A maximal contiguous fragment of `lit` present in `corpus`, long enough to prove the
 * guarded string still exists in a reworded form — plus what it leaves uncovered.
 *
 * Windows of exactly the threshold length are probed and the first hit is then GROWN
 * outward. Growing matters: the residue (what the source does NOT have) is the whole
 * discriminator below, and an un-grown threshold-length window reports residue the
 * source actually contains.
 *
 * `residue` is a fixed PAIR — [before the fragment, after it]. The implementation builds
 * it as an array literal, which infers as `string[]`; the tuple only survives because it
 * is written here.
 *
 * @param {string} lit
 * @param {IncludesFn} includes
 * @returns {{ fragment: string; residue: [string, string] } | null}
 */
export function driftFragment(lit: string, includes: IncludesFn): {
    fragment: string;
    residue: [string, string];
} | null;
/**
 * Judge one test file's negative assertions. `includes` answers "does the non-test
 * corpus contain this string" — injected so the unit tests can drive a synthetic corpus.
 *
 * @param {{ file: string; text: string; includes: IncludesFn }} args
 * @returns {{ considered: number; findings: VacuousFinding[] }}
 */
export function judgeFile({ file, text, includes }: {
    file: string;
    text: string;
    includes: IncludesFn;
}): {
    considered: number;
    findings: VacuousFinding[];
};
/**
 * DRIFTED gates: a prose literal that exists nowhere emittable, while a long fragment of
 * it IS in the source — the guard is pinned to that string's OLD wording.
 * ORPHANED reports only: nothing resembling the literal survives, or the literal is not
 * prose (a value pin, a shape guard, fixture-composed output).
 */
export type VacuousVerdict = "DRIFTED" | "ORPHANED";
/**
 * A negative assertion with a static literal argument, as extracted from a test file.
 */
export type NegativeAssertion = {
    /**
     * - 1-indexed line of the assertion in the test file.
     */
    line: number;
    /**
     * - Rendered matcher form, e.g. `not.toMatch(/…/)`.
     */
    kind: string;
    /**
     * - The static string the assertion pins.
     */
    lit: string;
    /**
     * - The matched assertion text, used to exclude self-references.
     */
    span: string;
};
/**
 * One judged assertion that did not survive the gate.
 */
export type VacuousFinding = {
    file: string;
    line: number;
    kind: string;
    lit: string;
    verdict: VacuousVerdict;
    /**
     * - The reworded fragment the source still carries, or null when nothing is close.
     */
    fragment: string | null;
};
/**
 * Answers "does the non-test corpus contain this string". Injected so the unit tests can
 * drive a synthetic corpus.
 */
export type IncludesFn = (needle: string) => boolean;
