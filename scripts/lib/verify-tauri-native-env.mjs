import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { committedWorkRootDependencyDonor, OWNER_MARKER } from '../lint-as-committed.mjs';
import { censusSpawnArgs, interpretRestrictedHoldPreflight } from './restricted-hold-preflight.mjs';
import { admitTaskDeadline, readTaskDeadlineEpochMs } from './task-deadline.mjs';

// Sequential parent readiness commands (deadline, identity, types, census),
// PostgreSQL init/start/stop/start, and portal setup precede the native rig.
// They must not spend the rig's own launch clock.
export const desktopPortalNativeTiming = Object.freeze({
  prepareEstimateMs: 20 * 60_000,
  nativeTimeoutMs: 45 * 60_000,
  setupTimeoutMs: 15_000 + 45_000 + 120_000 + 125_000 + 4 * 20_000 + 60_000,
  cleanupTimeoutMs: 60_000,
});

export function desktopPortalNativeTestTimeoutMs() {
  const timing = desktopPortalNativeTiming;
  return timing.setupTimeoutMs + timing.nativeTimeoutMs + timing.cleanupTimeoutMs;
}

export function admitDesktopPortalNativeParent(env = process.env, nowMs = Date.now()) {
  const testTimeoutMs = desktopPortalNativeTestTimeoutMs();
  const fileTimeoutMs = testTimeoutMs + 120_000;
  if (Number(env.PAPERCUSP_TEST_FILE_TIMEOUT_MS ?? 600_000) < fileTimeoutMs) {
    throw new Error(`Native profile requires PAPERCUSP_TEST_FILE_TIMEOUT_MS>=${fileTimeoutMs}; refusing before PostgreSQL or dependency copying`);
  }
  return admitTaskDeadline({ env, nowMs, knownEstimateMs: testTimeoutMs,
    knownTasks: 3, unknownTasks: 0 });
}

// A real native verifier is a separate runtime. Its assertion runner will
// establish its own test environment later. Keep the parent's unit database
// rail in the parent, and do not let Vitest enable an injected census here.
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ timeoutMs?: number, nowMs?: number, repoRoot?: string }} [launch]
 */
export function nativeVerifierEnv(env, launch) {
  const child = { ...env };
  if (launch?.repoRoot !== undefined) {
    const source = resolve(launch.repoRoot);
    const donor = committedWorkRootDependencyDonor(source);
    const modules = join(donor, 'node_modules');
    if (!existsSync(modules) || !lstatSync(modules).isDirectory()
      || existsSync(join(donor, OWNER_MARKER))) {
      throw new Error('Native verifier requires a physical installed dependency donor');
    }
    // The invoked wrapper remains in the tested checkout. Pin its Git source
    // separately: changing REPO_DIR alone would copy the mutable donor's code.
    const sourceRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    if (child.VERIFY_TAURI_SOURCE_REF && child.VERIFY_TAURI_SOURCE_REF !== sourceRef) {
      throw new Error('Native verifier source ref must match the invoked checkout');
    }
    child.PAPERCUSP_REPO_DIR = donor;
    child.VERIFY_TAURI_SOURCE_REF = sourceRef;
    if (!child.VERIFY_TAURI_SOURCE_INPUTS && !child.VERIFY_TAURI_SOURCE_INPUTS_FILE) {
      child.VERIFY_TAURI_SOURCE_INPUTS = [
        'apps/operator/bin/desktop-portal-native.test.ts',
        'apps/operator/bin/desktop-portal-persistence.test.ts',
        'scripts/lib/verify-tauri-native-env.mjs',
      ].join(',');
    }
  }
  if (launch?.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(launch.timeoutMs) || launch.timeoutMs <= 0) {
      throw new Error('Native verifier launch timeout must be a positive integer');
    }
    const nowMs = launch.nowMs ?? Date.now();
    child.PAPERCUSP_TASK_DEADLINE_EPOCH_MS = String(Math.min(
      readTaskDeadlineEpochMs(env) ?? Infinity, nowMs + launch.timeoutMs,
    ));
  }
  for (const key of ['PAPERCUSP_FORBID_REAL_PG', 'VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID',
    'PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE']) {
    delete child[key];
  }
  // Hermetic worker setup removes the live workspace pin but retains the
  // original test-run attribution. The real native child needs that source
  // workspace for its lock census; restore it only in this copied child env.
  const workspace = [child.PAPERCUSP_WORKSPACE_ID, child.PAPERCUSP_WORKSPACE,
    child.PAPERCUSP_TEST_RUN_WORKSPACE].find(value => typeof value === 'string' && value.trim());
  if (workspace) child.PAPERCUSP_WORKSPACE_ID = workspace.trim();
  return child;
}

// Exercise the same committed-source census used by the bundle gate before
// PostgreSQL initialization, dependency copying or compilation. This is a
// readiness check only: the real build still checks its exact inputs later.
export function preflightNativeVerifier(repoRoot, env, spawn = spawnSync) {
  const root = resolve(repoRoot);
  const child = nativeVerifierEnv(env, { repoRoot: root });
  if (!child.PAPERCUSP_WORKSPACE_ID?.trim()) {
    throw new Error('Native verifier requires a source workspace before preparation');
  }
  const census = censusSpawnArgs(['--tree', root], child);
  const verdict = interpretRestrictedHoldPreflight(spawn(process.execPath, census.argv, {
    cwd: root, env: census.env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
  }));
  if (verdict.verdict !== 'admit') {
    throw new Error(`Native verifier census is not ready: ${verdict.hint}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== '--preflight' || !process.argv[3]) {
      throw new Error('usage: verify-tauri-native-env.mjs --preflight <repo-root>');
    }
    preflightNativeVerifier(process.argv[3], process.env);
    console.log('VERIFY_TAURI_NATIVE_PREFLIGHT admitted=1');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
