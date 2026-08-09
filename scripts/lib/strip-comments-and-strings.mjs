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
 * KNOWN LIMIT, stated rather than papered over: a regex literal containing a quote or a slash
 * (`/'/`) can still confuse this, since telling a regex from division needs real parsing. That
 * is the same class of approximation the call-scanners already document ("without a real AST
 * parse"), and it fails toward the pre-existing behaviour.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }

    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    if (c === '"' || c === "'") {
      out += c;
      i += 1;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        i += text[i] === '\\' ? 2 : 1;
      }
      out += c;
      i += 1;
      continue;
    }

    if (c === '`') {
      out += '`';
      i += 1;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '$' && text[i + 1] === '{') {
          out += '${';
          i += 2;
          let depth = 1;
          const exprStart = i;
          while (i < n && depth > 0) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') depth -= 1;
            if (depth === 0) break;
            i += 1;
          }
          out += text.slice(exprStart, i);
          out += '}';
          i += 1;
          continue;
        }
        i += 1;
      }
      out += '`';
      i += 1;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
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
 * @param {string} text
 * @returns {string}
 */
export function stripCommentsOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
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
