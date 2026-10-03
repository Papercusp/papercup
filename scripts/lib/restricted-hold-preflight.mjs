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
/** Set by the raw router on its own env (inherited by every vitest it starts) after it admitted. */
export const RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER = 'admitted-by-test-router';
/** Set by the vitest root preflight (WI-10005724) on vitest's main-process env after it admitted. */
export const RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST = 'admitted-by-vitest-root';
const ADMITTED_MARKERS = new Set([
  RESTRICTED_HOLD_PREFLIGHT_DONE,
  RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER,
  RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST,
]);

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
 * - An enclosing router or vitest root already admitted this process tree (its marker is inherited).
 * - The green-checkpoint gate's isolated checkout cannot hold a restricted write (see isReleaseGate).
 * @param {NodeJS.ProcessEnv} env
 * @returns {'testing-run' | 'admitted-upstream' | 'release-gate' | 'nested-in-vitest' | null}
 */
export function restrictedHoldPreflightSkipReason(env) {
  const upstream = admittedUpstream(env);
  if (upstream) return upstream;
  if (isReleaseGate(env)) return 'release-gate';
  if (env.VITEST) return 'nested-in-vitest';
  return null;
}

/**
 * The green-checkpoint gate runs COMMITTED code in its own isolated checkout, and D-011 holds a
 * restricted session's writes out of every commit, so no held restricted write can exist where the
 * gate runs. Without this skip every vitest process the gate starts would pay a census spawn and
 * take a fail-closed Postgres dependency, so one database hiccup would turn the fleet's gate red
 * while fencing nothing. Keyed on BOTH gate markers: GREEN_CHECKPOINT=1 alone is exported by hand
 * to reproduce the gate's skip-set, PC_HEAVY_RELEASE_GATE=1 is set by nothing but the gate (WI-6140),
 * and proc-guard reads the same pair as the gate's identity.
 * @param {NodeJS.ProcessEnv} env
 */
function isReleaseGate(env) {
  return env.PC_HEAVY_RELEASE_GATE === '1' && env.GREEN_CHECKPOINT === '1';
}

/** @param {NodeJS.ProcessEnv} env @returns {'testing-run' | 'admitted-upstream' | null} */
function admittedUpstream(env) {
  const marker = env[RESTRICTED_HOLD_PREFLIGHT_ENV];
  if (marker === RESTRICTED_HOLD_PREFLIGHT_DONE) return 'testing-run';
  if (marker !== undefined && ADMITTED_MARKERS.has(marker)) return 'admitted-upstream';
  return null;
}

/**
 * Why the vitest ROOT preflight (WI-10005724) needs no census of its own, or null when it does.
 *
 * Unlike the router, it can NOT skip on `VITEST`: vitest sets `process.env.VITEST = 'true'` in its
 * own main process (prepareVitest) BEFORE the config or any globalSetup loads, so that signal is
 * present at the root of every run, not only at nested hops. Nested runs are recognised by the
 * admitted marker instead, which the root sets after it admits and every child process inherits.
 * - GitHub Actions runners host no Papercusp operator, so no restricted session and no census exist
 *   there (only `GITHUB_ACTIONS`, never the generic `CI`, which local tooling also sets).
 * - The green-checkpoint gate's isolated checkout cannot hold a restricted write (see isReleaseGate).
 * @param {NodeJS.ProcessEnv} env
 * @returns {'testing-run' | 'admitted-upstream' | 'release-gate' | 'github-actions' | null}
 */
export function vitestRootPreflightSkipReason(env) {
  const upstream = admittedUpstream(env);
  if (upstream) return upstream;
  if (isReleaseGate(env)) return 'release-gate';
  if (env.GITHUB_ACTIONS === 'true') return 'github-actions';
  return null;
}

/**
 * @param {{ repoRoot: string, files: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number, spawn?: typeof spawnSync }} opts
 * @returns {{ verdict: 'admit' } | { verdict: 'skipped', reason: 'testing-run' | 'nested-in-vitest' } | { verdict: 'refuse', error: string, hint: string }}
 */
export function runRestrictedHoldPreflight({ repoRoot, files, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  const skip = restrictedHoldPreflightSkipReason(env);
  if (skip) return { verdict: 'skipped', reason: skip };
  return spawnCensus({ repoRoot, files, env, timeoutMs, spawn });
}

/**
 * The vitest ROOT door (WI-10005724): `npx vitest`, and the per-workspace vitest runs
 * `npm run test:affected` starts, reach no router. libs/test-config's host-preflight globalSetup
 * calls this (through scripts/lib/vitest-host-preflight.mjs) after vitest has resolved the run's
 * files and before any test executes. Same census child, same fail-closed table as the router.
 * On admit it hands back the marker for vitest's main-process env, so every worker and every
 * nested router/vitest a test starts skips a duplicate census.
 * @param {{ repoRoot: string, files: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number, spawn?: typeof spawnSync }} opts
 */
export function runVitestRootPreflight({ repoRoot, files, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  const skip = vitestRootPreflightSkipReason(env);
  if (skip) return { verdict: 'skipped', reason: skip };
  const verdict = spawnCensus({ repoRoot, files, env, timeoutMs, spawn });
  if (verdict.verdict !== 'admit') return verdict;
  return { verdict: 'admit', setEnv: { [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST } };
}

/**
 * The host-bundle door (WI-10005745): bg-host's ExecStartPre bundles the LIVE shared tree and runs
 * it with the network. apps/operator/bin/bundle-restricted-hold-gate.mjs writes the bundle's exact
 * inputs (esbuild metafile inputs + verbatim-copied files/dirs) to `inputsFile` and calls this
 * before it lets the fresh bundle stand. No skip reasons: a bundle is never nested in a test run,
 * and the release/staging checkouts simply hold nothing, so their census admits on its own.
 * Same census child and fail-closed table as the router.
 * @param {{ repoRoot: string, inputsFile: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, spawn?: typeof spawnSync }} opts
 * @returns {{ verdict: 'admit' } | { verdict: 'refuse', error: string, hint: string }}
 */
export function runBundleRestrictedHoldPreflight({ repoRoot, inputsFile, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  return spawnCensus({ repoRoot, files: [], env, timeoutMs, spawn, leading: ['--bundle-inputs', inputsFile] });
}

function spawnCensus({ repoRoot, files, env, timeoutMs, spawn, leading = [] }) {
  const result = spawn(process.execPath, ['--import', 'tsx', RESTRICTED_HOLD_PREFLIGHT_CLI, ...leading, repoRoot, ...files], {
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

/** The vitest-root door's refusal line (vitest prints it as the globalSetup error). */
export function formatVitestRestrictedHoldRefusal(refusal) {
  return `VITEST_RESTRICTED_HOLD_REFUSED error=${refusal.error} measured=none ${refusal.hint}`;
}

/** The host-bundle door's refusal line (bundle-host.sh prints it, then falls back to last-known-good). */
export function formatBundleRestrictedHoldRefusal(refusal) {
  return `BUNDLE_RESTRICTED_HOLD_REFUSED error=${refusal.error} published=last-known-good ${refusal.hint}`;
}
