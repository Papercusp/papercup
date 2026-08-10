import ts from 'typescript';

/**
 * Strip comments AND the CONTENTS of string/template literals, in ONE pass.
 *
 * THE ONE canonical implementation for every lint guard in `scripts/` that text-matches a
 * call-shaped token. Import it; do not copy it. Copy-pasted `stripComments` IS the root
 * cause this module exists to remove (EI-19991116787260658) — at the time of lifting,
 * 16 guard scripts carried their own private copy and 5 were measurably defective.
 *
 * WHY THIS EXISTS (EI-19989853369726696): guards used to run a comments-only `stripComments`,
 * which leaves string literals intact — so a call-shaped token appearing in PROSE inside a
 * string parsed as a real call site. That is not hypothetical and it was not cheap:
 * `apps/operator/lib/release/green-checkpoint.ts` contains the error text of a DIFFERENT
 * guard —
 *
 *     '... a new recurring timer bypassed managedSetInterval (P-008) ...'
 *
 * The detector regex was /\bmanagedSetInterval\s*\(/, and `\s*\(` happily matches the space
 * before `(P-008)`. The scan extracted `P-008` as that "call's" argument text, found no
 * `classification:`, and reported a phantom offender — red-pinning the fleet gate on a file
 * that does not even IMPORT managedSetInterval, while agents triaged a call site that did
 * not exist.
 *
 * That failure mode is STRUCTURAL for this class of tool, not bad luck: a guard's error
 * message quotes the very token the guard detects, so guards are exactly the code most
 * likely to contain their own detection tokens inside strings. A guard whose own failure
 * text is quoted elsewhere will keep minting phantoms, so the fix belongs in the scanner —
 * never in a reword of the quoting file.
 *
 * ONE pass rather than strip-comments-then-strip-strings, because the two are mutually
 * escaping: `//` inside a string does not start a comment ("http://x" must survive as a
 * string, not silently truncate the rest of the line), and a quote inside a comment does
 * not start a string (`// don't` would otherwise open an unterminated literal and eat the
 * rest of the file). Chaining two independent regex passes gets both of those wrong.
 *
 * `${...}` template expressions are preserved AS CODE — a real call can legitimately live
 * inside one, and dropping them would trade a false POSITIVE for a false NEGATIVE, which is
 * the worse direction for a guard.
 *
 * The delimiters are kept (contents emptied) so nothing new is concatenated across a
 * removal. Argument-level detection is unaffected: a check looking for a `classification:`
 * KEY is reading code, never the string VALUE — `{ classification: 'must-sample' }` still
 * reads as `{ classification: '' }` and still matches.
 *
 * ⚠ NOT FOR EVERY GUARD. Some guards detect tokens that legitimately live INSIDE string or
 * template literals — `check-no-raw-install-slug-filter` matches `harness_slug = ${installSlug}`
 * inside SQL template literals BY DESIGN, and the SQL-in-string guards
 * (check-migration-forward-compat, check-no-sql-json) are the same shape. For those, stripping
 * strings would trade this false positive for a false NEGATIVE. Use this module when the token
 * you detect is CODE (a call or identifier); keep reading raw text when the token is legitimately
 * string-resident.
 *
 * ⚠ REGEX LITERAL BODIES ARE BLANKED TOO (delimiters kept). A guard's own detection regex is
 * the single most likely place for its token to appear — `/\bsetInterval\s*\(/` sits in the
 * source of the very guard that bans `setInterval(` — so a regex body is data, exactly like a
 * string, for every consumer of this function.
 *
 * ⚠ JSX TEXT IS LEFT AS CODE. `<p>see https://x/y</p>` is neither a comment nor a literal;
 * treating the `//` there as a comment (which the pre-AST lexer did) erases the rest of the
 * line. Leaving it fails toward a false POSITIVE, which is the safe direction for a guard.
 *
 * WHY A REAL PARSER (EI-20064929206355679, measured 2026-08-10). This was a hand-rolled lexer
 * until then, and it carried TWO defects that no amount of care in the regexes downstream
 * could have compensated for:
 *
 *   1. NO REGEX-LITERAL HANDLING. The quote in an ordinary `/['"]/` opened a phantom string
 *      that ran to the end of the line, DELETING whatever followed it — including a real
 *      call site — and then consumed the newline, gluing the next line onto it. Telling a
 *      regex from division genuinely needs parsing; the old header said so and accepted it.
 *   2. BLOCK COMMENTS WERE DELETED, NEWLINES AND ALL, so every line after one SHIFTED UP.
 *      Any caller counting lines in the stripped text reported the wrong line, and an
 *      `^`-anchored /m regex could match across a boundary that does not exist in the source.
 *
 * Both are now structurally impossible: TypeScript's own parser supplies the literal, regex
 * and comment ranges, and every removal is BLANKED WITH SPACES rather than deleted, so the
 * output is the same LENGTH as the input, character for character. Offsets and line numbers
 * in the stripped text are therefore exact — `text.indexOf(x)` and `slice(0, i).split('\n')`
 * mean in the stripped text precisely what they mean in the source.
 *
 * @param {string} text
 * @param {string} [fileName]  the real path, used ONLY to pick a ScriptKind (.ts vs .tsx
 *        change how `<T>x` parses). Omit it and the kind is inferred by parsing both ways and
 *        keeping whichever the parser preferred — correct, but twice the work, so pass it.
 * @returns {string}
 */
export function stripCommentsAndStrings(text, fileName) {
  return blankRanges(text, collectRanges(text, fileName, { strings: true, regex: true }));
}

/**
 * Comments ONLY — string literals are left intact.
 *
 * ⚠ USE THIS ONLY when your downstream analysis has to READ STRING VALUES. Reach for
 * `stripCommentsAndStrings` by default; this one leaves you exposed to the phantom-offender
 * class documented above, and that exposure is a deliberate trade, not an oversight.
 *
 * THE CASE THAT FORCED THIS TO EXIST (EI-19991116787260658, measured 2026-08-09): a single guard can
 * need BOTH strippers at DIFFERENT call sites. `check-no-module-scope-flag-subscribe` detects the
 * CODE token `onFlagChange(` (wants strings stripped) but then hands the matched call's text to
 * `checkUnpopulatedDeclaration`, which reads the string VALUE out of
 * `kind: 'seeded-from-flag-default'` via /kind\s*:\s*['"]([a-z-]+)['"]/. Strip the strings there
 * and the value becomes `kind: ''`, the regex stops matching, and EVERY call site reports
 * "no `unpopulated.kind` declared" — a guard that fails loudly on correct code.
 *
 * So the A/B split is PER CALL SITE, not per guard. Ask what the regex downstream of the strip
 * actually reads: a KEY or a call token (code) -> stripCommentsAndStrings; a VALUE inside quotes
 * -> this function.
 *
 * ⚠ THIS IS QUOTE-AWARE AND LINE-PRESERVING, and both properties are load-bearing (WI-37605).
 * It was a two-regex pass until 2026-08-10 — `.replace(/\/\/[^\n]*\/g, '')` — which had exactly
 * the two defects the module header warns about, in the FALSE-NEGATIVE direction:
 *
 *   1. A `//` INSIDE A STRING started a "comment". `console.warn("see https://x/d", tag)` lost
 *      everything after `https:`, so a real violation later on that line was silently erased.
 *      A guard that reports clean on an offending line is the worst failure this class has.
 *   2. Block comments were DELETED rather than blanked, so `a/*c*\/b` became `ab` (tokens
 *      concatenated across the removal — the very thing stripCommentsAndStrings keeps its
 *      delimiters to prevent) and every line after a multi-line comment SHIFTED UP, making
 *      reported line numbers wrong for any caller that counts them.
 *
 * Comments are replaced with spaces (newlines preserved) rather than removed, so offsets and
 * line numbers stay true. String CONTENTS are still fully preserved — this function remains
 * string-blind BY DESIGN, which is what `guard-string-literal-blindness` uses it to control for.
 *
 * ⚠ IT WAS ALSO REGEX-BLIND until 2026-08-10 (EI-20064929206355679), and that defect ran in
 * the FALSE-POSITIVE direction — the one this module exists to eliminate. The quote in a
 * regex literal (`/'/`, `/['"]/`) opened a phantom string that never closed, so from that
 * point to the end of the file NO comment was blanked and every detection token quoted in a
 * doc comment read as a live call site. Measured, not hypothetical: it put a phantom
 * `role: 'cup'` — text from a doc comment in `check-ungated-mug-kettle.mjs` — into the
 * mug/kettle surface census. Comment ranges now come from TypeScript's parser, which knows a
 * regex from a division.
 *
 * @param {string} text
 * @param {string} [fileName]  the real path, used ONLY to pick a ScriptKind. See
 *        `stripCommentsAndStrings` — omitting it costs a second parse.
 * @returns {string}
 */
export function stripCommentsOnly(text, fileName) {
  return blankRanges(text, collectRanges(text, fileName, { strings: false, regex: false }));
}

/** .ts and .tsx disagree only on `<T>expr` vs JSX, but they disagree HARD — guessing wrong
 *  mis-blanks real code, which is the failure this module exists to prevent. */
function parseSource(text, fileName) {
  const byExt = !fileName
    ? null
    : fileName.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : fileName.endsWith('.ts') || fileName.endsWith('.mts') || fileName.endsWith('.cts')
        ? ts.ScriptKind.TS
        : fileName.endsWith('.jsx')
          ? ts.ScriptKind.JSX
          : ts.ScriptKind.JS;
  if (byExt !== null) {
    return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, byExt);
  }
  const asTs = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const asTsx = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return (asTsx.parseDiagnostics || []).length < (asTs.parseDiagnostics || []).length ? asTsx : asTs;
}

function collectRanges(text, fileName, { strings, regex }) {
  const sf = parseSource(text, fileName);
  const ranges = [];
  const seen = new Set();

  // BOTH trivia directions are required. ts.getLeadingCommentRanges only begins collecting
  // AFTER a newline, so a comment that starts on the SAME LINE as the previous token —
  // `{/* jsx */}`, `foo(/* inline */ x)`, `const a = 1; /* note */` — is not LEADING anything;
  // it is TRAILING trivia of the token before it. Leading-only leaves those comments standing
  // as live code: measured, it resurrected a `kettle` mention inside a JSX comment that even
  // the old lexer got right.
  const addComments = (crs) => {
    if (!crs) return;
    for (const r of crs) {
      const key = `${r.pos}:${r.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranges.push([r.pos, r.end]);
    }
  };

  const visit = (node) => {
    addComments(ts.getLeadingCommentRanges(text, node.pos));
    addComments(ts.getTrailingCommentRanges(text, node.end));
    const k = node.kind;
    const s = node.getStart(sf);
    const e = node.getEnd();
    if (strings) {
      if (k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
        ranges.push([s + 1, Math.max(s + 1, e - 1)]);
      } else if (k === ts.SyntaxKind.TemplateHead || k === ts.SyntaxKind.TemplateMiddle) {
        // `\`head${` and `}middle${` — two closing characters, not one.
        ranges.push([s + 1, Math.max(s + 1, e - 2)]);
      } else if (k === ts.SyntaxKind.TemplateTail) {
        ranges.push([s + 1, Math.max(s + 1, e - 1)]);
      }
    }
    if (regex && k === ts.SyntaxKind.RegularExpressionLiteral) {
      const lastSlash = text.lastIndexOf('/', e - 1); // before the flags
      if (lastSlash > s) ranges.push([s + 1, lastSlash]);
    }
    for (const child of node.getChildren(sf)) visit(child);
  };

  visit(sf);
  return ranges;
}

function blankRanges(text, ranges) {
  if (!ranges.length) return text;
  // split('') — UTF-16 CODE UNITS, which is what both String.length and TypeScript's node
  // offsets count. Array.from() splits by code POINT, so a single astral emoji (🚨, and this
  // repo is full of them) desynchronises every offset after it and silently mis-blanks code.
  const buf = text.split('');
  for (const [s, e] of ranges) {
    for (let i = Math.max(0, s); i < Math.min(e, buf.length); i += 1) {
      const ch = buf[i];
      if (ch !== '\n' && ch !== '\r') buf[i] = ' ';
    }
  }
  const out = buf.join('');
  /* c8 ignore next 4 -- a tripwire, not a branch under test: it can only fire on an offset
     desynchronisation, which would mean silently mis-blanked code. Loud is the point. */
  if (out.length !== text.length) {
    throw new Error(`strip-comments-and-strings: offset desync (${text.length} -> ${out.length})`);
  }
  return out;
}

/**
 * The shared RECURRENCE GUARD for the phantom-offender class.
 *
 * Feed a guard's own exported detector a source in which its detection token appears ONLY
 * inside a string literal. A correct detector reports nothing. A detector still running a
 * comments-only strip reports a phantom — the exact defect that red-pinned the fleet gate.
 *
 * This lives beside the stripper on purpose: the fix (import the stripper) and the proof
 * (run this) travel together, so a NEW guard cannot ship with the defect merely by not
 * knowing the history. Call it from the guard's own test suite.
 *
 * @param {(src: string) => unknown} detector  the guard's exported detector
 * @param {string} tokenInProse  a line containing the guard's token as PROSE, e.g.
 *        `a bare setInterval (P-008) is banned`
 * @returns {{ ok: boolean, flagged: boolean, detail: string }}
 */
export function probeStringLiteralBlindness(detector, tokenInProse) {
  const asSingleQuoted = `const msg = '${tokenInProse.replace(/'/g, "\\'")}';\n`;
  const asTemplate = `const HELP = \`\n${tokenInProse}\n\`;\n`;
  const asComment = `// ${tokenInProse}\n`;

  const results = [
    ['string literal', asSingleQuoted],
    ['template literal', asTemplate],
    ['comment', asComment],
  ].map(([label, src]) => {
    let out;
    try {
      out = detector(src);
    } catch (err) {
      return { label, flagged: false, threw: String(err && err.message) };
    }
    return { label, flagged: Array.isArray(out) ? out.length > 0 : Boolean(out) };
  });

  const bad = results.filter((r) => r.flagged);
  return {
    ok: bad.length === 0,
    flagged: bad.length > 0,
    detail: bad.length
      ? `detector reported a PHANTOM offender for a token appearing only in: ${bad
          .map((b) => b.label)
          .join(', ')} — it is text-matching without stripping string literals (see stripCommentsAndStrings)`
      : 'no phantom for token-in-prose (string, template, comment)',
  };
}
