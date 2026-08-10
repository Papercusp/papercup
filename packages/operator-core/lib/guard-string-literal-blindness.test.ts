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
import {
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

  it('an `^`-anchored /m detector still sees a declaration that follows a block comment', () => {
    // The line-collapse above was not cosmetic: gluing lines together breaks `^`.
    const src = '/* note\n   note */\nconst run = promisify(execFile);\n';
    expect(/^(export\s+)?(const|let)\s+\w+\s*=\s*promisify\(\s*execFile\w*\s*\)/m.test(stripCommentsAndStrings(src, 'a.ts'))).toBe(true);
  });

  it('blanks a regex BODY, where a guard is most likely to quote its own token', () => {
    expect(detects('const RE = /\\bsetInterval\\s*\\(/;\n')).toBe(false);
    expect(detects('const RE = /\\bsetInterval\\s*\\(/;\nsetInterval(fn);\n')).toBe(true);
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
  ];

  for (const [name, detector, token] of cases) {
    it(`${name}: its own detection token, quoted in prose, is not a call site`, () => {
      const verdict = probeStringLiteralBlindness(detector, token);
      expect(verdict.ok, `${name}: ${verdict.detail}`).toBe(true);
    });
  }
});

describe('the copy-pasted stripComments population is SHRINK-ONLY', () => {
  /**
   * Scripts that still define a PRIVATE comment stripper instead of importing the shared one.
   *
   * This list may SHRINK, never GROW. Removing an entry = migrating that guard (verify first
   * whether its token is legitimately string-resident — see the header note). Adding one means
   * a new copy-paste of the exact defect that froze the fleet gate; import the shared module
   * from `scripts/lib/strip-comments-and-strings.mjs` instead.
   *
   * `check-timer-classification.mjs` is on this list holding a CORRECT private copy (it is the
   * donor the shared module was lifted from). It should collapse into the import, but was left
   * alone deliberately: it was the live subject of an in-flight gate incident when this landed.
   */
  const BASELINE = new Set([
    'check-declared-consumed.mjs',
    'check-drop-database-force.mjs',
    'check-lint-guard-reachability.mjs',
    'check-migration-forward-compat.mjs',
    'check-no-proc-path-fixture.mjs',
    'check-no-raw-block-edge.mjs',
    'check-no-raw-install-slug-filter.mjs',
    'check-no-retired-style.mjs',
    'check-timer-classification.mjs',
    'check-unbounded-inbox-read.mjs',
    'check-workspace-deps-complete.mjs',
  ]);

  const DEFINES_PRIVATE_STRIPPER = /^(export\s+)?function\s+stripComments/m;

  function measurePopulation(): string[] {
    return readdirSync(SCRIPTS_DIR)
      .filter((f) => f.endsWith('.mjs'))
      .filter((f) => DEFINES_PRIVATE_STRIPPER.test(readFileSync(join(SCRIPTS_DIR, f), 'utf8')))
      .sort();
  }

  it('no NEW script hand-rolls its own comment stripper', () => {
    const added = measurePopulation().filter((f) => !BASELINE.has(f));
    expect(
      added,
      `These scripts define a private stripComments instead of importing scripts/lib/strip-comments-and-strings.mjs. ` +
        `That copy-paste IS the root cause of the phantom-offender class (EI-19991116787260658).`,
    ).toEqual([]);
  });

  it('the baseline does not carry entries that are already migrated (it must stay honest)', () => {
    // A stale baseline entry silently buys back budget for a future copy-paste.
    const stale = [...BASELINE].filter((f) => !measurePopulation().includes(f));
    expect(stale, 'Already-migrated scripts still listed in BASELINE — remove them.').toEqual([]);
  });

  it('the guards migrated by EI-19991116787260658 have NOT regressed to a private copy', () => {
    const migrated = [
      'check-no-eager-execfile-promisify.mjs',
      'check-no-module-scope-flag-subscribe.mjs',
      'check-no-raw-agent-spawn.mjs',
      'check-no-raw-setinterval.mjs',
    ];
    const regressed = migrated.filter((f) => measurePopulation().includes(f));
    expect(regressed, 'These were migrated to the shared stripper and must not re-declare one.').toEqual([]);
  });
});
