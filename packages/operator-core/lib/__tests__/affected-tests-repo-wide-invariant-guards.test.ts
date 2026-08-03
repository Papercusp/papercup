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

// The REAL exports of the lint, so the roots below cannot drift from the roots it scans.
import {
  SOURCE_ROOTS as PARTIAL_INDEX_SOURCE_ROOTS,
  SCHEMA_FILE_REL as PARTIAL_INDEX_SCHEMA_FILE,
} from '../../../../scripts/check-partial-index-alignment.mjs';
// Likewise the REAL scanned dir of the forward-compat lint, so the guard's routing
// prefix cannot drift from the directory the lint actually reads.
import { SQL_DIR_REL as MIGRATION_SQL_DIR } from '../../../../scripts/check-migration-forward-compat.mjs';

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

/**
 * WI-9434 — the SECOND instance of the class, wired the same way.
 *
 * `lint:partial-index-alignment` scans four roots but its ratchet ("the tree is
 * currently aligned") is a vitest file in @papercusp/operator-core, so three of
 * those four roots had no enforcement outside an operator-core-affecting change.
 *
 * The difference from chunk-safe, and why these tests are not a copy-paste: that
 * guard's enumeration is genuinely repo-wide, so its `appliesTo` is every TS file.
 * This one's scan is BOUNDED, so over-firing spends every agent's edit budget for a
 * finding that is impossible by construction — precision is part of the contract
 * here, and `does NOT attach for a TS file outside every scanned root` pins it.
 */
const PI_SCRIPT = 'lint:partial-index-alignment';
const PI_TASK = `${HOST_WORKSPACE} :: ${PI_SCRIPT}`;

/** A TS path under a scanned root that does NOT route to the host workspace. */
const PI_OUTSIDE_PATH = 'apps/operator/lib/release/green-checkpoint.ts';
/** A TS path under NO scanned root — the lint could never read it. */
const PI_UNSCANNED_PATH = 'apps/operator/app/adv/create/PreviewPanel.tsx';

describe('affected-tests: partial-index-alignment guard (WI-9434)', () => {
  it('attaches for a TS change outside the host workspace but inside a scanned root', () => {
    const out = dryTasks(PI_OUTSIDE_PATH);
    expect(
      out,
      `${PI_OUTSIDE_PATH} is inside the lint's scanned roots but routes to @papercusp/web, ` +
        'so without this attachment a misaligned `->>` query there gets ZERO local signal ' +
        'and first reds the shared fleet gate',
    ).toContain(PI_TASK);
  });

  /**
   * A REAL tracked TS file under `root`, or null.
   *
   * Must be a real path, not a synthesized one: the router maps a path to a workspace by
   * PACKAGE DIRECTORY, so an invented `<root>/__probe__.ts` sitting directly under
   * `libs/papercusp/packages` matches no package and selects nothing — which reads as
   * "the guard is not wired" when the wiring is fine. That false negative is what the
   * first version of this test reported.
   *
   * `--recurse-submodules` because two roots live in submodules. Gate-shaped checkouts
   * carry 0/39 submodules (WI-6776), so this returns null there and the case SKIPS rather
   * than failing — a guard test must not red the fleet gate over a checkout shape.
   */
  function realTsFileUnder(root: string): string | null {
    const res = spawnSync('git', ['ls-files', '--recurse-submodules', root], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) return null;
    return (res.stdout ?? '').split('\n').find((f) => /\.[cm]?tsx?$/.test(f)) ?? null;
  }

  it.each(PARTIAL_INDEX_SOURCE_ROOTS.map((root) => [root]))(
    'enforces the lint for a change under scanned root %s',
    (root: string) => {
      const probe = realTsFileUnder(root);
      if (!probe) {
        // Nothing tracked under this root in THIS checkout (submodule-less gate tree).
        expect(true).toBe(true);
        return;
      }
      const out = dryTasks(probe);
      // Either form means the ratchet is reached: the narrow guard task, or the host
      // workspace's full suite (which already contains the ratchet, so attaching the
      // narrow task as well would just run it twice).
      const reached = out.includes(PI_TASK) || out.includes(`${HOST_WORKSPACE} :: test`);
      expect(
        reached,
        `the lint SCANS ${root} (probe: ${probe}), so a change there must reach its ratchet — ` +
          `via "${PI_TASK}" or via "${HOST_WORKSPACE} :: test". This case is GENERATED from the ` +
          "lint's own exported SOURCE_ROOTS: if you added a root there and did not mirror it into " +
          'PARTIAL_INDEX_SOURCE_ROOTS in scripts/affected-tests.mjs, the guard silently stopped ' +
          `enforcing that root. Task list was:\n${out}`,
      ).toBe(true);
    },
  );

  it('attaches when the GENERATED SCHEMA changes, not just when source changes', () => {
    // The subtle case chunk-safe does not have: the schema is an INPUT to the lint, so a
    // new partial index can retroactively misalign an existing, untouched query.
    const out = dryTasks(PARTIAL_INDEX_SCHEMA_FILE);
    expect(
      out,
      `${PARTIAL_INDEX_SCHEMA_FILE} defines the partial indexes the lint aligns queries ` +
        'against; adding one can misalign a query nobody touched, so a schema-only change ' +
        'must still run the ratchet',
    ).toContain(PI_TASK);
  });

  it('does NOT double-run it when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_TS_PATH);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      "operator-core's suite already contains partial-index-alignment-guard.test.ts, whose " +
        'ratchet execs the same lint — attaching the narrow task too would run it twice',
    ).not.toContain(PI_TASK);
  });

  it('does NOT attach for a TS file outside every scanned root', () => {
    const out = dryTasks(PI_UNSCANNED_PATH);
    expect(
      out,
      `${PI_UNSCANNED_PATH} is outside every SOURCE_ROOT, so the lint cannot read it and ` +
        'cannot produce a finding. Unlike chunk-safe (whose enumeration IS repo-wide), ' +
        'firing here would spend every agent\'s edit budget for nothing.',
    ).not.toContain(PI_TASK);
  });

  it('keeps the guard script defined, and pointed at the SCRIPT rather than the vitest file', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(
      pkg.scripts?.[PI_SCRIPT],
      `${HOST_WORKSPACE} must define "${PI_SCRIPT}" — the router only builds a task when the ` +
        'script exists, so removing it re-opens the gap silently (green, and simply no longer checking)',
    ).toBeTruthy();
    // MEASURED: the standalone script is 0.57-0.60s; running the 20-test vitest file instead
    // costs 7.66s because vitest startup dominates. Every agent pays this on every matching
    // edit, so the narrow form is load-bearing, not a style preference.
    expect(
      pkg.scripts?.[PI_SCRIPT],
      'must invoke the standalone lint script; switching it to `vitest run …` would make the ' +
        'narrow task ~12x more expensive for the same ratchet',
    ).toContain('check-partial-index-alignment.mjs');
    expect(pkg.scripts?.[PI_SCRIPT]).not.toContain('vitest');
  });
});

/**
 * WI-9573 — the THIRD instance of the class, and the most expensive so far.
 *
 * Unlike the two guards above, `lint:migration-forward-compat` had NO local
 * enforcement point at all. It was invoked only by green-checkpoint
 * (apps/operator/lib/release/green-checkpoint.ts), and a `.sql` migration maps to no
 * workspace test suite — so there was no partial coverage to widen, the signal was
 * entirely absent, and a violation first surfaced as a red FLEET gate hours later,
 * blocking every agent. MEASURED 2026-08-03: it red-pinned the gate for 4 consecutive
 * runs on migrations 750/751/752/754/755, and three other sessions independently hit
 * the same wall the same day (EI-19409083906144989, EI-19407054630567497).
 *
 * The fourth test below is not ceremony — it pins the exact trap the author of this
 * guard fell into. The router silently `continue`s when the host workspace does not
 * define the script, so registering the guard while operator-core lacked
 * `lint:migration-forward-compat` produced a registry entry that attached NOTHING and
 * looked, from every output, exactly like success.
 */
describe('affected-tests: migration forward-compat guard (WI-9573)', () => {
  const FC_SCRIPT = 'lint:migration-forward-compat';
  const FC_TASK = `${HOST_WORKSPACE} :: ${FC_SCRIPT}`;
  /** A real migration, under the directory the lint itself reports scanning. */
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/750-drop-dead-hfc-partial-indexes.sql`;

  it('attaches for a migration .sql change, which routes to no operator-core suite', () => {
    const out = dryTasks(MIGRATION_PATH);
    expect(
      out,
      `a migration at ${MIGRATION_PATH} must run the forward-compat guard. Before this ` +
        'wiring it ran ONLY inside green-checkpoint, so destructive DDL with no ' +
        'FORWARD-COMPAT acknowledgment got zero local signal and red-pinned the shared ' +
        'gate for every agent hours later.',
    ).toContain(FC_TASK);
  });

  it('does NOT double-run it when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_TS_PATH);
    expect(out, 'the host workspace should run its own suite here').toContain(
      `${HOST_WORKSPACE} :: test`,
    );
    expect(
      out,
      "operator-core's full suite already covers this ratchet, so attaching the narrow " +
        'task as well would run the same scan twice',
    ).not.toContain(FC_TASK);
  });

  it('does NOT attach for a .sql OUTSIDE the scanned migrations directory', () => {
    // The discriminating case: same extension, different directory. A prefix-free
    // `endsWith('.sql')` rule would attach here and spend every agent's edit budget
    // on a scan that cannot produce a finding.
    const out = dryTasks('apps/operator/docs/examples/999-not-a-migration.sql');
    expect(
      out,
      `only files under ${MIGRATION_SQL_DIR}/ are scanned by the lint, so a .sql ` +
        'elsewhere cannot violate the invariant',
    ).not.toContain(FC_TASK);
  });

  it('keeps the guard script defined, so the attachment cannot silently no-op', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(
      pkg.scripts?.[FC_SCRIPT],
      `${HOST_WORKSPACE} must define "${FC_SCRIPT}". The router only builds a task when ` +
        'the script exists on the HOST workspace — defining it only in the ROOT ' +
        'package.json is not enough, and that exact mistake made this guard attach ' +
        'nothing while every probe still looked healthy.',
    ).toBeTruthy();
    expect(pkg.scripts?.[FC_SCRIPT]).toContain('check-migration-forward-compat.mjs');
  });
});
