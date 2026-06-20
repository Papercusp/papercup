/**
 * Regression coverage for setup-release-checkout.sh `need_node_modules()` — the
 * deploy-pipeline staleness heuristic that decides whether the release /
 * green-checkpoint tree must re-hardlink-copy node_modules from the integration
 * tree (it "never npm installs" by design — apps/operator/bin/release/setup-release-checkout.sh).
 *
 * EI-935 (F-FIX-035): a new TOP-LEVEL, NON-scoped dependency (e.g. `rrule`) was
 * invisible to the original per-`@scope` diff, so a stale node_modules never
 * gained it — `Cannot find package 'rrule'` crashed the green-checkpoint AND would
 * crash the deployed operator at import time, blocking EVERY deploy until someone
 * hand-copied the dep. The fix diffs the FULL top-level listing (scoped + non-scoped)
 * and falls back to a lockfile compare. This locks that behaviour so the class can't
 * silently regress and re-wedge the pipeline.
 *
 * Both the deploy (deploy-deps.realDeps.runSetup) and the green-checkpoint
 * (green-checkpoint.realCheckpointDeps.setupTree) shell THIS script with
 * `--node-modules auto`, so this one function gates both paths.
 *
 * The function reads its inputs from the script-level globals INTEGRATION_ROOT /
 * RELEASE_ROOT / NODE_MODULES_MODE. We extract just the function from the real
 * script (so the test tracks the shipped logic, never a copy) and invoke it under
 * controlled temp trees — the same isolation pattern as verify-release-paths.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// apps/operator/lib/release → apps/operator/bin/release/setup-release-checkout.sh
const SCRIPT_PATH = join(__dirname, '../../bin/release/setup-release-checkout.sh');

/**
 * Run the real `need_node_modules()` against the given trees. Returns true when the
 * function decided a re-copy is NEEDED (exit 0) and false when node_modules is
 * up-to-date (exit 1) — the script's own `return 0`/`return 1` contract.
 */
function needsCopy(integrationRoot: string, releaseRoot: string, mode = 'auto'): boolean {
  // Source ONLY the function out of the live script, then call it — the same
  // extraction the function's globals expect, so we exercise shipped logic.
  const wrapper = [
    'set -uo pipefail',
    'source <(sed -n "/^need_node_modules()/,/^}/p" "$SETUP_SCRIPT")',
    'need_node_modules',
  ].join('\n');
  const r = spawnSync('bash', ['-c', wrapper], {
    env: {
      ...process.env,
      SETUP_SCRIPT: SCRIPT_PATH,
      INTEGRATION_ROOT: integrationRoot,
      RELEASE_ROOT: releaseRoot,
      NODE_MODULES_MODE: mode,
    },
    encoding: 'utf8',
  });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`need_node_modules exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

/** Create a node_modules package dir (with a package.json) under `root`. */
function addPkg(root: string, name: string): void {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
}

let int: string;
let rel: string;

beforeEach(() => {
  int = mkdtempSync(join(tmpdir(), 'nm-int-'));
  rel = mkdtempSync(join(tmpdir(), 'nm-rel-'));
  // Baseline both trees: the scoped workspace roots present + identical, no
  // non-scoped deps, no lockfiles → the function's "nothing changed" state.
  for (const root of [int, rel]) {
    mkdirSync(join(root, 'node_modules/@papercusp'), { recursive: true });
    mkdirSync(join(root, 'node_modules/@papercup'), { recursive: true });
  }
});

afterEach(() => {
  rmSync(int, { recursive: true, force: true });
  rmSync(rel, { recursive: true, force: true });
});

describe('setup-release-checkout.sh need_node_modules() — deploy staleness heuristic', () => {
  it('copies when the release tree has no node_modules at all', () => {
    rmSync(join(rel, 'node_modules'), { recursive: true, force: true });
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('does NOT copy when the dep state is identical (no lockfiles, same package set)', () => {
    expect(needsCopy(int, rel)).toBe(false);
  });

  it('copies when a new SCOPED workspace package appears in the integration tree', () => {
    addPkg(int, '@papercusp/new-package');
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('EI-935: copies when a new NON-scoped top-level dep (rrule) appears in the integration tree', () => {
    // The exact regression: a non-scoped dep the per-@scope diff could not see.
    addPkg(int, 'rrule');
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('does NOT over-copy when the same non-scoped dep is present in BOTH trees', () => {
    addPkg(int, 'rrule');
    addPkg(rel, 'rrule');
    expect(needsCopy(int, rel)).toBe(false);
  });

  it('copies when the root package-lock.json differs (deps changed, dirs unchanged)', () => {
    writeFileSync(join(int, 'package-lock.json'), '{"lockfileVersion":3,"a":1}');
    writeFileSync(join(rel, 'package-lock.json'), '{"lockfileVersion":3,"a":2}');
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('copies (fail-safe) when the integration tree has a lockfile but the release tree does not', () => {
    writeFileSync(join(int, 'package-lock.json'), '{"lockfileVersion":3}');
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('does NOT copy when package-lock.json is identical and the package set matches', () => {
    const lock = '{"lockfileVersion":3,"packages":{}}';
    writeFileSync(join(int, 'package-lock.json'), lock);
    writeFileSync(join(rel, 'package-lock.json'), lock);
    expect(needsCopy(int, rel)).toBe(false);
  });

  it('ignores a difference confined to dot-prefixed entries (.bin/.package-lock.json) — not a real dep change', () => {
    // The non-scoped diff filters `^\.` entries; a difference only there must NOT
    // trip a copy on its own (it falls through to the lockfile compare → no lockfiles → no copy).
    mkdirSync(join(int, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(int, 'node_modules/.package-lock.json'), '{}');
    expect(needsCopy(int, rel)).toBe(false);
  });

  it('mode=skip never copies, even when node_modules is missing in the release tree', () => {
    rmSync(join(rel, 'node_modules'), { recursive: true, force: true });
    expect(needsCopy(int, rel, 'skip')).toBe(false);
  });

  it('mode=force always copies, even when the dep state is identical', () => {
    expect(needsCopy(int, rel, 'force')).toBe(true);
  });
});
