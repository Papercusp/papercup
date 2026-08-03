/**
 * affected-tests-repo-wide-invariant-guards.test.ts — EI-19388389386110890 regression guard.
 *
 * ## The gap this covers
 *
 * `scripts/affected-tests.mjs` selects suites by WORKSPACE. That is right for a
 * test that covers its own workspace, and wrong for a check whose SCOPE is the
 * whole repository but which happens to live in one workspace's suite: the check
 * then runs only when its host workspace is independently affected.
 *
 * `child-output-guard.test.ts` is that shape. It enumerates via
 * `git ls-files --recurse-submodules` — ~20k TypeScript paths across 39
 * submodules — but it is a vitest file inside @papercusp/operator-core. So a
 * chunk-unsafe `stdout += String(chunk)` introduced anywhere ELSE produced no
 * local signal at all (test:affected green; lint:tsc is type-only and green) and
 * first surfaced hours later as a red FLEET gate blocking every agent. That is
 * the entire reported history of the class: five separate CORRECT fixes
 * (EI-19298378364087215, EI-19356631236774183, WI-6776, WI-6666/WI-6667), each
 * caught at the most expensive possible moment, each looking like fresh breakage
 * because each offender genuinely was new.
 *
 * `REPO_WIDE_INVARIANT_GUARDS` closes it by attaching a NARROW, cheap task
 * (~1s, 14 assertions) whenever a matching path changes anywhere.
 *
 * ## What this guard asserts, and what it does not
 *
 * It asserts BEHAVIOR through the real CLI's `--dry` probe (builds the task list,
 * runs nothing), never source text. It covers the four independent ways the
 * wiring silently reopens:
 *
 *   1. the guard stops being attached for changes outside its host workspace —
 *      the original bug, and the one that reads as "green" rather than as broken;
 *   2. it starts double-running when the host workspace IS affected (the whole
 *      suite already contains it) — cheap to miss, since duplicated work still
 *      passes;
 *   3. it fires for changes that cannot possibly violate the invariant;
 *   4. the `lint:chunk-safe` script disappears from operator-core's package.json,
 *      which would make the attachment a silent no-op — the same failure shape as
 *      WI-6077's missing `test` script.
 *
 * It does NOT assert that the guard itself is correct; that is
 * child-output-guard.test.ts's job.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const HOST_WORKSPACE = '@papercusp/operator-core';
const GUARD_SCRIPT = 'lint:chunk-safe';
const GUARD_TASK = `${HOST_WORKSPACE} :: ${GUARD_SCRIPT}`;

/**
 * A TS path OUTSIDE the guard's host workspace. `apps/operator` is the measured
 * case from the filing: it routes to @papercusp/web, never to operator-core.
 */
const OUTSIDE_TS_PATH = 'apps/operator/lib/release/deploy-cli.ts';
/** A TS path INSIDE the host workspace, whose full `test` task already covers the guard. */
const INSIDE_TS_PATH = 'packages/operator-core/lib/terminal-spawn.ts';
/** A non-source path that cannot introduce a stream accumulator. */
const NON_SOURCE_PATH = 'apps/operator/docs/nuqs-audit-2026-05-11.md';

/**
 * Run the real CLI in --dry mode: it resolves the affected set and BUILDS the task
 * list, then exits without executing a suite. Deliberately the same probe shape the
 * standalone-packages guard uses — asserting on behavior keeps this test honest if
 * the mechanism is ever reimplemented differently.
 */
function dryTasks(changedPaths: string): string {
  const res = spawnSync(
    process.execPath,
    [AFFECTED_TESTS, '--changed-paths', changedPaths, '--dry'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
  );
  // Fail loudly rather than letting a crashed probe read as "guard absent" — a
  // non-zero exit with empty stdout would otherwise satisfy every `not.toContain`.
  expect(res.error, `CLI failed to spawn: ${res.error?.message}`).toBeUndefined();
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  expect(out, 'probe produced no output — cannot conclude anything about task selection').not.toBe('');
  expect(out).toContain('AFFECTED_TESTS_RESULT');
  return out;
}

describe('affected-tests: repo-wide invariant guards (EI-19388389386110890)', () => {
  it('attaches the chunk-safe guard for a TS change OUTSIDE its host workspace', () => {
    const out = dryTasks(OUTSIDE_TS_PATH);
    // The regression: before this wiring, operator-core was simply absent here.
    expect(
      out,
      `a TS change at ${OUTSIDE_TS_PATH} must still run the repo-wide chunk-safe guard; ` +
        'without it, a chunk-unsafe accumulator introduced outside operator-core gets ' +
        'ZERO local signal and first reds the shared gate hours later',
    ).toContain(GUARD_TASK);
  });

  it('does NOT double-run it when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_TS_PATH);
    expect(out, 'the host workspace should run its own suite here').toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      `${HOST_WORKSPACE}'s full test suite already contains child-output-guard.test.ts, so ` +
        'attaching the narrow task as well would run the same assertions twice',
    ).not.toContain(GUARD_TASK);
  });

  it('does NOT attach it for a change that cannot violate the invariant', () => {
    const out = dryTasks(NON_SOURCE_PATH);
    expect(
      out,
      'the guard is paid for by every agent on every edit; attaching it to non-source ' +
        'changes spends that budget for no possible finding',
    ).not.toContain(GUARD_TASK);
  });

  it('keeps the guard script defined, so the attachment cannot silently no-op', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(
      pkg.scripts?.[GUARD_SCRIPT],
      `${HOST_WORKSPACE} must define "${GUARD_SCRIPT}". The router only builds a task when ` +
        'the script exists, so removing it re-opens the gap silently — the run stays green ' +
        'and simply stops checking (the WI-6077 missing-`test`-script failure shape).',
    ).toBeTruthy();
    expect(pkg.scripts?.[GUARD_SCRIPT]).toContain('child-output-guard.test.ts');
  });
});
