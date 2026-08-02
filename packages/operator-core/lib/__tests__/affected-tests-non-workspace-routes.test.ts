/**
 * affected-tests-non-workspace-routes.test.ts — EI-19346163916263067 regression guard.
 *
 * `scripts/affected-tests.mjs` maps a changed path to a workspace by matching it
 * against each WORKSPACE DIRECTORY. Root `scripts/` is not an npm workspace and holds
 * no package.json, so every path under it matched NOTHING and contributed zero to the
 * affected set — while being the repo's own gate machinery (affected-tests.mjs itself,
 * lint-tsc*.mjs, gen-declarations.ts, next-migration.mjs, the 53 `check-*.mjs` guards).
 * The tooling that decides what gets tested was the one thing it could not select
 * tests for.
 *
 * MEASURED before the fix (last 600 commits of staging): 106 commits touched
 * `scripts/`; for 7 of them the computed affected set did not include operator-core,
 * so the ~56 suites that exercise those scripts never ran — and one (33edac17e5)
 * selected ZERO workspaces and reported `status=passed tasks=0` having run nothing.
 *
 * These assert BEHAVIOR through the real CLI (`--changed-paths … --print-affected`,
 * which exits before executing any suite), not source text.
 *
 * NOTE ON CONTROLS: the negative cases below are not decoration. `expect(...).toContain`
 * on a route target would pass just as happily if the route had become a catch-all that
 * selects every workspace for every path, and an "empty" assertion would pass if the
 * probe were simply broken and always printed nothing. Each direction is pinned by a
 * case that must come out the other way.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const ROUTED_DIR = 'scripts/';
const ROUTE_TARGET = '@papercusp/operator-core';

/** The affected workspace names the real CLI computes for an explicit path set. */
function affectedFor(paths: string[]): string[] {
  const r = spawnSync(
    'node',
    [AFFECTED_TESTS, '--changed-paths', paths.join(','), '--print-affected'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  expect(r.status, `affected-tests --print-affected failed:\n${r.stderr}`).toBe(0);
  return (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('AFFECTED_WS\t'))
    .map((l) => l.slice('AFFECTED_WS\t'.length).trim());
}

describe('affected-tests: non-workspace path routes (EI-19346163916263067)', () => {
  it('routes a root scripts/ change to the workspace that owns its tests', () => {
    expect(
      affectedFor([`${ROUTED_DIR}lint-tsc.mjs`]),
      `A change to ${ROUTED_DIR}** no longer selects ${ROUTE_TARGET}, so none of the ~56 ` +
        `suites that exercise root scripts/ would run for it — including every check-*.mjs ` +
        `guard test. Check NON_WORKSPACE_PATH_ROUTES in scripts/affected-tests.mjs.`,
    ).toContain(ROUTE_TARGET);
  });

  it('CONTROL: an unrouted root file still selects nothing — the route is not a catch-all', () => {
    // Without this, the assertion above is satisfied by a rule that selects everything
    // for everything, which would be a far worse bug than the one being fixed.
    expect(
      affectedFor(['README.md']),
      'A root file with no owning workspace and no route now selects workspaces. The ' +
        'routing fallback has become a catch-all; every commit would run those suites.',
    ).toEqual([]);
  });

  it('CONTROL: a genuine workspace path still resolves through the workspace-dir rule', () => {
    // Pins the other direction: the probe really can return a non-empty set for a
    // normal path, so the empty result above is a fact about routing, not a broken probe.
    expect(affectedFor(['libs/flags/src/types.ts'])).toContain('@papercusp/flags');
  });

  it('defers to a real workspace that owns the path — routing is a fallback, not an override', () => {
    // `apps/operator/scripts/**` is inside the @papercusp/web workspace. It must resolve
    // there and NOT be dragged into the root-scripts route by a naive substring match.
    const affected = affectedFor(['apps/operator/scripts/some-tool.mjs']);
    expect(affected).toContain('@papercusp/web');
    expect(
      affected,
      'apps/operator/scripts/** is owned by @papercusp/web but is being routed as if it ' +
        'were root scripts/. The route must only apply when no workspace claims the path.',
    ).not.toContain(ROUTE_TARGET);
  });

  it("THE RATCHET: the route's premise holds — root scripts/ is still not an npm workspace", () => {
    // If `scripts` ever becomes a workspace, the workspace-dir rule claims it and this
    // route becomes dead code that silently stops being the thing under test.
    const patterns: string[] = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
    ).workspaces ?? [];
    const claimed = patterns.some((p) =>
      p.endsWith('/*') ? 'scripts'.startsWith(p.slice(0, -2) + '/') : p === 'scripts',
    );
    expect(
      claimed,
      'root `scripts` is now an npm workspace — remove its NON_WORKSPACE_PATH_ROUTES entry ' +
        'so the workspace-dir rule owns it, rather than leaving a dead route behind.',
    ).toBe(false);
  });

  it('THE RATCHET: the routed workspace still owns tests that exercise root scripts/', () => {
    // The route is only correct while the suites it aims at live there. If they move,
    // the route keeps "working" while selecting a workspace that covers nothing.
    const r = spawnSync(
      'bash',
      [
        '-c',
        `grep -rl "scripts/" --include=*.test.ts --include=*.test.tsx packages/operator-core | wc -l`,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(
      Number(String(r.stdout).trim()),
      `${ROUTE_TARGET} no longer holds a meaningful number of tests referencing root scripts/. ` +
        'If those suites moved, move the route with them.',
    ).toBeGreaterThan(20);
  });
});
