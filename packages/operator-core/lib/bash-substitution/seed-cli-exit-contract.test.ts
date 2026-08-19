/**
 * seed-cli-exit-contract.test.ts — the three-way exit contract of
 * `scripts/seed-substitution-registry.ts --check` (EI-20822558150340173 / D-046).
 *
 * ## Why this exists
 *
 * D-046 wired `seed:substitutions:check` into `REPO_WIDE_INVARIANT_GUARDS`, which means
 * the affected-tests router now BRANCHES ON THIS SCRIPT'S EXIT STATUS:
 *
 *   0                 compared the pairs against real rows; they agree
 *   1                 compared them; they DISAGREE — the gate is enforcing stale rules
 *   EXIT_NOT_CHECKED  could not reach Postgres; NOTHING was compared
 *
 * Only the middle one is a finding, and the third is the whole reason the wiring was
 * admissible at all. Before D-046 the script exited **0** when the database was
 * unreachable — printing a ⚠ notice and then telling every caller "pass". That is the
 * failure `scripts/lib/not-checked.mjs` was extracted to kill, and its header describes
 * this exact shape: three guards inherited the NOT-CHECKED prose by copy and quietly
 * dropped the exit status, so each printed the warning and exited 0. A human reads the
 * headline; a script reads the status; the two said opposite things.
 *
 * That distinction had NO test before this file — the CLI had no test of any kind, which
 * is a large part of how it drifted in the first place. So this pins the one case that can
 * be proved hermetically, and it is also the one that matters most: with the guard wired
 * up, a regression to `exit 0` here would not fail anything loudly. It would just quietly
 * turn a repo-wide invariant guard into a step that always passes.
 *
 * ## Why only the unreachable-DB case
 *
 * The 0 and 1 arms both require a real database, so asserting them here would either make
 * this file DB-dependent (it is a pure-lane unit test) or make it lie. They are exercised
 * against live Postgres instead — verified 2026-08-19: a clean tree returned 0, and a
 * read-only probe against a workspace id with no rows returned 1 with 22 MISSING rows.
 * This arm needs no database precisely BECAUSE it is the absence-of-database arm, which
 * makes it both hermetic and the only one at risk of being "simplified" back to 0.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The shared verdict, imported rather than hardcoded as `2` — a copied constant is exactly
// how the prose and the status drift apart (see the file header).
import { EXIT_NOT_CHECKED } from '../../../../scripts/lib/not-checked.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SEED_CLI = resolve(REPO_ROOT, 'scripts/seed-substitution-registry.ts');
const TSX = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

/**
 * A database URL that cannot connect. `getHarnessAdminUrlWithSource` pins the `env` source
 * ahead of discovery and the native fallback, so this deterministically forces the
 * unreachable path rather than racing whatever Postgres happens to be up on this box.
 */
const UNREACHABLE_PG = 'postgres://nobody@127.0.0.1:59999/definitely-not-a-database';

describe('seed:substitutions:check exit contract (D-046)', () => {
  it('exits NOT_CHECKED — never 0 — when it could not reach the database', () => {
    // Fail loudly rather than skipping into a false pass if the toolchain moves.
    expect(existsSync(TSX), `tsx not found at ${TSX}`).toBe(true);
    expect(existsSync(SEED_CLI), `seeder CLI not found at ${SEED_CLI}`).toBe(true);

    const res = spawnSync(TSX, [SEED_CLI, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, HARNESS_ADMIN_DATABASE_URL: UNREACHABLE_PG },
    });

    expect(res.error, `CLI failed to spawn: ${res.error?.message}`).toBeUndefined();
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    // The status is what the affected-tests router branches on.
    expect(
      res.status,
      'an unreachable database must report NOT_CHECKED, not success — exiting 0 here makes ' +
        `the repo-wide guard a step that always passes. Output was:\n${out}`,
    ).toBe(EXIT_NOT_CHECKED);

    // And the headline a human reads must agree with it. These drifting apart IS the bug.
    expect(out).toContain('NOT CHECKED');
    expect(out).toContain('This is NOT a clean bill');
    expect(
      out,
      'the clean-comparison tick must not appear on a run that compared nothing',
    ).not.toContain('matches the audited pairs');
  });
});
