/**
 * desktop-selftests-registry-complete.test.ts — WI-6181 regression guard.
 *
 * The papercusp-desktop bash selftests guard the live-federation rig + release-leg
 * scripts. They are enumerated in THREE independent places:
 *
 *   1. the files themselves          papercusp-desktop/bin/lib/*.selftest.sh
 *   2. the aggregate runner's array  papercusp-desktop/bin/lib/run-selftests.sh  (TESTS=(...))
 *   3. the admin/Tests-tab registry  the `desktop-selftests` domain in this package
 *
 * Nothing derived any of the three from the others, so a newly added selftest was run
 * by nothing and surfaced nowhere — which is how EI-18725214765732588's original fix
 * went dark a SECOND time: at the time WI-6181 was filed, three files on disk
 * (restart-settle-barrier, rig-wait-converged, roster-scope) were in neither the runner
 * array nor the registry. All three passed; nothing executed them. A guard that nobody
 * runs is indistinguishable from a guard that does not exist, except that it is worse —
 * it reads as coverage.
 *
 * run-selftests.sh now fails on disk-vs-array drift itself (so the live-federation gate
 * catches a missing entry). This test covers the half a bash script cannot see: that the
 * REGISTRY agrees with both. Registry drift therefore reds a fast unit test rather than
 * the gate.
 *
 * Note papercusp-desktop is a git SUBMODULE and deliberately not an npm workspace, so
 * these paths are read from disk rather than imported, and the whole suite skips when the
 * submodule is not checked out (same posture as affected-tests-standalone-packages).
 *
 * DELIBERATELY NOT ASSERTED — papercusp-desktop/package.json's per-selftest `test:<name>`
 * scripts. They are ergonomic aliases for running one selftest by hand; the execution path
 * is `test:selftests` -> run-selftests.sh, which runs every entry in TESTS regardless. A
 * missing alias therefore cannot make a selftest dark, so asserting it would enforce a
 * convention rather than protect coverage, and would red on a deliberate exception. (Four
 * were missing when this guard was written — vm-run-env plus the three formerly-dark files
 * — and were added for consistency, not because anything depended on them.)
 *
 * ALSO NOT COVERED, worth knowing: live-federation-gate.sh does NOT invoke this aggregate
 * runner. It calls bin/lib/federation-asserts.selftest.sh directly and only that one, as an
 * assert-core precondition. The aggregate's real caller is `npm run test:selftests`, reached
 * by the green checkpoint through the STANDALONE_PACKAGE_DIRS registration (WI-6077). So a
 * selftest listed here is guarded by the green checkpoint, not by the hourly live-fed gate.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { papercuspRegistry } from '../testing-domains-registry';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SELFTEST_DIR = resolve(REPO_ROOT, 'papercusp-desktop/bin/lib');
const RUNNER = resolve(SELFTEST_DIR, 'run-selftests.sh');
const SUFFIX = '.selftest.sh';

const submodulePresent = existsSync(RUNNER);

/** Basenames of every *.selftest.sh actually on disk. */
function onDisk(): string[] {
  return readdirSync(SELFTEST_DIR)
    .filter((f) => f.endsWith(SUFFIX))
    .sort();
}

/**
 * Basenames listed in run-selftests.sh's `TESTS=( ... )` array.
 * Parsed rather than executed: this test must not shell out to the rig.
 */
function inRunnerArray(): string[] {
  const src = readFileSync(RUNNER, 'utf8');
  const open = src.indexOf('TESTS=(');
  if (open === -1) throw new Error('run-selftests.sh: TESTS=( array not found — did the runner change shape?');
  const close = src.indexOf(')', open);
  if (close === -1) throw new Error('run-selftests.sh: unterminated TESTS=( array');
  return src
    .slice(open + 'TESTS=('.length, close)
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.endsWith(SUFFIX))
    .sort();
}

/** Basenames referenced by the `desktop-selftests` registry domain's shell runners. */
function inRegistry(): string[] {
  const domain = papercuspRegistry.find((d) => d.id === 'desktop-selftests');
  if (!domain) throw new Error("testing-domains-registry: domain 'desktop-selftests' is not registered");
  return domain.sections
    .flatMap((section) => section.runners ?? [])
    .flatMap((runner) => (runner.kind === 'shell' ? (runner.args ?? []) : []))
    .filter((arg) => arg.endsWith(SUFFIX))
    .map((arg) => arg.slice(arg.lastIndexOf('/') + 1))
    .sort();
}

describe.skipIf(!submodulePresent)('desktop selftests: disk == runner array == registry (WI-6181)', () => {
  it('runs every selftest that exists on disk', () => {
    const disk = onDisk();
    const runner = inRunnerArray();
    const unlisted = disk.filter((f) => !runner.includes(f));

    // Stated this way so a failure names the dark files rather than dumping two arrays.
    expect(
      unlisted,
      `${unlisted.length} selftest(s) exist on disk but are NOT in run-selftests.sh's TESTS array, so nothing runs them: ${unlisted.join(', ')}`,
    ).toEqual([]);
  });

  it('has no stale runner entries pointing at deleted/renamed files', () => {
    const disk = onDisk();
    const missing = inRunnerArray().filter((f) => !disk.includes(f));

    expect(
      missing,
      `${missing.length} TESTS entr(ies) in run-selftests.sh have no file on disk: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('surfaces every runner-array selftest in the desktop-selftests registry domain', () => {
    const runner = inRunnerArray();
    const registry = inRegistry();
    const unsurfaced = runner.filter((f) => !registry.includes(f));

    expect(
      unsurfaced,
      `${unsurfaced.length} selftest(s) run by run-selftests.sh are NOT in the 'desktop-selftests' registry domain, so they are invisible in the Tests tab / admin Testing dashboard: ${unsurfaced.join(', ')}`,
    ).toEqual([]);
  });

  it('has no registry entries pointing at selftests the runner does not run', () => {
    const runner = inRunnerArray();
    const registry = inRegistry();
    const orphaned = registry.filter((f) => !runner.includes(f));

    expect(
      orphaned,
      `${orphaned.length} 'desktop-selftests' registry entr(ies) are not in run-selftests.sh's TESTS array: ${orphaned.join(', ')}`,
    ).toEqual([]);
  });

  it('still guards the three files that were dark when WI-6181 was filed', () => {
    // Named explicitly: a generic set-equality assertion stays green if all three are
    // dropped from every surface at once, which is precisely the regression to catch.
    const disk = onDisk();
    const runner = inRunnerArray();
    const registry = inRegistry();

    for (const f of [
      'restart-settle-barrier.selftest.sh',
      'rig-wait-converged.selftest.sh',
      'roster-scope.selftest.sh',
    ]) {
      expect(disk, `${f} vanished from disk`).toContain(f);
      expect(runner, `${f} was dropped from run-selftests.sh's TESTS array`).toContain(f);
      expect(registry, `${f} was dropped from the desktop-selftests registry domain`).toContain(f);
    }
  });
});
