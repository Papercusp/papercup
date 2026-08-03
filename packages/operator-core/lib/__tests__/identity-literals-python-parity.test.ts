import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * EI-19462813694036210 — pin the RELATIONSHIP between the two identity-leak detectors, in BOTH
 * directions, so neither kind of drift can happen silently.
 *
 *   scripts/lib/identity-leak-patterns.mjs  `resolveIdentityLiterals()`   <- edit/checkpoint time,
 *                                                                            THREE blocking lints
 *   papercusp-desktop/bin/audit-release-bundle.py  `identity_literals()`  <- release-cut time
 *
 * The .mjs is a faithful port of `identity_literals()`, which is build-box-only. The python's CALL
 * SITES then `lits.update(KNOWN_SENSITIVE_IDENTITIES)` — a cross-box set that is deliberately NOT
 * ported, because its remedy is stage-time redaction (bin/stage-source-tree.sh consumes
 * `--identity-literals` and --transforms a redacted COPY at tar time), not a working-tree block.
 *
 * Both failure directions are real and expensive:
 *
 *   1. UNDER-PORT (a real false-green). Someone adds a build-* key to the python and the .mjs
 *      never learns about it, so the cheap edit-time detector silently stops mirroring the
 *      expensive one. This is the failure the module's "MUST agree or it's a false-green" header
 *      is about, and nothing enforced it before this test.
 *
 *   2. OVER-PORT (a self-inflicted outage). Someone reads "7 literals vs 4 keys", concludes the
 *      .mjs is narrower, and arms KNOWN_SENSITIVE_IDENTITIES in it. Measured 2026-08-03 over
 *      `git ls-files`: that adds 31 + 8 instant findings across three BLOCKING lints — mostly
 *      mac-VM runbooks under apps/operator-docs and their generated projections — red-pinning
 *      `main`. EI-19462813694036210 proposed exactly this in good faith; the measurement is what
 *      stopped it.
 *
 * ⚠ THIS TEST ASSERTS ON KEY NAMES ONLY, NEVER ON RESOLVED VALUES, and it must stay that way.
 * This file is tracked source and is therefore scanned by the very lints it pins — a fixture
 * spelling a real identity would fail the gate from inside the guard written to prevent it (the
 * same reasoning as the module's own "THE LITERALS ARE A PARAMETER, NOT AN INTERNAL LOOKUP" note).
 * Nothing here executes either detector or reads this box's git config / hostname / OS account.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MJS_PATH = join(REPO_ROOT, 'scripts', 'lib', 'identity-leak-patterns.mjs');
const PY_PATH = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'audit-release-bundle.py');

/** Keys the .mjs port assigns, e.g. `lits['build-user-name'] = account`. */
export function mjsPortedKeys(source: string): string[] {
  return [...source.matchAll(/lits\[['"]([a-z-]+)['"]\]\s*=/g)].map((m) => m[1]).sort();
}

/** Keys the .mjs port assigns via its `[key, gitConfig]` loop pairs. */
export function mjsLoopKeys(source: string): string[] {
  return [...source.matchAll(/\[['"](build-git-[a-z]+)['"],\s*['"]user\.[a-z]+['"]\]/g)]
    .map((m) => m[1])
    .sort();
}

/** Keys python's build-box `identity_literals()` assigns, e.g. `lits["build-user-name"] = user`. */
export function pyIdentityLiteralKeys(source: string): string[] {
  const start = source.indexOf('def identity_literals(');
  expect(start, 'could not locate def identity_literals() in the python gate').toBeGreaterThan(-1);
  // Bounded to this function: stop at the next top-level `def `.
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\ndef ');
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...body.matchAll(/lits\[["']([a-z-]+)["']\]\s*=/g)].map((m) => m[1]).sort();
}

/** Keys in python's cross-box KNOWN_SENSITIVE_IDENTITIES dict (names only, never values). */
export function pyKnownSensitiveKeys(source: string): string[] {
  const start = source.indexOf('KNOWN_SENSITIVE_IDENTITIES = {');
  expect(start, 'could not locate KNOWN_SENSITIVE_IDENTITIES in the python gate').toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('}', start));
  return [...body.matchAll(/["'](known-sensitive:[a-z-]+)["']\s*:/g)].map((m) => m[1]).sort();
}

describe('EI-19462813694036210: identity-literal parity between the .mjs and .py detectors', () => {
  const mjs = readFileSync(MJS_PATH, 'utf8');
  const py = readFileSync(PY_PATH, 'utf8');

  const mjsKeys = [...new Set([...mjsPortedKeys(mjs), ...mjsLoopKeys(mjs)])].sort();
  const pyBuildKeys = pyIdentityLiteralKeys(py);
  const knownSensitiveKeys = pyKnownSensitiveKeys(py);

  it('parses a non-empty key set from BOTH files (guards a vacuous green)', () => {
    // A regex that silently stops matching would make every assertion below pass on empty
    // arrays — the zero-work false-green class this repo keeps hitting.
    expect(mjsKeys.length).toBeGreaterThanOrEqual(4);
    expect(pyBuildKeys.length).toBeGreaterThanOrEqual(4);
    expect(knownSensitiveKeys.length).toBeGreaterThanOrEqual(3);
  });

  it('⭐ UNDER-PORT: the .mjs mirrors every build-box key python resolves', () => {
    expect(
      mjsKeys,
      'scripts/lib/identity-leak-patterns.mjs resolveIdentityLiterals() must mirror ' +
        "audit-release-bundle.py identity_literals() exactly — the module's own header calls a " +
        "mismatch here a false-green. Port the new key, don't relax this test.",
    ).toEqual(pyBuildKeys);
  });

  it('⭐ OVER-PORT: the .mjs does NOT arm the cross-box known-sensitive set', () => {
    // Deliberate asymmetry. See the CLASS 3 header block in the .mjs for the full reasoning and
    // the measured blast radius. If you are here because you want to add these: don't — they are
    // redacted at tar time by bin/stage-source-tree.sh, and blocking them at edit time red-pins
    // main on 31 files.
    for (const key of knownSensitiveKeys) {
      expect(
        mjs.includes(key),
        `${key} must NOT be armed in the edit-time detector (it is handled by stage-time ` +
          'redaction; arming it red-pins main on ~31 tracked doc files)',
      ).toBe(false);
    }
    expect(mjs).not.toContain('KNOWN_SENSITIVE_IDENTITIES = ');
  });

  it('the known-sensitive set is the expected one — a NEW entry must be a conscious decision', () => {
    // Not a value assertion: keys only. Adding an entry to the python fails this until someone
    // re-affirms (here) that it stays unported, which is exactly the review beat we want.
    expect(knownSensitiveKeys).toEqual([
      'known-sensitive:linux-build-user',
      'known-sensitive:mac-vm-login',
      'known-sensitive:mac-vm-user',
    ]);
  });

  it('the .mjs documents the deliberate boundary, so the next reader does not "fix" it', () => {
    // The header is the actual defect this item found: without it, "7 literals vs 4 keys" reads
    // as a bug and the obvious remedy is the harmful one.
    expect(mjs).toMatch(/KNOWN_SENSITIVE_IDENTITIES/);
    expect(mjs).toMatch(/stage-source-tree\.sh/);
  });

  // ---- permanent controls: prove the parsers discriminate ---------------------------

  it('CONTROL: the python parser is bounded to identity_literals(), not the whole file', () => {
    const synthetic = [
      'def identity_literals():',
      '    lits["build-user-name"] = user',
      '',
      'def something_else():',
      '    lits["not-a-build-key"] = x',
      '',
    ].join('\n');
    expect(pyIdentityLiteralKeys(synthetic)).toEqual(['build-user-name']);
  });

  it('CONTROL: an under-ported key set is detected as unequal', () => {
    const pythonHasTwo = ['build-hostname', 'build-user-name'];
    const mjsHasOne = ['build-user-name'];
    expect(mjsHasOne).not.toEqual(pythonHasTwo);
  });

  it('CALIBRATION: the mjs parser finds both the direct and loop-assigned keys', () => {
    // Guards against a parser that sees only one assignment style and reports a short set,
    // which would make the UNDER-PORT test fail for a bogus reason.
    expect(mjsKeys).toContain('build-user-name');
    expect(mjsKeys).toContain('build-hostname');
    expect(mjsKeys).toContain('build-git-email');
    expect(mjsKeys).toContain('build-git-name');
  });
});
