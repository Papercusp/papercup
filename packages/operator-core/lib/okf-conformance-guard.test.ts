/**
 * okf-conformance-guard.test.ts — the in-suite RATCHET for
 * `scripts/check-okf-conformance.mjs` (`okf-frontmatter-adoption-2026-08-08` P-006).
 *
 * ## Why the ratchet lives HERE and not only in the routing registry
 *
 * `REPO_WIDE_INVARIANT_GUARDS` attaches the lint as a narrow task when a corpus
 * file changes and operator-core is not otherwise affected. But a knowledge-pack
 * path routes to operator-core anyway (measured: a pack file selects
 * @papercusp/harness, @papercusp/web, @papercusp/orchestrator,
 * @papercusp/operator-core, @papercusp/blueprint-distribution), and the router
 * deliberately SKIPS the narrow task when the host workspace's own suite is
 * already running — on the assumption that the suite contains the check.
 *
 * For `lint:chunk-safe` that assumption holds, because that guard IS a vitest
 * file. For a standalone script it does not, and the result is a hole exactly
 * where the corpus is most exposed: the pack half is written by CODE (plan
 * D-003), so it can regress with no author involved. This file is what makes the
 * router's assumption true.
 *
 * ## What it asserts
 *
 * The TREE RATCHET only — "both corpora are conformant right now". It does not
 * test the detector; the discrimination cases (every rule fires on a violation
 * AND stays quiet on the conformant control) live in
 * `packages/docs-engine/src/okf-conformance.test.ts`, and the minting paths are
 * judged by the same oracle in `knowledge-packs/candidates.test.ts`. Three
 * distinct jobs, three places — a green detector says nothing about where the
 * detector is RUN, which is the whole reason this file exists.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { OKF_SCAN_ROOTS, isOkfScannedFile } from '../../../scripts/check-okf-conformance.mjs';
import { runGuardScript } from './testing-guard-script';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('OKF conformance ratchet', () => {
  it('both corpora are conformant, and a NON-ZERO population of each was judged', () => {
    // The exit status is half the assertion, so it is asserted explicitly below rather
    // than left to a throw. It used to be an execFileSync, whose thrown Error renders
    // only "Command failed: npx tsx scripts/check-okf-conformance.mjs" as its message —
    // the lint's own list of non-conformant files survives merely as an unrendered
    // `.stdout` property, so in practice the red named the command, not the files (the cost
    // of that shape, measured on a sibling guard: EI-20692923474318761). ONE run, both
    // checks: this executes on every operator-core-affecting change, and every agent
    // pays for it.
    const guard = runGuardScript('npx', ['tsx', 'scripts/check-okf-conformance.mjs'], {
      cwd: REPO_ROOT,
      timeoutMs: 120_000,
    });
    const out = guard.stdout;
    expect(guard.status, guard.output).toBe(0);
    expect(out).toContain('OKF v0.2 conformance holds');

    // The denominator half is not decoration. A lint that silently stops walking
    // a corpus reports "0 offenders", which is byte-identical to a clean result —
    // the exact shape of `tsc -p .` and a zero-selection `test:affected`. The
    // verdict alone would stay green on a lint that checks nothing.
    const denominators = [...out.matchAll(/DENOMINATOR: (\d+) file\(s\) judged/g)].map((m) => Number(m[1]));
    expect(denominators).toHaveLength(3); // insights, pack docs, pack manifests
    for (const n of denominators) expect(n).toBeGreaterThan(0);
  }, 180_000);
});

describe('OKF conformance routing predicate', () => {
  it('accepts the file kinds the lint actually opens, under both roots', () => {
    expect(isOkfScannedFile(`${OKF_SCAN_ROOTS[0]}some-insight.mdx`)).toBe(true);
    expect(isOkfScannedFile(`${OKF_SCAN_ROOTS[0]}some-insight.md`)).toBe(true);
    expect(isOkfScannedFile(`${OKF_SCAN_ROOTS[1]}coding/testing.md`)).toBe(true);
    expect(isOkfScannedFile(`${OKF_SCAN_ROOTS[1]}coding/manifest.yaml`)).toBe(true);
  });

  it('rejects dot-paths — the lint does not judge them, so routing on them is pure cost', () => {
    // Astro's content loader ignores dot-paths, so `.papercusp/memory/raw.md` is
    // never schema-validated and the lint deliberately excludes it (plan D-001's
    // denominator discrepancy). A guard that fires on a file it cannot judge
    // spends every agent's edit budget for a finding impossible by construction.
    expect(isOkfScannedFile(`${OKF_SCAN_ROOTS[0]}.papercusp/memory/raw.md`)).toBe(false);
  });

  it('rejects everything outside the scanned roots and the scanned extensions', () => {
    expect(isOkfScannedFile('apps/operator-docs/astro.config.mjs')).toBe(false);
    expect(isOkfScannedFile('apps/operator-docs/src/content/docs/system/repo-conventions.mdx')).toBe(false);
    expect(isOkfScannedFile(`${OKF_SCAN_ROOTS[1]}coding/sync-map.json`)).toBe(false);
  });
});
