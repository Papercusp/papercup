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
const NAMED_STRIPPER =
  /\b(?:strip|mask|blank|scrub|elide|redact)[A-Za-z]*(?:Comments?|Strings?|Literals?|Bodies)\b/;
/** The two copy-pasted regexes themselves, matched as literal text — they are the defect. */
const NAIVE_BLOCK_RE = String.raw`\/\*[\s\S]*?\*\/`;
const NAIVE_LINE_RE = String.raw`\/\/.*$`;
const PARSES_AST = /from\s*['"]typescript['"]|ts\.createSourceFile|@babel\/parser|\bacorn\b|ts-morph/;
const SCANS_CODE_FILES = /\.tsx?['"`]|\.mjs['"`]|\.jsx['"`]|\.cts['"`]|\.mts['"`]/;
const TEXT_MATCHES = /\.test\s*\(|\.match(All)?\s*\(|\.includes\s*\(|\.exec\s*\(/;
const READS_FILES = /readFileSync|execFileSync\s*\(\s*['"](rg|grep)['"]/;

type Masking = 'shared' | 'hand-rolled' | 'ast' | 'unmasked';

function classifyMasking(maskedSource: string): Masking {
  if (SHARED_STRIPPER.test(maskedSource)) return 'shared';
  if (
    NAMED_STRIPPER.test(maskedSource) ||
    maskedSource.includes(NAIVE_BLOCK_RE) ||
    maskedSource.includes(NAIVE_LINE_RE)
  ) {
    return 'hand-rolled';
  }
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
   * Entries that are NOT JS/TS and so cannot use the shared module (it is a TypeScript parse):
   *   check-assert-integrity.mjs        — shell `#` comments
   *   check-partial-index-alignment.mjs — SQL `--` comments (already length-preserving)
   *   lint-migrations.mjs               — SQL
   *   check-unenrolled-mjs-imports.mjs  — strips `//` out of JSONC before JSON.parse
   *
   * `check-timer-classification.mjs` is on this list holding a CORRECT private copy (it is the
   * donor the shared module was lifted from). It should collapse into the import, but was left
   * alone deliberately: it was the live subject of an in-flight gate incident when this landed.
   */
  const BASELINE = new Set([
    'check-assert-integrity.mjs',
    'check-declared-consumed.mjs',
    'check-drop-database-force.mjs',
    'check-lint-guard-reachability.mjs',
    'check-migration-forward-compat.mjs',
    'check-no-proc-path-fixture.mjs',
    'check-no-raw-block-edge.mjs',
    'check-no-raw-install-slug-filter.mjs',
    'check-no-retired-style.mjs',
    'check-partial-index-alignment.mjs',
    'check-timer-classification.mjs',
    'check-unbounded-inbox-read.mjs',
    'check-unenrolled-mjs-imports.mjs',
    'check-workspace-deps-complete.mjs',
    'lint-migrations.mjs',
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
    'check-constant-conditional.mjs',
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
    'check-github-identity-terms.mjs',
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
    'check-sql-guidance-justified.mjs',
    'check-systemd-startlimit-placement.mjs',
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

    it('importing the shared module outranks every other signal', () => {
      // A migrated guard that still MENTIONS a stripper name must classify as `shared`, or
      // migrating a file would move it from one baseline to the other instead of off both.
      const fixture = `import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';`;
      expect(classifyMasking(fixture)).toBe('shared');
    });
  });
});
