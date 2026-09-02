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
 * inside SQL template literals BY DESIGN, and `check-migration-forward-compat`
 * has the same SQL-in-string shape. For those guards, stripping
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
  if (isSqlFile(fileName))
    return blankRanges(text, collectSqlRanges(text, { strings: true }));
  return blankRanges(
    text,
    collectRanges(text, fileName, { strings: true, regex: true }),
  );
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
  if (isSqlFile(fileName))
    return blankRanges(text, collectSqlRanges(text, { strings: false }));
  return blankRanges(
    text,
    collectRanges(text, fileName, { strings: false, regex: false }),
  );
}

/** Does this path name a SQL file? Extension gate for the dispatch above. */
function isSqlFile(fileName) {
  return typeof fileName === 'string' && /\.sql$/i.test(fileName);
}

/**
 * SQL (PostgreSQL) comment + string ranges — the SQL half of this module.
 *
 * WHY THIS EXISTS (EI-20073035509369492, measured 2026-08-10). Everything above is the
 * TypeScript parser, and `fileName` only ever picked a ScriptKind. Handed SQL, it returned the
 * input COMPLETELY UNMASKED — no throw, no warning. That is worse than lacking SQL support,
 * because the repo's standing advice is "migrate your guard to the shared stripper", and doing
 * that to a `.sql`-scanning guard left the hole open WHILE the guard-of-guards classifier
 * reclassified it as masked. A no-op indistinguishable from success, on the documented path.
 *
 * It also replaces five private implementations that disagreed with each other, none of which
 * was string-aware and only one of which preserved offsets:
 *   check-partial-index-alignment:222  blanks in place, but no block comments, no strings
 *   check-migration-forward-compat:122 collapses each comment to '\n' — LINE NUMBERS SHIFT
 *   lint-migrations:266                deletes outright — every offset after it is wrong
 *   check-workspace-default-sql:91     per-line, and treats any earlier `--` as a comment start
 *                                      even inside a string literal (silent false negatives)
 *
 * Three PostgreSQL specifics that a naive dash-dash-to-end-of-line regex cannot get right, all
 * common in this repo's migrations (and note: writing that regex literally in THIS comment
 * ends it early — its trailing slash closes the block. That is the same class of bug):
 *   1. DOLLAR-QUOTED STRINGS ($$…$$, $tag$…$tag$) — function bodies, which contain `--` and
 *      `/*` freely. A regex masks straight through them and mangles the body.
 *   2. NESTABLE BLOCK COMMENTS — unlike C, PostgreSQL nests, so the first `*​/` does not
 *      necessarily close the comment. Depth must be counted.
 *   3. DOUBLED-QUOTE ESCAPES — '' inside a string and "" inside an identifier continue the
 *      literal rather than ending it.
 *
 * Contract matches the TypeScript path exactly: ranges are BLANKED WITH SPACES by the shared
 * `blankRanges`, never deleted, so output length, offsets and line numbers are identical to the
 * input. String DELIMITERS are preserved when `strings` is set, so `isLiveCodeAt` works the same
 * way here as it does for TS.
 *
 * @param {string} text
 * @param {{ strings?: boolean, dollarBodies?: 'literal'|'code' }} [opts]
 *   `strings` also blanks string/identifier literal CONTENT.
 *   `dollarBodies` decides what a `$tag$…$tag$` body IS — see the note on `stripSqlCommentsAndStrings`.
 *   It defaults to the reading `strings` implies, so the two long-standing masks are unchanged.
 * @returns {Array<[number, number]>} half-open [start, end) ranges
 */
function collectSqlRanges(
  text,
  { strings = false, dollarBodies = strings ? 'literal' : 'code' } = {},
) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    // -- line comment, to end of line (the newline itself is left alone by blankRanges).
    if (ch === '-' && next === '-') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      ranges.push([i, end]);
      i = end;
      continue;
    }

    // /* block comment */ — NESTABLE in PostgreSQL, so count depth rather than stopping at
    // the first close.
    if (ch === '/' && next === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth += 1;
          i += 2;
          continue;
        }
        if (text[i] === '*' && text[i + 1] === '/') {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      ranges.push([start, i]);
      continue;
    }

    // $tag$ … $tag$ dollar-quoted string. The tag is [A-Za-z_][A-Za-z0-9_]* or empty ($$).
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const delim = m[0];
        const bodyStart = i + delim.length;
        const close = text.indexOf(delim, bodyStart);
        // Unterminated ⇒ treat the rest as body; a truncated file must not read as clean code.
        const bodyEnd = close === -1 ? n : close;
        const end = close === -1 ? n : close + delim.length;
        if (dollarBodies === 'literal') {
          // The literal reading: to `stripSqlCommentsAndStrings` a dollar-quoted body IS a string
          // literal, and its consumers (injection / transaction-control detection) want the whole
          // body opaque. Blank it entire and do not look inside.
          ranges.push([bodyStart, bodyEnd]);
        } else {
          // COMMENTS-ONLY must RECURSE, not skip. A dollar-quoted body is PL/pgSQL *code*, so a
          // `--` inside it is a real comment — and skipping the body wholesale leaves that comment
          // LIVE, which is how a guard reads prose as DDL. Measured on this repo 2026-08-10:
          // 264 of 661 migrations use dollar quoting and 109 of them carry a comment that survives
          // ONLY because it sits in a body (e.g. 000-baseline.sql's "-- Echo-loop guard:").
          // Recursion also handles nesting ($$ inside $function$) for free, and a `--` inside a
          // STRING within the body still correctly stays live, which a blanket skip cannot express.
          for (const [s, e] of collectSqlRanges(
            text.slice(bodyStart, bodyEnd),
            {
              strings,
              dollarBodies,
            },
          )) {
            ranges.push([bodyStart + s, bodyStart + e]);
          }
        }
        i = end;
        continue;
      }
    }

    // '…' string (with '' escape) and "…" quoted identifier (with "" escape). E'…' adds
    // backslash escapes; the leading E is ordinary code, so we only shift the opening quote.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const backslashEscapes =
        quote === "'" &&
        i > 0 &&
        /[eE]/.test(text[i - 1]) &&
        !/[A-Za-z0-9_]/.test(text[i - 2] ?? '');
      const bodyStart = i + 1;
      let j = bodyStart;
      while (j < n) {
        if (backslashEscapes && text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          if (text[j + 1] === quote) {
            j += 2;
            continue;
          } // doubled ⇒ escaped, keep going
          break;
        }
        j += 1;
      }
      if (strings) ranges.push([bodyStart, Math.min(j, n)]);
      i = Math.min(j + 1, n);
      continue;
    }

    i += 1;
  }
  return ranges;
}

/**
 * SQL comments blanked; string and dollar-quoted literals left INTACT.
 * The SQL counterpart of `stripCommentsOnly` — use it when the value you match on lives inside
 * a literal (a `DEFAULT 'default'`, a quoted identifier).
 * @param {string} text
 * @returns {string}
 */
export function stripSqlComments(text) {
  return blankRanges(text, collectSqlRanges(text, { strings: false }));
}

/**
 * SQL comments AND literal contents blanked — the SQL counterpart of
 * `stripCommentsAndStrings`, and the default choice unless you must read literal values.
 *
 * `dollarBodies` PICKS WHAT A `$tag$…$tag$` BODY IS, and there is no universally right answer —
 * which is exactly why it is a parameter rather than a fixed behaviour:
 *
 *   'literal' (DEFAULT) — the body is an opaque string literal; blank it entire. Correct when a
 *       hit inside a body would be a FALSE POSITIVE because the body is not top-level SQL:
 *       `findRawTxControl` (a `COMMIT` inside a PL/pgSQL body is not top-level transaction
 *       control) and `findUnguardedConstraintRename` (a rename inside a `DO` block is that
 *       lint's own documented FIX SHAPE, so flagging it would flag the fix).
 *
 *   'code' — the body is PL/pgSQL CODE; recurse into it, so comments and strings INSIDE the body
 *       are still blanked but its statements stay live. Correct when a hit inside a body is REAL
 *       and sealing it would be a FALSE NEGATIVE on a safety lint: `findUniqueIndexShapeSwap`
 *       (a DROP + re-ADD of a unique constraint inside a `DO` block really executes, and really
 *       breaks every `ON CONFLICT` written against the old shape).
 *
 * ⚠ "A hit inside a body is real, so use 'code'" is NOT sufficient — check whether the consumer
 * also EXEMPTS itself on something it finds. `findUnguardedReslug` detects a real in-body offence
 * AND disarms on a guard token found anywhere in the file, so 'code' widens its exemption faster
 * than its detection and makes it strictly blinder (measured: 2 offences found, 0 reported). It
 * stays on 'literal' for that reason. For any detect-then-exempt check, ask what the wider view
 * does to the EXEMPT branch, not just to the detect branch.
 *
 * Both readings are legitimate — PostgreSQL says a dollar-quoted body IS a string literal, while
 * every one of these consumers cares about whether the DDL inside it RUNS. Choosing per call site
 * is the whole point; a single shared answer silently mints false positives for one half of the
 * callers or false negatives for the other. Getting this wrong is not hypothetical: masking every
 * body was measured to drop migration 377's in-`DO` unique-constraint swap from
 * `findUniqueIndexShapeSwap` (6 firing files -> 5) with every test still green (WI-37800).
 *
 * @param {string} text
 * @param {{ dollarBodies?: 'literal'|'code' }} [opts]
 * @returns {string}
 */
export function stripSqlCommentsAndStrings(
  text,
  { dollarBodies = 'literal' } = {},
) {
  return blankRanges(
    text,
    collectSqlRanges(text, { strings: true, dollarBodies }),
  );
}

/**
 * Was the character at `index` LIVE CODE, or was it blanked out as string/comment content?
 *
 * THE CASE THIS EXISTS FOR — a pattern that SPANS code and string content, where NEITHER
 * stripper works and read-on-raw does not apply either. `check-no-retired-imports` matches
 * /(?:\bfrom\b|\bimport\b)\s*['"`][^'"`]*_retired\//: masking strings deletes the specifier it
 * needs, and masking only comments leaves a template literal quoting an import standing as a
 * phantom. `check-no-wire-compression` is the same shape one level worse — its rules disagree
 * with EACH OTHER: `createGzip(` is pure code (wants strings masked) while
 * `'content-encoding': 'gzip'` lives ENTIRELY inside string literals (masking deletes it).
 *
 * The resolution is to stop choosing a mask and use the mask as an ORACLE instead: exec the
 * pattern on the RAW text, then ask whether its ANCHOR — the first character of the match, which
 * for these patterns is always the code-shaped part (`from`, `import`, `new`, or the literal's
 * own opening quote) — is real program text. Blanked ⇒ the whole match was string or comment
 * content ⇒ phantom, skip it. Live ⇒ a real hit, and its specifier being a string is EXPECTED.
 *
 * Exact by construction: blanking only ever REPLACES a character with a space, so
 * `raw[i] !== masked[i]` holds if and only if that character was blanked. String DELIMITERS are
 * kept, so a quote reads as live code (it is program text) while its contents do not — which is
 * precisely why a rule anchored on the opening quote still fires on real code but not on the
 * same text nested inside a template literal, where the inner quote is itself blanked.
 *
 * @param {string} raw     the original source
 * @param {string} masked  the SAME source through stripCommentsAndStrings (length-preserving)
 * @param {number} index   an offset into either — they address identically
 * @returns {boolean}
 */
export function isLiveCodeAt(raw, masked, index) {
  return raw[index] === masked[index];
}

/**
 * The first match of `re` in `raw` whose anchor is LIVE CODE, or null.
 *
 * ⚠ IT MUST SCAN PAST PHANTOMS, NOT STOP AT THE LEFTMOST MATCH — that is the whole reason this
 * is a helper instead of one `re.exec` plus an `isLiveCodeAt` check at each call site. A single
 * exec returns the LEFTMOST match; if that one happens to sit inside a string while a REAL
 * occurrence follows it on the same line, testing only the leftmost rejects the line and the
 * real hit is silently lost. That is a false NEGATIVE created by a fix aimed at false positives
 * — the same trap already measured once here, where a real `vi.mock` call after a comment
 * quoting the same shape was double-counted (check-full-replacement-mocks, 2 → 1).
 *
 * ⚠ IT TESTS THE FIRST NON-WHITESPACE CHARACTER, NOT `m.index`. Blanking replaces a character
 * WITH A SPACE, so a blanked character and a real space are indistinguishable — and a pattern
 * that opens with `^\s*` (every line-anchored rule here) puts exactly that ambiguous character
 * at `m.index`. Testing it directly would report a match inside a template literal as live code
 * and let the phantom straight through, which is the precise defect this module exists to stop.
 *
 * `re` is cloned with the `g` flag when it lacks one, so a caller's shared module-scope regex is
 * never mutated and never carries `lastIndex` state between calls.
 *
 * @param {string} raw
 * @param {string} masked  `raw` through stripCommentsAndStrings (length-preserving)
 * @param {RegExp} re
 * @returns {RegExpExecArray | null}
 */
export function firstLiveMatch(raw, masked, re) {
  const scanner = re.flags.includes('g')
    ? new RegExp(re.source, re.flags)
    : new RegExp(re.source, `${re.flags}g`);
  scanner.lastIndex = 0;
  for (let m = scanner.exec(raw); m; m = scanner.exec(raw)) {
    const end = m.index + m[0].length;
    let anchor = -1;
    for (let i = m.index; i < end; i++) {
      if (!/\s/.test(raw[i])) {
        anchor = i;
        break;
      }
    }
    if (anchor !== -1 && isLiveCodeAt(raw, masked, anchor)) return m;
    if (m.index === scanner.lastIndex) scanner.lastIndex++; // zero-width match: do not spin
  }
  return null;
}

/** .ts and .tsx disagree only on `<T>expr` vs JSX, but they disagree HARD — guessing wrong
 *  mis-blanks real code, which is the failure this module exists to prevent. */
function parseSource(text, fileName) {
  const byExt = !fileName
    ? null
    : fileName.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : fileName.endsWith('.ts') ||
          fileName.endsWith('.mts') ||
          fileName.endsWith('.cts')
        ? ts.ScriptKind.TS
        : fileName.endsWith('.jsx')
          ? ts.ScriptKind.JSX
          : ts.ScriptKind.JS;
  // setParentNodes=false, and it is SAFE here: nothing in this module reads `node.parent`.
  // `collectRanges` only walks downward, and it passes `sf` EXPLICITLY to both
  // `node.getChildren(sf)` and `node.getStart(sf)` — that argument exists precisely so neither
  // has to reach the source file through parent pointers. Asking for parents made TypeScript
  // build and retain structure this module never reads: setNodeChildren 2.73s + getChildren
  // 1.08s + createChildren 0.47s in one census profile, plus the allocation behind its 7.34s
  // of GC.
  //
  // PROVEN, not reasoned: 16,622 files x both exported variants = 33,244 comparisons, 0
  // mismatches, measured 2026-08-31 (1.12x faster on the same corpus).
  //
  // ⚠ HOW TO RE-PROVE IT, because the OBVIOUS method gives a confident WRONG answer here.
  // Do NOT hash the whole corpus in one run, change the code, and hash it again: this is a
  // shared checkout that ~40 agents commit to continuously, and git-sync sweeps the tree. A
  // measured 12 commits touched 21 code files under packages/libs/apps/scripts during one
  // such A/B, so the two passes read DIFFERENT corpora and the run reported "diverged" for a
  // change that is byte-identical. That false verdict is what this comment originally
  // recorded as fact. Instead run BOTH implementations in ONE process over ONE snapshot —
  // read each file once, feed the identical string to old and new, compare directly.
  if (byExt !== null) {
    return ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      false,
      byExt,
    );
  }
  const asTs = ts.createSourceFile(
    'x.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const asTsx = ts.createSourceFile(
    'x.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return (asTsx.parseDiagnostics || []).length <
    (asTs.parseDiagnostics || []).length
    ? asTsx
    : asTs;
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
      if (
        k === ts.SyntaxKind.StringLiteral ||
        k === ts.SyntaxKind.NoSubstitutionTemplateLiteral
      ) {
        ranges.push([s + 1, Math.max(s + 1, e - 1)]);
      } else if (
        k === ts.SyntaxKind.TemplateHead ||
        k === ts.SyntaxKind.TemplateMiddle
      ) {
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
    // ⛔ getChildren(sf), NOT ts.forEachChild — and this is DELIBERATE, MEASURED, and REVERTED
    // ONCE. getChildren materialises a synthetic node for every punctuation and keyword token,
    // which is the most expensive thing this module does: over one 18,184-file / 423.8 MB
    // snapshot, parse alone is 36.52s while parse + this walk is 119.00s. forEachChild does the
    // same traversal in 48.66s — a 59.1% saving that is REAL and NOT AVAILABLE, because token
    // nodes are exactly what makes the comment scan above complete.
    //
    // Every LITERAL here is a real node, so forEachChild keeps all of those. COMMENTS are not:
    // a comment is trivia, and trivia adjacent only to a token — an empty `catch { }` whose sole
    // content is a comment, anything before the end-of-file token — belongs to no node
    // forEachChild visits. Attempted 2026-08-31 with a whole-file ts.createScanner pass to
    // supply the missing comments; the corpus oracle rejected it at 3,972 mismatches / 36,174
    // (lengths preserved, so it read as harmless): every one was a comment left UNMASKED.
    //
    // WHY THE SCANNER CANNOT BE THE FIX, and why the obvious guard against it does not work:
    // scan() has no parser feedback, so it needs reScanSlashToken / reScanTemplateToken /
    // reScanJsxToken to resolve `/`, `}` and JSX text. Without them it gives up mid-file — and
    // when it does, it moves its own position to the END, so getTokenEnd() === text.length for
    // ALL 18,087 files INCLUDING ones it demonstrably skipped (RealLogsPanel.tsx: 622 tokens,
    // last real token at offset 3240 of 7790). A completeness check on the scanner's own
    // reported position therefore returns true precisely when it is lying.
    //
    // So: do not "optimise" this line without a token enumeration that is complete BY
    // CONSTRUCTION, and do not accept one on reasoning — run the corpus oracle.
    for (const child of node.getChildren(sf)) visit(child);
  };

  visit(sf);
  return ranges;
}

function blankRanges(text, ranges) {
  if (!ranges.length) return text;
  // Blank by SLICING rather than exploding the source into a character array. The previous
  // `text.split('')` allocated one single-character string per code unit — the 247 MB of repo
  // source this module is asked to mask became ~247 million strings per full scan. Measured
  // on the mug-kettle census (2026-08-31): 3.10s of self time here plus 7.34s of GC, against
  // 0.35s for all eight detectors it exists to serve.
  //
  // Both properties of the old loop are preserved, which is why output is byte-identical:
  //   - code units, not code points. slice() and a non-`u` regex both index UTF-16 code
  //     units, which is what String.length and TypeScript's node offsets count. Array.from()
  //     or a `/u` flag would split by code POINT and desynchronise every offset after an
  //     astral emoji (🚨, and this repo is full of them), silently mis-blanking code.
  //   - newlines survive: `[^\n\r]` blanks exactly what `ch !== '\n' && ch !== '\r'` blanked,
  //     so length, offsets and every reported line number are unchanged.
  //
  // Ranges arrive UNSORTED and may OVERLAP (a comment range inside a masked string range),
  // which the old mutable buffer absorbed for free. Sorting and merging first reproduces that
  // exactly; slicing overlapping ranges without merging would duplicate or drop text.
  const clamped = [];
  for (const [s, e] of ranges) {
    const lo = Math.max(0, s);
    const hi = Math.min(e, text.length);
    if (hi > lo) clamped.push([lo, hi]);
  }
  if (!clamped.length) return text;
  clamped.sort((a, b) => a[0] - b[0]);

  const parts = [];
  let cursor = 0;
  let [curS, curE] = clamped[0];
  for (let i = 1; i <= clamped.length; i += 1) {
    const next = clamped[i];
    if (next && next[0] <= curE) {
      if (next[1] > curE) curE = next[1];
      continue;
    }
    if (curS > cursor) parts.push(text.slice(cursor, curS));
    parts.push(text.slice(curS, curE).replace(/[^\n\r]/g, ' '));
    cursor = curE;
    if (next) [curS, curE] = next;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  const out = parts.join('');
  /* c8 ignore next 4 -- a tripwire, not a branch under test: it can only fire on an offset
     desynchronisation, which would mean silently mis-blanked code. Loud is the point. */
  if (out.length !== text.length) {
    throw new Error(
      `strip-comments-and-strings: offset desync (${text.length} -> ${out.length})`,
    );
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
    return {
      label,
      flagged: Array.isArray(out) ? out.length > 0 : Boolean(out),
    };
  });

  const bad = results.filter((r) => r.flagged);
  return {
    ok: bad.length === 0,
    flagged: bad.length > 0,
    detail: bad.length
      ? `detector reported a PHANTOM offender for a token appearing only in: ${bad
          .map((b) => b.label)
          .join(
            ', ',
          )} — it is text-matching without stripping string literals (see stripCommentsAndStrings)`
      : 'no phantom for token-in-prose (string, template, comment)',
  };
}

/**
 * Strip a trailing `#` comment from ONE SHELL line, respecting quotes.
 *
 * The shell arm of this module. `#` opens a comment only at the START OF A WORD, so it is
 * comment-initiating at position 0 or after whitespace or one of `;`, `&`, `|`, `(` — and is
 * ordinary data anywhere else. That distinction is the whole point: `grep -q '#define'` must
 * not be truncated into a different pipeline, and neither must a `#` in `sed 's/#//'`.
 *
 * ⚠ THIS RETURNS A TRUNCATED LINE, unlike every other export here, which BLANKS its ranges to
 * keep offsets and line numbers true. That is deliberate and is why it is a separate function
 * rather than a `ScriptKind` on the others: its callers split the surviving text into pipeline
 * stages and never map a match back to a column, so truncation is the honest shape for them.
 * If you ever need shell offsets preserved, add a blanking variant — do not "fix" this one.
 *
 * WHY IT LIVES HERE. Until 2026-09-02 the shell arm was a private copy inside
 * `check-assert-integrity.mjs`, and the BASELINE in `guard-string-literal-blindness` listed it
 * under "Entries that are NOT JS/TS and so cannot use the shared module". That reason expired
 * the moment a SECOND copy appeared (`check-pipefail-sigpipe.mjs`, landed the same day with a
 * NARROWER `/\s/` predecessor class that missed `;`, `&`, `|` and `(`) — which is the exact
 * copy-paste-then-drift the module exists to prevent, and is how "SQL cannot use the shared
 * module" had already died on 2026-08-10. Both callers now delegate here, and the shared
 * implementation keeps the WIDER, correct class.
 *
 * @param {string} line  a single shell line
 * @returns {string}     the line up to its first live `#`, or the line unchanged
 */
export function stripShellTrailingComment(line) {
  let sq = false;
  let dq = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && dq) {
      i++;
      continue;
    }
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (c === '#' && !sq && !dq && (i === 0 || /[\s;&|(]/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}
