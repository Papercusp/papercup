/**
 * guard-string-literal-blindness.test.ts — the recurrence guard for the PHANTOM-OFFENDER class.
 *
 * THE DEFECT THIS EXISTS TO PREVENT (EI-19989853369726696 -> EI-19991116787260658):
 * a lint guard strips COMMENTS and then text-matches a call-shaped token, leaving STRING
 * LITERALS intact. A guard's error message quotes the very token the guard detects, so guards
 * are exactly the code most likely to contain their own detection tokens inside strings — and
 * `apps/operator/lib/release/green-checkpoint.ts` quoting another guard's failure text
 * ('... bypassed managedSetInterval (P-008) ...') minted a phantom offender that RED-PINNED the
 * fleet gate on a file that does not even import the symbol. Agents then triaged a call site
 * that did not exist, which reads as a triage failure rather than a guard defect.
 *
 * The root cause was never one guard: `stripComments` was COPY-PASTED into 16 scripts. This
 * suite ratchets that population down and proves the migrated ones are actually fixed.
 *
 * ⚠ NOT every guard may strip strings. Some detect tokens that legitimately live INSIDE string
 * or template literals — `check-drop-database-force` matches `DROP DATABASE`, which in TS source
 * appears ONLY inside a SQL template literal, so stripping strings there would convert a phantom
 * POSITIVE into a silent false NEGATIVE on dropping a database. The split is per CALL SITE, not
 * per guard: see `stripCommentsOnly`'s doc for the case where one guard needs both.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- .mjs guard script, no type declarations
import { usesEagerExecFilePromisify } from '../../../scripts/check-no-eager-execfile-promisify.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { usesModuleScopeFlagSubscribe } from '../../../scripts/check-no-module-scope-flag-subscribe.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { isRawAgentSpawnBypass } from '../../../scripts/check-no-raw-agent-spawn.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { usesRawSetInterval } from '../../../scripts/check-no-raw-setinterval.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { findOffendersInText } from '../../../scripts/check-no-retired-imports.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { findSelfReferentialExports } from '../../../scripts/check-no-self-referential-export.mjs';
// No @ts-expect-error: enrolled in tsconfig.declarations.json, so this import is genuinely typed
// and a directive here would be TS2578 "unused".
import { isUnenrolledDetachedSpawn } from '../../../scripts/check-no-unenrolled-detached-spawn.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { scanSource } from '../../../scripts/check-no-wire-compression.mjs';
// Enrolled in tsconfig.declarations.json — typed, no directive (see above).
import { countReexportChains } from '../../../scripts/check-typeless-reexport-trap.mjs';
import {
  firstLiveMatch,
  probeStringLiteralBlindness,
  stripCommentsAndStrings,
  stripCommentsOnly,
  // No @ts-expect-error here any more: the module is registered in tsconfig.declarations.json
  // (WI-37605) and now has a generated sibling .d.mts, so this import is genuinely typed. The
  // directive that used to sit here became TS2578 "unused" the moment that landed.
} from '../../../scripts/lib/strip-comments-and-strings.mjs';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

describe('stripCommentsAndStrings', () => {
  it('empties string contents while KEEPING delimiters, so nothing concatenates across the removal', () => {
    // Blanked with spaces rather than deleted: the output is the same LENGTH as the input, so
    // offsets and line numbers in the stripped text still address the source (EI-20064929206355679).
    const src = `const a = 'setInterval(';\nconst b = 2;`;
    const out = stripCommentsAndStrings(src, 'a.ts');
    expect(out).toBe(`const a = '            ';\nconst b = 2;`);
    expect(out).toHaveLength(src.length);
    expect(out).not.toContain('setInterval(');
  });

  it('does not let `//` inside a string start a comment (the mutual-escaping case)', () => {
    // A chained strip-comments-then-strip-strings pass gets this wrong and eats the rest of the line.
    const out = stripCommentsAndStrings(`const u = 'http://x'; const kept = 1;`);
    expect(out).toContain('const kept = 1;');
  });

  it("does not let a quote inside a comment open an unterminated literal (`// don't`)", () => {
    const out = stripCommentsAndStrings(`// don't\nconst kept = 'v';\n`);
    expect(out).toContain('const kept =');
  });

  it('PRESERVES ${...} template expressions as CODE — dropping them would trade a false positive for a false negative', () => {
    expect(stripCommentsAndStrings('const s = `a ${setInterval(fn)} b`;')).toContain('setInterval(fn)');
  });
});

// Each of these pairs a DECLINE with a FIRE in the SAME fixture. A stripper that returns nothing
// useful would satisfy every "does not contain" assertion on its own, so "it didn't flag" is only
// evidence when the same input proves it still CAN flag. (EI-20064929206355679: the pre-AST lexer
// carried all four defects below; each was measured against the real tree before being fixed.)
describe('the lexer defects an AST parse removes', () => {
  const detects = (src: string, name = 'a.ts') => /\bsetInterval\s*\(/.test(stripCommentsAndStrings(src, name));

  it('a regex literal containing a quote does not erase the code after it', () => {
    // OLD: the `'` in /['"]/ opened a phantom string that ran to the newline, DELETING the rest
    // of the line — a real call site on that line vanished, and the newline was eaten too.
    const src = `const RE = /['"]/; setInterval(fn, 1000);\n`;
    expect(detects(src)).toBe(true); // FIRES on the real offender...
    expect(detects(`const RE = /['"]/; const msg = 'setInterval(';\n`)).toBe(false); // ...and declines on the quoted one
  });

  it('keeps line numbers true across a block comment (they used to shift UP)', () => {
    // OLD: block comments were deleted NEWLINES AND ALL, so every later line moved up and any
    // caller counting lines in the stripped text reported the wrong one.
    const src = ['/* one', '   two', '   three */', 'setInterval(fn);', ''].join('\n');
    const out = stripCommentsAndStrings(src, 'a.ts');
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
    expect(out.split('\n').findIndex((l) => l.includes('setInterval('))).toBe(3);
  });

  it('does not concatenate code across a removed block comment', () => {
    // The module keeps string delimiters precisely so nothing new is concatenated across a
    // removal — but OLD deleted block comments OUTRIGHT, so `*/const run = ...` collapsed onto
    // the line above and an ^-anchored module-scope detector fired on a declaration that is
    // not at line start. Blanking preserves the column, so it correctly declines.
    const glued = '/* c\n*/const run = promisify(execFile);\n';
    const anchored = /^(export\s+)?(const|let)\s+\w+\s*=\s*promisify\(\s*execFile\w*\s*\)/m;
    expect(anchored.test(stripCommentsAndStrings(glued, 'a.ts'))).toBe(false);
    // ...and a genuine column-0 declaration below a block comment still FIRES.
    expect(anchored.test(stripCommentsAndStrings('/* c\n*/\nconst run = promisify(execFile);\n', 'a.ts'))).toBe(true);
  });

  it('blanks a regex BODY, where a guard is most likely to quote its own token', () => {
    expect(detects('const RE = /setInterval(fn)/;\n')).toBe(false);
    expect(detects('const RE = /setInterval(fn)/;\nsetInterval(fn);\n')).toBe(true);
  });

  it('survives astral emoji before a literal (UTF-16 code units, not code points)', () => {
    // Splitting by code POINT desynchronises every offset after an emoji and mis-blanks real code.
    const src = `const icon = '🚨';\nsetInterval(fn);\n`;
    const out = stripCommentsAndStrings(src, 'a.ts');
    expect(out).toHaveLength(src.length);
    expect(out).toContain('setInterval(fn);');
  });
});

describe('stripCommentsOnly is regex-aware too (the phantom that reached the census)', () => {
  it('still blanks a comment that FOLLOWS a regex containing a quote', () => {
    // OLD: the quote opened a phantom string that never closed, so from there to EOF no comment
    // was blanked. Measured: it put a `role: 'cup'` read out of a doc comment into the
    // mug/kettle surface census.
    const src = `const RE = /'/;\nconst live = 'kept';\n// role: 'cup'\n`;
    const out = stripCommentsOnly(src, 'a.ts');
    expect(out).not.toContain("role: 'cup'"); // the comment is gone...
    expect(out).toContain("const live = 'kept'"); // ...and string VALUES are still readable
  });

  // NOT a defect of the pre-AST lexer (it got this right). This guards the AST implementation:
  // a comment starting on the same line as the previous token is TRAILING trivia, and a
  // leading-trivia-only scan silently leaves it standing as live code. That intermediate
  // resurrected a `kettle` mention inside a JSX comment during this very fix.
  it('blanks a JSX {/* ... */} comment — trailing trivia, which leading-only trivia scanning misses', () => {
    const src = 'const A = () => (<div>{/* role: kettle */}<b/></div>);\n';
    const out = stripCommentsOnly(src, 'a.tsx');
    expect(out).not.toContain('role: kettle');
    expect(out).toContain('<b/>');
  });

  it('leaves JSX TEXT alone — `//` in a URL is content, not a comment', () => {
    const src = 'const A = () => (<p>see https://x/y and role: kettle</p>);\n';
    expect(stripCommentsOnly(src, 'a.tsx')).toContain('role: kettle');
  });
});

describe('firstLiveMatch — the mask used as an ORACLE, for patterns that span code and string', () => {
  const live = (raw: string, re: RegExp) => firstLiveMatch(raw, stripCommentsAndStrings(raw, 'a.ts'), re);
  const IMPORT_RE = /(?:\bfrom\b|\bimport\b)\s*\(?\s*['"`][^'"`]*_retired\//;

  it('keeps a real import, whose SPECIFIER is legitimately a string literal', () => {
    expect(live(`import x from '_retired/y';\n`, IMPORT_RE)).not.toBeNull();
  });

  it('rejects the same text quoted inside a template literal', () => {
    expect(live('const doc = `\nimport x from \'_retired/y\';\n`;\n', IMPORT_RE)).toBeNull();
  });

  // THE REASON THIS IS A HELPER AND NOT AN INLINE `isLiveCodeAt` CHECK. A single exec returns the
  // LEFTMOST match; testing only that one rejects the whole line when a phantom happens to precede
  // a real hit, turning a false-positive fix into a silent false NEGATIVE.
  it('scans PAST a phantom to a real match later on the same line', () => {
    const raw = `const doc = 'import x from "_retired/y"'; import z from '_retired/y';\n`;
    expect(live(raw, IMPORT_RE)).not.toBeNull();
  });

  // A pattern opening with `^\s*` puts a SPACE at m.index, and a blanked character is also a
  // space — so anchoring on m.index reports a masked match as live and lets the phantom through.
  it('anchors on the first NON-WHITESPACE character, not on m.index', () => {
    const re = /^\s*export\s+\*\s+from\s+['"][^'"]+['"]/m;
    expect(live(`export * from './x';\n`, re)).not.toBeNull();
    expect(live('const doc = `\n  export * from \'./x\';\n`;\n', re)).toBeNull();
  });

  it('does not mutate the caller\'s regex or leak lastIndex between calls', () => {
    const shared = /\bgzip\b/g;
    const raw = 'gzip(); gzip();\n';
    const masked = stripCommentsAndStrings(raw, 'a.ts');
    expect(firstLiveMatch(raw, masked, shared)).not.toBeNull();
    expect(shared.lastIndex).toBe(0);
    expect(firstLiveMatch(raw, masked, shared)).not.toBeNull();
  });
});

describe('the probe itself is falsifiable (control + calibration)', () => {
  // CONTROL: the exact pre-fix implementation. If the probe cannot catch THIS, it cannot catch
  // anything, and every "ok" below would be vacuous.
  const brokenDetector = (src: string) => /\bsetInterval\s*\(/.test(stripCommentsOnly(src));
  // CALIBRATION: the same detector over the shared stripper. Proves the probe is not simply
  // flagging everything handed to it.
  const fixedDetector = (src: string) => /\bsetInterval\s*\(/.test(stripCommentsAndStrings(src));
  const TOKEN = 'a bare setInterval (P-008) is banned';

  it('CATCHES a comments-only detector (the defect that red-pinned the gate)', () => {
    const verdict = probeStringLiteralBlindness(brokenDetector, TOKEN);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('PHANTOM');
  });

  it('PASSES a detector that strips strings too', () => {
    expect(probeStringLiteralBlindness(fixedDetector, TOKEN).ok).toBe(true);
  });
});

describe('migrated guards do not mint phantom offenders from tokens quoted in prose', () => {
  const cases: Array<[string, (src: string) => unknown, string]> = [
    ['check-no-raw-setinterval', usesRawSetInterval, 'a bare setInterval (P-008) is banned'],
    ['check-no-raw-agent-spawn', isRawAgentSpawnBypass, 'never call buildInvokeOnce (use the ledger)'],
    [
      'check-no-eager-execfile-promisify',
      usesEagerExecFilePromisify,
      'const run = promisify(execFile) at module scope is banned',
    ],
    [
      'check-no-module-scope-flag-subscribe',
      usesModuleScopeFlagSubscribe,
      'onFlagChange (cb) at module scope is banned',
    ],
    // Added WI-37717. These five were "INCONCLUSIVE" under the previous probe — a mirror corpus
    // that planted the token in a /tmp tree and watched whether the guard fired. That probe could
    // never distinguish "read the file and correctly ignored it" from "never enumerated the file
    // at all", so a guard that mints phantoms and a guard that is clean produced the SAME result.
    // Handing the detector the prose form DIRECTLY removes that ambiguity: it cannot fail to read
    // an argument. All five were confirmed phantom-minting and then fixed.
    ['check-no-self-referential-export', (src: string) => findSelfReferentialExports('a.ts', src), 'export const foo = foo;'],
    ['check-typeless-reexport-trap', (src: string) => countReexportChains(src, 'a.ts'), `export * from '@x/trap';`],
    ['check-no-retired-imports', (src: string) => findOffendersInText('a.ts', src), `fetch('/plugins/orchestrator/spawn')`],
    [
      'check-no-unenrolled-detached-spawn',
      (src: string) => isUnenrolledDetachedSpawn('packages/x/a.ts', src),
      'spawn(cmd, args, { detached: true })',
    ],
    ['check-no-wire-compression', (src: string) => scanSource(src, 'a.ts'), 'createGzip() on the wire is banned'],
  ];

  for (const [name, detector, token] of cases) {
    it(`${name}: its own detection token, quoted in prose, is not a call site`, () => {
      // POSITIVE CONTROL FIRST — and it is not ceremony. A detector that never fires AT ALL
      // passes the phantom probe perfectly, so without this line a broken or mis-tokened entry
      // reads as the strongest possible pass. That is not hypothetical: while classifying these
      // guards, `check-explicit-presence` returned a clean verdict and the only reason it was not
      // recorded as clean is that this control showed its token never fired as bare code either.
      // A suspiciously tidy sweep of green is the tell — assert the teeth before the restraint.
      const bare = detector(`${token}\n`);
      expect(
        Array.isArray(bare) ? bare.length > 0 : Boolean(bare),
        `${name}: VACUOUS CASE — the token does not fire as bare code, so "no phantom" says ` +
          `nothing about string-literal blindness. Fix the token, do not delete the assertion.`,
      ).toBe(true);

      const verdict = probeStringLiteralBlindness(detector, token);
      expect(verdict.ok, `${name}: ${verdict.detail}`).toBe(true);
    });
  }
});

/**
 * Classification of one guard script, from its own source with ITS comments masked.
 *
 * Masking first is not a nicety: v1 of this census keyed on `.ts` appearing anywhere in the
 * script and counted 44 unmasked guards, because nearly every guard's header comment NAMES
 * the `.ts` files it scans. The classifier had the exact defect it was built to measure.
 * Masked, the honest number is 31. (EI-20045405992394901.)
 */
const SHARED_STRIPPER = /strip-comments-and-strings\.mjs/;
/**
 * Any comment stripper, ANY spelling and ANY binding form — `stripSqlComments`,
 * `const stripComments = …`, `maskCommentsAndStrings`, `blankStringLiterals`.
 *
 * ⚠ THE VERB SET IS LOAD-BEARING, and the old `strip`-only rule proves why: this comment
 * already CLAIMED "ANY spelling" while matching only /strip[A-Za-z]*Comments?/, and
 * `check-no-unthreaded-apply.mjs` sat in the corpus the whole time calling its private lexer
 * `maskCommentsAndStrings`. One name-specific regex gave TWO wrong answers about that file:
 * it read as masking NOTHING, so it landed in SCANS_UNMASKED_SOURCE (false — it did mask)
 * while escaping this shrink-only baseline (false — it was a copy-paste of the exact defect,
 * regex-blind included). A guard-of-guards that classifies by NAME cannot see a synonym, and
 * "any spelling" in a comment is not a rule. Widened 2026-08-10 (WI-37717).
 */
const STRIPPER_NAME = String.raw`(?:strip|mask|blank|scrub|elide|redact)[A-Za-z]*(?:Comments?|Strings?|Literals?|Bodies)`;
/**
 * A stripper DEFINITION, not a mention — and the distinction is the whole point (WI-37801).
 *
 * Matching any MENTION cannot work here, because the import statement of a migrated file
 * (`import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs'`) mentions a
 * stripper name itself. That collision is why the classifier used to return on the FIRST
 * match with `shared` ranked ahead of `hand-rolled`: it was the only way to stop every
 * migrated file from re-reporting as a hand-roller. But ordering traded one wrong answer for
 * another — it made a PARTIALLY migrated file permanently invisible, so the first migrated
 * call site in a file switched off enforcement for every hand-rolled stripper still in it.
 *
 * Anchoring on the definition forms dissolves the conflict instead of ranking it: a bare
 * import has no definition and still classifies `shared`, while a file that imports the
 * shared module AND defines its own stripper is correctly `hand-rolled`.
 */
const NAMED_STRIPPER_DEF = new RegExp(
  String.raw`\b(?:export\s+)?(?:async\s+)?function\s*\*?\s*${STRIPPER_NAME}\s*\(` +
    String.raw`|\b(?:const|let|var)\s+${STRIPPER_NAME}\s*=` +
    String.raw`|^[ \t]*(?:static\s+)?(?:async\s+)?${STRIPPER_NAME}\s*\([^)\n]*\)\s*\{`,
  'm',
);
/** The two copy-pasted regexes themselves, matched as literal text — they are the defect. */
const NAIVE_BLOCK_RE = String.raw`\/\*[\s\S]*?\*\/`;
const NAIVE_LINE_RE = String.raw`\/\/.*$`;
const PARSES_AST = /from\s*['"]typescript['"]|ts\.createSourceFile|@babel\/parser|\bacorn\b|ts-morph/;
const SCANS_CODE_FILES = /\.tsx?['"`]|\.mjs['"`]|\.jsx['"`]|\.cts['"`]|\.mts['"`]/;
const TEXT_MATCHES = /\.test\s*\(|\.match(All)?\s*\(|\.includes\s*\(|\.exec\s*\(/;
const READS_FILES = /readFileSync|execFileSync\s*\(\s*['"](rg|grep)['"]/;

/**
 * A call to one of the shared module's OWN exports. WI-37801 follow-up: a definition whose
 * body DELEGATES to the shared stripper is a thin alias, not a hand-roll — and counting it
 * as one punishes exactly the migration this guard exists to drive.
 *
 * Found the expensive way, an hour after the definition rule landed: `lint-migrations.mjs`
 * retired its private `stripSqlBodies` in favour of
 *   const maskSealingBodies = (sqlText) => stripSqlCommentsAndStrings(sqlText);
 * and the name-shaped rule scored that FULLY-MIGRATED file as hand-rolled, because
 * `maskSealingBodies` is `mask` + `Sealing` + `Bodies` in `const X =` form. The author had
 * done the right thing and the guard called it debt.
 */
const SHARED_EXPORT_CALL =
  /\b(?:stripCommentsAndStrings|stripCommentsOnly|stripSqlComments|stripSqlCommentsAndStrings|stripShellTrailingComment)\s*\(/;

/**
 * Does this source DEFINE its own stripper, as opposed to importing or aliasing the shared one?
 *
 * Checks EVERY definition site, not just the first: a file may hold a delegating alias AND a
 * real hand-roll, and stopping at the first match would let whichever came first decide — the
 * same first-match-wins mistake at one level down.
 *
 * Delegation is judged on the definition's OWN line, which is deliberately conservative: it
 * clears the one-line arrow alias above and nothing else. A multi-line wrapper that merely
 * forwards still reads as hand-rolled — a false positive that costs one BASELINE line, versus
 * a body-scanning rule that would exempt a real hand-roll for mentioning the shared module
 * somewhere inside it. That is the direction this guard must err in.
 */
function definesPrivateStripper(maskedSource: string): boolean {
  for (const m of maskedSource.matchAll(new RegExp(NAMED_STRIPPER_DEF.source, 'gm'))) {
    const nl = maskedSource.indexOf('\n', m.index);
    const line = maskedSource.slice(m.index, nl === -1 ? undefined : nl);
    if (SHARED_EXPORT_CALL.test(line)) continue;
    return true;
  }
  return false;
}

type Masking = 'shared' | 'hand-rolled' | 'ast' | 'unmasked';

function classifyMasking(maskedSource: string): Masking {
  // HAND-ROLLED IS TESTED FIRST, AHEAD OF THE SHARED IMPORT (WI-37801). The old order asked
  // "does this file import the shared module?" and returned on the first yes, which made the
  // classification per-FILE. Consolidation proceeds per CALL SITE, so the first migrated site
  // in a file silenced the guard for every stripper still living beside it — partial migration
  // was not merely unenforced, it was rewarded with a permanent exemption. Worse, that reached
  // the BASELINE below: an entry could be removed for a file that still hand-rolls, so the
  // shrink-only list shrank while the debt stayed. Both files it hid (lint-migrations.mjs,
  // check-migration-forward-compat.mjs) had in fact already been de-listed that way.
  //
  // Ordering is safe now only because the predicate anchors on DEFINITIONS: a migrated file
  // whose sole stripper reference is its own import has no definition site and still falls
  // through to `shared`. See NAMED_STRIPPER_DEF.
  if (
    definesPrivateStripper(maskedSource) ||
    maskedSource.includes(NAIVE_BLOCK_RE) ||
    maskedSource.includes(NAIVE_LINE_RE)
  ) {
    return 'hand-rolled';
  }
  if (SHARED_STRIPPER.test(maskedSource)) return 'shared';
  if (PARSES_AST.test(maskedSource)) return 'ast';
  return 'unmasked';
}

function maskedSourceOf(file: string): string {
  return stripCommentsOnly(readFileSync(join(SCRIPTS_DIR, file), 'utf8'), file);
}

const ALL_SCRIPTS = () => readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs')).sort();
const GUARD_SCRIPTS = () => readdirSync(SCRIPTS_DIR).filter((f) => /^(check|lint)-.*\.mjs$/.test(f)).sort();

describe('the copy-pasted stripComments population is SHRINK-ONLY', () => {
  /**
   * Scripts that still hand-roll a comment stripper instead of importing the shared one.
   *
   * This list may SHRINK, never GROW. Removing an entry = migrating that guard (verify first
   * whether its token is legitimately string-resident — see the header note). Adding one means
   * a new copy-paste of the exact defect that froze the fleet gate; import the shared module
   * from `scripts/lib/strip-comments-and-strings.mjs` instead.
   *
   * Entries that are NOT JS/TS and so cannot use the shared module:
   *   check-unenrolled-mjs-imports.mjs  — strips `//` out of JSONC before JSON.parse
   *
   * ⚠ "shell `#` comments cannot use the shared module" WAS listed here for
   * check-assert-integrity.mjs and is now FALSE, for the same reason the SQL claim below died:
   * the module grew a shell arm (`stripShellTrailingComment`) on 2026-09-02 and that entry was
   * migrated onto it and REMOVED from this list. The trigger was a SECOND copy appearing —
   * check-pipefail-sigpipe.mjs landed 2026-09-02T19:15Z carrying the same loop with a NARROWER
   * `/\s/` predecessor class that missed a `#` after `;`, `&`, `|` or `(`. That is the whole
   * thesis of this guard observed live: the copy-paste drifted within a day, in the
   * false-negative direction, and only the shrink-only rule caught it. Both callers now
   * delegate, and the shared implementation keeps the wider class. "Shell cannot use the
   * shared module" must never be reintroduced as a reason for adding an entry.
   *
   * ⚠ "SQL cannot use the shared module" WAS listed here as a reason and is now FALSE: the
   * module grew a SQL path (stripSqlComments / stripSqlCommentsAndStrings, dispatched by
   * isSqlFile) on 2026-08-10, so `--`, nestable block comments, $tag$ bodies and quoted
   * identifiers are all covered. ALL THREE SQL entries — check-partial-index-alignment.mjs,
   * check-migration-forward-compat.mjs and lint-migrations.mjs — were migrated onto it and
   * REMOVED from this list that day (EI-20073035509369492). "SQL cannot use the shared module"
   * must never be reintroduced as a reason for adding an entry.
   *
   * ⚠ TWO of those three came BACK the same day (WI-37801), and the distinction matters when
   * you read them: only check-partial-index-alignment.mjs was fully migrated. The other two
   * migrated ONE call site while keeping a private stripper, and the classifier's
   * first-match-wins ordering made that invisible — so they were de-listed on a verdict the
   * measurement could not actually support. They are listed again on the DEFINITION-anchored
   * measurement. So a SQL-shaped entry here is not a relapse to the retired reason above; it
   * means that file still DEFINES its own stripper. Check which before acting on it.
   *
   * `check-timer-classification.mjs` is on this list holding a CORRECT private copy (it is the
   * donor the shared module was lifted from). It should collapse into the import, but was left
   * alone deliberately: it was the live subject of an in-flight gate incident when this landed.
   */
  const BASELINE = new Set([
    // check-assert-integrity.mjs was REMOVED here on 2026-09-02: its private stripShellComments
    // is now a one-line alias delegating to stripShellTrailingComment. See the shell note above.
    'check-declared-consumed.mjs',
    'check-drop-database-force.mjs',
    'check-lint-guard-reachability.mjs',
    // ⚠ RE-ADDED 2026-08-10 (WI-37801), having been REMOVED here earlier the SAME DAY
    // (EI-20073035509369492). The removal was made in good faith — that guard's own call site
    // genuinely migrated onto stripSqlComments — but the file still DEFINES a private
    // `stripComments(sql)` (:142), and the classifier could not see it: `shared` was returned on
    // the FIRST match, so importing the shared module anywhere exempted the whole file. Nothing
    // failed when the entry was dropped, and that silence IS the harm this list exists to
    // prevent: the shrink-only population shrank while the debt stayed exactly where it was.
    // It measured straight back in once classification anchored on DEFINITIONS rather than
    // mentions. Removing it again requires removing the private stripper, not another import.
    // The original migration note, still true of the migrated call site: its private pair
    // (`/* */` then `--[^\n]*`) was not quote-aware, so a `--` inside a STRING LITERAL erased the
    // rest of the line — swallowing any real DDL that followed it and reporting the migration
    // CLEAN. That is a false NEGATIVE on the one guard whose whole job is catching destructive
    // DDL before it ships. Comments only, NOT the strings variant: the RULES match DDL keywords,
    // and sealing $tag$ bodies would hide real DDL inside a DO block. Both directions are pinned
    // by falsifying controls in that guard's own selfTest().
    'check-migration-forward-compat.mjs',
    'check-no-proc-path-fixture.mjs',
    'check-no-raw-block-edge.mjs',
    'check-no-raw-install-slug-filter.mjs',
    'check-no-retired-style.mjs',
    // check-partial-index-alignment.mjs was REMOVED here on 2026-08-10 (EI-20073035509369492):
    // it now imports stripSqlComments. Its private copy handled `--` only, so a `--` inside a
    // quoted identifier was blanked as a comment — and blanking LIVE CODE can erase the very
    // presence guard the lint looks for, reporting an aligned query as a violation.
    // Comments only, strings intact: the key it matches on (`->> 'reviewBy'`) IS a string
    // literal, so the strings variant would take the detector silently 100% inert.
    'check-timer-classification.mjs',
    'check-unbounded-inbox-read.mjs',
    'check-unenrolled-mjs-imports.mjs',
    'check-workspace-deps-complete.mjs',
    // lint-migrations.mjs was REMOVED here on 2026-08-10 (EI-20073035509369492):
    // findLiteralTenantDefault now uses stripSqlComments. Its private pair DELETED comments
    // rather than blanking them, and was not quote-aware — so a `--` inside a string literal
    // erased the rest of the line, hiding any literal tenant default that followed it.
    // Comments only, NOT the strings variant: its main quarry is the ALTERs inside a
    // `DO $$ … $$` loop, which the strings variant would seal away entirely.
    // lint-migrations.mjs: RE-ADDED and then REMOVED AGAIN, both on 2026-08-10, and the round
    // trip is worth keeping because each step was correct on the evidence available at the time.
    // WI-37801 re-added it once classification anchored on DEFINITIONS, because the file then
    // genuinely still hand-rolled `stripSqlBodies`; that entry's note said it comes off "when
    // WI-37800 retires that stripper, not before". WI-37800 then retired it the same day,
    // replacing it with a one-line alias that DELEGATES to the shared module:
    //     const maskSealingBodies = (sqlText) => stripSqlCommentsAndStrings(sqlText);
    // which is the fully-migrated state this list exists to reward. So it is off the list.
    // ⚠ That alias also exposed a false positive in the definition rule itself — `maskSealingBodies`
    // is `mask`+`Sealing`+`Bodies` in `const X =` form, so a name-shaped rule scored a migrated
    // file as debt. Fixed by SHARED_EXPORT_CALL / definesPrivateStripper above; do not re-add
    // this entry on the strength of a stripper-shaped NAME alone — check whether the definition
    // delegates.
  ]);

  const measurePopulation = (): string[] =>
    ALL_SCRIPTS().filter((f) => classifyMasking(maskedSourceOf(f)) === 'hand-rolled');

  it('no NEW script hand-rolls its own comment stripper', () => {
    const added = measurePopulation().filter((f) => !BASELINE.has(f));
    expect(
      added,
      `These scripts hand-roll a comment stripper instead of importing scripts/lib/strip-comments-and-strings.mjs. ` +
        `That copy-paste IS the root cause of the phantom-offender class (EI-19991116787260658).`,
    ).toEqual([]);
  });

  it('the baseline does not carry entries that are already migrated (it must stay honest)', () => {
    // A stale baseline entry silently buys back budget for a future copy-paste.
    const stale = [...BASELINE].filter((f) => !measurePopulation().includes(f));
    expect(stale, 'Already-migrated scripts still listed in BASELINE — remove them.').toEqual([]);
  });

  it('the guards migrated to the shared stripper have NOT regressed to a private copy', () => {
    const migrated = [
      'check-no-eager-execfile-promisify.mjs',
      'check-no-module-scope-flag-subscribe.mjs',
      'check-no-raw-agent-spawn.mjs',
      'check-no-raw-setinterval.mjs',
      // EI-20045405992394901 — both were invisible to the name+form-specific predecessor rule.
      'lint-affected-gate.mjs',
      'check-derived-signal-firings.mjs',
    ];
    const regressed = migrated.filter((f) => measurePopulation().includes(f));
    expect(regressed, 'These were migrated to the shared stripper and must not re-declare one.').toEqual([]);
  });
});

/**
 * WI-10002074 — THE POPULATION WAS ITSELF THE BLIND SPOT.
 *
 * Everything above ratchets `scripts/*.mjs` and nothing else, because `ALL_SCRIPTS()` is a
 * `readdirSync(SCRIPTS_DIR)`. But nothing about the phantom-offender class is specific to a
 * `.mjs` under `scripts/` — `classifyMasking` never looks at a path, only at source text. A
 * tree-scanning guard written as a VITEST FILE carries the identical defect and was
 * structurally outside the detector that owns its class.
 *
 * That is not hypothetical, and the sizes are the argument (measured 2026-09-20):
 *   scripts/*.mjs      255 files ->  13 hand-rolled   <- the watched population
 *   tracked *.test.ts 7896 files ->  30 hand-rolled   <- the blind spot, ~2.3x larger
 * The trigger (EI-23769743489199449) was exactly one of these: a source-scanning guard in
 * `pg-read-query.test.ts` whose control fixture self-matched. It was fixed by hand because
 * no ratchet could see it.
 *
 * ⚠⚠ THE MASK IS PER CALL SITE, AND GETTING IT WRONG SILENTLY EMPTIES THE POPULATION.
 * The first cut of this block masked with `stripCommentsAndStrings` throughout and measured
 * ZERO offenders — which read as "nothing to ratchet, ship it". It was a TAUTOLOGICAL zero:
 * `SCANS_CODE_FILES` detects a guard by a QUOTED extension (`'.ts'`), and the strings variant
 * empties string CONTENTS, so that predicate can never match under it. The detector would have
 * been 100% inert while looking green. Hence two views of every file, each matched by what it
 * is actually able to see:
 *   - comments-only  -> the SCANNER predicates, whose quarry legitimately lives in a string.
 *   - +strings       -> `definesPrivateStripper`, whose quarry is a code-form definition and
 *                       NEVER a string literal.
 * The strings view is also what cures the self-match: THIS FILE quotes hand-rolled strippers
 * as deliberately-wrong control fixtures (see the probe controls below), and under a
 * comments-only mask it flags ITSELF — the very class it exists to detect, one level up.
 *
 * The naive-regex `includes()` arms of `classifyMasking` are deliberately NOT reused here.
 * They are sound only for a `.mjs` guard, where containing `\/\*[\s\S]*?\*\/` as text MEANS
 * hand-rolling it; across test files they were measured to mint 24 false positives on files
 * holding that regex as fixture data. Definition-anchored only, per WI-37801's reasoning.
 */
describe('tree-scanning guards written as .test.ts are IN the ratchet (WI-10002074)', () => {
  const REPO_ROOT = join(SCRIPTS_DIR, '..');

  /** Cheap superset gate: masking only ever REMOVES text, so a file with no stripper-ish token
   *  in its raw source cannot define one after masking. Skips ~99% of 7.9k files (4.8s -> ~1s). */
  const MIGHT_DEFINE_STRIPPER = /strip|mask|blank|scrub|elide|redact/;

  const trackedTests = (): string[] =>
    execFileSync('git', ['ls-files', '*.test.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);

  const isTreeScanningGuard = (commentsOnlyView: string): boolean =>
    SCANS_CODE_FILES.test(commentsOnlyView) &&
    TEXT_MATCHES.test(commentsOnlyView) &&
    READS_FILES.test(commentsOnlyView);

  const measureTestPopulation = (): string[] => {
    const found: string[] = [];
    for (const rel of trackedTests()) {
      let raw: string;
      try {
        raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // tracked but absent (mid-sweep deletion) is not this guard's business
      }
      if (!MIGHT_DEFINE_STRIPPER.test(raw)) continue;
      if (!isTreeScanningGuard(stripCommentsOnly(raw, rel))) continue;
      if (!definesPrivateStripper(stripCommentsAndStrings(raw, rel))) continue;
      found.push(rel);
    }
    return found.sort();
  };

  /**
   * SHRINK-ONLY, exactly like the scripts/ baseline above. These 30 are pre-existing debt
   * measured at adoption; the ratchet exists to stop the 31st, not to force a 30-file
   * migration in one change. Remove an entry when its file imports the shared stripper.
   */
  const TEST_BASELINE = new Set([
    'apps/operator-vite/src/__tests__/no-server-leak-in-client-graph.test.ts',
    'apps/operator-vite/src/lib/operator-core-client-boundary.test.ts',
    'apps/operator/app/_lints/design-primitives.test.ts',
    'apps/operator/app/_lints/popper-stacking.test.ts',
    'apps/operator/lib/chat-actions/ctx-wiring.test.ts',
    'packages/operator-core/lib/__tests__/affected-tests-passing-verdict-cache.test.ts',
    'packages/operator-core/lib/__tests__/not-checked-non-gating-mirror.test.ts',
    'packages/operator-core/lib/agent-tools/capability/base-dir.test.ts',
    'packages/operator-core/lib/agent-tools/coordination/dispatch-intervention-reachable.test.ts',
    'packages/operator-core/lib/agent-tools/tool-tree-root.test.ts',
    'packages/operator-core/lib/agent-tools/work_items/swallowed-work-item-read-guard.test.ts',
    'packages/operator-core/lib/chat-protocol-nodenext-export-extensions.test.ts',
    // holder-context.test.ts:452 `export function stripComments(src: string)` — the clearest
    // instance in the corpus, and an EXPORTED one, so its blindness is reachable by importers.
    'packages/operator-core/lib/coord/holder-context.test.ts',
    'packages/operator-core/lib/deployment/account-pool-write-path.test.ts',
    'packages/operator-core/lib/desktop-acl-command-sync.test.ts',
    'packages/operator-core/lib/doc-claims/identity-recovery-door.test.ts',
    'packages/operator-core/lib/doc-claims/system-closer-identity-registration.test.ts',
    'packages/operator-core/lib/execute-action-dispatch-contract.test.ts',
    'packages/operator-core/lib/goal-launch-resolver-coverage.test.ts',
    'packages/operator-core/lib/harness/improvements/recursion-safety-invariants.test.ts',
    'packages/operator-core/lib/inference-gateway/egress-pool-resolution.test.ts',
    'packages/operator-core/lib/pg-stat-activity-role-visibility-guard.test.ts',
    'packages/operator-core/lib/release/green-stall-watchdog-presence-columns.test.ts',
    'packages/operator-core/lib/search/search-engine-mock-completeness.test.ts',
    'packages/operator-core/lib/sync-interest-single-contract.test.ts',
    'packages/operator-core/lib/sync-resolver/no-embedding-in-list-projection.test.ts',
    'packages/operator-core/lib/sync-resolver/workspace-filter-coverage.test.ts',
    'packages/operator-core/lib/sync/hyperbee/projections/__tests__/lww-guard-registry-lint.test.ts',
    'packages/operator-core/lib/work-item-born-claimable.test.ts',
    'packages/operator-core/lib/workspace-reg-current-guard.test.ts',
  ]);

  it('no NEW .test.ts tree-scanning guard hand-rolls its own comment stripper', () => {
    const added = measureTestPopulation().filter((f) => !TEST_BASELINE.has(f));
    expect(
      added,
      'These tree-scanning guards hand-roll a comment stripper instead of importing ' +
        'scripts/lib/strip-comments-and-strings.mjs. Being a .test.ts rather than a scripts/*.mjs ' +
        'does not change the defect (EI-23769743489199449) — it only used to hide it.',
    ).toEqual([]);
  });

  it('the baseline does not carry entries that are already migrated (it must stay honest)', () => {
    const population = measureTestPopulation();
    const stale = [...TEST_BASELINE].filter((f) => !population.includes(f));
    expect(stale, 'Already-migrated test guards still listed in TEST_BASELINE — remove them.').toEqual([]);
  });

  // ---- falsifiability: controls that must keep answering both ways (never tree mutation) ----

  it('CATCHES a hand-rolled stripper in a .test.ts-shaped guard (positive control)', () => {
    const offender = [
      "const files = ['a.ts', 'b.ts'];",
      'const src = readFileSync(files[0], "utf8");',
      'function stripComments(s) { return s.replace(/x/g, ""); }',
      'if (src.includes("token")) throw new Error("boom");',
    ].join('\n');
    expect(isTreeScanningGuard(stripCommentsOnly(offender, 'control.test.ts'))).toBe(true);
    expect(definesPrivateStripper(stripCommentsAndStrings(offender, 'control.test.ts'))).toBe(true);
  });

  it('PASSES a guard that imports the shared stripper instead (negative control)', () => {
    const migrated = [
      "import { stripCommentsAndStrings } from '../scripts/lib/strip-comments-and-strings.mjs';",
      "const files = ['a.ts'];",
      'const src = stripCommentsAndStrings(readFileSync(files[0], "utf8"), files[0]);',
      'if (src.includes("token")) throw new Error("boom");',
    ].join('\n');
    expect(definesPrivateStripper(stripCommentsAndStrings(migrated, 'ok.test.ts'))).toBe(false);
  });

  /**
   * THE SELF-MATCH THAT THE STRINGS VIEW EXISTS TO CURE. This file quotes hand-rolled
   * strippers as fixtures; under a comments-only view it reports ITSELF as an offender.
   * Both directions are asserted so a future "simplification" back to one mask fails here
   * rather than silently re-minting a phantom offender against the guard-of-guards.
   */
  it('does NOT flag a stripper that appears only inside a STRING (the phantom this class is about)', () => {
    const quotedOnly = [
      "const files = ['a.ts'];",
      'const src = readFileSync(files[0], "utf8");',
      'const BAD_FIXTURE = "const stripComments = (s) => s.replace(/x/g, \'\')";',
      'if (src.includes(BAD_FIXTURE)) throw new Error("boom");',
    ].join('\n');
    // comments-only view still sees the quoted fixture: this is the false positive.
    expect(definesPrivateStripper(stripCommentsOnly(quotedOnly, 'phantom.test.ts'))).toBe(true);
    // +strings view does not: this is the cure, and why the split is load-bearing.
    expect(definesPrivateStripper(stripCommentsAndStrings(quotedOnly, 'phantom.test.ts'))).toBe(false);
  });

  it('this very file is NOT in its own population (the guard-of-guards must not self-match)', () => {
    expect(measureTestPopulation()).not.toContain(
      'packages/operator-core/lib/guard-string-literal-blindness.test.ts',
    );
  });
});

/**
 * EI-20045405992394901 — the population this suite could not see.
 *
 * Every rule above asks HOW a guard strips. A guard that strips NOTHING declares no stripper,
 * matches no rule, and is perfectly invisible — while being MORE exposed than the hand-rollers,
 * not less. `scripts/mug-kettle-surface-census.mjs` scanned raw source at all 9 detector sites,
 * reported a JSX comment as a new ungated entry point, and red-pinned the fleet gate on a
 * comment — fully compliant with this file the whole time.
 *
 * So this registry anchors on the PROPERTY (does it scan source it never masked?), not the
 * SPELLING. The control block below fails against the old name-specific rule on purpose: a
 * widening with no control is silently narrowed back the first time someone tidies it.
 */
describe('guards that scan UNMASKED source are visible, and the population is SHRINK-ONLY', () => {
  /**
   * check-/lint- guards that read JS/TS source and text-match against it without masking
   * comments or strings first. May SHRINK, never GROW.
   *
   * Being on this list is not automatically a bug — a guard whose token cannot appear in prose
   * is safe, and some (check-no-nul-in-source, check-no-control-bytes, check-smart-quotes) are
   * BYTE-level checks where masking would defeat the purpose. It is a declaration that the
   * exposure was considered. To remove an entry: import the shared module, or move to an AST
   * parse. To add one: don't — mask the source instead.
   */
  const SCANS_UNMASKED_SOURCE = new Set([
    // This guard intentionally scans comments (its subject is pending-action attribution),
    // so masking its own source would hide the prose it must inspect.
    'check-no-agent-intent-comments.mjs',
    // check-bundled-cli-entry-guards.mjs delegates the source-token scan to findGuards(),
    // whose shared implementation masks comments and strings before matching. The cheap
    // census cannot follow that imported helper, so keep this justified exposure here rather
    // than forcing a redundant second mask into the wrapper.
    'check-bundled-cli-entry-guards.mjs',
    'check-constant-conditional.mjs',
    // check-declared-deps-extracted.mjs reads package.json/package-lock.json and package-local
    // manifests, then imports runtime entrypoints in child processes. It never reads JS/TS
    // source to text-match code tokens; the census prefilter is fooled by its documented .mjs
    // paths plus generic readFileSync/.test usage, so masking would add no protection.
    'check-declared-deps-extracted.mjs',
    // check-insight-normative.mjs scans agent-insight DOCS (`isInsightDoc` selects .md/.mdx
    // frontmatter) — never JS/TS source. The census prefilter trips only on its
    // `./lib/tracked-files.mjs` import specifier (added 2026-09-04) plus a generic
    // readFileSync/.test pair; a JS comment stripper applied to Markdown would corrupt the
    // frontmatter it validates, so the exposure is recorded here instead.
    'check-insight-normative.mjs',
    // check-format.mjs is a RANGE PARSER, not a source-token guard. Its only regex
    // parses @@ hunk metadata from `git diff`; the source file itself is read solely
    // to translate those line ranges into character offsets for Prettier. Masking
    // comments or strings would change those offsets and format the wrong bytes.
    // The filename/classifier shape is nevertheless guard-like, so record the
    // exposure here instead of weakening the property-based census.
    'check-format.mjs',
    // check-env-feature-gates.mjs was REMOVED here on 2026-08-10 (WI-37717). BOTH passes now
    // detect over stripCommentsOnly() text (the `git grep` is a fast FILE FINDER, not the
    // detector). Two latent harms, both measured reachable: (1) a comment naming an
    // UNCLASSIFIED gate is reported as real, and `--strict` is CI-wired, so that is a red gate
    // for code that does not exist; (2) worse, `seen.add` runs BEFORE the classification test
    // and `seen` drives the stale-registry check, so a capability gate DELETED from code but
    // still described in a comment is never reported stale — its registry entry lingers
    // forever, defeating the anti-linger purpose the guard exists for (EI-2390).
    // Two live instances of the shape (both absorbed by ALLOW, hence currently invisible):
    // PAPERCUSP_SPAWNER_SIDECAR and PAPERCUSP_LOOP_PROFILER — the latter in a comment that
    // explains the env gate BECAME a flag, i.e. it is gone.
    // ⚠ comments ONLY: the operative token IS a string literal (`=== '1'`), so
    // stripCommentsAndStrings would take both passes silently 100% inert.
    // check-explicit-presence.mjs was REMOVED here on 2026-08-10 (WI-37717) because it now
    // imports stripCommentsOnly, which this file's classifier ranks as `shared`. Read that as
    // a PARTIAL mask, not a full one: it deliberately still text-matches against unmasked
    // STRINGS, because its corpus includes generated runner source living inside template
    // literals (admin-test-suites.ts) that carries the real incident shape. Measured over
    // 3,934 files: masking comments moved the corpus verdict by nothing (62 -> 62) while
    // ALSO masking strings dropped 8 rows, every one real code and not one a phantom. So it
    // cannot pass probeStringLiteralBlindness and is correctly absent from the cases table
    // above — "migrate it to the full stripper" is a REGRESSION, and its own header says so.
    'check-generic-first.mjs',
    // check-github-identity-terms.mjs STAYS (audited 2026-08-10, WI-37717) — and this entry is
    // the "exposure considered" kind, not the "needs a stripper" kind. Its corpus is `.md`/`.mdx`
    // under the docs root ONLY: there is no code file in it, so comment/string masking is not
    // merely unnecessary but UNDEFINED — the prose IS the detection target, and the shared
    // stripper is a TS/SQL parser with no markdown path. Importing it here would be a no-op at
    // best and would blank a URL tail at worst. There is nothing to migrate.
    // The phantom class IS real here, in its prose-specific form: the guard quotes the banned
    // phrasing in its own header, so a doc that must SAY the wrong phrase to correct it trips it.
    // Measured: all 3 near-miss lines in the corpus sit in spec/distribution.mdx — the single
    // hard-coded exclusion — so the ONLY doc explaining the identity split survived purely by
    // being named in the lint's source. A second such doc had no recourse but a code change.
    // Fixed the right way for a prose guard: an in-place `github-identity-justified: <reason>`
    // marker (same convention as `sql-snippet-justified:`), bare-marker-rejected, 3-line
    // lookback, pinned by __tests__/check-github-identity-terms.test.ts. Prose can now justify
    // itself without editing code — which is the actual defect a stripper could never have fixed.
    'check-github-identity-terms.mjs',
    // check-host-bundle-builds.mjs does not scan JS/TS source for code tokens. It invokes the
    // host bundler and compares the generated systemd runner byte-for-byte with its source;
    // `readFileSync` is used for equality, and `.test` only filters child-process diagnostics.
    // The property-based prefilter therefore sees a guard-shaped exposure, but masking would
    // not affect any analyzed text. Keep the exposure declared rather than adding a no-op import.
    'check-host-bundle-builds.mjs',
    // check-js-syntax.mjs does not text-match code tokens against source at all. Its offenders
    // come from `node --check` EXIT CODES and an eslint scope graph — two real parsers — so no
    // comment, string literal or prose can mint a phantom offender here. The property prefilter
    // is fooled by three incidental shapes, each measured 2026-08-30 against its own masked
    // source: SCANS_CODE_FILES matches `.mjs'` inside the `f.endsWith('.mjs')` SCOPE FILTER;
    // TEXT_MATCHES matches `f.includes('/_retired/')`, which tests a FILE PATH, and the
    // `text.match(...)` pair, which parses node's STDERR for `<path>:<line>` and `SyntaxError:`;
    // READS_FILES matches the `readFileSync` that hands source to eslint's PARSER.
    // It became visible here only when the load leg (EI-21892432987434951) introduced that read —
    // before it the guard shelled out to `node --check` alone and matched no predicate. Masking
    // would change nothing it analyses, so this is the "exposure considered" kind, not the
    // "needs a stripper" kind. A no-op stripper import would score it `shared` while masking
    // nothing, which is exactly the laundering this list exists to make visible. (WI-1309267)
    'check-js-syntax.mjs',
    // check-migration-fixture-drift.mjs was REMOVED here on 2026-08-10 (WI-37717). It scans
    // TWO surfaces and both are now masked: migration .sql text via stripSqlComments (inside
    // extractIntroducedColumns — the input is definitionally SQL, so no extension dispatch is
    // needed) and .ts fixture text via stripCommentsOnly(text, relPath). Unmasked it was wrong
    // in BOTH directions, measured on the real corpus: 5 phantom columns off a commented-out
    // ALTER TABLE (563-memory-federation-capture-triggers.sql), and — the costlier one — 7 of
    // 14 real columns dropped on 299-scheduled-plans-schedule-fields.sql, because a statement
    // ends at the first `;` and prose in an interior comment supplied one early.
    // ⚠ comments ONLY, never stripCommentsAndStrings: these fixtures hold their CREATE TABLE
    // inside a template literal, so blanking strings takes the guard silently 100% inert.
    'check-no-box-identity.mjs',
    'check-no-cdn-egress.mjs',
    'check-no-control-bytes.mjs',
    'check-no-identity-literals.mjs',
    'check-no-nul-in-source.mjs',
    // check-no-restart-imports.mjs was REMOVED here on 2026-08-10 (WI-37717): it now imports
    // stripCommentsOnly, which this file's classifier ranks as `shared`. Same PARTIAL-mask
    // shape as check-explicit-presence above — it deliberately still matches unmasked STRINGS,
    // because its stated miss-class is "bare config strings" (package.json deps, tsconfig path
    // maps, transpilePackages arrays), which ARE string literals. Masking strings would blind
    // it to its PRIMARY target, so it cannot pass probeStringLiteralBlindness and is correctly
    // absent from the cases table. Its own --self-test pins that: the four STRING positive
    // controls fail loudly if anyone swaps in the full stripper.
    'check-okf-conformance.mjs',
    // check-scope-defaults.mjs was REMOVED here on 2026-08-10 (WI-37717). It always DID mask
    // comments, but with a hand-rolled per-line heuristic this classifier cannot see — the
    // documented mis-ranking shape (see the note above this set). It now imports
    // stripCommentsOnly, so it ranks `shared`. Strings stay unmasked deliberately: the scanned
    // expression `?? 'default'` IS a string literal, so a string-masking stripper would blind
    // it entirely. The heuristic it replaced was also WRONG in the false-negative direction —
    // it treated any earlier `//` as a comment start without checking for strings, so
    // `const u = 'https://x.com'; const ws = scope ?? 'default';` reported nothing.
    'check-shell-syntax.mjs',
    'check-smart-quotes.mjs',
    // check-sql-guidance-justified.mjs was REMOVED here on 2026-08-10 (WI-37717). Detection now
    // runs over stripCommentsOnly() for .ts; prose surfaces (.md/.mdx) are deliberately NOT
    // masked, because there the agent-facing text IS the corpus and a TS parser would blank
    // whatever follows a `//` in a URL. Same PARTIAL-mask shape as its siblings above — the
    // token it reads IS a string literal (`description: '…'`, the guidance object's values), so
    // stripCommentsAndStrings would take it silently 100% inert.
    // Unmasked it walked COMMENT text as code in `guidanceRegions()` and was wrong in BOTH
    // directions, each measured on the real corpus (986 agent-tool files):
    //   - an apostrophe in a comment inside the object ("a peer's", "they haven't") opens a fake
    //     string the walker never closes, so depth never returns to 0 and the region runs to EOF:
    //     work_items/claim_next.ts's region covered the whole 22KB file, which would report that
    //     tool's OWN implementation SQL as agent-facing guidance — precisely what the guard's
    //     header promises it does not flag. mode/set.ts over-ran by 5.5KB the same way;
    //   - the mirror image: a comment BETWEEN `description:` and its literal makes the walker see
    //     `/` instead of a quote and skip the region entirely (3 live today — the prompt-weight
    //     annotations agents add sit exactly there), and a brace in a comment closed
    //     dev/pipeline_position.ts's region 9KB early. Guidance past that point was never linted.
    // Both were LATENT, not live: none of the 3 affected files currently holds covered-table SQL,
    // and the tree verdict is unchanged at 3 (all .mdx). Reachable, though — claim_next.ts is a
    // work_items tool whose most likely future edit is exactly the SQL its runaway region covers.
    // ⚠ The MARKER window still reads RAW text: a justification is normally written AS a comment
    // (`// sql-snippet-justified: …`), so masking it would blank every justification in the repo
    // and turn the guard into a false-positive machine. `--self-test` case 4 pins that.
    'check-systemd-startlimit-placement.mjs',
    // ⚠ KNOWN FALSE POSITIVE, not debt — remove this entry when EI-20077125623815751 lands.
    // This guard never reads JS/TS source: it reads `package.json` and regex-tests
    // `JSON.stringify(declared)`. Its ONLY quoted-extension evidence is its own IMPORT
    // SPECIFIER (`from './lib/tracked-files.mjs'`), which SCANS_CODE_FILES cannot tell apart
    // from a scan target — the both-directions blindness EI-20077125623815751 tracks.
    // ⛔ DO NOT "fix" that by blanking module specifiers before SCANS_CODE_FILES. Measured
    // 2026-09-20: it drops the population 93 -> 75, silently de-guarding 18 files whose only
    // quoted extension is likewise an import — among them check-no-nul-in-source.mjs,
    // check-shell-syntax.mjs and check-constant-conditional.mjs, which genuinely DO scan
    // source. That trades one false positive for 18 false NEGATIVES, the direction this
    // suite must never err in. The real fix needs evidence of the file list actually being
    // iterated, not a quoted-extension proxy.
    'check-tracked-src-entry-dist.mjs',
    'check-vacuous-negative-assertions.mjs',
    // check-workspace-default-sql.mjs was REMOVED here on 2026-08-10 (WI-37717 /
    // EI-20073035509369492). Same PARTIAL-mask shape as its siblings above: it now imports
    // stripCommentsOnly and passes the real path, so masking DISPATCHES per file — this guard
    // scans both `.sql` migrations and `.ts` runtime DDL. Strings stay unmasked because the
    // matched token IS a string literal (`DEFAULT 'default'`).
    // It was the last of the three hand-rolled string-blind comment tests: any earlier `--` or
    // `//` counted as a comment start even inside a literal, so
    //   INSERT INTO t VALUES ('a--b'), (workspace_id ... DEFAULT 'default')
    // reported NOTHING. The SQL path it needed did not exist until this WI added it — the
    // shared stripper was a TypeScript parser that returned SQL completely unmasked.
    'lint-tsc-workspaces.mjs',
  ]);

  const measureUnmasked = (): string[] =>
    GUARD_SCRIPTS().filter((f) => {
      const masked = maskedSourceOf(f);
      if (!(SCANS_CODE_FILES.test(masked) && TEXT_MATCHES.test(masked) && READS_FILES.test(masked))) return false;
      return classifyMasking(masked) === 'unmasked';
    });

  it('no NEW guard text-matches code tokens against source it never masked', () => {
    const added = measureUnmasked().filter((f) => !SCANS_UNMASKED_SOURCE.has(f));
    expect(
      added,
      `These guards scan JS/TS source and text-match against it WITHOUT masking comments or strings. ` +
        `A guard's error message quotes the very token it detects, so prose that discusses the rule ` +
        `mints phantom offenders and reds the gate on a comment (EI-20045405992394901). Import ` +
        `stripCommentsOnly / stripCommentsAndStrings from scripts/lib/strip-comments-and-strings.mjs.`,
    ).toEqual([]);
  });

  it('the unmasked baseline does not carry entries that already mask (it must stay honest)', () => {
    const stale = [...SCANS_UNMASKED_SOURCE].filter((f) => !measureUnmasked().includes(f));
    expect(stale, 'These guards now mask their source — remove them from SCANS_UNMASKED_SOURCE.').toEqual([]);
  });

  // CONTROL. The rule this replaced was `/^(export\s+)?function\s+stripComments/m` — it keyed on
  // one SPELLING in one BINDING FORM. Each fixture below is a real shape found in scripts/ that
  // the old rule scored as clean. If someone narrows the classifier back, these fail.
  describe('CONTROL: the widened rule catches what the name-specific rule missed', () => {
    const OLD_RULE = /^(export\s+)?function\s+stripComments/m;
    const cases: Array<[string, string, Masking]> = [
      [
        'a stripper bound with const, not declared as a function (was in lint-affected-gate.mjs)',
        `const stripComments = (src) => src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');`,
        'hand-rolled',
      ],
      [
        'the naive regexes inlined with no named function at all (was in check-derived-signal-firings.mjs)',
        `const body = m[1].replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').split('\\n');`,
        'hand-rolled',
      ],
      [
        'a stripper for another language, so another name (check-partial-index-alignment.mjs)',
        `const stripSqlComments = (s) => s.replace(/--[^\\n]*/g, ' ');`,
        'hand-rolled',
      ],
      [
        'a guard that strips NOTHING — invisible to every HOW-shaped rule',
        `const src = readFileSync(f, 'utf8'); if (src.includes('setInterval(')) fail(f);`,
        'unmasked',
      ],
    ];

    for (const [name, fixture, expected] of cases) {
      it(name, () => {
        expect(OLD_RULE.test(fixture), 'CONTROL IS VACUOUS: the old rule already caught this').toBe(false);
        expect(classifyMasking(fixture)).toBe(expected);
      });
    }

    it('and still recognises the shape the old rule DID catch (no coverage was traded away)', () => {
      const fixture = `function stripComments(src) { return src; }`;
      expect(OLD_RULE.test(fixture)).toBe(true);
      expect(classifyMasking(fixture)).toBe('hand-rolled');
    });

    it('a bare import of the shared module is not itself a hand-roll', () => {
      // A migrated guard MENTIONS a stripper name in its own import statement. That must not
      // read as a hand-rolled definition, or migrating a file would move it from one baseline
      // to the other instead of off both. This is why the rule anchors on DEFINITION forms
      // rather than ranking `shared` ahead of `hand-rolled` (see NAMED_STRIPPER_DEF).
      const fixture = `import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';`;
      expect(classifyMasking(fixture)).toBe('shared');
    });

    // WI-37801 — THE FALSIFYING CONTROL FOR THE FIRST-MATCH-WINS BLIND SPOT.
    // Under the previous implementation this returned 'shared', so the assertion below fails
    // before the fix and passes after; that is what makes the fix verifiable rather than
    // plausible. The fixture is not hypothetical — it is the exact shape of lint-migrations.mjs,
    // which imports the shared SQL mask for findLiteralTenantDefault while still hand-rolling
    // stripSqlBodies (deliberately, WI-37800), and was de-listed from BASELINE while doing so.
    it('a file that BOTH imports the shared module AND defines a private stripper is hand-rolled', () => {
      const fixture = [
        `import { stripSqlComments } from './lib/strip-comments-and-strings.mjs';`,
        `export function stripSqlBodies(sqlText) {`,
        `  return sqlText.replace(/\\$([A-Za-z_]*)\\$/g, ' ');`,
        `}`,
      ].join('\n');
      expect(SHARED_STRIPPER.test(fixture), 'CONTROL IS VACUOUS: fixture must import the shared module').toBe(true);
      expect(classifyMasking(fixture)).toBe('hand-rolled');
    });

    // The mirror case, so the fix cannot be "call everything hand-rolled". A file that imports
    // the shared module and merely CALLS it — the shape every fully-migrated guard has — must
    // still be `shared`, including when the call sits at the start of a line.
    it('calling an imported stripper is not defining one', () => {
      const fixture = [
        `import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';`,
        `const masked = stripCommentsOnly(readFileSync(f, 'utf8'), f);`,
        `stripCommentsOnly(src, name);`,
      ].join('\n');
      expect(classifyMasking(fixture)).toBe('shared');
    });

    // WI-37801 follow-up, from a REAL false positive an hour after the definition rule landed:
    // lint-migrations.mjs retired its private stripSqlBodies for exactly this alias, and the
    // rule scored the now-migrated file as debt. A named wrapper that DELEGATES is the migrated
    // state — flagging it punishes the very consolidation this suite drives.
    it('a named alias that DELEGATES to the shared module is migrated, not hand-rolled', () => {
      const fixture = [
        `import { stripSqlCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';`,
        `const maskSealingBodies = (sqlText) => stripSqlCommentsAndStrings(sqlText);`,
      ].join('\n');
      // VACUITY GUARD: the alias must really look like a stripper definition, or this proves
      // nothing about the delegation carve-out — it would just be a name the rule never matched.
      expect(
        new RegExp(NAMED_STRIPPER_DEF.source, 'm').test(fixture),
        'CONTROL IS VACUOUS: the alias no longer matches the definition rule at all',
      ).toBe(true);
      expect(classifyMasking(fixture)).toBe('shared');
    });

    // ...and the carve-out must not become a laundering trick. A file that delegates in one
    // place and still hand-rolls in another is hand-rolled: definesPrivateStripper checks EVERY
    // definition site precisely so the first one cannot decide for the rest.
    it('a delegating alias does NOT launder a real hand-roll elsewhere in the same file', () => {
      const fixture = [
        `import { stripSqlCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';`,
        `const maskSealingBodies = (sqlText) => stripSqlCommentsAndStrings(sqlText);`,
        `function stripComments(sql) {`,
        `  return sql.replace(/--[^\\n]*/g, ' ');`,
        `}`,
      ].join('\n');
      expect(classifyMasking(fixture)).toBe('hand-rolled');
    });
  });
});
