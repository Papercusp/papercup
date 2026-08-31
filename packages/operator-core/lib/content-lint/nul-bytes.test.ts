/**
 * Behavioural lock for the write-time NUL guard (content-lint rule `nul-bytes`).
 *
 * This is the only content-lint detector that REWRITES the caller's content —
 * `autoFixNulBytes` runs on the PreToolUse write/edit path, so it mutates what an
 * agent actually persists — and it was the only functional rule in this directory
 * with no test of its own. `registry.test.ts` imports the mdx / smart-quotes /
 * shell-syntax / conflict-markers detectors and never this one, so nothing pinned
 * the detection, the line numbers, the scope, or the repair. An auto-repair with
 * no behavioural test is the guard you have not tested (EI-19324723577412708).
 *
 * ⚠ Every NUL here is built with `String.fromCharCode(0)` — never as a literal
 * byte and never as the JS escape `'\x00'`, which COMPILES to a raw NUL and would
 * make this very file trip `lint:no-control-bytes` and `check-no-nul-in-source`.
 * The four-character escape the fixer emits is spelled `'\\x00'`. Keeping those
 * two apart is the entire subject of the rule under test, so the test file has to
 * observe the same discipline it verifies.
 */
import { describe, it, expect } from 'vitest';
import {
  NUL_SKIP_RE,
  NUL_SOURCE_RE,
  autoFixNulBytes,
  findNulBytes,
  nulByteScopeMatches,
} from './nul-bytes';

/** A single raw NUL byte, constructed so it never appears literally in source. */
const NUL = String.fromCharCode(0);
/** The four ASCII characters the fixer writes out: backslash, x, 0, 0. */
const ESCAPE = '\\x00';

describe('nulByteScopeMatches', () => {
  it('covers the text-source extensions the CI script covers', () => {
    for (const f of [
      'packages/x/lib/a.ts',
      'apps/operator/components/B.tsx',
      'scripts/tool.mjs',
      'scripts/legacy.cjs',
      'lib/a.js',
      'lib/a.jsx',
      'package.json',
      'README.md',
      'docs/page.mdx',
      'app/styles.css',
      'libs/db/sql/001-init.sql',
      'scripts/run.sh',
      'config.yml',
      'config.yaml',
      'Cargo.toml',
    ]) {
      expect(nulByteScopeMatches(f), f).toBe(true);
    }
  });

  it('leaves non-text-source files alone, including .txt and binaries', () => {
    for (const f of ['notes.txt', 'image.png', 'yarn.lock', 'bin/tool', 'a.rs']) {
      expect(nulByteScopeMatches(f), f).toBe(false);
    }
  });

  it('skips fixture and snapshot trees, where a NUL can be deliberate', () => {
    for (const f of [
      'fixtures/sample.ts',
      'fixture/sample.ts',
      'packages/x/__fixtures__/sample.json',
      'packages/x/snapshots/out.md',
      'packages/x/snapshot/out.md',
      'packages/x/__snapshots__/out.md',
    ]) {
      expect(nulByteScopeMatches(f), f).toBe(false);
    }
  });

  it('only treats fixtures/snapshots as a skip at a path boundary', () => {
    // `myfixtures/` is not the fixture dir the skip means; the rule must still apply.
    expect(nulByteScopeMatches('src/myfixtures/a.ts')).toBe(true);
    expect(nulByteScopeMatches('src/snapshotting/a.ts')).toBe(true);
    // ...and a bare filename containing the word is not a directory match either.
    expect(nulByteScopeMatches('src/fixtures-helper.ts')).toBe(true);
  });

  it('exposes the scope halves it is composed from', () => {
    expect(NUL_SOURCE_RE.test('a.ts')).toBe(true);
    expect(NUL_SOURCE_RE.test('a.txt')).toBe(false);
    expect(NUL_SKIP_RE.test('pkg/fixtures/a.ts')).toBe(true);
    expect(NUL_SKIP_RE.test('pkg/myfixtures/a.ts')).toBe(false);
  });
});

describe('findNulBytes', () => {
  it('returns null for clean text', () => {
    expect(findNulBytes('const a = 1;\n')).toBeNull();
    expect(findNulBytes('')).toBeNull();
  });

  it('does NOT flag the four-character escape — the fixer’s own output stays clean', () => {
    // This is the no-false-positive case that makes the repair idempotent: the
    // text the fixer emits must not read as a fresh violation on the next pass.
    const key = `const k = \`\${a}${ESCAPE}\${b}\`;\n`;
    expect(key.includes(NUL)).toBe(false);
    expect(findNulBytes(key)).toBeNull();
  });

  it('counts every raw NUL and reports 1-indexed lines of first appearance', () => {
    const text = `a${NUL}b\nc${NUL}${NUL}d`;
    expect(findNulBytes(text)).toEqual({ count: 3, lines: [1, 2] });
  });

  it('records a line once however many NULs it holds', () => {
    expect(findNulBytes(`x${NUL}${NUL}${NUL}y`)).toEqual({ count: 3, lines: [1] });
  });

  it('reports lines in order of first appearance across a multi-line file', () => {
    const text = ['clean', `two${NUL}`, 'clean', `four${NUL}`].join('\n');
    expect(findNulBytes(text)).toEqual({ count: 2, lines: [2, 4] });
  });

  it('locates a NUL on the final line with no trailing newline', () => {
    expect(findNulBytes(`a\nb\nc${NUL}`)).toEqual({ count: 1, lines: [3] });
  });
});

describe('autoFixNulBytes', () => {
  it('is a no-op on clean text and reports changed:false', () => {
    const clean = 'const a = 1;\n';
    expect(autoFixNulBytes(clean)).toEqual({ fixed: clean, changed: false });
  });

  it('rewrites every raw NUL to the escape and reports changed:true', () => {
    const { fixed, changed } = autoFixNulBytes(`a${NUL}b${NUL}c`);
    expect(changed).toBe(true);
    expect(fixed).toBe(`a${ESCAPE}b${ESCAPE}c`);
  });

  it('leaves no raw NUL behind', () => {
    const { fixed } = autoFixNulBytes(`k${NUL}v\nk2${NUL}v2\n`);
    expect(fixed.includes(NUL)).toBe(false);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const first = autoFixNulBytes(`a${NUL}b`);
    expect(first.changed).toBe(true);
    const second = autoFixNulBytes(first.fixed);
    expect(second).toEqual({ fixed: first.fixed, changed: false });
  });

  it('disturbs no other character, including non-ASCII', () => {
    const { fixed } = autoFixNulBytes(`café — 日本${NUL}end`);
    expect(fixed).toBe(`café — 日本${ESCAPE}end`);
  });

  it('produces text the detector then reports as clean', () => {
    // The round trip the write-time guard depends on: repair, then re-detect.
    const { fixed } = autoFixNulBytes(`a${NUL}b\nc${NUL}d`);
    expect(findNulBytes(fixed)).toBeNull();
  });
});

describe('falsifiability control', () => {
  /**
   * A deliberately-wrong detector kept here permanently: it looks for the ESCAPE
   * TEXT instead of the raw byte — the single most plausible way to misimplement
   * this rule, and the one that inverts its behaviour in both directions. The two
   * assertions below are what make the suite above meaningful: if a future change
   * ever let the real detector agree with this control on these inputs, the tests
   * would be passing without discriminating anything.
   */
  const escapeMatchingDetector = (text: string): boolean => text.includes(ESCAPE);

  const rawNulSource = `const k = a${NUL}b;`;
  const escapedSource = `const k = a${ESCAPE}b;`;

  it('the wrong detector MISSES a real raw NUL that findNulBytes catches', () => {
    expect(escapeMatchingDetector(rawNulSource)).toBe(false);
    expect(findNulBytes(rawNulSource)).not.toBeNull();
  });

  it('the wrong detector FLAGS a clean escape that findNulBytes passes', () => {
    expect(escapeMatchingDetector(escapedSource)).toBe(true);
    expect(findNulBytes(escapedSource)).toBeNull();
  });
});
