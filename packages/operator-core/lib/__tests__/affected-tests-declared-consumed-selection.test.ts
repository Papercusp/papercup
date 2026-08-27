/**
 * affected-tests-declared-consumed-selection.test.ts — EI-21082046676950143 regression guard.
 *
 * `lint:declared-consumed` is the declared-vs-consumed sweep (WI-6444 / P-002): ~10s, and it
 * prints "24 consumed · 0 UNCONSUMED". It was reachable only from a ROOT npm script, so editing
 * a policed interface selected NOTHING and e.g. adding an optional field to `CellSpec` surfaced
 * ~14 min later inside `test:lane-pure`. Registering it in `REPO_WIDE_INVARIANT_GUARDS` closed
 * that — but only once BOTH of the following held, and each failed silently on its own:
 *
 *  1. `packages/operator-core` must DECLARE the script. The runner execs `script` inside
 *     `workspace` and skips a registration whose workspace declares no such script
 *     (affected-tests.mjs:815) — the entry looks deliberately wired and runs nowhere. That
 *     axis is already blocking in `lint:guard-reachability`
 *     (`findInertRepoWideRegistrations`, WI-37454), which selects on any package.json edit,
 *     so it is deliberately NOT re-asserted here.
 *
 *  2. The selection key must cover BOTH of the guard's registries. `DECLARED_FIELDS` is 9 of
 *     the 24 policed rows; the other 15 are `DECLARED_COLUMNS`, whose declaration site is a
 *     migration, not a `declaredIn` path. A fields-only key reads as wired while missing most
 *     of the guard's own surface — the same orphaned-guard shape one layer up. THAT is what
 *     this file guards, because nothing else fails when it regresses.
 *
 * It asserts BEHAVIOR via the real CLI's `--print-affected` probe (which exits before running
 * any suite), two-sided: a one-sided "the negative control passed" reads identically to a key
 * that selects nothing at all, which is exactly how the fields-only version looked correct.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declaringPaths,
  DECLARED_FIELDS,
  DECLARED_COLUMNS,
  DB_MIGRATION_DIR,
} from '../../../../scripts/check-declared-consumed.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');
const GUARD_LINE = 'AFFECTED_GUARD\t@papercusp/operator-core\tlint:declared-consumed';

/** Run the real selection probe for one changed path and report whether the guard attached. */
function selectsGuard(changedPath: string): boolean {
  const r = spawnSync(
    process.execPath,
    [AFFECTED_TESTS, '--changed-paths', changedPath, '--print-affected'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
  );
  // A probe that failed to run must never read as "not selected" — that is the false
  // negative this whole item is about.
  expect(r.status, `probe failed for ${changedPath}: ${r.stderr?.slice(-800)}`).toBe(0);
  return `${r.stdout}`.includes(GUARD_LINE);
}

describe('affected-tests: lint:declared-consumed selection (EI-21082046676950143)', () => {
  it('derives its policed paths from BOTH registries plus the registry module', () => {
    const paths = new Set(declaringPaths());

    // Both halves are non-empty, so neither loop can silently degrade to nothing.
    expect(DECLARED_FIELDS.length).toBeGreaterThan(0);
    expect(DECLARED_COLUMNS.length).toBeGreaterThan(0);

    for (const f of DECLARED_FIELDS) expect(paths).toContain(f.declaredIn);
    for (const c of DECLARED_COLUMNS) expect(paths).toContain(`${DB_MIGRATION_DIR}/${c.migration}`);

    // Adding a registry row is the most common edit that changes this sweep's verdict, so the
    // registry module must select the guard that judges it.
    expect(paths).toContain('scripts/check-declared-consumed.mjs');
  });

  it('selects the guard for a declared FIELD site', () => {
    expect(selectsGuard(DECLARED_FIELDS[0].declaredIn)).toBe(true);
  });

  it('selects the guard for a declared COLUMN site (the half a fields-only key misses)', () => {
    expect(selectsGuard(`${DB_MIGRATION_DIR}/${DECLARED_COLUMNS[0].migration}`)).toBe(true);
  });

  it('does NOT select the guard for an unpoliced path — the other side of the probe', () => {
    expect(selectsGuard('README.md')).toBe(false);
  });
});
