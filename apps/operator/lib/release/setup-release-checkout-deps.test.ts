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
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  readdirSync,
} from 'node:fs';
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

/**
 * sync_one_node_modules() — the ATOMIC node_modules refresh (2026-06-25 all-pages
 * connection-refused outage). The old in-place `rm -rf "$dest"; cp -al` left the LIVE
 * operator looking at a deleted/half-populated node_modules for the ~minute the root
 * copy took → 32 cluster workers respawned mid-copy, crash-looped on MODULE_NOT_FOUND,
 * and refused every page. The function builds into a sibling temp then swaps with two
 * fast renames, so the live tree is only ever COMPLETE (the swap window is the µs
 * between two rename(2) calls). These pin the functional contract: correct content,
 * wholesale replacement, relative-symlink preservation (the workspace isolation
 * invariant), and temp cleanup.
 */
describe('setup-release-checkout.sh sync_one_node_modules() — atomic node_modules swap', () => {
  function syncOne(src: string, dest: string): number {
    const wrapper = [
      'set -euo pipefail',
      'source <(sed -n "/^sync_one_node_modules()/,/^}/p" "$SETUP_SCRIPT")',
      'sync_one_node_modules "$SRC" "$DEST"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: { ...process.env, SETUP_SCRIPT: SCRIPT_PATH, SRC: src, DEST: dest },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`sync_one_node_modules failed (${r.status}): ${r.stderr || r.stdout}`);
    return r.status ?? -1;
  }

  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nm-swap-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('first-time (no dest): creates dest as a hardlink copy of src', () => {
    const src = join(work, 'src');
    mkdirSync(join(src, 'pkg'), { recursive: true });
    writeFileSync(join(src, 'pkg/index.js'), 'OK');
    const dest = join(work, 'dest');
    syncOne(src, dest);
    expect(readFileSync(join(dest, 'pkg/index.js'), 'utf8')).toBe('OK');
  });

  it('existing dest: swaps to the NEW content wholesale (stale entries gone, dest never absent)', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'marker.txt'), 'NEW');
    const dest = join(work, 'dest');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'marker.txt'), 'OLD');
    writeFileSync(join(dest, 'stale.txt'), 'STALE'); // not in src → must be gone after swap
    syncOne(src, dest);
    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('NEW');
    expect(existsSync(join(dest, 'stale.txt'))).toBe(false);
  });

  it('preserves relative workspace symlinks verbatim (../../packages/X isolation invariant)', () => {
    const src = join(work, 'src');
    mkdirSync(join(src, '@papercusp'), { recursive: true });
    symlinkSync('../../packages/flags', join(src, '@papercusp/flags')); // relative; dangling is fine
    const dest = join(work, 'dest');
    syncOne(src, dest);
    expect(lstatSync(join(dest, '@papercusp/flags')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, '@papercusp/flags'))).toBe('../../packages/flags');
  });

  it('leaves no .deploy-tmp / .deploy-old sibling dirs behind after a swap', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a'), '1');
    const dest = join(work, 'dest');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'a'), '0');
    syncOne(src, dest);
    const leftovers = readdirSync(work).filter((n) => n.includes('deploy-tmp') || n.includes('deploy-old'));
    expect(leftovers).toEqual([]);
  });
});
