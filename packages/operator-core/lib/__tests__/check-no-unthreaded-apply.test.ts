/**
 * Recurrence guard + ENFORCEMENT point for `lint:no-unthreaded-apply` (EI-7667).
 *
 * ## Why this file runs the guard over the REAL TREE, not just its helpers
 *
 * `check-lint-guard-reachability.mjs` classifies a guard covered only by a unit test of
 * its helpers as `logic-test` — ADVISORY, not blocking — and says why: such a test proves
 * the DETECTOR works while catching no violation and blocking no commit, "which is worse
 * than no test at all" because it makes the guard look thoroughly covered. Its measured
 * proof is `lint:mock-cast-escape`, whose helper tests passed continuously across the
 * entire window in which the guard's real-tree count drifted +45 past its baseline.
 *
 * So this file does BOTH, and the two halves answer different questions:
 *
 *   1. CONTROLS (`findUnthreadedApplies` fed synthetic sources) — can the detector still
 *      FAIL? A guard that has never failed is a guard nobody has tested. The controls are
 *      permanent fixtures, so proving falsifiability never requires mutating the shared
 *      tree — which on this repo would race git-sync's whole-tree sweep and can commit the
 *      mutant (measured: db6d7b02b1).
 *   2. ENFORCEMENT (spawning the guard over the repo) — does anything actually RUN it?
 *      Unit-testing a helper proves nothing about whether a call site exists; that is the
 *      EI-19461720588871359 class, where a function was defined, exported, typed and
 *      tested while nothing ever called it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findUnthreadedApplies, splitArgs } from '../../../../scripts/check-no-unthreaded-apply.mjs';
// The guard no longer carries a private masker — it imports the shared stripper, whose own
// length/line-fidelity properties are proven in guard-string-literal-blindness.test.ts.
import { stripCommentsAndStrings } from '../../../../scripts/lib/strip-comments-and-strings.mjs';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const GUARD = join(REPO_ROOT, 'scripts', 'check-no-unthreaded-apply.mjs');

function runGuard(
  args: string[] = [],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [GUARD, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('lint:no-unthreaded-apply — enforcement over the real tree', () => {
  it('passes at HEAD: every production applyOpVia call site threads ownLogKeyHex', () => {
    const { status, stdout, stderr } = runGuard();
    expect(stderr + stdout).not.toMatch(/un-threaded production apply call site/);
    expect(status).toBe(0);
  });

  /**
   * Pins the measured population so the allowlist cannot GROW silently. ALLOW is
   * shrink-only; a new entry is a deliberate act and must show up as a failing assertion
   * in the same diff, not as a quietly widened exemption. That is the same discipline the
   * dark-flag watermark enforces, for the same reason.
   */
  it('has exactly ONE allowlisted site — the by-design global-registry path', () => {
    const { stdout } = runGuard(['--list']);
    expect(stdout).toContain('packages/operator-core/lib/sync/hyperbee/projection.ts');
    expect(stdout).toMatch(/allowlisted: 1\b/);
    expect(stdout).toMatch(/total files: 1\b/);
  });
});

describe('enforcement path is FALSIFIABLE (mutant caught end-to-end)', () => {
  /**
   * The controls below prove the DETECTOR flags bad input. They do not prove the
   * ENFORCEMENT path — walk → detect → exit(1) — can fail, and a guard whose runner
   * always exits 0 is indistinguishable from a clean tree.
   *
   * Mutating a tracked file to prove this would be unsafe here: git-sync sweeps the whole
   * tree every few minutes, so a probe that legitimately holds a file mutated for the
   * duration of a run can have the mutant COMMITTED with nothing going wrong and no trap
   * firing. So the subject is a fixture outside the tree, via the guard's read-only
   * PC_UNTHREADED_APPLY_SCAN_ROOT seam — zero window, no lock, no trap needed.
   */
  it('exits 1 on a violating fixture and 0 once it is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-unthreaded-apply-'));
    try {
      const file = join(dir, 'violator.ts');
      writeFileSync(file, 'export const bad = (l: unknown, o: unknown) => applyOpVia(l, o);\n');

      const mutant = runGuard([], { PC_UNTHREADED_APPLY_SCAN_ROOT: dir });
      expect(mutant.status).toBe(1);
      expect(mutant.stderr).toMatch(/un-threaded production apply call site/);
      expect(mutant.stderr).toMatch(/violator\.ts:1/);

      rmSync(file);
      const clean = runGuard([], { PC_UNTHREADED_APPLY_SCAN_ROOT: dir });
      expect(clean.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findUnthreadedApplies — controls (proves the detector can still fail)', () => {
  it('FLAGS a 2-argument call — the un-threaded shape itself', () => {
    const hits = findUnthreadedApplies('const r = applyOpVia(lookup, op);');
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/2 argument\(s\)/);
  });

  it('FLAGS an ApplyOpOpts literal that omits ownLogKeyHex', () => {
    // `{ hlcClock }` is a real miss that READS as threaded — the case a naive
    // "has a third argument?" check would wave through.
    const hits = findUnthreadedApplies('applyOpVia(lookup, op, { hlcClock });');
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/omits ownLogKeyHex/);
  });

  it('does NOT flag a correctly threaded call', () => {
    expect(findUnthreadedApplies('applyOpVia(lookup, op, { ownLogKeyHex, hlcClock });')).toEqual([]);
  });

  it('does NOT flag a variable third argument (documented limitation, not an oversight)', () => {
    // Statically undecidable here; the runtime WI-6210 detector covers the remainder.
    // Asserting it explicitly keeps the boundary honest instead of implicit.
    expect(findUnthreadedApplies('applyOpVia(lookup, op, applyOpts);')).toEqual([]);
  });

  it('does NOT flag the function DECLARATION', () => {
    expect(findUnthreadedApplies('export async function applyOpVia(lookup, op, opts) {}')).toEqual([]);
  });

  /**
   * The prose-is-not-code property. This guard's own header contains several literal
   * `applyOpVia(lookup, op)` strings; without masking it would flag itself, and more
   * generally a comment DESCRIBING the rule is textually identical to the rule being
   * broken. That has fired repeatedly in this repo on guards written to prevent it.
   */
  it('does NOT flag an occurrence inside a comment or a string', () => {
    expect(findUnthreadedApplies('// bad: applyOpVia(lookup, op);')).toEqual([]);
    expect(findUnthreadedApplies('/* applyOpVia(lookup, op); */')).toEqual([]);
    expect(findUnthreadedApplies('const doc = "applyOpVia(lookup, op)";')).toEqual([]);
  });

  it('counts a nested call or object as ONE argument, not several', () => {
    // Naive comma-splitting would see 4+ args here and wrongly call it threaded.
    expect(findUnthreadedApplies('applyOpVia((t) => reg.get(t) ?? null, op);')).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('the shared stripper preserves length and newlines so line numbers stay exact', () => {
    const src = 'a\n// comment\nb';
    const masked = stripCommentsAndStrings(src, 'x.ts');
    expect(masked).toHaveLength(src.length);
    expect(masked.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('a regex literal containing a quote no longer erases the call site after it', () => {
    // The private lexer this guard used to carry treated the quote in /['"]/ as opening a
    // string, swallowing the rest of the line — so a REAL call site after one vanished.
    // This is the defect that motivated the migration; it must stay dead.
    const src = `const q = /['"]/; applyOpVia(lookup, op);`;
    expect(findUnthreadedApplies(src, 'x.ts')).toHaveLength(1);
  });

  it('a call whose FIRST argument is a string literal is not counted one argument short', () => {
    // Blanking string DELIMITERS (the old behaviour) made the first arg empty, and splitArgs
    // drops an empty leading arg — so a 3-arg call read as 2 and was reported unthreaded.
    expect(findUnthreadedApplies(`applyOpVia('reg', op, thread);`, 'x.ts')).toHaveLength(0);
  });

  it('splitArgs returns null on unbalanced parens rather than a confident wrong arity', () => {
    expect(splitArgs('f(a, b', 1)).toBeNull();
  });
});
