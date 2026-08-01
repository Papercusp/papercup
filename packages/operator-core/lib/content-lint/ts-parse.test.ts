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

  it('catches an unterminated construct in a .tsx file', () => {
    const brokenTsx = ['export function C() {', '  return <div>oops;', '}'].join('\n');
    expect(findTsParseError('C.tsx', brokenTsx)).not.toBeNull();
  });

  it('catches a truncated file (the concurrent-edit interleave class)', () => {
    expect(findTsParseError('x.ts', 'export function half() {\n  const a = 1;')).not.toBeNull();
  });
});

describe('tsParseDetector', () => {
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
