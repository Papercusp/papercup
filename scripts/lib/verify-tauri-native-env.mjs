import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { censusSpawnArgs, interpretRestrictedHoldPreflight } from './restricted-hold-preflight.mjs';

// A real native verifier is a separate runtime. Its assertion runner will
// establish its own test environment later. Keep the parent's unit database
// rail in the parent, and do not let Vitest enable an injected census here.
export function nativeVerifierEnv(env) {
  const child = { ...env };
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
  const child = nativeVerifierEnv(env);
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
