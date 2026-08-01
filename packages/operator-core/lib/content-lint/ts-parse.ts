/**
 * TypeScript PARSE detector — "does this file parse at all" (WI-6683). The
 * general form of the hard-parse-failure class `smart-quotes` already catches
 * one narrow instance of.
 *
 * WI-6683: two sibling projection modules were auto-committed to `staging` in a
 * state where TypeScript cannot PARSE them — a backtick inside a `--` SQL
 * comment that lives INSIDE a `sql` tagged template closed the template, so the
 * rest of each module parsed as garbage (TS1005 / TS1443). A parse error is not
 * a normal type error: it is not baselined, not local, and not attributable to
 * one call site — EVERY consumer of the package fails. Measured, not asserted:
 * repairing one of the two files took `packages/operator-core`'s tsc error count
 * from 231 to 184, and those ~47 were OTHER agents' files that could no longer
 * resolve anything through the broken module. For the whole window it sat
 * committed, no agent could typecheck their own work and the green-checkpoint
 * would red for the entire fleet on a defect none of them introduced.
 *
 * A narrow guard for that one spelling already existed
 * (`scripts/check-sql-comment-backtick.mjs`) and was GREEN the whole time the
 * break sat committed — nothing ran it on the path where the damage happens. A
 * guard that runs on no blocking path is not a guard. This detector states the
 * invariant at the altitude that actually holds: *a file that does not parse
 * must not reach the shared tree*, whatever the spelling of the mistake.
 *
 * SYNTACTIC ONLY. `ts.createSourceFile` is a pure parse — no type graph, no
 * program load, no module resolution, no disk, no network. It can therefore only
 * ever report "this text is not valid TypeScript", never a type error, so it can
 * never quarantine a file over an unresolved import, a missing dependency, or a
 * bad annotation. Measured at ~0.85ms/file across all 10,829 tracked .ts/.tsx
 * files in this repo with ZERO false positives on that corpus; git-sync only
 * checks the handful DIRTY on a given tick, so the real per-tick cost is noise.
 *
 * Deliberately mirrors `findCodePositionCurlyQuotes` in this directory, which
 * already performs this exact parse and reads the same `parseDiagnostics` — it
 * just discards every diagnostic that does not sit at a curly-quote offset.
 */
import ts from 'typescript';

/** A single TypeScript syntax error: 1-based source position + the parser's own reason. */
export interface TsParseError {
  line: number | null;
  col: number | null;
  /** The TS diagnostic code (e.g. 1005 for "';' expected"). */
  code: number;
  reason: string;
}

/**
 * Pure detector: the FIRST syntactic diagnostic in `text`, or null when the file
 * parses cleanly. Never throws on a syntax error (that is the expected result and
 * is returned); it throws only if the TS build cannot report parse diagnostics at
 * all — see below.
 */
export function findTsParseError(fileName: string, text: string): TsParseError | null {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false, scriptKind);
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  // `parseDiagnostics` is an internal property (the same one smart-quotes reads).
  // If a TypeScript upgrade ever removes it, FAIL LOUD rather than return null for
  // everything: a check that can only answer "clean" is precisely the silent
  // non-guard this work item exists to remove. The content guard fails open on a
  // throwing detector, so the fleet's commit is never wedged — the operator log
  // records that this check went dark, which is the outcome we want to be noisy.
  if (diags === undefined) {
    throw new Error(
      'ts-parse: SourceFile.parseDiagnostics is unavailable in this TypeScript build — the parse check cannot run',
    );
  }
  const first = diags[0];
  if (!first) return null;
  const pos = typeof first.start === 'number' ? sf.getLineAndCharacterOfPosition(first.start) : null;
  return {
    line: pos ? pos.line + 1 : null,
    col: pos ? pos.character + 1 : null,
    code: first.code,
    reason: ts.flattenDiagnosticMessageText(first.messageText, ' '),
  };
}
