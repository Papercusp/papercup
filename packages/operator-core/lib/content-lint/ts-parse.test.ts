/**
 * The TypeScript parse detector (WI-6683).
 *
 * The load-bearing property is NARROWNESS as much as detection: this runs on
 * every dirty .ts/.tsx on every git-sync tick, so a false positive would
 * quarantine healthy work fleet-wide. The tests below pin both directions —
 * the real regression is caught, and a file that merely fails to TYPECHECK
 * (unresolved import, wrong annotation) is explicitly NOT flagged.
 *
 * The broken fixtures are built from single-quoted lines joined with \n rather
 * than written as literal template text, so this test file itself always parses
 * (a fixture that broke its own container would be self-defeating here).
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { findTsParseError } from './ts-parse';
import { tsParseDetector } from './registry';

/**
 * The ACTUAL WI-6683 regression, reduced: a backtick inside a `--` SQL comment
 * inside a `sql` tagged template. The backtick closes the template, so every
 * following line is parsed as garbage. This exact shape was committed to
 * `staging` twice in one day in two sibling projection modules.
 */
const BACKTICK_IN_SQL_COMMENT = [
  'export const q = sql`',
  '  select id from things',
  '  -- filter on the `kind` column',
  '  where kind = $1',
  '`;',
  'export function stillHere() { return 1; }',
].join('\n');

/** Parses cleanly AND typechecks — the control. */
const HEALTHY = [
  'export const q = sql`',
  '  select id from things',
  '  -- filter on the kind column',
  '  where kind = $1',
  '`;',
  'export function stillHere(): number { return 1; }',
].join('\n');

describe('findTsParseError', () => {
  it('catches the WI-6683 regression — a backtick in a SQL comment inside a sql template', () => {
    const hit = findTsParseError('projections/engineer-issues.ts', BACKTICK_IN_SQL_COMMENT);
    expect(hit).not.toBeNull();
    // Reported at a real source position with the parser's own code + reason, so
    // the quarantine message points the author at the line to fix.
    expect(hit!.line).toBeGreaterThan(0);
    expect(hit!.code).toBeGreaterThan(0);
    expect(hit!.reason).toBeTruthy();
  });

  it('returns null for the same file with the backtick removed', () => {
    expect(findTsParseError('projections/engineer-issues.ts', HEALTHY)).toBeNull();
  });

  it('does NOT flag a file that parses but fails to TYPECHECK (syntactic-only)', () => {
    // The whole safety argument for running this on every tick: no type graph is
    // loaded, so an unresolved import or a wrong annotation can never quarantine
    // a file. Both lines below are hard tsc errors and neither is a parse error.
    const typeErrorsOnly = [
      "import { missing } from './does-not-exist';",
      'export const n: number = "not a number";',
      'export const m: string = missing;',
    ].join('\n');
    expect(findTsParseError('x.ts', typeErrorsOnly)).toBeNull();
  });

  it('does not flag an empty file or a comment-only file', () => {
    expect(findTsParseError('x.ts', '')).toBeNull();
    expect(findTsParseError('x.ts', '// just a comment\n')).toBeNull();
  });

  it('parses .tsx as TSX — valid JSX is not a false positive', () => {
    const tsx = [
      'export function C(props: { name: string }) {',
      '  return <div className="x">{props.name}</div>;',
      '}',
    ].join('\n');
    expect(findTsParseError('C.tsx', tsx)).toBeNull();
  });

  it('does not flag valid parameter decorators used by NestJS controllers', () => {
    const decorated = [
      'function Inject(): ParameterDecorator { return () => {}; }',
      'class Controller {',
      '  handle(@Inject() value: string): string { return value; }',
      '}',
    ].join('\n');
    expect(findTsParseError('controller.ts', decorated)).toBeNull();
  });

  it('does not flag valid CommonJS import-assignment syntax', () => {
    const commonjs = [
      "import cookieParser = require('cookie-parser');",
      'export const parser = cookieParser;',
    ].join('\n');
    // The module kind is a project setting, not a property of this source text.
    // The isolated grammar checker must not invent ESM and quarantine a valid
    // CommonJS consumer over TS1202.
    expect(findTsParseError('legacy-commonjs.ts', commonjs)).toBeNull();
  });

  it('catches an unterminated construct in a .tsx file', () => {
    const brokenTsx = ['export function C() {', '  return <div>oops;', '}'].join('\n');
    expect(findTsParseError('C.tsx', brokenTsx)).not.toBeNull();
  });

  it('catches a truncated file (the concurrent-edit interleave class)', () => {
    expect(findTsParseError('x.ts', 'export function half() {\n  const a = 1;')).not.toBeNull();
  });
});

/**
 * EI-22372621599811236 — the MODULE/TARGET class, and the guard whose absence let it land.
 *
 * Phase 2's `module`/`target` are not incidental setup: TypeScript reports a family of
 * sub-2000 GRAMMAR codes purely as a function of them, so the wrong pair MANUFACTURES
 * file-breaking diagnostics on files that are valid under the project's real tsconfig
 * (module ESNext, target ES2022) — and a flagged file is EXCLUDED from git-sync's
 * auto-commit, so a false positive here strands work rather than merely mis-reporting it.
 *
 * Measured when this landed: `module: CommonJS` with no explicit target flagged 1,529 of
 * 15,377 tracked files — 627 TS1378 (top-level `await`) + 902 TS1343 (`import.meta`),
 * ~10% of the repo, every one of them valid. The quarantined file that surfaced it,
 * routines.test.ts, was ALREADY COMMITTED and green; only the git-sync guard disagreed.
 *
 * The three cases below are pinned TOGETHER on purpose, because they are mutually
 * exclusive under every module kind but `preserve`: `commonjs` satisfies only TS1202,
 * `esnext` only TS1378+TS1343, `nodenext` trades TS1343 for TS1470. Any single-case test
 * would therefore pass against a setting that breaks one of the others — which is exactly
 * how the CommonJS regression got in past a suite that already covered TS1202 (above).
 */
describe('findTsParseError — module/target grammar options (EI-22372621599811236)', () => {
  it('does not flag top-level await (TS1378) — legal under the repo module ESNext/target ES2022', () => {
    const topLevelAwait = ["const mod = await import('./list');", 'export default mod;'].join('\n');
    expect(findTsParseError('top-level-await.ts', topLevelAwait)).toBeNull();
  });

  it('does not flag import.meta (TS1343)', () => {
    expect(findTsParseError('meta.ts', 'export const here = import.meta.url;\n')).toBeNull();
  });

  it('still does not flag import-assignment (TS1202) — the constraint that forced CommonJS', () => {
    // The sibling of the TS1202 case above, restated HERE so the three constraints sit in
    // one block: a future edit that fixes one of these by breaking another reds immediately
    // instead of trading one silent quarantine class for a different one.
    const importEquals = ["import path = require('node:path');", 'export const sep = path.sep;'].join('\n');
    expect(findTsParseError('import-equals.ts', importEquals)).toBeNull();
  });

  it('CONTROL: an explicit target is required, not merely a module kind', () => {
    // TS1378 tests `module` AND `target >= ES2017` INDEPENDENTLY, and a program built with
    // no target defaults to ES5 — so a module-only fix leaves top-level await flagged. The
    // `createSourceFile` ScriptTarget.Latest above sets the PARSE target, NOT
    // `compilerOptions.target`, which is what the grammar checks read; that gap is precisely
    // what made this look configured when it was not. Asserting the detector's own verdict
    // on the two shapes keeps the pair honest without duplicating its compiler options here.
    expect(findTsParseError('a.ts', "export const m = await import('./x');\n")).toBeNull();
    expect(findTsParseError('b.ts', 'export const u = import.meta.url;\n')).toBeNull();
  });

  it('CONTROL: the widened options still catch the real breakage cases', () => {
    // The negative direction. Loosening module/target must not loosen the detector itself:
    // if it did, every test above would pass for the wrong reason — a check that flags
    // nothing is the silent non-guard this file exists to prevent.
    expect(findTsParseError('x.ts', 'export export const X = 1;\n')).not.toBeNull();
    expect(findTsParseError('y.ts', 'const a = 1;\nconst a = 2;\nexport { a };\n')).not.toBeNull();
    expect(findTsParseError('z.ts', "const s = 'unterminated;\nexport default s;\n")).not.toBeNull();
  });
});

/**
 * WI-37398 — the DUPLICATE MODIFIER class.
 *
 * TypeScript's parser is deliberately error-TOLERANT here: `export export const X = 1`
 * parses to a valid AST carrying two `export` modifiers, and the error is reported by
 * the CHECKER (TS1030), not the parser. So a parse-only check returns CLEAN while
 * esbuild rejects the file outright — and esbuild is what bundle-host.sh runs as
 * ExecStartPre for the staging, bg-host and release services.
 *
 * Measured live: git-sync swept exactly this into corpus-recall-io.ts at the shared
 * tip on 2026-08-09T05:55Z. Both surfaces running this check said clean; it surfaced
 * only because :3170 happened to restart and crash-looped 6 times. A doubled keyword
 * is the classic bad-edit artifact, so this is the shape an agent-edited tree makes.
 */
describe('findTsParseError — duplicate modifiers (WI-37398)', () => {
  it('catches the exact line git-sync swept to the tip (doubled `export`)', () => {
    const hit = findTsParseError(
      'packages/operator-core/lib/memory/corpus-recall-io.ts',
      "export export const CORPUS_SOURCE_NAMES = ['session_turn', 'work_item'] as const;\n",
    );
    expect(hit).not.toBeNull();
    expect(hit!.code).toBe(1030); // "'export' modifier already seen."
    expect(hit!.line).toBe(1);
    expect(hit!.reason).toContain('already seen');
  });

  it('catches sibling spellings of the same bad-edit artifact', () => {
    // A doubled `async`, and a doubled accessibility modifier (TS1028). Neither is
    // reported by the parser, and the first is also rejected by esbuild.
    expect(findTsParseError('x.ts', 'export async async function f() {}\n')).not.toBeNull();
    expect(findTsParseError('x.ts', 'class C { public public x = 1; }\n')).not.toBeNull();
  });

  it('does not flag the same file once the duplicate is removed', () => {
    expect(
      findTsParseError(
        'packages/operator-core/lib/memory/corpus-recall-io.ts',
        "export const CORPUS_SOURCE_NAMES = ['session_turn', 'work_item'] as const;\n",
      ),
    ).toBeNull();
  });

  /**
   * The narrowness property, re-pinned for the grammar phase specifically. Phase 2
   * runs the CHECKER, so it is the phase that could plausibly start quarantining
   * files over type errors — the codes are filtered to < 2000 precisely so it cannot.
   * Every construct below is valid TypeScript that a checker sees "problems" in once
   * no lib and no modules are loaded.
   */
  it('does NOT flag valid TypeScript that merely cannot be typechecked in isolation', () => {
    const cases = [
      "import type { Nope } from './does-not-exist';\nexport const a: Nope | null = null;\n",
      'export class S { constructor(private readonly x: number) {} }\n',
      'export function f<T>(a: T): T { return a; }\n',
      'export enum E { A, B }\nexport abstract class C { abstract m(): void; }\n',
      "export const o = { a: 1 } satisfies Record<string, number>;\n",
      'export class D { declare x: number; }\n',
      'export const big = 1n; const s = Symbol("x"); export type U = keyof typeof o;\n',
    ];
    for (const text of cases) {
      expect(findTsParseError('x.ts', text), text).toBeNull();
    }
  });

  it('reports the EARLIEST grammar error when a file has several', () => {
    const text = ['export const a = 1;', 'export export const b = 2;', 'export export const c = 3;'].join('\n');
    const hit = findTsParseError('x.ts', text);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(2);
  });

  it('prefers a real PARSE error over a grammar error (phase 1 short-circuits)', () => {
    // Both faults present: the unterminated brace is the parser's, and it wins.
    const hit = findTsParseError('x.ts', 'export export const a = 1;\nexport function f() {\n');
    expect(hit).not.toBeNull();
    expect(hit!.code).not.toBe(1030);
  });
});

/**
 * EI-19457229906581679 — the esbuild-fatal codes that live ABOVE the 2000 grammar bound.
 *
 * Measured 2026-08-10: a mid-edit duplicate `const startingAdvSessionId` in
 * routes/adv/launch-su.ts failed bundle-host.sh (`✘ [ERROR] The symbol ... has already
 * been declared`) and crash-looped papercup-staging-api until supervision gave up, with
 * :3170 down fleet-wide. This detector — built for exactly that class — was silent: a
 * redeclaration is an ECMAScript EARLY error, so phase 1 sees a clean parse, and phase 2's
 * only finding is TS2451, discarded for being ≥ 2000.
 *
 * The two tests below are a matched pair and must stay that way: the fix is only correct
 * if the esbuild-fatal code FIRES *and* the ordinary 2xxx noise stays SILENT. Either one
 * alone would be satisfied by a wrong implementation (delete the filter, or delete the set).
 */
describe('findTsParseError — esbuild-fatal codes above the grammar bound', () => {
  const DUPLICATE_CONST =
    'export function f(ownerId: string) {\n  const sessionId = ownerId ? "a" : null;\n  const sessionId = ownerId ? "b" : null;\n  return sessionId;\n}\n';

  it('catches a duplicate block-scoped declaration (TS2451) — esbuild refuses to bundle it', () => {
    const hit = findTsParseError('launch-su.ts', DUPLICATE_CONST);
    expect(hit, 'TS2451 breaks every bundling host; it must not be filtered as a type error').not.toBeNull();
    expect(hit!.code).toBe(2451);
    // TS reports TS2451 at BOTH conflicting declarations; the detector's earliest-wins rule
    // therefore surfaces the FIRST one (line 2). Either position identifies the conflict —
    // pinned here so a future change to that ordering is a deliberate decision, not a drift.
    expect(hit!.line).toBe(2);
    expect(hit!.reason).toMatch(/sessionId/);
  });

  it('confirms phase 1 alone cannot see it (this is why the grammar phase is load-bearing)', () => {
    // If a future refactor drops the grammar phase, the case above would go silent again
    // with no other test noticing. This pins WHY it is needed, not merely that it works.
    const sf = ts.createSourceFile('launch-su.ts', DUPLICATE_CONST, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    // `parseDiagnostics` is an INTERNAL property — cast exactly as ts-parse.ts itself does.
    const parseDiagnostics = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
    expect(parseDiagnostics?.length, 'a redeclaration is an early error, not a parse error').toBe(0);
  });

  it('stays SILENT on ordinary code whose only 2xxx diagnostics come from noLib', () => {
    // `noLib: true` reports TS2318 (no global Promise) / TS2584 (no console) here. Raising
    // the bound instead of enumerating esbuild-fatal codes would quarantine this file —
    // which is why the fix is an explicit set.
    expect(
      findTsParseError('ordinary.ts', 'export async function f() {\n  console.log(1);\n  return Promise.resolve(2);\n}\n'),
    ).toBeNull();
  });

  it('does NOT flag a duplicate TYPE alias — erased before emit, and esbuild bundles it fine', () => {
    // The nearest neighbour to TS2451 that must NOT be admitted: it reports 2xxx too, but
    // types never reach the bundler, so quarantining it would be a false positive.
    expect(findTsParseError('t.ts', 'type A = { x: number };\ntype A = { y: string };\nexport const v = 1;\n')).toBeNull();
  });
});

describe('tsParseDetector', () => {
  // EI-20089601803883232 — the commit-path detector and its PostToolUse sibling must agree
  // on WHICH FILES EXIST. The sibling has always matched .mts/.cts; this half did not, so an
  // unparseable .mts committed clean (test-e2e-generation.mts, ten `\!` artifacts, TS1127).
  it('covers .mts/.cts — the release path executes them and they break identically', () => {
    expect(tsParseDetector.matches('apps/operator/lib/release/test-e2e-generation.mts')).toBe(true);
    expect(tsParseDetector.matches('packages/x/a.cts')).toBe(true);
    // ...and the exclusions still apply to the newly-covered extensions.
    expect(tsParseDetector.matches('packages/x/node_modules/y/z.mts')).toBe(false);
    expect(tsParseDetector.matches('_retired/papercup/x.mts')).toBe(false);
  });

  it('scopes to tracked .ts/.tsx and skips retired/vendored/build trees', () => {
    expect(tsParseDetector.matches('packages/operator-core/lib/x.ts')).toBe(true);
    expect(tsParseDetector.matches('apps/operator/components/X.tsx')).toBe(true);
    expect(tsParseDetector.matches('libs/x/types.d.ts')).toBe(true);
    expect(tsParseDetector.matches('docs/x.mdx')).toBe(false);
    expect(tsParseDetector.matches('scripts/x.sh')).toBe(false);
    expect(tsParseDetector.matches('_retired/papercup/x.ts')).toBe(false);
    expect(tsParseDetector.matches('packages/x/node_modules/y/z.ts')).toBe(false);
    expect(tsParseDetector.matches('packages/x/dist/y.ts')).toBe(false);
  });

  it('returns a human-readable error naming the position, and null when clean', async () => {
    const err = await tsParseDetector.detect('projections/engineer-issues.ts', BACKTICK_IN_SQL_COMMENT);
    expect(err).toContain('TypeScript parse error at line');
    // The message must say WHY this is worse than a local error — the author reading
    // the quarantine needs to know it breaks every consumer, not just their file.
    expect(err).toContain('does not PARSE');
    expect(await tsParseDetector.detect('projections/engineer-issues.ts', HEALTHY)).toBeNull();
  });

  it('has no autoFix — a parse break is never guessed at automatically', () => {
    expect(tsParseDetector.autoFix).toBeUndefined();
  });
});
