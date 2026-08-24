/**
 * affected-tests-standalone-packages.test.ts — WI-6077 regression guard.
 *
 * `scripts/affected-tests.mjs` builds its universe of testable packages from root
 * `package.json`'s `workspaces` array. `papercusp-desktop` is a git SUBMODULE that is
 * deliberately NOT an npm workspace (it manages its own dependency graph and lockfile),
 * so it was invisible to that universe — and because the green gate's greenCmd is
 * `npm run test:affected` (release-config.ts), the gate ran ZERO of the desktop's ~20
 * guard suites: the deb/sidecar/reaper/config guards and the live-federation rig
 * selftests, i.e. exactly the release+packaging paths this repo ships.
 *
 * The fix joins such packages to the graph via `STANDALONE_PACKAGE_DIRS`, marking them
 * `standalone` so the runner invokes them with cwd=<dir> instead of
 * `npm run --workspace <dir>` (which resolves ONLY for genuine workspaces — it fails
 * with "No workspaces found", verified).
 *
 * This guard covers the three independent ways the gap silently reopens:
 *   1. the standalone registration is removed / renamed;
 *   2. the package loses its aggregate `test` script (the runner only builds a task
 *      when `ws.scripts.test` exists, so no `test` script == silently zero suites);
 *   3. someone "tidies" the submodule INTO root `workspaces`, which would break the
 *      standalone branch's premise and change npm's install/hoisting topology.
 *
 * It asserts BEHAVIOR, not source text: it runs the real CLI's `--print-affected`
 * probe, which exits before executing any suite.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');
const STANDALONE_DIR = 'papercusp-desktop';
const STANDALONE_PKG_NAME = '@papercusp/desktop';

const pkgAt = (rel: string) => JSON.parse(readFileSync(resolve(REPO_ROOT, rel, 'package.json'), 'utf8'));

// The submodule is not always checked out (a shallow/partial clone). Skip rather than
// fail there — a missing submodule is not a regression in this wiring.
const submodulePresent = existsSync(resolve(REPO_ROOT, STANDALONE_DIR, 'package.json'));

describe.skipIf(!submodulePresent)('affected-tests: standalone (non-workspace) packages (WI-6077)', () => {
  it('includes the standalone package in the affected universe', () => {
    // `--all --print-affected` enumerates the whole universe and exits before running
    // anything, so this is the cheapest honest probe of "can the runner even see it".
    const r = spawnSync('node', [AFFECTED_TESTS, '--all', '--print-affected'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
      killSignal: 'SIGKILL',
    });
    expect(r.status, `affected-tests --print-affected failed:\n${r.stderr}`).toBe(0);

    const names = (r.stdout ?? '')
      .split('\n')
      .filter((l) => l.startsWith('AFFECTED_WS\t'))
      .map((l) => l.slice('AFFECTED_WS\t'.length).trim());

    expect(names.length).toBeGreaterThan(10); // sanity: the probe really enumerated
    expect(
      names,
      `${STANDALONE_PKG_NAME} is missing from the affected universe — the green gate is ` +
        `back to running ZERO of its suites. Check STANDALONE_PACKAGE_DIRS in scripts/affected-tests.mjs.`,
    ).toContain(STANDALONE_PKG_NAME);
  });

  it('declares an aggregate `test` script, without which the runner builds no task for it', () => {
    // affected-tests.mjs only queues a task when `ws.scripts.test` exists. A package in
    // the universe with no `test` script is therefore silently zero-coverage — the exact
    // second half of the original bug.
    const scripts = pkgAt(STANDALONE_DIR).scripts ?? {};
    expect(
      scripts.test,
      `${STANDALONE_DIR} has no \`test\` script, so affected-tests.mjs queues nothing for it.`,
    ).toBeTruthy();
  });

  it('excludes the heavy/VM-dependent suites from that aggregate script', () => {
    // These must never enter the gate's affected path: test:rust duplicates a separate
    // cargo step, and the live-matrix / updater-e2e suites need real VMs or network.
    const testScript: string = pkgAt(STANDALONE_DIR).scripts.test;
    for (const forbidden of ['test:rust', 'test:federation:live-matrix', 'test:updater-e2e-vm']) {
      expect(
        testScript.includes(forbidden),
        `${STANDALONE_DIR}'s \`test\` script must not run ${forbidden} — it is either already ` +
          `covered elsewhere or needs a VM/network, and would wreck the gate's wall-clock budget.`,
      ).toBe(false);
    }
  });

  it('is NOT an npm workspace — the standalone path exists precisely because it is not', () => {
    // If someone adds it to root `workspaces`, the standalone branch's premise breaks AND
    // npm's install/hoisting topology changes for a submodule that manages its own deps.
    // Fail here, loudly, rather than at install time or in a confusing gate error.
    const patterns: string[] = pkgAt('.').workspaces ?? [];
    const matches = patterns.some((p) =>
      p.endsWith('/*') ? STANDALONE_DIR.startsWith(p.slice(0, -2) + '/') : p === STANDALONE_DIR,
    );
    expect(
      matches,
      `${STANDALONE_DIR} appears in root package.json "workspaces". It is a submodule with its ` +
        `own dependency graph — keep it in STANDALONE_PACKAGE_DIRS instead.`,
    ).toBe(false);
  });
});
