/**
 * fuzzyEnum — the generic CLOSED-SET argument validator (generic-tool-arg-fuzzy-validation-2026-07-03,
 * D-001). The argument analogue of fuzzy tool-NAME resolution: a zod string schema that checks a
 * value against a closed set and, on a miss, returns the NEAREST allowed value(s) + the allowed
 * list — so a weak model that passes a typo'd/invalid value gets a corrective nudge instead of an
 * opaque failure.
 *
 * It composes into any tool's existing `args: z.object({ … })` and rides the EXISTING
 * `standardValidate → formatInvalidArgs` path: the rich `message` surfaces automatically (no
 * formatter change), and structured `params` ride along for structured consumers. Opt-in per arg;
 * generic by composition (works across ALL tools).
 *
 * WHEN to use it:
 *   - DYNAMIC sets that can't be a literal enum — models, harness/plan slugs, flag keys — where
 *     it is the only feasible guard. Back the resolver with an out-of-band-refreshed SYNC cache so
 *     validation stays fast and never blocks (this factory is deliberately SYNC so it works through
 *     every validation path, sync or async).
 * WHEN NOT to use it:
 *   - A STATICALLY-KNOWN set — prefer plain `z.enum([...])`. It rejects invalids too AND advertises
 *     the allowed values in the tool's JSON Schema up front (something a runtime refine can't).
 *     `fuzzyEnum` is the upgrade only where a literal enum is impossible.
 *
 * FAIL-OPEN: when the resolved set is empty (an unavailable/cold resolver), no issue is added — an
 * unavailable validator never blocks a real call.
 */
import { z } from 'zod';
/** Top-k candidates nearest to `target` by NORMALIZED edit distance (≤ maxRatio) — a wildly-wrong
 *  value returns [] (so the caller shows the full list), a near-miss returns the suggestion(s). */
export declare function nearestByLevenshtein(target: string, candidates: readonly string[], opts?: {
    k?: number;
    maxRatio?: number;
}): string[];
export interface FuzzyEnumOpts {
    /** Only validate when this returns true (default: always). Scopes a set to the values it actually
     *  governs — e.g. only validate a `model` that LOOKS local (a claude alias is an open set). */
    applies?: (value: string) => boolean;
    /** Canonicalize a value + each candidate BEFORE matching (case-fold, strip a provider prefix,
     *  …), so variant spellings of the same member match and are NOT false-rejected. Matching + the
     *  nearest search run on the normalized forms; the ORIGINAL candidate is what's shown as the
     *  suggestion. Default: identity. */
    normalize?: (value: string) => string;
    /** Noun used in the error message, e.g. 'model'. Default 'value'. */
    label?: string;
    /** Nearest-match tuning. */
    k?: number;
    maxRatio?: number;
    /** Cap the allowed-list echoed in the error, to bound the payload. Default 25. */
    maxListed?: number;
}
/**
 * A zod string schema that fuzzy-validates against a closed set (see module header). `allowed` is a
 * STATIC list or a SYNC resolver (cache-backed). Returns a `.custom` issue carrying a rich `message`
 * (`… Did you mean \`x\`? Allowed: [ … ]`) + structured `params { got, nearest, allowed }`.
 */
export declare function fuzzyEnum(allowed: readonly string[] | (() => readonly string[]), opts?: FuzzyEnumOpts): z.ZodType<string>;
