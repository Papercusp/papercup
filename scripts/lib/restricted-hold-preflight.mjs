// Restricted-write preflight for the RAW test router (WI-10005713, follow-up of WI-10005634 —
// plan personal-data-reader-set-labels-2026-10-01, BAR R-11, Decision D-012).
//
// A session holding an active personal disclosure has no network (D-012), but code it WROTE into
// the shared tree can still be executed later by an unrestricted process that has the network.
// `testing:run` refuses that in-process (restricted-hold-fence.ts). A raw `npm run test:file`
// reaches scripts/test-files.mjs without it, so the router calls `runRestrictedHoldPreflight`
// before it starts any test process.
//
// The census and reach walk are NOT re-implemented here: this module spawns the operator-core
// entry (restricted-hold-preflight-cli.ts) that runs the exact `restrictedHoldRefusal` testing:run
// uses. It fails CLOSED: no marker line, bad JSON, a crash or a timeout all refuse.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** stdout marker the CLI prints exactly once, followed by a JSON verdict. */
export const RESTRICTED_HOLD_PREFLIGHT_MARKER = 'RESTRICTED_HOLD_PREFLIGHT';

/** CLI exit codes. Anything else is treated as an unknown state and refuses. */
export const RESTRICTED_HOLD_PREFLIGHT_EXIT = Object.freeze({ admit: 0, misuse: 2, refuse: 3 });

/**
 * Set by `testing:run` on the router it spawns, after its in-process fence admitted the SAME file
 * set. It only skips a duplicate check; it is not a bypass for any path testing:run did not check.
 * A caller that could set it could equally run vitest directly, which no router-side check can
 * stop. The PreToolUse layer is the place for that, not this module.
 */
export const RESTRICTED_HOLD_PREFLIGHT_ENV = 'PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT';
export const RESTRICTED_HOLD_PREFLIGHT_DONE = 'admitted-by-testing-run';

/**
 * Absolute path of the operator-core entry the router spawns — resolved from THIS module, never
 * from the checkout being checked, so the census code that runs is always this repo's own.
 */
export const RESTRICTED_HOLD_PREFLIGHT_CLI = fileURLToPath(
  new URL('../../packages/operator-core/lib/agent-tools/testing/restricted-hold-preflight-cli.ts', import.meta.url),
);

const DEFAULT_TIMEOUT_MS = 120_000;

function unknownState(why) {
  return {
    verdict: 'refuse',
    error: 'restricted_hold_state_unknown',
    hint: `could not verify whether a restricted session's writes are held in this checkout; no test process was started (${why})`,
  };
}

/**
 * Parse the CLI's result. Exported so the fail-closed table is unit-testable without a spawn.
 * @param {{ status: number | null, signal?: string | null, stdout?: string | null, stderr?: string | null, error?: Error }} result
 */
export function interpretRestrictedHoldPreflight(result) {
  if (result.error) return unknownState(`preflight could not run: ${result.error.message}`);
  if (result.signal) return unknownState(`preflight was killed by ${result.signal}`);
  const line = String(result.stdout ?? '')
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(`${RESTRICTED_HOLD_PREFLIGHT_MARKER} `));
  if (!line) {
    const tail = String(result.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
    return unknownState(`preflight exited ${result.status} without a verdict${tail ? `: ${tail}` : ''}`);
  }
  let payload;
  try {
    payload = JSON.parse(line.slice(RESTRICTED_HOLD_PREFLIGHT_MARKER.length + 1));
  } catch {
    return unknownState('preflight printed an unparseable verdict');
  }
  if (payload?.verdict === 'admit' && result.status === RESTRICTED_HOLD_PREFLIGHT_EXIT.admit) return { verdict: 'admit' };
  if (payload?.verdict === 'refuse' && typeof payload.error === 'string' && typeof payload.hint === 'string') {
    return { verdict: 'refuse', error: payload.error, hint: payload.hint };
  }
  return unknownState(`preflight verdict ${JSON.stringify(payload?.verdict)} does not match exit ${result.status}`);
}

/**
 * Why this router invocation needs no preflight of its own, or null when it does.
 * - testing:run already ran `restrictedHoldRefusal` over the same files in-process.
 * - The router is nested inside a vitest process tree (a test that drives the router). That test
 *   process has already executed everything it loads, so the fence belongs at the ROOT of the run
 *   (testing:run, or this router's own top-level invocation), not at every nested hop. Without
 *   this, each in-test router call would pay a ~2s census spawn and a Postgres dependency.
 * @param {NodeJS.ProcessEnv} env
 * @returns {'testing-run' | 'nested-in-vitest' | null}
 */
export function restrictedHoldPreflightSkipReason(env) {
  if (env[RESTRICTED_HOLD_PREFLIGHT_ENV] === RESTRICTED_HOLD_PREFLIGHT_DONE) return 'testing-run';
  if (env.VITEST) return 'nested-in-vitest';
  return null;
}

/**
 * @param {{ repoRoot: string, files: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number, spawn?: typeof spawnSync }} opts
 * @returns {{ verdict: 'admit' } | { verdict: 'skipped', reason: 'testing-run' | 'nested-in-vitest' } | { verdict: 'refuse', error: string, hint: string }}
 */
export function runRestrictedHoldPreflight({ repoRoot, files, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  const skip = restrictedHoldPreflightSkipReason(env);
  if (skip) return { verdict: 'skipped', reason: skip };
  const result = spawn(process.execPath, ['--import', 'tsx', RESTRICTED_HOLD_PREFLIGHT_CLI, repoRoot, ...files], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return interpretRestrictedHoldPreflight(result);
}

/** One stderr line for a refusal; greppable, and it names the measured state: nothing ran. */
export function formatRestrictedHoldRefusal(refusal) {
  return `TEST_FILE_RESTRICTED_HOLD_REFUSED error=${refusal.error} measured=none ${refusal.hint}`;
}
