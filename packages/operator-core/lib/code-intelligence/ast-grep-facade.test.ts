/**
 * P-014's proof obligation: the pin, the `sg` trap, the read-only property,
 * and the zero-indexed line conversion.
 *
 * The identity test carries a NEGATIVE CONTROL that is not synthetic — it is
 * the literal output of this box's `/usr/bin/sg` (shadow-utils' substitute-group
 * command, package `login`), captured 2026-08-21. That binary is what a PATH
 * lookup for ast-grep's documented `sg` alias actually resolves to on Linux,
 * and it EXITS 0 for `--version`, so it defeats both checks a provisioning
 * guard would normally make. Feeding its real output through the predicate is
 * what makes this a test rather than an assertion.
 */

import { describe, expect, it } from 'vitest';

import {
  assertIsAstGrep,
  buildAstGrepArgs,
  parseAstGrepMatches,
  resolveAstGrepBin,
  type AstGrepArgs,
} from './ast-grep-facade.ts';
import { LINE_INDEX_BASE } from './contracts.ts';

/** Verbatim `/usr/bin/sg --help` / `--version` output on this box (exit 0). */
const SHADOW_UTILS_SG_OUTPUT = 'Usage: sg group [[-c] command]';

describe('the `sg` trap — identity is judged on the STRING, never the exit code', () => {
  it('accepts real ast-grep version output', () => {
    const r = assertIsAstGrep('ast-grep 0.45.1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe('0.45.1');
  });

  it('REJECTS shadow-utils `sg` — the binary a PATH lookup actually finds', () => {
    const r = assertIsAstGrep(SHADOW_UTILS_SG_OUTPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('does not identify as ast-grep');
    // The reason must name WHY an exit-code check would not have caught it,
    // because that is the whole lesson and the next reader needs it.
    expect(r.reason).toContain('exits 0');
  });

  it.each(['', '   ', 'sg 4.13', 'astgrep 0.45.1', 'ast-grep-cli 0.45.1'])(
    'rejects near-miss identity string %p',
    (s) => {
      expect(assertIsAstGrep(s).ok).toBe(false);
    },
  );

  it('resolves ONLY at the pinned vendor path, never through PATH', () => {
    const bin = resolveAstGrepBin();
    // Provisioning is environmental, so assert the SHAPE rather than presence:
    // whatever it returns must be the vendor path, never `/usr/bin/sg` and never
    // a bare name that a PATH lookup would resolve.
    if (bin !== null) {
      expect(bin).toContain('.papercusp/vendor/ast-grep');
      expect(bin.startsWith('/')).toBe(true);
    }
    expect(bin).not.toBe('sg');
    expect(bin).not.toBe('/usr/bin/sg');
    expect(bin).not.toBe('ast-grep');
  });
});

describe('READ-ONLY by construction — the argv can never carry an apply flag', () => {
  const base: AstGrepArgs = { pattern: 'foo($X)', language: 'ts', rootPath: '/repo' };

  it('a plain search names no rewrite at all', () => {
    const argv = buildAstGrepArgs(base, 'search');
    expect(argv).not.toContain('--rewrite');
    expect(argv).toContain('--json=compact');
  });

  it('a rewrite PREVIEW passes --rewrite but never --update-all', () => {
    const argv = buildAstGrepArgs({ ...base, rewrite: 'baz($X)' }, 'rewrite_preview');
    expect(argv).toContain('--rewrite');
    expect(argv).toContain('baz($X)');
    expect(argv).not.toContain('--update-all');
    expect(argv).not.toContain('-U');
  });

  /**
   * THE PROPERTY, stated over inputs rather than over one call: no argv this
   * builder can produce — including one whose pattern or rewrite is itself an
   * apply flag — contains an apply flag as its own argv entry. execFile takes
   * an argv ARRAY with no shell, so a flag-shaped VALUE stays a value.
   */
  it.each([
    { pattern: '--update-all', rewrite: 'x' },
    { pattern: 'foo($X)', rewrite: '--update-all' },
    { pattern: '-U', rewrite: '-U' },
    { pattern: 'foo($X) --update-all', rewrite: 'bar($X) -U' },
  ])('never emits an apply flag as an OPTION for %j', (over) => {
    for (const op of ['search', 'rewrite_preview'] as const) {
      const argv = buildAstGrepArgs({ ...base, ...over }, op);
      // The values may APPEAR (as operands), but every apply-flag occurrence
      // must sit at an index the option parser cannot read as a flag: either
      // after `--`, or as the value of the preceding option.
      const dashDash = argv.indexOf('--');
      expect(dashDash).toBeGreaterThan(-1);
      argv.forEach((tok, i) => {
        if (tok !== '--update-all' && tok !== '-U') return;
        const precededByOption = i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--';
        expect(precededByOption || i > dashDash).toBe(true);
      });
    }
  });

  it('terminates option parsing before the paths, so a dash-leading path is an operand', () => {
    const argv = buildAstGrepArgs({ ...base, paths: ['-weird-dir/x.ts'] }, 'search');
    expect(argv.indexOf('--')).toBeLessThan(argv.indexOf('-weird-dir/x.ts'));
  });

  it('passes each option value as its OWN argv entry, so spaces cannot split it', () => {
    const argv = buildAstGrepArgs({ ...base, pattern: 'foo($X, $Y)' }, 'search');
    expect(argv).toContain('foo($X, $Y)');
    expect(argv.some((a) => a.startsWith('--pattern='))).toBe(false);
  });
});

describe('line-base conversion — ast-grep is ZERO-indexed', () => {
  it('the shared table records it as zero-indexed', () => {
    expect(LINE_INDEX_BASE['ast-grep']).toBe(0);
  });

  /** A real `--json=compact` payload, captured 2026-08-21 at ast-grep 0.45.1. */
  const REAL_PAYLOAD = JSON.stringify([
    {
      text: 'foo(1)',
      range: { byteOffset: { start: 10, end: 16 }, start: { line: 0, column: 10 }, end: { line: 0, column: 16 } },
      file: '/repo/probe.ts',
      lines: 'const a = foo(1);',
    },
    {
      text: 'foo(2)',
      range: { byteOffset: { start: 28, end: 34 }, start: { line: 1, column: 10 }, end: { line: 1, column: 16 } },
      file: '/repo/probe.ts',
      lines: 'const b = foo(2);',
    },
  ]);

  it('converts a first-line match reported as line 0 into line1 === 1', () => {
    const sites = parseAstGrepMatches(REAL_PAYLOAD, '/repo');
    expect(sites.map((s) => s.line1)).toEqual([1, 2]);
    expect(sites.map((s) => s.path)).toEqual(['probe.ts', 'probe.ts']);
  });

  it('preserves a repo-relative file emitted for a repo-relative input', () => {
    const payload = JSON.stringify([
      {
        text: "managedSetInterval('pty-idle-reaper')",
        range: { start: { line: 168, column: 2 } },
        file: 'packages/operator-core/lib/pty-bridge.ts',
      },
    ]);
    const site = parseAstGrepMatches(payload, '/repo')[0];

    expect(site.path).toBe('packages/operator-core/lib/pty-bridge.ts');
    expect(site.path).not.toMatch(/^\.\.\//);
    expect(site.line1).toBe(169);
  });

  it('CONTROL: reading the raw value would cite line 0, which no editor has', () => {
    const raw = JSON.parse(REAL_PAYLOAD) as Array<{ range: { start: { line: number } } }>;
    expect(raw[0].range.start.line).toBe(0);
    // The off-by-one this conversion exists to prevent.
    expect(parseAstGrepMatches(REAL_PAYLOAD, '/repo')[0].line1).not.toBe(
      raw[0].range.start.line,
    );
  });

  it('carries the replacement as detail for a rewrite preview', () => {
    const payload = JSON.stringify([
      {
        text: 'foo(1)',
        replacement: 'baz(1)',
        range: { start: { line: 4, column: 0 } },
        file: '/repo/a.ts',
      },
    ]);
    const sites = parseAstGrepMatches(payload, '/repo');
    expect(sites[0].detail).toBe('baz(1)');
    expect(sites[0].line1).toBe(5);
  });

  it('returns an empty set for empty or malformed output rather than throwing', () => {
    expect(parseAstGrepMatches('', '/repo')).toEqual([]);
    expect(parseAstGrepMatches('   ', '/repo')).toEqual([]);
    expect(parseAstGrepMatches('not json', '/repo')).toEqual([]);
    expect(parseAstGrepMatches('{"not":"an array"}', '/repo')).toEqual([]);
  });

  it('skips entries with no file rather than inventing a path', () => {
    const payload = JSON.stringify([{ text: 'x', range: { start: { line: 0 } } }]);
    expect(parseAstGrepMatches(payload, '/repo')).toEqual([]);
  });

  it('reports a null line when the payload carries none, never line 1', () => {
    const payload = JSON.stringify([{ text: 'x', file: '/repo/a.ts' }]);
    expect(parseAstGrepMatches(payload, '/repo')[0].line1).toBeNull();
  });
});
