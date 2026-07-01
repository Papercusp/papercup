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
  realpathSync,
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

/**
 * rebuild_stale_native_addons() — native-addon ABI guard (infra-fail-fast P-003 / WI-349).
 *
 * The 2026-06-19 :3070 outage: papercup-release's better-sqlite3 was built for
 * Node 22 (ABI 127) while the service ran Node 25 (ABI 141). The hardlink-copy
 * (step 3) carries whatever ABI the INTEGRATION tree built under — if the
 * runtime Node differs, the binary fails to load. This function test-loads each
 * critical addon and `npm rebuild`s it in the release checkout on a mismatch,
 * so the release tree self-heals before the deploy-gate preflight can block it.
 *
 * Tested here via the same sed-extraction pattern as need_node_modules /
 * sync_one_node_modules: extract ONLY the named function from the live script
 * and drive it with controlled temp trees + fake `node`/`npm` stubs on PATH.
 */
describe('setup-release-checkout.sh rebuild_stale_native_addons() — native-addon ABI guard', () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'abi-guard-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /**
   * Run rebuild_stale_native_addons() with fake node/npm stubs that let us
   * control whether require() and npm rebuild succeed or fail.
   *
   * `nodeLoads`: what `node -e "require('$addon')"` returns (0=ok, 1=fail).
   *   Pass an array for sequential calls: [firstCallExit, secondCallExit, …].
   *   If a call count exceeds the array, the last entry is reused.
   * `npmRebuildExit`: what `npm rebuild $addon` returns (0=ok, 1=fail).
   */
  function runGuard(opts: {
    releaseRoot: string;
    addonName?: string;
    /** Per-call exit codes for `node -e "require(...)"`. Single number = constant. */
    nodeLoads?: number | number[];
    /** Exit code for `npm rebuild`. */
    npmRebuildExit?: number;
  }): { status: number | null; stdout: string; stderr: string } {
    const binDir = join(work, 'fake-bin');
    mkdirSync(binDir, { recursive: true });

    // Write a stateful node stub. Uses a call-counter file so each invocation
    // can return a different exit code for sequential test scenarios.
    const callCountFile = join(work, 'node-call-count');
    const exitsArg = Array.isArray(opts.nodeLoads)
      ? opts.nodeLoads.join(' ')
      : String(opts.nodeLoads ?? 0);
    const nodeStub = [
      '#!/usr/bin/env bash',
      // Only intercept the require() probe; delegate real node calls (e.g. -p) to the real node.
      'if [[ "$*" == *"require("* ]]; then',
      `  exits=(${exitsArg})`,
      `  count_file=${JSON.stringify(callCountFile)}`,
      '  count=0; [ -f "$count_file" ] && count="$(cat "$count_file")"',
      '  idx=$(( count < ${#exits[@]} ? count : ${#exits[@]} - 1 ))',
      '  echo $(( count + 1 )) > "$count_file"',
      '  exit "${exits[$idx]}"',
      'fi',
      // For non-require calls (e.g. `node -p ...`), forward to the real node.
      `exec ${process.execPath} "$@"`,
    ].join('\n');
    writeFileSync(join(binDir, 'node'), nodeStub, { mode: 0o755 });

    // npm stub: always returns the requested exit code.
    const npmExit = opts.npmRebuildExit ?? 0;
    const npmStub = `#!/usr/bin/env bash\nexit ${npmExit}\n`;
    writeFileSync(join(binDir, 'npm'), npmStub, { mode: 0o755 });

    const addon = opts.addonName ?? 'better-sqlite3';
    const wrapper = [
      'set -uo pipefail',
      // Extract rebuild_stale_native_addons from the script, plus the log helper it calls.
      'log() { echo "[setup-release] $*"; }',
      `source <(sed -n '/^rebuild_stale_native_addons()/,/^}/p' "$SETUP_SCRIPT")`,
      'rebuild_stale_native_addons',
    ].join('\n');

    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        SETUP_SCRIPT: SCRIPT_PATH,
        RELEASE_ROOT: opts.releaseRoot,
        PAPERCUSP_PREFLIGHT_ADDONS: addon,
      },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('skips an addon whose node_modules dir is absent (not installed on this path)', () => {
    // releaseRoot has no node_modules/better-sqlite3 → skip silently
    mkdirSync(join(work, 'release'), { recursive: true });
    const r = runGuard({ releaseRoot: join(work, 'release'), nodeLoads: 1 });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/WARN|ERROR|rebuild/i);
  });

  it('skips an addon that loads cleanly (ABI matches — no rebuild needed)', () => {
    const rel = join(work, 'release');
    mkdirSync(join(rel, 'node_modules', 'better-sqlite3'), { recursive: true });
    const r = runGuard({ releaseRoot: rel, nodeLoads: 0 }); // require() → OK
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/WARN|ERROR|rebuild/i);
  });

  it('rebuilds when the addon fails to load, and succeeds (the ABI-mismatch auto-heal path)', () => {
    // 1st require() call → fail (ABI mismatch); 2nd (post-rebuild) → OK
    const rel = join(work, 'release');
    mkdirSync(join(rel, 'node_modules', 'better-sqlite3'), { recursive: true });
    const r = runGuard({ releaseRoot: rel, nodeLoads: [1, 0], npmRebuildExit: 0 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARN.*will not load/);
    expect(r.stdout).toMatch(/rebuilt OK/);
    expect(r.stdout).not.toMatch(/STILL will not load/);
  });

  it('logs ERROR and returns non-zero when addon still will not load after rebuild', () => {
    const rel = join(work, 'release');
    mkdirSync(join(rel, 'node_modules', 'better-sqlite3'), { recursive: true });
    // require() always fails; npm rebuild "succeeds" but the binary still doesn't load
    const r = runGuard({ releaseRoot: rel, nodeLoads: 1, npmRebuildExit: 0 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/WARN.*will not load/);
    expect(r.stdout).toMatch(/STILL will not load/);
  });

  it('logs ERROR and returns non-zero when npm rebuild itself fails', () => {
    const rel = join(work, 'release');
    mkdirSync(join(rel, 'node_modules', 'better-sqlite3'), { recursive: true });
    const r = runGuard({ releaseRoot: rel, nodeLoads: 1, npmRebuildExit: 1 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/WARN.*will not load/);
    expect(r.stdout).toMatch(/STILL will not load/);
  });

  it('respects PAPERCUSP_PREFLIGHT_ADDONS: skips when the named addon dir is absent', () => {
    const rel = join(work, 'release');
    mkdirSync(rel, { recursive: true });
    // sodium-native is not installed in this temp tree → guard skips it silently
    const r = runGuard({ releaseRoot: rel, addonName: 'sodium-native', nodeLoads: 1 });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/WARN|ERROR/);
  });

  it('integration: real better-sqlite3 loads cleanly under the current Node ABI (no rebuild needed)', () => {
    // Run the guard against the REAL integration tree's release checkout to confirm
    // the 2026-06-19 outage class is not currently manifesting.
    const releaseRoot = '/home/marsh-office/papercupai-workspace/papercup-release';
    if (!existsSync(join(releaseRoot, 'node_modules', 'better-sqlite3'))) {
      // Release checkout not set up — skip (CI / fresh clone); not a test failure.
      return;
    }
    const wrapper = [
      'set -uo pipefail',
      'log() { echo "[setup-release] $*"; }',
      `source <(sed -n '/^rebuild_stale_native_addons()/,/^}/p' "$SETUP_SCRIPT")`,
      'rebuild_stale_native_addons',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        RELEASE_ROOT: releaseRoot,
        PAPERCUSP_PREFLIGHT_ADDONS: 'better-sqlite3',
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    // No rebuild should be needed when the binary is already built for ABI 141.
    expect((r.stdout ?? '') + (r.stderr ?? '')).not.toMatch(/WARN|ERROR|rebuild/i);
  });
});
