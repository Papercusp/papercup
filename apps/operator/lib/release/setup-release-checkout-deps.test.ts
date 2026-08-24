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
  statSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  openSync,
  closeSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// apps/operator/lib/release → apps/operator/bin/release/setup-release-checkout.sh
const SCRIPT_PATH = join(__dirname, '../../bin/release/setup-release-checkout.sh');
const DEPENDENCY_GENERATION_SCRIPT = join(
  __dirname,
  '../../bin/release/dependency-generation.sh',
);
const REPO_ROOT = resolve(__dirname, '../../../..');

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

function recordCopyMetadata(
  integrationRoot: string,
  releaseRoot: string,
  generationId: string,
  sourceFingerprint: string,
): { status: number | null; stdout: string; stderr: string } {
  const wrapper = [
    'set -euo pipefail',
    'log() { printf "[setup-release] %s\\n" "$*"; }',
    'source <(sed -n "/^record_node_modules_copy_metadata()/,/^}/p" "$SETUP_SCRIPT")',
    'record_node_modules_copy_metadata',
  ].join('\n');
  const r = spawnSync('bash', ['-c', wrapper], {
    env: {
      ...process.env,
      SETUP_SCRIPT: SCRIPT_PATH,
      INTEGRATION_ROOT: integrationRoot,
      RELEASE_ROOT: releaseRoot,
      PINNED_DEPENDENCY_GENERATION_ID: generationId,
      DEPENDENCY_GENERATION_SOURCE_FINGERPRINT: sourceFingerprint,
    },
    encoding: 'utf8',
  });
  return {
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  };
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

  it('copies when the integration lock differs from the ignored dependency-copy stamp', () => {
    writeFileSync(join(int, 'package-lock.json'), '{"lockfileVersion":3,"a":1}');
    writeFileSync(join(rel, 'node_modules/.papercusp-source-package-lock.json'), '{"lockfileVersion":3,"a":2}');
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('copies (fail-safe) when the integration tree has a lockfile but no dependency-copy stamp', () => {
    writeFileSync(join(int, 'package-lock.json'), '{"lockfileVersion":3}');
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('does NOT copy when the dependency-copy stamp is current and the package set matches', () => {
    const lock = '{"lockfileVersion":3,"packages":{}}';
    writeFileSync(join(int, 'package-lock.json'), lock);
    writeFileSync(join(rel, 'node_modules/.papercusp-source-package-lock.json'), lock);
    expect(needsCopy(int, rel)).toBe(false);
  });

  it('never treats the pinned tracked package-lock.json as the dependency-copy stamp', () => {
    const lock = '{"lockfileVersion":3,"packages":{}}';
    writeFileSync(join(int, 'package-lock.json'), lock);
    writeFileSync(join(rel, 'package-lock.json'), lock);
    expect(needsCopy(int, rel)).toBe(true);
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

  it('records an empty dependency generation when no root node_modules was copied', () => {
    rmSync(join(rel, 'node_modules'), { recursive: true, force: true });
    const generationId = `v1-${'e'.repeat(64)}`;
    const sourceFingerprint = 'e'.repeat(64);

    const result = recordCopyMetadata(
      int,
      rel,
      generationId,
      sourceFingerprint,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `DEPENDENCY_GENERATION_PIN identity=${generationId}`,
    );
    expect(
      readFileSync(
        join(rel, 'node_modules/.papercusp-dependency-generation'),
        'utf8',
      ),
    ).toBe(`identity=${generationId}\nsource=${sourceFingerprint}\n`);
  });
});

describe('setup-release-checkout.sh assert_hardlink_compatible_roots() — cross-device guard', () => {
  function assertCompatible(releaseRoot: string, copyMode = 'hardlink'): { status: number | null; stdout: string; stderr: string } {
    const wrapper = [
      'set -uo pipefail',
      'source <(sed -n "/^filesystem_device()/,/^}/p; /^assert_hardlink_compatible_roots()/,/^}/p" "$SETUP_SCRIPT")',
      'assert_hardlink_compatible_roots',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: REPO_ROOT,
        RELEASE_ROOT: releaseRoot,
        NODE_MODULES_COPY_MODE: copyMode,
      },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('passes when the release root is on the same filesystem', () => {
    const releaseRoot = mkdtempSync(join(dirname(REPO_ROOT), 'release-root-same-device-'));
    try {
      expect(assertCompatible(releaseRoot).status).toBe(0);
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('fails once with an actionable message before cross-device hardlink copy', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'release-root-cross-device-'));
    try {
      const result = assertCompatible(releaseRoot);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('same filesystem');
      expect(result.stderr).toContain('--node-modules-copy copy');
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('allows explicit copy mode across filesystems', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'release-root-copy-mode-'));
    try {
      expect(assertCompatible(releaseRoot, 'copy').status).toBe(0);
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
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
  function syncOne(src: string, dest: string, copyMode = 'hardlink'): number {
    const wrapper = [
      'set -euo pipefail',
      'log() { :; }',
      'source "$GENERATION_SCRIPT"',
      'source <(sed -n "/^node_modules_tree_fingerprint()/,/^}/p; /^sync_one_node_modules()/,/^}/p" "$SETUP_SCRIPT")',
      'sync_one_node_modules "$SRC" "$DEST"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        GENERATION_SCRIPT: DEPENDENCY_GENERATION_SCRIPT,
        SRC: src,
        DEST: dest,
        NODE_MODULES_COPY_MODE: copyMode,
      },
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

  it('copy mode isolates checkpoint files from later integration-tree mutation', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'marker.txt'), 'BEFORE-INSTALL');
    const dest = join(work, 'dest');

    syncOne(src, dest, 'copy');
    writeFileSync(join(src, 'marker.txt'), 'AFTER-INSTALL');

    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('BEFORE-INSTALL');
    expect(statSync(join(dest, 'marker.txt')).ino).not.toBe(statSync(join(src, 'marker.txt')).ino);
  });

  it('copy mode reuses an unchanged prior isolated snapshot without copying file payloads again', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'large.bin'), Buffer.alloc(1024 * 1024, 7));
    const dest = join(work, 'dest');

    syncOne(src, dest, 'copy');
    const sourceInode = statSync(join(src, 'large.bin')).ino;
    const firstSnapshotInode = statSync(join(dest, 'large.bin')).ino;
    syncOne(src, dest, 'copy');

    expect(statSync(join(dest, 'large.bin')).ino).toBe(firstSnapshotInode);
    expect(statSync(join(dest, 'large.bin')).ino).not.toBe(sourceInode);
    expect(readFileSync(join(dest, '.papercusp-isolated-snapshot'), 'utf8')).toMatch(
      /^source=[0-9a-f]{64}\nsnapshot=[0-9a-f]{64}\n$/,
    );
  });

  it('copy mode rejects a drifted prior snapshot and restores it from integration', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'marker.txt'), 'CANONICAL');
    const dest = join(work, 'dest');

    syncOne(src, dest, 'copy');
    const firstSnapshotInode = statSync(join(dest, 'marker.txt')).ino;
    writeFileSync(join(dest, 'marker.txt'), 'MUTATED-BY-TEST');
    syncOne(src, dest, 'copy');

    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('CANONICAL');
    expect(statSync(join(dest, 'marker.txt')).ino).not.toBe(firstSnapshotInode);
    expect(statSync(join(dest, 'marker.txt')).ino).not.toBe(statSync(join(src, 'marker.txt')).ino);
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

  it('skips a source that vanished after enumeration instead of crashing the gate', () => {
    const vanished = join(work, 'sidecar.old.2029466/node_modules');
    const dest = join(work, 'release-sidecar/node_modules');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'marker.txt'), 'STABLE');

    expect(syncOne(vanished, dest)).toBe(0);
    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('STABLE');
  });
});

/**
 * WI-39301: a co-hosted pnpm app's copied root package symlinks point through
 * node_modules/.pnpm. The old unconditional "debris" cleanup removed that source-backed
 * virtual store after the atomic copy, leaving present-by-name but dangling packages and
 * failing the checkpoint before tests (TypeScript MODULE_NOT_FOUND). Exercise the shipped
 * cleanup function directly so npm-only debris is still pruned without breaking pnpm apps.
 */
describe('setup-release-checkout.sh prune_stale_pnpm_store() — package-manager-aware cleanup', () => {
  function prunePnpmStore(integrationRoot: string, releaseRoot: string): void {
    const wrapper = [
      'set -euo pipefail',
      'log() { :; }',
      'source <(sed -n "/^prune_stale_pnpm_store()/,/^}/p" "$SETUP_SCRIPT")',
      'prune_stale_pnpm_store',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`prune_stale_pnpm_store failed (${r.status}): ${r.stderr || r.stdout}`);
    }
  }

  it('preserves a copied .pnpm store when the integration source is pnpm-backed', () => {
    const sourceTsc = join(int, 'node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc');
    const releaseTsc = join(rel, 'node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc');
    mkdirSync(join(sourceTsc, '..'), { recursive: true });
    mkdirSync(join(releaseTsc, '..'), { recursive: true });
    writeFileSync(sourceTsc, 'source');
    writeFileSync(releaseTsc, 'release');

    prunePnpmStore(int, rel);

    expect(readFileSync(releaseTsc, 'utf8')).toBe('release');
  });

  it('removes a release-only .pnpm store when the integration source has none', () => {
    const staleStore = join(rel, 'node_modules/.pnpm/orphan');
    mkdirSync(staleStore, { recursive: true });

    prunePnpmStore(int, rel);

    expect(existsSync(join(rel, 'node_modules/.pnpm'))).toBe(false);
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
    const releaseRoot = '/home/dev/papercupai-workspace/papercup-release';
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

/**
 * Symlink-safe root resolution (EI-5307) — the node_modules copy enumeration must
 * survive a SYMLINKED INTEGRATION_ROOT.
 *
 * papercupai-workspace/papercup is a symlink -> papercusp (since 2026-06-25), and
 * deploy-cli passed that symlink as `--integration`. Step 3's copy loop enumerates
 * package-local node_modules with `find "$INTEGRATION_ROOT" -name node_modules -type d
 * -prune`, and `find` (default -P) does NOT descend a symlinked START path — so the
 * loop enumerated ZERO dirs and copied NOTHING while still logging "node_modules sync
 * complete". The release tree's node_modules stayed stale until the EI-2118
 * workspace-resolution gate aborted every deploy ("@papercusp/scheduled-registry
 * unresolved"), leaving live :3070 ~166 commits behind.
 *
 * The fix realpath-normalizes INTEGRATION_ROOT/RELEASE_ROOT right after arg-parse so
 * find/cp operate on the real tree regardless of how the caller named the root. The
 * existing deps tests only sed-extract need_node_modules/sync_one_node_modules — none
 * exercised root resolution, so this class could silently return. These lock it by
 * sourcing the SHIPPED normalization block (never a copy) and running the exact copy-loop
 * enumeration: the bug is real (symlink → nothing) and the fix cures it (symlink →
 * every dir, dereferenced to the real tree).
 */
describe('setup-release-checkout.sh — symlinked INTEGRATION_ROOT node_modules enumeration (EI-5307)', () => {
  let work: string;
  let realTree: string;
  let linkToTree: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'symlink-root-'));
    realTree = join(work, 'real');
    // A real integration tree: root node_modules + a package-local node_modules (both
    // must be enumerated), plus a .git so it reads as the integration repo.
    mkdirSync(join(realTree, 'node_modules/@papercusp'), { recursive: true });
    mkdirSync(join(realTree, 'packages/scheduled-registry/node_modules'), { recursive: true });
    mkdirSync(join(realTree, '.git'), { recursive: true });
    // Coordination state can contain complete repair worktrees with their own dependency
    // graphs. Those are runtime infrastructure, not product packages, and must never ride
    // into the checkpoint snapshot. Git metadata is excluded for the same reason.
    mkdirSync(join(realTree, '.papercusp/worktrees/repair/node_modules'), { recursive: true });
    mkdirSync(join(realTree, '.git/internal/node_modules'), { recursive: true });
    // The symlink deploy-cli passed as --integration (papercup -> papercusp).
    linkToTree = join(work, 'papercup-link');
    symlinkSync(realTree, linkToTree);
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /**
   * Run the copy-loop enumeration for INTEGRATION_ROOT=`root`. When `normalize` is set,
   * first source the SHIPPED realpath-normalization block out of the live script (so we
   * exercise the deployed fix, never a copy). Returns the enumerated node_modules dirs.
   */
  function enumerate(root: string, normalize: boolean): string[] {
    const lines = ['set -uo pipefail', `INTEGRATION_ROOT=${JSON.stringify(root)}`];
    lines.push(
      'source "$GENERATION_SCRIPT"',
      `source <(sed -n '/^enumerate_node_modules()/,/^}/p' "$SETUP_SCRIPT")`,
    );
    if (normalize) {
      lines.push(
        'RELEASE_ROOT="$INTEGRATION_ROOT"', // the shipped block normalizes both; unused here
        `source <(sed -n '/^# Symlink-safe roots/,/^RELEASE_ROOT="\\$(realpath -m/p' "$SETUP_SCRIPT")`,
      );
    }
    lines.push('enumerate_node_modules');
    const r = spawnSync('bash', ['-c', lines.join('\n')], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        GENERATION_SCRIPT: DEPENDENCY_GENERATION_SCRIPT,
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`enumeration failed (${r.status}): ${r.stderr || r.stdout}`);
    return (r.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  it('the bug: find over a SYMLINKED root enumerates ZERO node_modules (silent no-op)', () => {
    // Passing the symlink verbatim (no normalization) — `find -P` won't descend it.
    expect(enumerate(linkToTree, /* normalize */ false)).toEqual([]);
  });

  it('a REAL root enumerates every package-local node_modules (sanity: the tree has them)', () => {
    const dirs = enumerate(realTree, /* normalize */ false);
    expect(dirs.length).toBe(2);
    expect(dirs.every((d) => d.endsWith('/node_modules'))).toBe(true);
  });

  it('prunes .papercusp repair worktrees and .git metadata before dependency matching', () => {
    const dirs = enumerate(realTree, /* normalize */ false);
    expect(dirs).toEqual([
      join(realTree, 'node_modules'),
      join(realTree, 'packages/scheduled-registry/node_modules'),
    ]);
    expect(dirs.every((d) => !d.includes('/.papercusp/') && !d.includes('/.git/'))).toBe(true);
  });

  it('the fix: the shipped realpath normalization makes a SYMLINKED root enumerate them all', () => {
    const dirs = enumerate(linkToTree, /* normalize */ true);
    const realBase = realpathSync(realTree); // canonical (tmpdir itself may be symlinked)
    // Same set as the real tree — the copy loop now sees the node_modules dirs.
    expect(dirs.length).toBe(2);
    // …dereferenced under the REAL tree, never left on the symlink path.
    expect(dirs.every((d) => d.startsWith(realBase))).toBe(true);
    expect(dirs.some((d) => d.startsWith(linkToTree))).toBe(false);
  });
});

/**
 * EI-13127: `prune_post_pin_workspace_pkgs()` — the pin-aware companion to the
 * EI-2118 workspace-resolution fatal gate. A release symlink can dangle for two
 * reasons with opposite correct handling: (a) the package's source IS in the
 * target ref but extraction failed → real crash-loop risk, must stay for the
 * fatal gate; (b) the package was added to staging AFTER the pin (integration
 * node_modules reflects staging tip, release source reflects the pin) → pinned
 * code cannot import it, and fataling on it froze EVERY deploy (target and
 * rollback refs alike) until the next green pin — the 2026-07-16
 * @papercusp/release-profile deploy freeze. These tests pin the discriminator:
 * absent-from-TARGET_SHA ⇒ pruned; present-in-TARGET_SHA ⇒ left for the gate.
 */
describe('prune_post_pin_workspace_pkgs (EI-13127)', () => {
  let integrationRoot: string;
  let releaseRoot: string;
  let targetSha: string;

  function runPrune(): string {
    const wrapper = [
      'set -uo pipefail',
      'log() { echo "[log] $*"; }',
      'source <(sed -n "/^prune_post_pin_workspace_pkgs()/,/^}/p" "$SETUP_SCRIPT")',
      'prune_post_pin_workspace_pkgs',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
        TARGET_SHA: targetSha,
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`prune_post_pin_workspace_pkgs exited ${r.status}: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  const git = (...args: string[]) => {
    const r = spawnSync(
      'git',
      ['-C', integrationRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  /** Source dir + package.json under <root>/libs/generic/<pkg>. */
  function addSource(root: string, pkg: string): void {
    const dir = join(root, 'libs', 'generic', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@papercusp/${pkg}` }));
  }

  /** Relative workspace symlink node_modules/@papercusp/<pkg> -> ../../libs/generic/<pkg>. */
  function linkPkg(root: string, pkg: string): void {
    const scopeDir = join(root, 'node_modules', '@papercusp');
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(join('..', '..', 'libs', 'generic', pkg), join(scopeDir, pkg));
  }

  beforeEach(() => {
    integrationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'prune-int-')));
    releaseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'prune-rel-')));
    // Pin contains ONLY in-pin-pkg…
    git('init', '-q');
    addSource(integrationRoot, 'in-pin-pkg');
    git('add', '-A');
    git('commit', '-q', '-m', 'pin');
    targetSha = git('rev-parse', 'HEAD');
    // …then post-pin-pkg lands on the working tree (staging tip) after the pin.
    addSource(integrationRoot, 'post-pin-pkg');
    linkPkg(integrationRoot, 'in-pin-pkg');
    linkPkg(integrationRoot, 'post-pin-pkg');
    // Release tree: node_modules copied from integration (both symlinks) but
    // source extracted at the PIN — only in-pin-pkg's source exists, and we
    // model the extraction failure by omitting BOTH sources so both dangle.
    linkPkg(releaseRoot, 'in-pin-pkg');
    linkPkg(releaseRoot, 'post-pin-pkg');
  });

  afterEach(() => {
    rmSync(integrationRoot, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
  });

  it('prunes a dangling symlink for a package ABSENT from the target ref (post-pin) and logs it', () => {
    const out = runPrune();
    expect(existsSync(join(releaseRoot, 'node_modules', '@papercusp', 'post-pin-pkg'))).toBe(false);
    expect(lstatSync(join(releaseRoot, 'node_modules', '@papercusp', 'post-pin-pkg'), { throwIfNoEntry: false })).toBeUndefined();
    expect(out).toContain('pruned post-pin workspace package @papercusp/post-pin-pkg');
  });

  it('LEAVES a dangling symlink for a package PRESENT in the target ref (real extraction break → fatal gate)', () => {
    runPrune();
    // Symlink still there (dangling), so unresolved_workspace_pkgs still fatals on it.
    expect(lstatSync(join(releaseRoot, 'node_modules', '@papercusp', 'in-pin-pkg'), { throwIfNoEntry: false })).toBeDefined();
  });

  it('never touches a RESOLVABLE release package', () => {
    // Give the release tree the in-pin source so it resolves.
    addSource(releaseRoot, 'in-pin-pkg');
    const out = runPrune();
    expect(existsSync(join(releaseRoot, 'node_modules', '@papercusp', 'in-pin-pkg', 'package.json'))).toBe(true);
    expect(out).not.toContain('in-pin-pkg');
  });
});

/**
 * EI-13127 part 2: the prune alone was insufficient — unresolved_workspace_pkgs()
 * reports MISSING packages as unresolved too (by design, for in-pin packages),
 * so pruning a post-pin dangling symlink just converted "dangling" to "missing"
 * and the gate still fataled (observed live on deploy #3, 2026-07-16 23:17Z).
 * The gate itself now applies the same pin discriminator: a package whose
 * source is absent from TARGET_SHA is skipped; absent TARGET_SHA keeps the
 * original strict behavior.
 */
describe('unresolved_workspace_pkgs pin-awareness (EI-13127)', () => {
  let integrationRoot: string;
  let releaseRoot: string;
  let targetSha: string;

  function runGate(env: Record<string, string> = {}): string {
    const wrapper = [
      'set -uo pipefail',
      'source <(sed -n "/^unresolved_workspace_pkgs()/,/^}/p" "$SETUP_SCRIPT")',
      'unresolved_workspace_pkgs',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
        ...env,
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`unresolved_workspace_pkgs exited ${r.status}: ${r.stderr}`);
    return r.stdout.trim();
  }

  const git2 = (...args: string[]) => {
    const r = spawnSync(
      'git',
      ['-C', integrationRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  function addSrc(root: string, pkg: string): void {
    const dir = join(root, 'libs', 'generic', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@papercusp/${pkg}` }));
  }
  function link2(root: string, pkg: string): void {
    const scopeDir = join(root, 'node_modules', '@papercusp');
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(join('..', '..', 'libs', 'generic', pkg), join(scopeDir, pkg));
  }

  beforeEach(() => {
    integrationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gate-int-')));
    releaseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gate-rel-')));
    git2('init', '-q');
    addSrc(integrationRoot, 'in-pin-pkg');
    git2('add', '-A');
    git2('commit', '-q', '-m', 'pin');
    targetSha = git2('rev-parse', 'HEAD');
    addSrc(integrationRoot, 'post-pin-pkg');
    link2(integrationRoot, 'in-pin-pkg');
    link2(integrationRoot, 'post-pin-pkg');
    // Release tree: neither package resolves (both missing entirely — the
    // post-prune state for post-pin-pkg, an extraction break for in-pin-pkg).
  });

  afterEach(() => {
    rmSync(integrationRoot, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
  });

  it('with TARGET_SHA: reports the in-pin break, SKIPS the post-pin package', () => {
    const out = runGate({ TARGET_SHA: targetSha });
    expect(out).toContain('@papercusp/in-pin-pkg');
    expect(out).not.toContain('post-pin-pkg');
  });

  it('without TARGET_SHA: original strict behavior — both reported', () => {
    const out = runGate();
    expect(out).toContain('@papercusp/in-pin-pkg');
    expect(out).toContain('@papercusp/post-pin-pkg');
  });
});

/**
 * WI-5110: green-checkpoint's stale-candidate re-triage twice reported a false
 * "failures REPRODUCE at tip <sha>" verdict (2026-07-17) — tests that demonstrably
 * PASSED when re-run by hand at the named tip. The re-triage trusts a zero exit
 * from this script as proof its throwaway tree is actually at the requested ref;
 * assert_checkout_landed() is the fix — a fatal, script-level guarantee that a
 * zero exit really does mean HEAD == TARGET_SHA, for every caller (candidate
 * judgment, tip re-run, prefix salvage), not just the tip-retriage path.
 */
describe('assert_checkout_landed (WI-5110)', () => {
  let releaseRoot: string;
  let targetSha: string;

  function runAssert(env: Record<string, string> = {}): { status: number | null; stderr: string } {
    const wrapper = [
      'set -uo pipefail',
      'source <(sed -n "/^assert_checkout_landed()/,/^}/p" "$SETUP_SCRIPT")',
      'assert_checkout_landed',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        RELEASE_ROOT: releaseRoot,
        TARGET_SHA: targetSha,
        REF: 'main',
        ...env,
      },
      encoding: 'utf8',
    });
    return { status: r.status, stderr: r.stderr };
  }

  const git3 = (...args: string[]) => {
    const r = spawnSync(
      'git',
      ['-C', releaseRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeEach(() => {
    releaseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'assert-checkout-')));
    git3('init', '-q');
    writeFileSync(join(releaseRoot, 'f.txt'), 'v1');
    git3('add', '-A');
    git3('commit', '-q', '-m', 'c1');
    targetSha = git3('rev-parse', 'HEAD');
  });

  afterEach(() => {
    rmSync(releaseRoot, { recursive: true, force: true });
  });

  it('HEAD matches TARGET_SHA: exits 0, no FATAL', () => {
    const r = runAssert();
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('FATAL');
  });

  it('HEAD is a DIFFERENT commit than TARGET_SHA: exits 1 with a FATAL naming both shas', () => {
    writeFileSync(join(releaseRoot, 'f.txt'), 'v2');
    git3('add', '-A');
    git3('commit', '-q', '-m', 'c2');
    const staleTargetSha = targetSha; // the tree moved on; TARGET_SHA still names the OLD commit
    const r = runAssert({ TARGET_SHA: staleTargetSha });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FATAL');
    expect(r.stderr).toContain(staleTargetSha);
  });

  it('RELEASE_ROOT is not a git repo at all (git rev-parse fails): exits 1, reports "unknown" rather than crashing', () => {
    const notARepo = realpathSync(mkdtempSync(join(tmpdir(), 'not-a-repo-')));
    try {
      const r = runAssert({ RELEASE_ROOT: notARepo });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('FATAL');
      expect(r.stderr).toContain('unknown');
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

/**
 * EI-21181583819839124: a dead Git process left the checkpoint linked
 * worktree's index.lock behind. The gate's run-lock was idle and healthy, but
 * checkout setup failed before a test could run. The setup script may recover
 * only when the exact Git-resolved lock is old AND unowned; otherwise it must
 * leave the lock untouched and fail closed.
 */
describe('refresh_release_worktree — stale Git index.lock recovery (EI-21181583819839124)', () => {
  let releaseRoot: string;
  let quarantineRoot: string;
  let firstSha: string;
  let targetSha: string;

  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', releaseRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  function runRefresh(): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const wrapper = [
      'set -uo pipefail',
      'log() { printf "[test] %s\\n" "$*"; }',
      'source <(sed -n "/^index_lock_has_live_holder()/,/^}/p" "$SETUP_SCRIPT")',
      'source <(sed -n "/^quarantine_stale_worktree_index_lock()/,/^}/p" "$SETUP_SCRIPT")',
      'source <(sed -n "/^refresh_release_worktree()/,/^}/p" "$SETUP_SCRIPT")',
      'refresh_release_worktree',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        RELEASE_ROOT: releaseRoot,
        TARGET_SHA: targetSha,
        TMPDIR: quarantineRoot,
      },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function createIndexLock(ageMs: number): string {
    const lockPath = join(releaseRoot, '.git/index.lock');
    writeFileSync(lockPath, 'stale-test-lock');
    const timestamp = new Date(Date.now() - ageMs);
    utimesSync(lockPath, timestamp, timestamp);
    return lockPath;
  }

  beforeEach(() => {
    releaseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'stale-index-lock-release-')));
    quarantineRoot = realpathSync(mkdtempSync(join(tmpdir(), 'stale-index-lock-quarantine-')));
    git('init', '-q');
    writeFileSync(join(releaseRoot, 'f.txt'), 'v1');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');
    firstSha = git('rev-parse', 'HEAD');
    writeFileSync(join(releaseRoot, 'f.txt'), 'v2');
    git('add', '-A');
    git('commit', '-q', '-m', 'c2');
    targetSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', firstSha);
  });

  afterEach(() => {
    rmSync(releaseRoot, { recursive: true, force: true });
    rmSync(quarantineRoot, { recursive: true, force: true });
  });

  it('moves an old unowned lock to recoverable quarantine, retries once, and lands TARGET_SHA', () => {
    const lockPath = createIndexLock(10 * 60_000);
    const result = runRefresh();

    expect(result.status).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(git('rev-parse', 'HEAD')).toBe(targetSha);
    const quarantineDir = join(quarantineRoot, 'papercusp-stale-git-locks');
    expect(readdirSync(quarantineDir)).toHaveLength(1);
    expect(result.stdout).toContain('quarantined stale unowned Git index lock');
  });

  it('refuses a fresh lock and leaves both the lock and checkout untouched', () => {
    const lockPath = createIndexLock(1_000);
    const result = runRefresh();

    expect(result.status).not.toBe(0);
    expect(existsSync(lockPath)).toBe(true);
    expect(git('rev-parse', 'HEAD')).toBe(firstSha);
    expect(result.stdout).toContain('refusing to reclaim fresh Git index lock');
  });

  it('refuses an old lock while a live process still holds it open', () => {
    const lockPath = createIndexLock(10 * 60_000);
    const fd = openSync(lockPath, 'r');
    try {
      const result = runRefresh();
      expect(result.status).not.toBe(0);
      expect(existsSync(lockPath)).toBe(true);
      expect(git('rev-parse', 'HEAD')).toBe(firstSha);
      expect(result.stdout).toContain('held by a live process');
    } finally {
      closeSync(fd);
    }
  });
});

/**
 * EI-20336479620858625: Route A can finish a regular pinned clone and its
 * submodules before dependency preparation is retried. `--prepare-existing`
 * must validate that pin and refresh dependencies without resetting, cleaning,
 * or replacing the already-verified source checkout.
 */
describe('setup-release-checkout.sh --prepare-existing (EI-20336479620858625)', () => {
  let integrationRoot: string;
  let releaseRoot: string;
  let targetSha: string;

  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync(
      'git',
      ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeEach(() => {
    integrationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'prepare-int-')));
    git(integrationRoot, 'init', '-q');
    writeFileSync(join(integrationRoot, '.gitignore'), 'ignored-cache/\n');
    writeFileSync(join(integrationRoot, 'tracked.txt'), 'pinned source\n');
    git(integrationRoot, 'add', '-A');
    git(integrationRoot, 'commit', '-q', '-m', 'pinned');
    targetSha = git(integrationRoot, 'rev-parse', 'HEAD');

    const releaseParent = realpathSync(mkdtempSync(join(tmpdir(), 'prepare-rel-')));
    releaseRoot = join(releaseParent, 'clone');
    const clone = spawnSync('git', ['clone', '-q', integrationRoot, releaseRoot], { encoding: 'utf8' });
    if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr}`);
    writeFileSync(join(releaseRoot, 'untracked-sentinel.txt'), 'keep me\n');
    mkdirSync(join(releaseRoot, 'ignored-cache'), { recursive: true });
    writeFileSync(join(releaseRoot, 'ignored-cache', 'stale.txt'), 'keep me too\n');
  });

  afterEach(() => {
    rmSync(integrationRoot, { recursive: true, force: true });
    rmSync(join(releaseRoot, '..'), { recursive: true, force: true });
  });

  function runPrepare(args: string[] = []) {
    return spawnSync(
      'bash',
      [SCRIPT_PATH, '--prepare-existing', '--integration', integrationRoot, '--release', releaseRoot, '--node-modules', 'skip', ...args],
      { encoding: 'utf8' },
    );
  }

  it('preserves an existing pinned clone while running dependency-only preparation', () => {
    mkdirSync(join(integrationRoot, 'node_modules', 'dependency-only-fixture'), { recursive: true });
    writeFileSync(join(integrationRoot, 'node_modules', 'dependency-only-fixture', 'package.json'), '{}');
    const r = runPrepare(['--node-modules', 'force']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dependency-only');
    expect(git(releaseRoot, 'rev-parse', 'HEAD')).toBe(targetSha);
    expect(existsSync(join(releaseRoot, 'node_modules', 'dependency-only-fixture', 'package.json'))).toBe(true);
    expect(readFileSync(join(releaseRoot, 'untracked-sentinel.txt'), 'utf8')).toBe('keep me\n');
    expect(readFileSync(join(releaseRoot, 'ignored-cache', 'stale.txt'), 'utf8')).toBe('keep me too\n');
  });

  it('fails closed when an explicit ref does not match the existing clone HEAD', () => {
    writeFileSync(join(integrationRoot, 'new-tip.txt'), 'new tip\n');
    git(integrationRoot, 'add', '-A');
    git(integrationRoot, 'commit', '-q', '-m', 'new tip');

    const r = runPrepare(['--ref', 'HEAD']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not match requested ref');
    expect(git(releaseRoot, 'rev-parse', 'HEAD')).toBe(targetSha);
  });
});

/**
 * WI-5366: the worktree-refresh clean step only ever ran plain `git clean -fdq
 * -e node_modules` — which does NOT remove gitignored files (that requires `-x`).
 * Verified live in the running papercusp-checkpoint tree: package-local
 * `.vitest-tmp/` and `.papercusp-tmp/node-compile-cache/` dirs dated 17+ days
 * and untold checkouts stale, because they are ignored (not merely untracked)
 * and `-x` was never passed. A throwaway, correctness-critical tree (this
 * script's own header) must never let a stale gitignored artifact from a PRIOR
 * checkout at a DIFFERENT commit survive into the next one — the same class of
 * risk `--node-modules force` (over `auto`) already exists to close for
 * node_modules specifically. This locks `-x` in so the class can't regress,
 * while confirming node_modules itself is still spared (the one directory this
 * tree deliberately preserves + refreshes via its own hardlink-copy step).
 */
describe('worktree clean step removes gitignored debris without deleting live runtime assets (WI-5366, EI-20509311930433301)', () => {
  it('`-x` removes stale caches while preserving node_modules and the running operator dist-host tree', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clean-x-')));
    try {
      const git = (...args: string[]) => {
        const r = spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
          encoding: 'utf8',
        });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
        return r.stdout.trim();
      };
      git('init', '-q');
      writeFileSync(join(dir, '.gitignore'), '.vitest-tmp/\napps/operator/dist-host/\n');
      writeFileSync(join(dir, 'f.txt'), 'v1');
      git('add', '-A');
      git('commit', '-q', '-m', 'c1');

      // Simulate what a prior checkpoint run leaves behind: a gitignored cache
      // dir, plus node_modules (which the real script preserves + refreshes
      // itself — clean must never touch it).
      mkdirSync(join(dir, '.vitest-tmp'), { recursive: true });
      writeFileSync(join(dir, '.vitest-tmp', 'stale-cache-entry'), 'stale');
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'marker'), 'keep-me');
      mkdirSync(join(dir, 'apps/operator/dist-host/sql'), { recursive: true });
      writeFileSync(join(dir, 'apps/operator/dist-host/hono-host.mjs'), 'running-bundle');
      writeFileSync(join(dir, 'apps/operator/dist-host/sql/001-bootstrap.sql'), 'running-lock-ddl');

      // Old behavior (no -x): the gitignored dir survives.
      spawnSync('git', ['-C', dir, 'clean', '-fdq', '-e', 'node_modules']);
      expect(existsSync(join(dir, '.vitest-tmp', 'stale-cache-entry'))).toBe(true);

      // Shipped behavior (-x): stale caches are gone, while the two runtime
      // asset sets needed before restart remain coherent and available.
      spawnSync('git', [
        '-C', dir, 'clean', '-fdqx',
        '-e', 'node_modules',
        '-e', '/apps/operator/dist-host/',
      ]);
      expect(existsSync(join(dir, '.vitest-tmp'))).toBe(false);
      expect(existsSync(join(dir, 'node_modules', 'marker'))).toBe(true);
      expect(existsSync(join(dir, 'apps/operator/dist-host/hono-host.mjs'))).toBe(true);
      expect(existsSync(join(dir, 'apps/operator/dist-host/sql/001-bootstrap.sql'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the shipped script invokes `git clean` with `-x` and both runtime exclusions', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toMatch(
      /git\s+-C\s+"\$RELEASE_ROOT"\s+clean\s+-fdqx\s+-e\s+node_modules\s+-e\s+\/apps\/operator\/dist-host\//,
    );
  });
});

/**
 * EI-18749180047527506: `extract_submodule_source()` — the submodule SOURCE
 * extraction step (`git archive` at the pinned sha, local objects) must not
 * trust a zero exit from `tar -x` as proof the extraction is COMPLETE. A
 * truncated/interrupted archive stream can exit 0 having written fewer files
 * than its own manifest promised, silently leaving a submodule tree partial —
 * indistinguishable, downstream, from a genuine content regression (the
 * >150-file scan-sanity floor in prompt-blueprint-verb-catalog.test.ts, which
 * scans this exact submodule tree and reds the WHOLE fleet's green pin on a
 * false alarm). These pin the completeness check: a full extraction is
 * trusted as-is; a partial one is detected and repaired via the existing
 * full-tree rsync fallback (already used for an outright `tar -x` failure).
 */
describe('extract_submodule_source (EI-18749180047527506) — submodule archive completeness', () => {
  let work: string;
  let integrationRoot: string;
  let releaseRoot: string;
  let sha: string;

  /** A tiny real git repo at `<integrationRoot>/libs/sub` with two committed files —
   *  stands in for a submodule's LOCAL object store (git archive reads it directly,
   *  never the network — the whole reason this extraction strategy exists). */
  function makeSubmoduleSource(): void {
    const subDir = join(integrationRoot, 'libs', 'sub');
    mkdirSync(subDir, { recursive: true });
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-C', subDir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('init', '-q');
    writeFileSync(join(subDir, 'a.txt'), 'a');
    writeFileSync(join(subDir, 'b.txt'), 'b');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');
    sha = git('rev-parse', 'HEAD');
  }

  /** Runs the real `extract_submodule_source()` (sed-extracted from the shipped
   *  script) for `libs/sub` at the fixture's pinned sha. `extraPath` prepends a
   *  fake `tar` stub onto PATH for the truncation-simulation tests. */
  function runExtract(extraPath?: string): { status: number | null; stdout: string; stderr: string } {
    const wrapper = [
      'set -uo pipefail',
      'log() { echo "[log] $*"; }',
      'source <(sed -n "/^extract_submodule_source()/,/^}/p" "$SETUP_SCRIPT")',
      'extract_submodule_source "libs/sub" "$SHA"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        PATH: extraPath ? `${extraPath}:${process.env.PATH ?? '/usr/bin:/bin'}` : process.env.PATH,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
        SHA: sha,
      },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  beforeEach(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'extract-submodule-')));
    integrationRoot = join(work, 'int');
    releaseRoot = join(work, 'rel');
    mkdirSync(integrationRoot, { recursive: true });
    mkdirSync(releaseRoot, { recursive: true });
    makeSubmoduleSource();
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('a complete extraction lands every file and does NOT fall back to rsync', () => {
    const r = runExtract();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('WARN');
    expect(readdirSync(join(releaseRoot, 'libs', 'sub')).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('a re-run wipes stale content first (rm -rf before extraction, not an accumulating merge)', () => {
    mkdirSync(join(releaseRoot, 'libs', 'sub'), { recursive: true });
    writeFileSync(join(releaseRoot, 'libs', 'sub', 'stale-from-a-prior-pin.txt'), 'stale');
    runExtract();
    expect(existsSync(join(releaseRoot, 'libs', 'sub', 'stale-from-a-prior-pin.txt'))).toBe(false);
  });

  it('a PARTIAL extraction (tar -x exits 0 but drops a file) is detected and repaired via the rsync fallback', () => {
    // A fake `tar` that extracts only ONE of the two archived files on `-x` (an
    // interrupted/truncated stream that still exits 0) but is a transparent
    // passthrough for every other invocation (notably `-tf`, which must report
    // the TRUE manifest for the completeness check to have something to compare against).
    const fakeBinDir = join(work, 'fake-bin');
    mkdirSync(fakeBinDir, { recursive: true });
    const realTar = spawnSync('bash', ['-c', 'command -v tar']).stdout.toString().trim();
    const stub = [
      '#!/usr/bin/env bash',
      `real_tar=${JSON.stringify(realTar)}`,
      'if [[ "$*" == *"-x"* ]]; then',
      '  args=("$@"); outdir=""; tarfile=""',
      '  for i in "${!args[@]}"; do',
      '    [[ "${args[$i]}" == "-C" ]] && outdir="${args[$((i+1))]}"',
      '    [[ "${args[$i]}" == "-f" ]] && tarfile="${args[$((i+1))]}"',
      '  done',
      '  mkdir -p "$outdir"',
      '  "$real_tar" -x -C "$outdir" -f "$tarfile" a.txt', // drop b.txt on purpose
      '  exit 0',
      'fi',
      'exec "$real_tar" "$@"',
    ].join('\n');
    writeFileSync(join(fakeBinDir, 'tar'), stub, { mode: 0o755 });

    const r = runExtract(fakeBinDir);
    expect(r.status).toBe(0); // the function self-heals — never fails the caller
    expect(r.stdout).toContain('WARN');
    expect(r.stdout).toMatch(/landed only 1\/2 file\(s\)/);
    expect(r.stdout).toContain("rsync'ing integration HEAD");
    // The rsync fallback recovered the FULL content despite the truncated tar.
    expect(readdirSync(join(releaseRoot, 'libs', 'sub')).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('an outright `git archive` failure (bad sha) falls back to rsync exactly as before (pre-existing path, unchanged)', () => {
    sha = '0'.repeat(40); // a well-formed but nonexistent sha
    const r = runExtract();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WARN');
    expect(r.stdout).toContain("rsync'ing integration HEAD");
    expect(readdirSync(join(releaseRoot, 'libs', 'sub')).sort()).toEqual(['a.txt', 'b.txt']);
  });
});
