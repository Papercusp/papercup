/**
 * SQL-comment-backtick detector (EI-7661 / EI-19317789732905891 / EI-19415157731625374).
 *
 * A markdown-style backtick-quoted identifier inside a `--` SQL comment that
 * lives inside a template literal ENDS the template early. Two failure modes:
 *
 *  1. SILENT (the dangerous one) — inside a postgres-js tagged template the
 *     trailing text can still parse as valid TS, so the file compiles and RUNS
 *     with the query truncated mid-comment. On 2026-07-05 this amputated the
 *     entire WHERE clause from the mig-504 LWW upserts: the apply-guard vanished
 *     and stale writes applied unconditionally. `ts-parse` CANNOT see this — the
 *     file parses fine.
 *  2. LOUD — in a plain (non-tagged) DDL-fixture template it is a hard TS1005
 *     cascade. `ts-parse` does catch this, but its message names the parser's
 *     first confusion, which lands tens of lines from the cause. The whole
 *     complaint of EI-19415157731625374 is that diagnosis quality: three separate
 *     diagnose-and-fix cycles in ONE session, each looking like a different bug.
 *
 * So this detector earns its place twice over: it is the ONLY check that sees
 * case 1 at all, and for case 2 it names the actual mistake. It is registered
 * BEFORE `ts-parse` for exactly the reason `smart-quotes` is — the more
 * actionable message should be the one recorded.
 *
 * ── Why this is a heuristic, and why that is correct here ──────────────────
 * It is deliberately a LINE SCANNER, not a parser — but NOT for the reason you
 * might assume, and the wrong reason is worth stating because it is seductive.
 *
 * It is tempting to say "the file does not parse, so there are no nodes to
 * walk". That is FALSE, measured both ways on the real incident shapes:
 *   - the SILENT case (`sql` tagged) parses CLEANLY — 0 parse diagnostics — which
 *     is precisely what makes it silent;
 *   - the LOUD case (plain DDL template) emits TS1005s but TypeScript
 *     error-RECOVERS and still yields template-literal nodes.
 * So neither "it doesn't parse" nor "there are no nodes" discriminates anything.
 *
 * The real reason is worse, and is the whole trap: THE AST FAITHFULLY ENCODES
 * THE MIS-PARSE. By the time you have nodes, the stray backtick has already been
 * consumed as the template's TERMINATOR — it is no longer *inside* any
 * template's content. So an AST walk asking "is there a backtick inside a SQL
 * comment inside this template?" correctly answers NO, on a file that is broken
 * exactly that way. The evidence you would search for has been reinterpreted as
 * syntax. (Measured: the first template node ends mid-comment, right at the
 * stray backtick, and a second bogus template node is formed from the remainder.)
 *
 * A line scanner works because it reads the bytes the AUTHOR wrote, before the
 * parser's reinterpretation. The incidents themselves suggest the cheap
 * discriminator: a `--` SQL line-comment essentially never legitimately appears
 * outside a SQL string in this codebase.
 *
 * ── The >=2 backtick rule (measured, not guessed) ─────────────────────────
 * The authoring mistake is always a markdown-quoted PAIR (`` `closed_ts` ``), so
 * a real offender carries at least TWO unescaped backticks after the `--`.
 * Requiring two is what removes the one systematic false positive of the
 * original `scripts/check-sql-comment-backtick.mjs`: the backtick that
 * legitimately TERMINATES a single-line template, as in
 * `` `SELECT 1 -- trailing comment` `` — exactly one backtick after the marker,
 * and perfectly valid. Measured over all 26,376 tracked files on 2026-08-03:
 * the one-backtick rule produced 7 hits, ALL false positives; the >=2 rule
 * produces ZERO false positives while still catching all three real incidents.
 *
 * That false positive was not hypothetical — `lint:no-sql-comment-backtick` was
 * RED at the time this was written, on `content-lint/registry.ts` itself, and
 * had been silently red because nothing ran it (see the scope note below). A
 * guard on no blocking path does not merely fail to catch things; it rots.
 *
 * The residual blind spot is an UNBALANCED single backtick (`-- see `kind`).
 * That is accepted deliberately: it is rare (a typo, not the house-style habit
 * this class comes from), and it always breaks the parse, so `ts-parse`
 * quarantines it one entry later with its generic message. Trading that for
 * zero false positives is the right side of the trade on a path where a false
 * positive QUARANTINES a file and blocks the fleet's commit.
 */

/** A backtick-quoted identifier inside a SQL `--` comment: 1-based position + evidence. */
export interface SqlCommentBacktickHit {
  line: number;
  /** Column of the FIRST backtick inside the comment — the one that ends the template. */
  col: number;
  /** The offending source line, trimmed and capped. */
  text: string;
  /** Unescaped backticks found inside the comment (always >= 2 — see the rule above). */
  backticks: number;
}

/**
 * A postgres-js tagged template: `sql`, optionally with a generic type argument,
 * followed by a backtick.
 *
 * The lookbehind is load-bearing. The original guard used a bare /\bsql`/, which
 * also matches the PROSE spelling `` `sql` `` in a doc comment — and that alone
 * pulled `content-lint/registry.ts` (which has no SQL in it whatsoever, only a
 * paragraph ABOUT this bug) into scope, where it then false-positived. Requiring
 * that `sql` is preceded by neither a backtick nor a word character keeps a
 * discussion of SQL out of the scope of a SQL linter.
 *
 * WI-9253: the optional `<...>` is equally load-bearing, and its absence cost a
 * 17-minute :3170 outage on 2026-08-03. This pattern previously required the
 * backtick to follow `sql` IMMEDIATELY, so the overwhelmingly common typed form
 * — `` await sql<RoutineFailureRow[]>`...` `` — did not match, and since a
 * SELECT-only file also fails HAS_RAW_DDL, the gate rejected the WHOLE file and
 * the detector never ran a line of it. Measured at the time of the fix: 428
 * non-test files use the typed form and 411 were FULLY invisible to this guard,
 * which is the real reason it had accumulated 0 true positives.
 *
 * Note the asymmetry that follows, and keep this gate GENEROUS: admitting a file
 * that turns out to hold no SQL costs nothing (the detector still requires a real
 * `--` comment carrying >=2 unescaped backticks before it reports anything),
 * whereas excluding a file that does hold SQL is silent and unbounded — it is
 * indistinguishable from "clean" and stays that way until something crash-loops.
 * Prefer widening this pattern over tightening it.
 */
const USES_SQL_TAG = /(?<![`\w])sql\s*(?:<[^`]{0,200}>)?\s*`/;

/** Raw DDL anywhere in the file — covers plain template-literal schema fixtures
 *  that never use the tag at all (EI-19317789732905891: 657 lines of DDL across
 *  8 exported constants, invisible to USES_SQL_TAG alone). */
const HAS_RAW_DDL = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|(?:UNIQUE\s+)?INDEX)\b/;

/**
 * A genuine SQL `--` comment marker: dash-dash preceded by start-of-line or
 * whitespace and followed by whitespace. This distinguishes it from a CLI flag
 * token (`--flag`, `--flag=value`), which never has a space right after the
 * dashes and is the dominant false-positive source in this repo's shell and
 * CLI-wrapper files.
 */
const SQL_COMMENT_MARKER = /(?:^|\s)--\s/;

/**
 * A MACHINE-GENERATED file, declared by its own first-line comment header
 * (`Generated by …` / `Do not edit` / `@generated`). Exempt for the same reason
 * the scope gate excludes minified sidecar build output: there is no authored
 * comment to rephrase, so a hit can only ever quarantine the file — it cannot
 * be fixed where it sits, and if a GENERATOR really emitted a broken SQL
 * template the fix belongs in the generator, not in its output.
 *
 * Measured incident (2026-08-17, sidestage): `build-history.snapshot.ts` — a
 * 2.2MB generated data snapshot whose double-quoted JSON strings embed fleet
 * prose — tripped the heuristic at 15352:985 on markdown inline-code backticks
 * around a git PATHSPEC separator (`` `git log -1 -- libs/dock-workbench` ``:
 * a space-padded ` -- ` plus ≥2 backticks), while an embedded work-item body
 * quoting DDL satisfied HAS_RAW_DDL. `tsc --noEmit` parsed the file CLEAN —
 * every backtick sat inside a double-quoted string, which this line scanner
 * (deliberately — see the header) cannot know. The autofix's backtick→'"'
 * rewrite would have CORRUPTED the JSON string it targeted, so the file
 * quarantined for 10+ ticks, escalated needs-human, and starved the harness's
 * green gate of its regenerated snapshot.
 *
 * The header test is content-level (not a path rule in the scope gate) so every
 * consumer of this predicate — the git-sync guard, the registry, the CI shim,
 * the autofix — inherits it and none can disagree (D-003).
 */
const GENERATED_FILE_HEADER = /^(?:\/\/|\/\*)[^\n]*\b(?:generated by|generated from|do not edit|@generated)\b/i;

/**
 * Scope mirror for the registry entry + the CI script, so the two can never
 * disagree (D-003). Test/spec files are EXCLUDED — a measured decision, not an
 * oversight, and the one part of this worth re-deciding if the trade changes:
 *
 *   - Test files legitimately inline ad-hoc SQL, and two of them
 *     (`ts-parse.test.ts`, `git-sync/content-guard.test.ts`) carry a
 *     backtick-in-SQL-comment line as a deliberate FIXTURE of this exact bug.
 *     Registering test files would quarantine the very tests that prove the
 *     detector works — and on the commit path a false quarantine blocks the
 *     fleet, so the cost is real and immediate.
 *   - Test files are NOT left unguarded: `ts-parse` matches every .ts/.tsx with
 *     no test exclusion, so a parse-breaking instance in a test is still caught
 *     one entry later. What a test file forgoes is the better MESSAGE, not the
 *     containment.
 *   - The damage this detector exists to prevent (case 1 above — a silently
 *     truncated query reaching shared state) is a property of non-test DDL
 *     MODULES. In a test, a truncated fixture fails its own test.
 */
export const sqlCommentBacktickScopeMatches = (f: string): boolean =>
  /\.(ts|tsx|mjs)$/.test(f) &&
  !/\.(test|spec)\.(ts|tsx|mjs)$/.test(f) &&
  !f.endsWith('.d.ts') &&
  // Minified sidecar BUILD OUTPUT: a single 42MB line-wrapped bundle where a
  // backtick lands next to a `--` by coincidence and there is no authored
  // comment to rephrase. Same exclusion, same reason, as check-no-raw-setinterval.mjs.
  !f.includes('/env-sidecars/') &&
  !f.includes('/node_modules/') &&
  !f.includes('/dist/') &&
  !f.startsWith('_retired/') &&
  !f.includes('/_retired/');

/** Count unescaped backticks from `fromIndex`. A `\`` escape inside a template
 *  literal does not end it, so it is not part of the failure signature. */
function countUnescapedBackticks(line: string, fromIndex: number): number {
  let n = 0;
  for (let i = fromIndex; i < line.length; i++) {
    if (line[i] === '`' && line[i - 1] !== '\\') n++;
  }
  return n;
}

/** Index of the first unescaped backtick at/after `fromIndex`, or -1. */
function firstUnescapedBacktick(line: string, fromIndex: number): number {
  for (let i = fromIndex; i < line.length; i++) {
    if (line[i] === '`' && line[i - 1] !== '\\') return i;
  }
  return -1;
}

/**
 * Pure detector: the FIRST backtick-quoted identifier inside a SQL `--` comment,
 * or null when the file is clean (or carries no SQL at all).
 *
 * `fileName` participates only via the file-level SQL scope gate; callers that
 * have already applied `sqlCommentBacktickScopeMatches` still get the same
 * answer, since the gate here is about the file's CONTENT, not its path.
 */
export function findSqlCommentBacktick(fileName: string, text: string): SqlCommentBacktickHit | null {
  if (GENERATED_FILE_HEADER.test(text)) return null;
  if (!USES_SQL_TAG.test(text) && !HAS_RAW_DDL.test(text)) return null;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = SQL_COMMENT_MARKER.exec(line);
    if (!m) continue;

    // A `//`-style JS comment line is prose, not SQL — its `--` and backticks
    // are just discussion (this file itself is full of them).
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    const dashIdx = m.index + m[0].indexOf('--');
    const slash = line.indexOf('//');
    if (slash !== -1 && slash < dashIdx) continue;

    const backticks = countUnescapedBackticks(line, dashIdx);
    if (backticks < 2) continue;

    const col = firstUnescapedBacktick(line, dashIdx);
    return {
      line: i + 1,
      col: col + 1,
      text: line.trim().slice(0, 140),
      backticks,
    };
  }
  return null;
}

/** Bound on repair passes (one per offending line). A file needing more than this is not
 *  a stray typo — let the LLM fixer look at it rather than spinning. */
const MAX_AUTOFIX_PASSES = 200;

/**
 * Deterministic repair for this class: swap the offending backticks for straight double
 * quotes, which is exactly the remedy `detect` already prescribes to the author.
 *
 * WHY THIS EXISTS, given the entry in registry.ts long said "No autoFix" (EI-19493869861442174).
 * That note gave two reasons and both have since been answered:
 *
 *   1. "rephrasing is an authoring choice" — but `detect`'s own message already MAKES that
 *      choice ("use straight quotes"), and when this class actually fired on 2026-08-04 the
 *      LLM fixer independently produced precisely this transformation. The freedom was
 *      notional; the cost of deferring it was ~76min of a fleet-wide :3170 outage plus a
 *      peer's work stranded in quarantine.
 *   2. "the file may be mid-edit" — handled STRUCTURALLY one layer up: the git-sync guard's
 *      write is CAS-guarded (content-guard.ts), re-reading immediately before writing and
 *      writing only when the file still equals the baseline it detected on.
 *
 * SAFE BY CONSTRUCTION, so this can only shorten an outage, never cause one: the guard runs
 * this ONLY on a file that already FAILED `detect`, re-runs `detect` on the result, and keeps
 * the repair only if it fully clears the error — otherwise the file quarantines to the LLM
 * fixer exactly as before.
 *
 * The HEURISTIC is not reimplemented here (D-003): each offending line is located by calling
 * `findSqlCommentBacktick` itself and rewriting from the `col` it reports, which is documented
 * as the first unescaped backtick INSIDE the comment — so everything from there to end of line
 * is comment text and safe to requote. An ESCAPED backtick is left alone: it never terminated
 * the template, so touching it would be an edit the defect does not justify.
 *
 * Pure + idempotent, per the autoFix contract.
 */
export function autoFixSqlCommentBacktick(text: string): { fixed: string; changed: boolean } {
  const lines = text.split('\n');
  let changed = false;

  for (let pass = 0; pass < MAX_AUTOFIX_PASSES; pass++) {
    // fileName is unused by the predicate (it gates scope at the detector level), so the
    // empty string here is deliberate rather than a placeholder for something missing.
    const hit = findSqlCommentBacktick('', lines.join('\n'));
    if (!hit) break;

    const idx = hit.line - 1;
    const line = lines[idx];
    if (line === undefined) break;

    const from = hit.col - 1;
    let rebuilt = line.slice(0, from);
    for (let j = from; j < line.length; j++) {
      const ch = line[j];
      rebuilt += ch === '`' && line[j - 1] !== '\\' ? '"' : ch;
    }

    // No progress ⇒ this line is not something we can mechanically resolve. Bail out
    // WITHOUT partial edits so the whole file reaches the LLM fixer in its original state.
    if (rebuilt === line) return { fixed: text, changed: false };

    lines[idx] = rebuilt;
    changed = true;
  }

  return changed ? { fixed: lines.join('\n'), changed: true } : { fixed: text, changed: false };
}
