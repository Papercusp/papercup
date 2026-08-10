/**
 * js-syntax-guard.test.ts — capability + live verdict for `scripts/check-js-syntax.mjs`
 * (EI-20035436440627349).
 *
 * WHY BOTH DIRECTIONS. A guard that has never failed is a guard nobody has tested, and
 * the cheap way to fake one here is a detector that flags everything. So every FLAGS
 * case below is paired with a STAYS-SILENT calibration case that the real subject must
 * pass — in particular an ordinary ESM module using `import`/`export`, which a
 * script-mode parser (`new vm.Script(src)`) would reject as a syntax error. That
 * control is what pins the detector to node's MODULE goal rather than to the
 * happenstance that .mjs files usually parse.
 *
 * FIXTURES ARE WRITTEN OUTSIDE THE TREE, never by mutating a tracked file. git-sync
 * sweeps the whole working tree every few minutes, so a probe that holds a tracked
 * file broken for the length of a test run can have the mutant COMMITTED with nothing
 * going wrong and no trap firing (the sweep race documented in CLAUDE.md's
 * "Proving a guard is falsifiable" section, which cost a committed mutant on
 * 2026-08-03).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findJsSyntaxError, isJsSyntaxScanned } from '../../../scripts/check-js-syntax.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = path.join(ROOT, 'scripts/check-js-syntax.mjs');

let dir: string;
const write = (name: string, body: string) => {
  const p = path.join(dir, name);
  writeFileSync(p, body, 'utf8');
  return p;
};

/**
 * The exact 2026-08-10 incident shape: a regex pasted verbatim into a JSDoc block whose
 * body contains the comment terminator, ending the comment early and leaving the rest
 * of the line as stray syntax.
 *
 * Assembled by concatenation on purpose — writing the terminator as a literal inside a
 * block comment in THIS file would reproduce the bug here.
 */
const COMMENT_TERMINATOR = '*' + '/';
const JSDOC_ESCAPE_BREAK = ['/**', ` * .replace(/\\/\\/[^\\n]${COMMENT_TERMINATOR}g, '')`, ' ' + COMMENT_TERMINATOR, 'export const x = 1;', ''].join('\n');

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'js-syntax-guard-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('check-js-syntax detector — capability (both directions)', () => {
  it('FLAGS the JSDoc comment-terminator break that prompted the guard', async () => {
    const hit = await findJsSyntaxError(write('jsdoc-escape.mjs', JSDOC_ESCAPE_BREAK));
    expect(hit).not.toBeNull();
    expect(hit!.reason).toMatch(/SyntaxError/);
  });

  it('FLAGS an ordinary unbalanced-brace truncation (the concurrent-edit interleave shape)', async () => {
    const hit = await findJsSyntaxError(write('truncated.mjs', 'export function f() {\n  return 1;\n'));
    expect(hit).not.toBeNull();
  });

  it('CALIBRATION: STAYS SILENT on valid ESM — so it is not simply flagging everything', async () => {
    const clean = ['import path from "node:path";', 'export const joined = path.join("a", "b");', ''].join('\n');
    expect(await findJsSyntaxError(write('clean.mjs', clean))).toBeNull();
  });

  it('parses with the MODULE goal: top-level import/export is not treated as a script-mode error', async () => {
    // `new vm.Script(src)` — the obvious in-process alternative — rejects both of these.
    // If this ever fails, the detector has been swapped for a script-mode parser and
    // every ESM file in the repo would read as broken.
    expect(await findJsSyntaxError(write('tla.mjs', 'export const v = await Promise.resolve(1);\n'))).toBeNull();
    expect(await findJsSyntaxError(write('reexport.mjs', 'export { join } from "node:path";\n'))).toBeNull();
  });

  it('reports the offending LINE, so a triager is pointed at the break rather than the file', async () => {
    const hit = await findJsSyntaxError(write('line.mjs', 'export const a = 1;\nexport const b = ;\n'));
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(2);
  });
});

describe('check-js-syntax scope', () => {
  it('scans tracked .mjs and skips the surfaces whose baseline was never measured', () => {
    expect(isJsSyntaxScanned('scripts/lib/strip-comments-and-strings.mjs')).toBe(true);
    // .js/.cjs are deliberately out of scope: that surface includes large vendored
    // bundles, so including it would ship this guard on an unmeasured baseline.
    expect(isJsSyntaxScanned('papercusp-desktop/src-tauri/sidecar/spa/monaco/vs/loader.js')).toBe(false);
    expect(isJsSyntaxScanned('scripts/foo.cjs')).toBe(false);
    expect(isJsSyntaxScanned('_retired/papercup/x.mjs')).toBe(false);
    expect(isJsSyntaxScanned('libs/x/node_modules/y/z.mjs')).toBe(false);
    expect(isJsSyntaxScanned('libs/x/dist/y.mjs')).toBe(false);
  });
});

describe('check-js-syntax CLI', () => {
  const run = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [GUARD, ...args], { encoding: 'utf8', cwd: ROOT }) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  it('FAILS on a broken file (exit 1) and PASSES on a clean one (exit 0)', () => {
    const broken = write('cli-broken.mjs', JSDOC_ESCAPE_BREAK);
    const clean = write('cli-clean.mjs', 'export const ok = true;\n');
    expect(run([`--files=${broken}`]).code).toBe(1);
    expect(run([`--files=${clean}`]).code).toBe(0);
  });

  it('a ZERO denominator is a FAILURE, not a pass — a guard that measured nothing is broken', () => {
    // The whole class this guard belongs to fails silently toward "clean": a scan that
    // selects no files prints a ✓ that is indistinguishable from a real one.
    const r = run(['--files= ']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/scanned 0 files/);
  });
});

describe('check-js-syntax — live verdict over the real tree', () => {
  it('REACHED the tree, and the tree is clean', () => {
    let out: string;
    let code = 0;
    try {
      out = execFileSync(process.execPath, [GUARD], { encoding: 'utf8', cwd: ROOT });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? -1;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    // Assert the DENOMINATOR before the verdict. A guard enumerating via git ls-files
    // returns nothing for a checkout it cannot read, and its ✓ then means "scanned
    // nothing", which is the failure this whole file exists to make impossible.
    const scanned = Number(out.match(/all (\d+) tracked \.mjs/)?.[1] ?? 0);
    expect(scanned).toBeGreaterThan(200);
    expect(code, out).toBe(0);
  });
});
