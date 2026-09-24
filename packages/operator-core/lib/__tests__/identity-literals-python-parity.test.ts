import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  isSidecarCopiedIdentityPath,
  resolveIdentityLiteralScopes,
} from '../../../../scripts/lib/identity-leak-patterns.mjs';

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
 * Resolved-value fixtures below are synthetic only. This file is tracked source and is therefore
 * scanned by the very lints it pins — a fixture spelling a real identity would fail the gate from
 * inside the guard written to prevent it (the same reasoning as the module's own "THE LITERALS ARE
 * A PARAMETER, NOT AN INTERNAL LOOKUP" note). The resolver's git seam is injected; assertions
 * inspect only synthetic git/owner values and identity keys, never the live box's account/host.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MJS_PATH = join(REPO_ROOT, 'scripts', 'lib', 'identity-leak-patterns.mjs');
const PY_PATH = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'audit-release-bundle.py');

/** Keys the .mjs port assigns, e.g. `lits['build-user-name'] = account`. */
export function mjsPortedKeys(source: string): string[] {
  return [...source.matchAll(/(?:lits|box)\[['"]([a-z-]+)['"]\]\s*=/g)].map((m) => m[1]).sort();
}

/** Keys the .mjs port assigns via its `[key, gitConfig]` loop pairs. */
export function mjsLoopKeys(source: string): string[] {
  return [...source.matchAll(/\[['"](build-git-[a-z]+)['"],\s*['"]user\.[a-z]+['"]\]/g)]
    .map((m) => m[1])
    .sort();
}

/**
 * Keys python's build-box `identity_literals()` assigns — BOTH the direct
 * `lits["build-user-name"] = user` form AND the `for key, cfg in (("build-git-email", ...))`
 * loop form. Parsing only the direct form silently under-reports by 2 and makes the parity
 * assertion fail for a bogus reason (measured while writing this test).
 */
export function pyIdentityLiteralKeys(source: string): string[] {
  const start = source.indexOf('def identity_literals(');
  expect(start, 'could not locate def identity_literals() in the python gate').toBeGreaterThan(-1);
  // Bounded to this function: stop at the next top-level `def `.
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\ndef ');
  const body = end === -1 ? rest : rest.slice(0, end);
  const direct = [...body.matchAll(/lits\[["']([a-z-]+)["']\]\s*=/g)].map((m) => m[1]);
  const looped = [...body.matchAll(/\(["'](build-[a-z-]+)["'],\s*["']user\.[a-z]+["']\)/g)].map(
    (m) => m[1],
  );
  return [...new Set([...direct, ...looped])].sort();
}

/**
 * Python keys that the .mjs deliberately handles in a DIFFERENT class rather than in class 3's
 * literal resolver. The python packs all machine identity into one flat dict; the .mjs
 * decomposes it into three classes with three matchers (see the module header), so set-equality
 * against `resolveIdentityLiterals()` alone is the WRONG model.
 *
 * `build-home-path` is class 2's job (`findBoxIdentityPaths`, wired into check-no-box-identity.mjs),
 * and class 2's matcher is strictly richer than a bare literal would be — it also understands the
 * munged `-home-builduser-` form, already-redacted paths, and `/home/<file>` that is not a home dir
 * at all. Porting it into class 3 as a plain literal would be a REGRESSION, not a fix.
 */
const DELEGATED_TO_ANOTHER_CLASS: Record<string, string> = {
  'build-home-path': 'class 2 — findBoxIdentityPaths (check-no-box-identity.mjs)',
};

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

  it('⭐ UNDER-PORT: every python build-box key is covered by SOME class in the .mjs', () => {
    // NOT set-equality against class 3 alone — the .mjs decomposes what python keeps flat.
    // A python key is covered if class 3 resolves it OR another class owns it explicitly.
    const covered = [...new Set([...mjsKeys, ...Object.keys(DELEGATED_TO_ANOTHER_CLASS)])].sort();
    expect(
      covered,
      'audit-release-bundle.py identity_literals() gained (or lost) a key that the .mjs does not ' +
        "account for. The module's own header calls a mismatch here a false-green. Either port it " +
        'into class 3, or add it to DELEGATED_TO_ANOTHER_CLASS naming the class that owns it — ' +
        "don't relax this test.",
    ).toEqual(pyBuildKeys);
  });

  it('the delegated keys really are absent from class 3 (so the delegation is honest)', () => {
    // Guards the other half of the above: if someone ALSO ports a delegated key into class 3,
    // the union assertion still passes while the key is now hunted twice, by two matchers with
    // different false-positive surfaces. Keep the ownership single.
    for (const [key, owner] of Object.entries(DELEGATED_TO_ANOTHER_CLASS)) {
      expect(mjsKeys, `${key} is owned by ${owner}, so class 3 must not resolve it too`).not.toContain(
        key,
      );
    }
  });

  it('⭐ OVER-PORT: the .mjs does NOT arm the cross-box known-sensitive set', () => {
    // Deliberate asymmetry. See the CLASS 3 header block in the .mjs for the full reasoning and
    // the measured blast radius. If you are here because you want to add these: don't — they are
    // redacted at tar time by bin/stage-source-tree.sh, and blocking them at edit time red-pins
    // main on 31 files.
    //
    // NOTE this asserts on the RESOLVED KEY SET, not on whether the file mentions the key. The
    // header deliberately DOES name these keys (that documentation is the actual fix for this
    // item), so a `mjs.includes(key)` check here would fail on its own remedy — it did, on the
    // first run of this test.
    for (const key of knownSensitiveKeys) {
      expect(
        mjsKeys,
        `${key} must NOT be armed in the edit-time detector (it is handled by stage-time ` +
          'redaction; arming it red-pins main on ~31 tracked doc files)',
      ).not.toContain(key);
    }
    // No local copy of the cross-box dict either — mentioning it in prose is fine, defining one
    // is the thing that would arm it.
    expect(mjs).not.toMatch(/KNOWN_SENSITIVE_IDENTITIES\s*=\s*[{[]/);
  });

  it('the known-sensitive set is the expected one — a NEW entry must be a conscious decision', () => {
    // Not a value assertion: keys only. Adding an entry to the python fails this until someone
    // re-affirms (here) that it stays unported, which is exactly the review beat we want.
    //
    // REVIEW BEAT, 2026-08-11 — `known-sensitive:owner-github-handle` (EI-20108164746219771).
    // Affirmed: it STAYS UNPORTED, for the same reason as the other three. It is the owner's
    // GitHub handle, added from a MEASURED leak (10 occurrences inside the shipped seed
    // corestore), and it is owned by no box's `whoami` — so identity_literals(), which resolves
    // only the building machine and explicitly asserted owner values, could never produce it. Its remedy is stage-time redaction
    // (bin/stage-source-tree.sh), not a working-tree block: arming it in the edit-time detector
    // is the OVER-PORT failure this file's ⭐ test above independently pins.
    expect(knownSensitiveKeys).toEqual([
      'known-sensitive:linux-build-user',
      'known-sensitive:mac-vm-login',
      'known-sensitive:mac-vm-user',
      'known-sensitive:owner-github-handle',
    ]);
  });

  it('the .mjs documents the deliberate boundary, so the next reader does not "fix" it', () => {
    // The header is the actual defect this item found: without it, "7 literals vs 4 keys" reads
    // as a bug and the obvious remedy is the harmful one.
    expect(mjs).toMatch(/KNOWN_SENSITIVE_IDENTITIES/);
    expect(mjs).toMatch(/stage-source-tree\.sh/);
  });

  it('mirrors the audit automation drops and explicit owner-class overrides', () => {
    const gitValues: Record<string, string> = {
      'user.name': 'papercusp-build-agent',
      'user.email': 'papercusp-build-bot@example.test',
    };
    const resolved = resolveIdentityLiteralScopes((_command, args) => gitValues[args[2] ?? ''] ?? '', {
      PAPERCUSP_RELEASE_OWNER_NAME: 'Synthetic Owner,Alternate Owner;Synthetic Owner',
      PAPERCUSP_RELEASE_OWNER_EMAIL: 'owner@example.test;alternate@example.test',
    });

    const gitClass = (literals: Record<string, string>) =>
      Object.fromEntries(Object.entries(literals).filter(([key]) => key.startsWith('build-git-')));
    expect(Object.keys(gitClass(resolved.box))).toEqual([]);
    expect(gitClass(resolved.owner)).toEqual({
      'build-git-name': 'Synthetic Owner',
      'build-git-name-2': 'Alternate Owner',
      'build-git-email': 'owner@example.test',
      'build-git-email-2': 'alternate@example.test',
    });
    expect(gitClass(resolved.all)).toEqual(gitClass(resolved.owner));
    expect(Object.keys(gitClass(resolved.all))).not.toContain('build-git-name-3');

    const human = resolveIdentityLiteralScopes(
      (_command, args) =>
        (({ 'user.name': 'Synthetic Human', 'user.email': 'human@example.test' }) as Record<string, string>)[
          args[2] ?? ''
        ] ?? '',
      {},
    );
    expect(gitClass(human.all)).toEqual({
      'build-git-name': 'Synthetic Human',
      'build-git-email': 'human@example.test',
    });

    // Pin the Python side's value rules too; comparing only key names missed this exact drift.
    expect(py).toMatch(/AUTOMATION_NAME_RE\s*=\s*re\.compile/);
    expect(py).toMatch(/AUTOMATION_EMAIL_RE\s*=\s*re\.compile/);
    expect(py).toMatch(/looks_like_automation_identity\(v\)/);
    expect(py).toMatch(/looks_like_automation_email\(v\)/);
    expect(py).toMatch(/explicit_owner_values\(env_var\)/);
  });

  it('scopes explicit owner linting to the sidecar CC files copied verbatim', () => {
    const builderPath = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');
    const lintPath = join(REPO_ROOT, 'scripts', 'check-no-identity-literals.mjs');
    const builder = readFileSync(builderPath, 'utf8');
    const lint = readFileSync(lintPath, 'utf8');
    expect(isSidecarCopiedIdentityPath('apps/operator/scripts/hooks/cc/posttooluse-proof-stale-nudge.mjs')).toBe(true);
    expect(isSidecarCopiedIdentityPath('apps/operator/scripts/hooks/cc/pretooluse-proof.sh')).toBe(true);
    expect(isSidecarCopiedIdentityPath('apps/operator/scripts/hooks/cc/__tests__/hook.test.mjs')).toBe(false);
    expect(isSidecarCopiedIdentityPath('apps/operator/lib/release/owner-identity-env.ts')).toBe(false);
    expect(builder).toMatch(/CC_HOOK_SRC_DIR="\$WEB_DIR\/scripts\/hooks\/cc"/);
    expect(builder).toMatch(/"\$CC_HOOK_SRC_DIR"\/\*\.sh/);
    expect(builder).toMatch(/"\$CC_HOOK_SRC_DIR"\/\*\.py/);
    expect(builder).toMatch(/"\$CC_HOOK_SRC_DIR"\/\*\.mjs/);
    expect(lint).toMatch(/resolveIdentityLiteralScopes\(\)/);
    expect(lint).toMatch(/isSidecarCopiedIdentityPath\(file\)/);
    expect(lint).toMatch(/sidecarEntries/);
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
